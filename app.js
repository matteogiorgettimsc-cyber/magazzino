/* Magazzino – La Spesa Sfusa
   App offline: vendita al banco, scadenze e ordini. Dati salvati sul telefono (IndexedDB), backup su Drive. */
(function () {
'use strict';

const VERSIONE = '1.6.0';

/* =========================================================
   Utilità
   ========================================================= */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const uid = p => (p || '') + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const MESI = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];

function todayISO(d = new Date()) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function isoToDate(iso) { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); }
function daysUntil(iso) { return Math.round((isoToDate(iso) - isoToDate(todayISO())) / 86400000); }
function fmtDate(iso) { if (!iso) return ''; const [y, m, d] = iso.split('-'); return `${d}/${m}/${y.slice(2)}`; }
function fmtDateLong(iso) { const d = isoToDate(iso); return `${d.getDate()} ${MESI[d.getMonth()]} ${d.getFullYear()}`; }
function fmtEuro(n) { return (n == null || n === '' || isNaN(n)) ? '–' : Number(n).toLocaleString('it-IT', { style: 'currency', currency: 'EUR' }); }
function fmtNum(n) { return String(n).replace('.', ','); }
function relDays(n) {
  if (n === 0) return 'oggi';
  if (n === 1) return 'domani';
  if (n === -1) return 'scaduto ieri';
  return n > 0 ? `tra ${n} giorni` : `scaduto da ${-n} giorni`;
}
function parseNum(s) { if (s == null) return null; const v = parseFloat(String(s).replace(/\s/g, '').replace(',', '.')); return isNaN(v) ? null : v; }

/* Scadenza: 6 cifre ggmmaa, 8 cifre ggmmaaaa, 4 cifre mmaa (= fine mese) */
function parseScadenza(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  let dd, mm, yy, fine = false;
  if (d.length === 6) { dd = +d.slice(0, 2); mm = +d.slice(2, 4); yy = 2000 + +d.slice(4, 6); }
  else if (d.length === 8) { dd = +d.slice(0, 2); mm = +d.slice(2, 4); yy = +d.slice(4, 8); }
  else if (d.length === 4) { mm = +d.slice(0, 2); yy = 2000 + +d.slice(2, 4); fine = true; if (mm < 1 || mm > 12) return null; dd = new Date(yy, mm, 0).getDate(); }
  else return null;
  if (mm < 1 || mm > 12 || dd < 1) return null;
  const dt = new Date(yy, mm - 1, dd);
  if (dt.getMonth() !== mm - 1 || dt.getDate() !== dd) return null;
  return { iso: `${yy}-${pad(mm)}-${pad(dd)}`, fine };
}
function prezzoCalcolato(p) {
  const acq = p.prezzoAcquisto, iva = p.iva;
  if (acq == null || iva == null) return null;
  const ric = p.ricarico || 50;
  return Math.ceil(acq * (1 + ric / 100) * (1 + iva / 100) * 10 - 1e-9) / 10;
}
/* sfuso: il magazzino si conta in kg (in litri per i liquidi); il prezzo di vendita è al kg, all'etto o al litro.
   I prezzi restano salvati al kg (o al litro): l'etto è solo il modo di mostrarli, 1 etto = 1/10 di kg. */
const r3 = x => Math.round((+x || 0) * 1000) / 1000;
const isSfuso = p => !!(p && p.sfuso);
const UNITA = { kg: { al: 'al kg', corto: '/kg', f: 1 }, etto: { al: "all'etto", corto: '/etto', f: 0.1 }, l: { al: 'al litro', corto: '/l', f: 1 } };
const unitaDi = p => isSfuso(p) && UNITA[p.unita] ? p.unita : 'kg';
const inLitri = p => unitaDi(p) === 'l';
function fmtKg(q) {
  q = r3(q);
  if (Math.abs(q) < 1) return `${Math.round(q * 1000)} g`;
  return `${(Math.round(q * 100) / 100).toLocaleString('it-IT', { maximumFractionDigits: 2 })} kg`;
}
function fmtLitri(q) {
  q = r3(q);
  if (Math.abs(q) < 1) return `${Math.round(q * 1000)} ml`;
  const n = Math.round(q * 100) / 100;
  return `${n.toLocaleString('it-IT', { maximumFractionDigits: 2 })} ${n === 1 ? 'litro' : 'litri'}`;
}
const fmtSf = (p, q) => inLitri(p) ? fmtLitri(q) : fmtKg(q);
const fq = (p, q) => isSfuso(p) ? fmtSf(p, q) : `${fmtNum(q)} pz`;
const alKg = p => isSfuso(p) ? ' ' + UNITA[unitaDi(p)].al : '';             // prezzo di vendita
const prezzoBreve = p => { const pr = prezzoVendita(p); return pr == null ? '–' : fmtEuro(perUnita(p, pr)) + (isSfuso(p) ? UNITA[unitaDi(p)].corto : ''); };
const alBase = p => isSfuso(p) ? (inLitri(p) ? ' al litro' : ' al kg') : ''; // prezzo d'acquisto
const nomeBase = p => inLitri(p) ? 'litri' : 'kg';
const perUnita = (p, pr) => pr == null ? null : isSfuso(p) ? Math.round(pr * UNITA[unitaDi(p)].f * 100) / 100 : pr;   // €/kg → €/etto
const nomeSacco = (p, n = 1) => inLitri(p) ? (+n === 1 ? 'tanica' : 'taniche') : (+n === 1 ? 'sacco' : 'sacchi');
const fmtSacchi = (n, p) => `${fmtNum(n)} ${nomeSacco(p, n)}`;
function beep() {
  try { if (navigator.vibrate) navigator.vibrate(40); } catch (e) { }
  try {
    const A = window.AudioContext || window.webkitAudioContext; if (!A) return;
    beep.ctx = beep.ctx || new A();
    const o = beep.ctx.createOscillator(), g = beep.ctx.createGain();
    o.frequency.value = 1320; g.gain.value = 0.06; o.connect(g); g.connect(beep.ctx.destination);
    o.start(); o.stop(beep.ctx.currentTime + 0.07);
  } catch (e) { }
}

/* =========================================================
   Dati (IndexedDB) – tutto in memoria, scrittura immediata
   ========================================================= */
const DB_NAME = 'spesasfusa-magazzino';
const STORES = ['fornitori', 'prodotti', 'lotti', 'ordini', 'sprechi', 'vendite', 'chiusure', 'meta'];
const DATI = ['fornitori', 'prodotti', 'lotti', 'ordini', 'sprechi', 'vendite', 'chiusure'];   // archivi salvati nel backup
let db;
const S = { fornitori: new Map(), prodotti: new Map(), lotti: new Map(), ordini: new Map(), sprechi: new Map(), vendite: new Map(), chiusure: new Map(), meta: {}, coda: new Map() };

function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 4);
    r.onupgradeneeded = () => {
      const d = r.result;
      for (const s of STORES) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: s === 'meta' ? 'key' : 'id' });
      if (!d.objectStoreNames.contains('coda')) d.createObjectStore('coda', { keyPath: 'k' });   // modifiche da mandare agli altri dispositivi
    };
    r.onsuccess = () => { const d = r.result; d.onversionchange = () => { d.close(); location.reload(); }; res(d); };
    r.onerror = () => rej(r.error);
  });
}
function tx(store, fn) {
  return new Promise((res, rej) => {
    const t = db.transaction(store, 'readwrite');
    fn(t.objectStore(store));
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error('Scrittura annullata'));
  });
}
function getAll(store) {
  return new Promise((res, rej) => {
    const r = db.transaction(store, 'readonly').objectStore(store).getAll();
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function loadAll() {
  for (const s of DATI) S[s] = new Map((await getAll(s)).map(o => [o.id, o]));
  S.meta = {}; (await getAll('meta')).forEach(m => { S.meta[m.key] = m.value; });
  S.coda = new Map((await getAll('coda')).map(e => [e.k, e]));
  for (const k of S.coda.keys()) if (k > ultimoK) ultimoK = k;
}
/* ogni scrittura passa da qui: con la sincronizzazione attiva, la modifica entra nella coda
   nella stessa transazione, così non si perde nemmeno se l'app si chiude subito dopo */
async function save(store, obj) {
  const prev = S[store].get(obj.id);
  S[store].set(obj.id, obj);
  const q = codaPer(store, [[prev, obj]]);
  await txConCoda(store, s => s.put(obj), q);
  if (store === 'prodotti') rebuildCodeIndex();
}
async function saveMany(store, arr) {
  const coppie = arr.map(o => [S[store].get(o.id), o]);
  arr.forEach(o => S[store].set(o.id, o));
  const q = codaPer(store, coppie);
  await txConCoda(store, s => arr.forEach(o => s.put(o)), q);
  if (store === 'prodotti') rebuildCodeIndex();
}
async function remove(store, id) {
  const prev = S[store].get(id);
  S[store].delete(id);
  const q = prev && syncAttiva() && SYNC_STORES.includes(store) ? [voceCoda({ st: store, id, del: true })] : [];
  await txConCoda(store, s => s.delete(id), q);
  if (store === 'prodotti') rebuildCodeIndex();
}
async function setMeta(key, value) {
  S.meta[key] = value;
  const q = syncAttiva() && SYNC_META.includes(key) ? [voceCoda({ st: 'meta', id: key, set: { value } })] : [];
  await txConCoda('meta', s => s.put({ key, value }), q);
}
function txConCoda(store, fn, coda) {
  if (!coda.length) return tx(store, fn);
  coda.forEach(e => S.coda.set(e.k, e));
  return new Promise((res, rej) => {
    const t = db.transaction([store, 'coda'], 'readwrite');
    fn(t.objectStore(store));
    const c = t.objectStore('coda'); coda.forEach(e => c.put(e));
    t.oncomplete = () => { res(); syncPresto(); };
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error('Scrittura annullata'));
  });
}
/* cosa è cambiato in un record: solo i campi diversi; per le confezioni la quantità va come differenza */
let ultimoK = 0;
const voceCoda = e => { ultimoK = Math.max(Date.now() * 1000, ultimoK + 1); return { k: ultimoK, ...e }; };
function codaPer(store, coppie) {
  if (!syncAttiva() || !SYNC_STORES.includes(store)) return [];
  const out = [];
  for (const [prev, obj] of coppie) {
    const set = {}; let dq = 0, n = 0;
    const chiavi = new Set([...Object.keys(obj), ...(prev ? Object.keys(prev) : [])]);
    for (const k of chiavi) {
      if (k[0] === '_') continue;    // campi solo di questo dispositivo
      if (store === 'lotti' && k === 'quantita') { dq = r3((+obj.quantita || 0) - (prev ? +prev.quantita || 0 : 0)); continue; }
      const a = prev ? prev[k] : undefined, b = obj[k];
      if (!prev || JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) { set[k] = b ?? null; n++; }
    }
    if (n || dq) out.push(voceCoda({ st: store, id: obj.id, set, dq }));
  }
  return out;
}

const DEFAULT_SETTINGS = { soglie: { preferibilmente: [7, 15, 30], entro: [2, 5, 10] }, negozio: 'La Spesa Sfusa', avanzoSfuso: 5 };
function settings() {
  const s = S.meta.settings || {};
  return { negozio: s.negozio || DEFAULT_SETTINGS.negozio, soglie: Object.assign({}, DEFAULT_SETTINGS.soglie, s.soglie || {}), avanzoSfuso: s.avanzoSfuso ?? DEFAULT_SETTINGS.avanzoSfuso };
}
/* sfuso: quanto può restare in un sacco (polvere, pesate) prima di considerarlo finito */
function tolleranza(p) { return isSfuso(p) && p.pesoSacco ? r3(p.pesoSacco * settings().avanzoSfuso / 100) : 0; }

/* ---------- indici e calcoli ---------- */
let codeIndex = new Map();
function rebuildCodeIndex() { codeIndex = new Map(); for (const p of S.prodotti.values()) for (const c of (p.codici || [])) codeIndex.set(String(c), p.id); }
const prodotto = id => S.prodotti.get(id);
const fornitore = id => S.fornitori.get(id);
const nomeForn = id => { const f = fornitore(id); return f ? f.nome : 'Senza fornitore'; };
function byCode(code) { const id = codeIndex.get(String(code)); return id ? prodotto(id) : null; }
const lottiAttivi = () => [...S.lotti.values()].filter(l => l.stato === 'attivo');
function soglie(tipo) { const s = settings().soglie; return s[tipo] || s.preferibilmente; }
function fascia(l) {
  if (!l.scadenza) return 'nessuna';
  const d = daysUntil(l.scadenza);
  const p = prodotto(l.prodottoId);
  const [a, b, c] = soglie(p ? p.tipoScadenza : 'preferibilmente');
  if (d < 0) return 'scaduto';
  if (d <= a) return 'rosso';
  if (d <= b) return 'arancio';
  if (d <= c) return 'giallo';
  return 'ok';
}
const ordineAperto = fid => [...S.ordini.values()].find(o => o.fornitoreId === fid && o.stato === 'aperto');
const ordiniInviati = () => [...S.ordini.values()].filter(o => o.stato === 'inviato').sort((a, b) => (a.inviato || '').localeCompare(b.inviato || ''));
function ultimoOrdine(pid) {
  let best = null;
  for (const o of S.ordini.values()) {
    if (o.stato === 'aperto' || !o.inviato) continue;
    const r = o.righe.find(r => r.prodottoId === pid);
    if (r && (!best || o.inviato > best.data)) best = { qta: r.qta, data: o.inviato };
  }
  return best;
}
const giacenza = pid => r3(lottiAttivi().filter(l => l.prodottoId === pid).reduce((s, l) => s + (+l.quantita || 0), 0));
const nameNorm = new WeakMap();
function cerca(q, { fornitoreId = '', limit = 60, soloSenzaCodice = false, soloSfuso = false } = {}) {
  const nq = norm(q), words = nq ? nq.split(' ') : [], code = String(q || '').trim();
  const out = [];
  for (const p of S.prodotti.values()) {
    if (fornitoreId && p.fornitoreId !== fornitoreId) continue;
    if (soloSenzaCodice && (p.codici || []).length) continue;
    if (soloSfuso && !p.sfuso) continue;
    if (!words.length) { out.push([p, 1]); continue; }
    if (code && (p.codici || []).includes(code)) { out.push([p, -1]); continue; }
    let n = nameNorm.get(p); if (!n) { n = norm(p.nome); nameNorm.set(p, n); }
    if (words.every(w => n.includes(w))) out.push([p, n.startsWith(words[0]) ? 0 : 1]);
  }
  out.sort((a, b) => a[1] - b[1] || a[0].nome.localeCompare(b[0].nome, 'it'));
  return { total: out.length, items: out.slice(0, limit).map(x => x[0]) };
}

/* =========================================================
   Interfaccia: messaggi, finestre, conferme
   ========================================================= */
let toastTimer;
function toast(msg, { err = false, action = null, ms = 3200 } = {}) {
  const t = $('#toast');
  t.className = err ? 'err' : '';
  t.innerHTML = `<span>${esc(msg)}</span>${action ? `<button type="button">${esc(action.label)}</button>` : ''}`;
  t.hidden = false;
  if (action) t.querySelector('button').onclick = () => { t.hidden = true; action.run(); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, action ? 6500 : (err ? 4500 : ms));
}
const modal = $('#modal');
let modalScan = null, modalOnClose = null;
function openModal(html, mount, { onScan = null, onClose = null } = {}) {
  stopCamera();
  const prev = modalOnClose; modalOnClose = null; if (prev) prev();
  $('#modalBody').innerHTML = html;
  modalScan = onScan; modalOnClose = onClose;
  if (!modal.open) modal.showModal();
  const corpo = $('#modalBody'); corpo.setAttribute('tabindex', '-1'); corpo.focus({ preventScroll: true });
  if (mount) mount(corpo);
}
/* la pulizia è immediata: l'evento "close" del browser arriva dopo e non deve
   cancellare una finestra aperta subito dopo (es. collega codice → scheda rapida) */
function pulisciModal() {
  stopCamera(); $('#modalBody').innerHTML = ''; modalScan = null;
  const cb = modalOnClose; modalOnClose = null; if (cb) cb();
  if (SYNC.ridisegna) setTimeout(() => { if (SYNC.ridisegna && !modal.open) aggiornaVista(); }, 0);
}
function closeModal() {
  if (modal.open) modal.close();
  pulisciModal();
}
modal.addEventListener('close', () => { if (modal.open) return; if ($('#modalBody').innerHTML) pulisciModal(); });
modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
const mhead = title => `<div class="modal-head"><h2>${esc(title)}</h2><button class="modal-close" type="button" data-act="close-modal" aria-label="Chiudi">×</button></div>`;
function confirmBox(text, { ok = 'Conferma', danger = false, title = 'Conferma' } = {}) {
  return new Promise(res => {
    let done = false;
    openModal(`${mhead(title)}<p>${esc(text)}</p>
      <div class="btn-grid" style="grid-template-columns:1fr 1fr"><button class="btn" type="button" data-x="no">Annulla</button><button class="btn ${danger ? 'danger' : 'primary'}" type="button" data-x="ok">${esc(ok)}</button></div>`,
      b => {
        b.querySelector('[data-x=no]').onclick = () => { done = true; closeModal(); res(false); };
        b.querySelector('[data-x=ok]').onclick = () => { done = true; closeModal(); res(true); };
      }, { onClose: () => { if (!done) res(false); } });
  });
}

/* due scelte; risolve true (si), false (no) o null (finestra chiusa) */
function sceltaBox(text, { si, no, title = 'Scegli' }) {
  return new Promise(res => {
    let done = false;
    openModal(`${mhead(title)}<p>${esc(text)}</p>
      <div class="stack"><button class="btn primary block" type="button" data-x="si">${esc(si)}</button><button class="btn block" type="button" data-x="no">${esc(no)}</button></div>`,
      b => {
        b.querySelector('[data-x=si]').onclick = () => { done = true; closeModal(); res(true); };
        b.querySelector('[data-x=no]').onclick = () => { done = true; closeModal(); res(false); };
      }, { onClose: () => { if (!done) res(null); } });
  });
}

/* =========================================================
   Lettore di codici a barre
   - lettore Bluetooth: si comporta come una tastiera e manda "Invio"
   - fotocamera: BarcodeDetector di Chrome per Android
   ========================================================= */
const SC = { chars: '', times: [], field: null, before: null, timer: null };
const tastiRicevuti = [];   // per la schermata "Prova del lettore"
function resetSC() { clearTimeout(SC.timer); SC.chars = ''; SC.times = []; SC.field = null; SC.before = null; }
function confermaScan() {
  const code = SC.chars, field = SC.field, before = SC.before;
  resetSC();
  if (field && before !== null) { field.value = before; field.dispatchEvent(new Event('input', { bubbles: true })); }
  onScan(code);
}
const isTextField = t => t && (t.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit', 'file'].includes(t.type) || t.tagName === 'TEXTAREA' || t.isContentEditable);
document.addEventListener('keydown', e => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const now = performance.now();
  const field = isTextField(e.target) ? e.target : null;
  const prec = SC.times.length ? SC.times[SC.times.length - 1] : null;
  tastiRicevuti.push(`${e.key === 'Enter' ? '⏎' : e.key === 'Tab' ? '⇥' : e.key.length === 1 ? e.key : '[' + e.key + ']'}`);
  if (tastiRicevuti.length > 60) tastiRicevuti.shift();
  aggiornaDiagnosi();
  if (prec !== null && now - prec > 300) resetSC();
  if (e.key === 'Enter' || e.key === 'Tab') {
    const n = SC.chars.length;
    const avg = n > 1 ? (SC.times[n - 1] - SC.times[0]) / (n - 1) : 999;
    if (n >= 4 && (field ? avg < 80 : true)) { e.preventDefault(); e.stopPropagation(); confermaScan(); return; }
    resetSC(); return;
  }
  if (e.key && e.key.length === 1) {
    if (!SC.chars) { SC.field = field; SC.before = field ? field.value : null; }
    SC.chars += e.key; SC.times.push(now);
    if (!field) {
      e.preventDefault();
      // lettori che non mandano "Invio": se arrivano almeno 8 cifre e poi silenzio, è un codice
      clearTimeout(SC.timer);
      SC.timer = setTimeout(() => { if (/^\d{8,}$/.test(SC.chars)) confermaScan(); else resetSC(); }, 400);
    }
  }
}, true);
function aggiornaDiagnosi() {
  const el = document.getElementById('diagTasti');
  if (el) el.textContent = tastiRicevuti.join(' ') || '—';
}

let camStream = null, camTimer = null;
async function openCamera() {
  if (!('BarcodeDetector' in window)) { toast('Su questo dispositivo la fotocamera non legge i codici: usa il lettore o scrivi il codice', { err: true }); return; }
  const voluti = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'qr_code'];
  let det;
  try {
    let sup = []; try { sup = await BarcodeDetector.getSupportedFormats(); } catch (e) { }
    const f = voluti.filter(x => sup.includes(x));
    det = f.length ? new BarcodeDetector({ formats: f }) : new BarcodeDetector();
  } catch (e) {
    try { det = new BarcodeDetector(); }
    catch (e2) { toast('La fotocamera di questo telefono non riesce a leggere i codici: usa "Scrivi codice"', { err: true }); return; }
  }
  openModal(`${mhead('Inquadra il codice a barre')}<div class="video-wrap"><video id="camVideo" playsinline muted></video></div>
    <div class="row"><p class="faint spacer" style="margin:0" id="camMsg">Tieni il codice dentro il riquadro, ben fermo e con buona luce.</p><button class="btn small" type="button" id="camTorch" hidden>Luce</button></div>
    <button class="btn block" type="button" data-act="scrivi-codice">Non legge? Scrivi il codice</button>`, async b => {
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false }); }
    catch (e) { closeModal(); toast('Non riesco ad aprire la fotocamera: controlla i permessi di Chrome', { err: true }); return; }
    const v = b.querySelector('#camVideo');
    if (!v || !modal.open) { stream.getTracks().forEach(t => t.stop()); return; }
    camStream = stream;
    const track = stream.getVideoTracks()[0];
    try {
      const caps = track.getCapabilities ? track.getCapabilities() : {};
      if (caps.focusMode && caps.focusMode.includes('continuous')) await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
      if (caps.torch) {
        const tb = b.querySelector('#camTorch'); let on = false; tb.hidden = false;
        tb.onclick = async () => { on = !on; try { await track.applyConstraints({ advanced: [{ torch: on }] }); tb.textContent = on ? 'Spegni luce' : 'Luce'; } catch (e) { } };
      }
    } catch (e) { }
    v.srcObject = stream; await v.play().catch(() => { });
    let ultimo = null, volte = 0;
    const inizio = Date.now();
    const tick = async () => {
      if (camStream && Date.now() - inizio > 9000) { const m = b.querySelector('#camMsg'); if (m) m.textContent = 'Non riesco a leggerlo: prova ad avvicinarti o allontanarti un po\', con più luce. Oppure scrivi il codice.'; }
      if (!camStream) return;
      try {
        const r = await det.detect(v);
        if (!camStream) return;
        if (r && r.length) {
          const code = r[0].rawValue;
          if (code === ultimo) volte++; else { ultimo = code; volte = 1; }
          if (volte >= 2) { closeModal(); onScan(code); return; }   // stesso codice letto due volte: niente letture sbagliate
        }
      } catch (e) { }
      camTimer = setTimeout(tick, 120);
    };
    tick();
  });
}
function stopCamera() { clearTimeout(camTimer); if (camStream) { camStream.getTracks().forEach(t => t.stop()); camStream = null; } }

let ultimoCodice = '';
document.addEventListener('pointerdown', e => { const t = $('#toast'); if (!t.hidden && !t.contains(e.target)) t.hidden = true; }, true);
function onScan(code) {
  code = String(code || '').trim();
  if (!code) return;
  $('#toast').hidden = true;
  ultimoCodice = code;
  beep();
  if (modal.open && modalScan) { modalScan(code); return; }
  if (modal.open) closeModal();
  if (current.onScan) { current.onScan(code); return; }
  scanGenerico(code);
}
function scanGenerico(code) {
  const p = byCode(code);
  if (p) schedaRapida(p); else collegaCodice(code, schedaRapida);
}
function scriviCodice() {
  openModal(`${mhead('Scrivi il codice')}
    <label class="field">Numeri sotto il codice a barre<input type="text" inputmode="numeric" id="mCode" autocomplete="off"></label>
    <button class="btn primary block" type="button" id="mCodeOk">Cerca</button>`, b => {
    const i = b.querySelector('#mCode'); i.focus();
    const go = () => { const v = i.value.trim(); if (v.length < 4) { toast('Scrivi almeno 4 cifre', { err: true }); return; } closeModal(); onScan(v); };
    b.querySelector('#mCodeOk').onclick = go;
    i.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
  });
}

/* ---------- scegliere un prodotto / collegare un codice ---------- */
function rigaProdotto(p, act) {
  const g = giacenza(p.id);
  return `<button class="item" type="button" data-act="${act}" data-id="${esc(p.id)}">
    <div class="main"><div class="name">${esc(p.nome)}</div>
    <div class="sub">${esc(nomeForn(p.fornitoreId))}${p.formato ? ' · ' + esc(p.formato) : ''}${g ? ' · in negozio ' + fq(p, g) : ''}</div></div>
    ${p.sfuso ? '<span class="tag sfuso">sfuso</span>' : ''}${(p.codici || []).length ? '<span class="tag ok">codice</span>' : ''}</button>`;
}
function pickerModal({ title, intro = '', code = null, onPick }) {
  let q = '';
  const draw = b => {
    const res = cerca(q, { limit: 40 });
    b.querySelector('#pkList').innerHTML = res.items.length
      ? res.items.map(p => rigaProdotto(p, 'pk-pick')).join('') + (res.total > res.items.length ? `<div class="item faint">Altri ${res.total - res.items.length}: scrivi di più per restringere</div>` : '')
      : `<div class="empty">Nessun prodotto trovato.</div>`;
  };
  openModal(`${mhead(title)}${intro}
    <input type="search" id="pkQ" placeholder="Cerca per nome, es. mozzarella bufala" autocomplete="off">
    <div class="list" id="pkList"></div>
    <button class="btn block" type="button" id="pkNew">+ Nuovo prodotto${code ? ' con questo codice' : ''}</button>`, b => {
    const i = b.querySelector('#pkQ');
    i.addEventListener('input', () => { q = i.value; draw(b); });
    draw(b);
    b.querySelector('#pkList').addEventListener('click', async e => {
      const el = e.target.closest('[data-act=pk-pick]'); if (!el) return;
      e.stopPropagation();
      const p = prodotto(el.dataset.id);
      if (code) {
        const prima = byCode(code);
        if (prima && prima.id !== p.id) await save('prodotti', { ...prima, codici: (prima.codici || []).filter(c => c !== code) });
        const np = { ...p, codici: [...new Set([...(p.codici || []), code])] };
        await save('prodotti', np); closeModal(); toast(`Codice collegato a ${np.nome}`); onPick(np);
      } else { closeModal(); onPick(p); }
    });
    b.querySelector('#pkNew').onclick = () => nuovoProdottoModal({ code, nome: q, onDone: onPick });
    setTimeout(() => i.focus(), 50);
  }, { onScan: c => { const p = byCode(c); closeModal(); if (p) onPick(p); else collegaCodice(c, onPick); } });
}
function collegaCodice(code, onPick) {
  pickerModal({
    title: 'Codice nuovo', code, onPick,
    intro: `<div class="notice"><span>Il codice <b>${esc(code)}</b> non è ancora collegato a un prodotto. Cerca il prodotto qui sotto: la prossima volta lo riconosco da solo.</span></div>`
  });
}
function nuovoProdottoModal({ code = null, nome = '', fornitoreId = '', onDone }) {
  const forn = [...S.fornitori.values()].sort((a, b) => a.nome.localeCompare(b.nome, 'it'));
  const last = fornitoreId || S.meta.ultimoFornitore || '';
  openModal(`${mhead('Nuovo prodotto')}
    ${code ? `<div class="faint">Codice: ${esc(code)}</div>` : ''}
    <label class="field">Nome<input type="text" id="npNome" value="${esc(nome)}" autocomplete="off"></label>
    <label class="field">Fornitore<select id="npForn"><option value="">— scegli —</option>${forn.map(f => `<option value="${esc(f.id)}" ${f.id === last ? 'selected' : ''}>${esc(f.nome)}</option>`).join('')}</select></label>
    <label class="field">Formato <span class="hint">es. 500 g, 1 l, 6 pz</span><input type="text" id="npFormato" autocomplete="off"></label>
    <label class="field">Tipo di scadenza<select id="npTipo"><option value="preferibilmente">Preferibilmente entro (secchi, conserve)</option><option value="entro">Da consumarsi entro (freschi)</option></select></label>
    <label class="check"><input type="checkbox" id="npSfuso"> Sfuso (a peso o alla spina)</label>
    <div class="stack" id="npSaccoBox" hidden>
      ${campoUnita('npUnita', 'kg')}
      <label class="field"><span data-sacco-lab>${testoSacco('kg')}</span> <span class="hint" data-sacco-hint>${hintSacco('kg')}</span><input type="text" inputmode="decimal" id="npSacco" autocomplete="off"></label>
      ${code ? '' : `<label class="check"><input type="checkbox" id="npCrea" checked> Crea il codice a barre e stampa l'etichetta</label>`}
    </div>
    <button class="btn primary block" type="button" id="npSave">Crea prodotto</button>`, b => {
    b.querySelector('#npNome').focus();
    b.querySelector('#npSfuso').addEventListener('change', e => { b.querySelector('#npSaccoBox').hidden = !e.target.checked; });
    b.querySelector('#npUnita').addEventListener('change', e => aggiornaTestiSacco(b, e.target.value));
    b.querySelector('#npSave').onclick = async () => {
      const n = b.querySelector('#npNome').value.trim();
      if (!n) { toast('Scrivi il nome del prodotto', { err: true }); return; }
      const fid = b.querySelector('#npForn').value;
      const sf = b.querySelector('#npSfuso').checked, sacco = parseNum(b.querySelector('#npSacco').value);
      const crea = sf && !code && b.querySelector('#npCrea').checked;
      const codici = code ? [code] : crea ? [await codiceInterno()] : [];
      const p = { id: uid('p'), nome: n, fornitoreId: fid, categoria: '', formato: b.querySelector('#npFormato').value.trim(), prezzoAcquisto: null, iva: null, prezzoVendita: null, prezzoManuale: null, ricarico: 50, codici, tipoScadenza: b.querySelector('#npTipo').value, note: '', origine: 'Creato nell\'app', sfuso: sf, unita: sf ? b.querySelector('#npUnita').value : undefined, pesoSacco: sf && sacco > 0 ? sacco : null };
      if (code) { const prima = byCode(code); if (prima) await save('prodotti', { ...prima, codici: prima.codici.filter(c => c !== code) }); }
      await save('prodotti', p); if (fid) await setMeta('ultimoFornitore', fid);
      closeModal(); toast(`Creato: ${p.nome}`); onDone && onDone(p);
      if (crea) etichettaPronta(p.id);
    };
  });
}
/* campi dello sfuso, uguali nel nuovo prodotto e nella scheda */
const campoUnita = (id, u) => `<label class="field">Si vende<select id="${id}">${[['kg', 'al kg'], ['etto', "all'etto"], ['l', 'al litro (detersivi alla spina)']].map(([v, t]) => `<option value="${v}" ${u === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label>`;
const testoSacco = u => u === 'l' ? 'Litri della tanica' : 'Peso del sacco in kg';
const hintSacco = u => u === 'l' ? 'come arriva dal fornitore, es. 5 o 25' : 'come arriva dal fornitore, es. 5 · 1 per la frutta secca';
function aggiornaTestiSacco(b, u) {
  $$('[data-sacco-lab]', b).forEach(x => { x.textContent = testoSacco(u); });
  $$('[data-sacco-hint]', b).forEach(x => { x.textContent = hintSacco(u); });
}
/* etichetta da stampare subito dopo aver creato il codice: si apre la finestra di stampa,
   oppure, se c'è già un'altra finestra aperta (banco, arrivi), un avviso con «Stampa» */
function etichettaPronta(pid) {
  setTimeout(() => {
    const p = prodotto(pid); if (!p) return;
    if (modal.open) toast(`Codice creato per ${p.nome}`, { ms: 8000, action: { label: 'Stampa etichetta', run: () => stampaModal([p.id], { titolo: 'Etichetta pronta' }) } });
    else stampaModal([p.id], { titolo: 'Etichetta pronta' });
  }, 350);
}
function schedaRapida(p) {
  const lotti = lottiAttivi().filter(l => l.prodottoId === p.id).sort((a, b) => (a.scadenza || '9').localeCompare(b.scadenza || '9'));
  const u = ultimoOrdine(p.id);
  openModal(`${mhead(p.nome)}
    <div class="faint">${esc(nomeForn(p.fornitoreId))}${p.formato ? ' · ' + esc(p.formato) : ''}${p.sfuso ? ' · sfuso' + (p.pesoSacco ? `, ${nomeSacco(p, 2)} da ${fmtSf(p, p.pesoSacco)}` : '') : ''}</div>
    ${lotti.length ? `<div class="list">${lotti.map(l => rigaConfezione(l)).join('')}</div>` : '<div class="faint">Nessuna confezione registrata in negozio.</div>'}
    ${u ? `<div class="faint">Ultimo ordine: ${p.sfuso ? fmtSacchi(u.qta, p) : fmtNum(u.qta)} il ${fmtDate(u.data)}</div>` : ''}
    <div class="stack">
      <button class="btn primary block" type="button" data-act="sr-carico" data-id="${esc(p.id)}">Arrivo merce</button>
      <button class="btn block" type="button" data-act="sr-ordina" data-id="${esc(p.id)}">Aggiungi all'ordine</button>
      <a class="btn ghost block" href="#prodotto/${encodeURIComponent(p.id)}" data-act="close-modal-link">Apri la scheda</a>
    </div>`);
}

const ICO_MATITA = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';
function rigaConfezione(l, { arrivo = false, togli = false } = {}) {
  return `<div class="item" style="flex-wrap:wrap"><div class="main tappable" style="flex:1 1 60%" data-act="lot-modifica" data-id="${esc(l.id)}" role="button" tabindex="0"><div class="name">${l.scadenza ? 'Scade ' + fmtDate(l.scadenza) : 'Senza scadenza'} · ${fq(prodotto(l.prodottoId), l.quantita)}</div>
    <div class="sub">${l.scadenza ? relDays(daysUntil(l.scadenza)) : 'tocca Modifica per scrivere la data'}${arrivo && l.arrivo ? ' · ' + ({ inventario: 'contato', reso: 'reso del cliente' }[l.origine] || 'arrivato') + ' il ' + fmtDate(l.arrivo) : ''}${l.gestito ? ' · ' + esc(l.nota || 'gestito') : ''}</div></div>
    <div class="conf-acts">
      <button class="btn small" type="button" data-act="lot-modifica" data-id="${esc(l.id)}">${ICO_MATITA} Modifica</button>
      ${togli ? `<button class="btn small ghost" type="button" data-act="lotto-annulla" data-id="${esc(l.id)}">Togli</button>` : `<button class="btn small" type="button" data-act="lot-esaurito" data-id="${esc(l.id)}">Esaurito</button><button class="btn small danger" type="button" data-act="lot-buttato" data-id="${esc(l.id)}">Buttato</button>`}
    </div></div>`;
}

/* =========================================================
   Navigazione
   ========================================================= */
let current = { name: 'home', arg: null, onScan: null, back: null };
const routes = {};
function route() {
  const h = decodeURIComponent((location.hash || '#home').slice(1));
  const i = h.indexOf('/');
  const name = i < 0 ? h : h.slice(0, i), arg = i < 0 ? null : h.slice(i + 1);
  current = { name: routes[name] ? name : 'home', arg, onScan: null, back: null };
  if (modal.open) closeModal();
  $('#toast').hidden = true;
  render(true);
}
function render(scrollTop = false) {
  current.fresh = !!scrollTop; SYNC.ridisegna = false;
  const r = routes[current.name](current.arg) || {};
  $('#viewTitle').textContent = r.title || 'Magazzino';
  document.title = (r.title ? r.title + ' – ' : '') + 'Magazzino';
  $('#view').innerHTML = r.html || '';
  current.onScan = r.onScan || null;
  current.back = r.back || null;
  $('#backBtn').hidden = !r.back;
  $$('.tabbar a').forEach(a => a.classList.toggle('on', a.dataset.tab === (r.tab || current.name)));
  if (r.mount) r.mount($('#view'));
  aggiornaBadge();
  if (scrollTop) window.scrollTo(0, 0);
}
function aggiornaBadge() {
  const urg = lottiAttivi().filter(l => !l.gestito && ['scaduto', 'rosso'].includes(fascia(l))).length;
  const b1 = $('#badgeScad'); b1.hidden = !urg; b1.textContent = urg;
  const righe = [...S.ordini.values()].filter(o => o.stato === 'aperto').reduce((s, o) => s + o.righe.length, 0);
  const b2 = $('#badgeOrd'); b2.hidden = !righe; b2.textContent = righe;
}
window.addEventListener('hashchange', route);

const scanIcon = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8V5h3M17 5h3v3M20 16v3h-3M7 19H4v-3M7 9v6M10 9v6M13 9v6M16 9v6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
function scanbox(title, sub, cercaAct) {
  return `<div class="scanbox"><div class="pulse">${scanIcon}</div><strong>${esc(title)}</strong><div class="faint">${esc(sub)}</div>
    <div class="row"><button class="btn small" type="button" data-act="${cercaAct}">Cerca per nome</button>
    <button class="btn small" type="button" data-act="camera">Fotocamera</button>
    <button class="btn small" type="button" data-act="scrivi-codice">Scrivi codice</button></div></div>`;
}
const tagTipo = p => p && p.tipoScadenza === 'entro' ? '<span class="tag fresh">fresco</span>' : '';

/* =========================================================
   HOME
   ========================================================= */
let installPrompt = null;
routes.home = () => {
  const att = lottiAttivi().filter(l => l.scadenza && !l.gestito);
  const scad = att.filter(l => fascia(l) === 'scaduto').length;
  const presto = att.filter(l => ['rosso', 'arancio'].includes(fascia(l))).length;
  const aperti = [...S.ordini.values()].filter(o => o.stato === 'aperto');
  const righe = aperti.reduce((s, o) => s + o.righe.length, 0);
  const inviati = ordiniInviati().length;
  const lb = S.meta.lastBackup;
  const giorniBk = lb ? daysUntil(lb.slice(0, 10)) * -1 : null;
  let html = '';
  if (!S.prodotti.size) {
    html += `<div class="card"><h2>Benvenuta! Per iniziare carica il catalogo</h2>
      <p class="muted small">Scegli il file <b>catalogo_iniziale.json</b> (dai listini) salvato su Drive o sul telefono. Si fa una volta sola.</p>
      <button class="btn primary block" type="button" data-act="import-catalogo">Carica il catalogo</button>
      <button class="btn ghost block" type="button" data-act="ripristina">Ho già un backup: ripristina</button></div>`;
  }
  html += `<div class="stats">
    <a class="stat ${scad ? 'red' : ''}" href="#scadenze/scaduti"><b>${scad}</b><span>Scaduti</span></a>
    <a class="stat ${presto ? 'orange' : ''}" href="#scadenze/urgenti"><b>${presto}</b><span>In scadenza a breve</span></a>
    <a class="stat ${righe ? 'green' : ''}" href="#ordini"><b>${righe}</b><span>Da ordinare${aperti.length ? ` · ${aperti.length} fornitori` : ''}</span></a>
    <a class="stat" href="#ordini"><b>${inviati}</b><span>Ordini in arrivo</span></a></div>`;
  html += `<div class="btn-grid">
    <a class="big-btn accent" href="#carico">Arrivo merce<small>Scansiona e scrivi la scadenza</small></a>
    <a class="big-btn" href="#scadenze">Scadenze<small>Cosa scade e cosa fare</small></a>
    <a class="big-btn" href="#ordini">Da ordinare<small>Giro con il lettore e invio</small></a>
    <a class="big-btn" href="#carico/inventario">Inventario<small>Conta quello che c'è già</small></a></div>`;
  const rv = venditeDel(todayISO());
  if (rv.length) html += `<a class="card tight" href="#banco" style="text-decoration:none"><div class="row"><div class="spacer"><b>Banco di oggi</b><div class="faint small">${totaleQta(rv, v => v.tipo === 'reso' ? -1 : 1)} · ${fmtEuro(rv.reduce((t, v) => t + (importo(v) || 0), 0))}</div></div><span class="chev">›</span></div></a>`;
  const spm = sprechiPeriodo('mese').filter(perso);
  if (spm.length) html += `<a class="card tight" href="#sprechi" style="text-decoration:none"><div class="row"><div class="spacer"><b>Sprechi di questo mese</b><div class="faint small">${totaleQta(spm)} · ${fmtEuro(spm.reduce((t, r) => t + (valoreSpreco(r) || 0), 0))}</div></div><span class="chev">›</span></div></a>`;
  html += `<div class="faint" style="text-align:center">Puoi anche scansionare un prodotto in qualsiasi momento per vedere cosa fare.</div>`;
  const warn = giorniBk == null || giorniBk >= 3;
  html += `<div class="notice ${warn ? 'red' : 'green'}"><div class="spacer">${giorniBk == null ? '<b>Nessun backup ancora.</b> Fallo ogni giorno a fine lavoro.' : giorniBk === 0 ? 'Backup fatto oggi.' : `Ultimo backup: <b>${giorniBk === 1 ? 'ieri' : giorniBk + ' giorni fa'}</b>.`}</div>
    <button class="btn small ${warn ? 'primary' : ''}" type="button" data-act="backup">Fai backup</button></div>`;
  if (installPrompt) html += `<button class="btn block" type="button" data-act="installa">Installa l'app sul telefono</button>`;
  if (syncAttiva()) html += `<div id="syncStato" class="sync-stato" style="text-align:center">${esc(testoStato())}</div>`;
  html += `<div class="faint small" style="text-align:center">Versione ${VERSIONE}</div>`;
  return { title: settings().negozio, html, tab: 'home' };
};

/* =========================================================
   ARRIVO MERCE / INVENTARIO
   ========================================================= */
let CS = nuovoCarico('arrivo');
function nuovoCarico(modo) { return { pid: null, qta: '1', scad: '', senza: false, field: 'scad', qtaFresh: true, modo, unita: 'pz' }; }
/* carico aperto su un prodotto: lo sfuso si conta a sacchi all'arrivo, in kg all'inventario */
function caricoPer(p, modo) {
  const c = nuovoCarico(modo); c.pid = p.id;
  if (isSfuso(p)) { c.unita = modo === 'arrivo' && p.pesoSacco ? 'sacchi' : 'kg'; if (c.unita === 'kg') c.qta = ''; }
  return c;
}
function qtaCarico(p) {
  if (!isSfuso(p)) { const n = parseInt(CS.qta, 10) || 0; return { q: n, ordine: n }; }
  if (CS.unita === 'sacchi') { const n = parseInt(CS.qta, 10) || 0; return { q: r3(n * p.pesoSacco), sacchi: n, ordine: n }; }
  const k = r3(parseNum(CS.qta) || 0);
  return { q: k, ordine: p.pesoSacco ? r3(k / p.pesoSacco) : k };
}
/* totale di una lista di righe con prodotti a pezzi e sfusi: "6 pz · 1,25 kg" */
function totaleQta(righe, segno = () => 1) {
  let pz = 0, kg = 0, l = 0;
  for (const r of righe) { const p = prodotto(r.prodottoId), q = (+r.qta || 0) * segno(r); if (!isSfuso(p)) pz += q; else if (inLitri(p)) l += q; else kg += q; }
  const out = [];
  if (pz || (!kg && !l)) out.push(`${fmtNum(pz)} pz`);
  if (kg) out.push(fmtKg(kg));
  if (l) out.push(fmtLitri(l));
  return out.join(' · ');
}
function infoOrdine(p) {
  const o = ordiniInviati().find(o => o.fornitoreId === p.fornitoreId && o.righe.some(r => r.prodottoId === p.id));
  if (!o) return null;
  const r = o.righe.find(r => r.prodottoId === p.id);
  return { o, qta: r.qta, ric: r.ricevuto || 0 };
}
function fmtScadDigits(d) {
  const ph = 'ggmmaa';
  let s = '';
  for (let i = 0; i < 6; i++) { s += i < d.length ? d[i] : `<span style="color:#B5BCAD">${ph[i]}</span>`; if (i === 1 || i === 3) s += '/'; }
  if (d.length > 6) s = `${d.slice(0, 2)}/${d.slice(2, 4)}/${d.slice(4)}`;
  return s;
}
function anteprimaScad() {
  if (CS.senza) return { t: 'Senza scadenza', err: false };
  const d = CS.scad;
  if (!d.length) return { t: 'Scrivi la data con i tasti qui sotto', err: false, faint: true };
  if (d.length === 4) {
    const r = parseScadenza(d), anno = +d.slice(2), ora = new Date().getFullYear() % 100;
    if (r && anno >= ora - 1) return { t: `Solo mese e anno: fine ${fmtDateLong(r.iso).split(' ').slice(1).join(' ')} · oppure continua a scrivere`, err: false };
    return { t: 'Continua: mancano le 2 cifre dell\'anno', err: false, faint: true };
  }
  if (d.length === 6 || d.length === 8) { const r = parseScadenza(d); return r ? { t: `${fmtDateLong(r.iso)} · ${relDays(daysUntil(r.iso))}`, err: daysUntil(r.iso) < 0 } : { t: 'Data non valida', err: true }; }
  return { t: '', err: false };
}
routes.carico = arg => {
  if (arg === 'inventario' && CS.modo !== 'inventario' && !CS.pid) CS = nuovoCarico('inventario');
  if (arg !== 'inventario' && CS.modo === 'inventario' && !CS.pid && arg !== 'keep') CS = nuovoCarico('arrivo');
  const inv = CS.modo === 'inventario';
  const p = CS.pid ? prodotto(CS.pid) : null;
  let html = `<div class="segmented"><button type="button" data-act="modo" data-m="arrivo" class="${inv ? '' : 'on'}">Arrivo merce</button><button type="button" data-act="modo" data-m="inventario" class="${inv ? 'on' : ''}">Inventario</button></div>`;
  if (!p) {
    html += scanbox(inv ? 'Scansiona un prodotto sullo scaffale' : 'Scansiona il prodotto arrivato', 'Se non ha codice, cercalo per nome.', 'carico-cerca');
  } else {
    const info = inv ? null : infoOrdine(p);
    const pr = anteprimaScad();
    const kgMode = p.sfuso && CS.unita === 'kg', virgola = kgMode && CS.field === 'qta';
    html += `<div class="card">
      <div class="row"><div class="spacer"><h2>${esc(p.nome)}</h2><div class="faint">${esc(nomeForn(p.fornitoreId))}${p.formato ? ' · ' + esc(p.formato) : ''}</div></div>${tagTipo(p)}</div>
      ${info ? `<div class="notice green"><span>In ordine: <b>${p.sfuso ? fmtSacchi(info.qta, p) : fmtNum(info.qta)}</b> · già arrivati <b>${fmtNum(r3(info.ric))}</b></span></div>` : ''}
      ${p.sfuso && !p.pesoSacco && !inv ? `<div class="notice"><span>Sfuso senza ${inLitri(p) ? 'litri della tanica' : 'peso del sacco'}: scrivi i <b>${nomeBase(p)}</b>. Per contare a ${nomeSacco(p, 2)}, scrivi ${inLitri(p) ? 'i litri della tanica' : 'il peso del sacco'} nella <a href="#prodotto/${encodeURIComponent(p.id)}"><b>scheda</b></a>.</span></div>` : ''}
      <div class="kp-fields">
        <button type="button" class="kp-field ${CS.field === 'scad' ? 'on' : ''}" data-act="kp-field" data-f="scad" ${CS.senza ? 'disabled' : ''}><small>Scadenza</small><b>${CS.senza ? '—' : fmtScadDigits(CS.scad)}</b></button>
        <div class="kp-qta ${kgMode ? 'solo' : ''}">
          ${kgMode ? '' : '<button type="button" class="kp-pm" data-act="qta-" aria-label="Meno uno">−</button>'}
          <button type="button" class="kp-field ${CS.field === 'qta' ? 'on' : ''}" data-act="kp-field" data-f="qta"><small>${{ pz: 'Pezzi', sacchi: inLitri(p) ? 'Taniche' : 'Sacchi', kg: inLitri(p) ? 'Litri' : 'Kg' }[CS.unita]}</small><b>${esc(CS.qta || '0')}</b></button>
          ${kgMode ? '' : '<button type="button" class="kp-pm" data-act="qta+" aria-label="Più uno">+</button>'}
        </div>
      </div>
      ${p.sfuso ? `<div class="sf-unita">${p.pesoSacco ? `<div class="segmented mini"><button type="button" data-act="unita" data-u="sacchi" class="${CS.unita === 'sacchi' ? 'on' : ''}">${inLitri(p) ? 'Taniche' : 'Sacchi'}</button><button type="button" data-act="unita" data-u="kg" class="${CS.unita === 'kg' ? 'on' : ''}">${inLitri(p) ? 'Litri' : 'Kg'}</button></div>` : ''}<span>${CS.unita === 'sacchi' ? `${fmtSacchi(parseInt(CS.qta, 10) || 0, p)} da ${fmtSf(p, p.pesoSacco)} = <b>${fmtSf(p, qtaCarico(p).q)}</b>` : `Scrivi i ${nomeBase(p)} con la virgola, es. 2,5`}</span></div>` : ''}
      <div class="date-preview ${pr.err ? 'err' : ''} ${pr.faint ? 'faint' : ''}">${esc(pr.t)}</div>
      <div class="keypad">${['1', '2', '3', '4', '5', '6', '7', '8', '9'].map(k => `<button type="button" data-act="kp" data-k="${k}">${k}</button>`).join('')}
        ${virgola ? `<button type="button" data-act="kp" data-k=",">,</button><button type="button" data-act="kp" data-k="0">0</button><button type="button" data-act="kp" data-k="back" aria-label="Cancella">⌫</button>
        <button type="button" class="ok largo" data-act="carico-salva">Salva</button>` : `<button type="button" data-act="kp" data-k="back" aria-label="Cancella">⌫</button><button type="button" data-act="kp" data-k="0">0</button>
        <button type="button" class="ok" data-act="carico-salva">Salva</button>`}</div>
      <div class="row wrap"><label class="check spacer"><input type="checkbox" data-act="senza" ${CS.senza ? 'checked' : ''}> Senza scadenza</label>
        <button class="btn small ghost" type="button" data-act="carico-annulla">Annulla</button></div>
    </div>`;
    const gia = lottiAttivi().filter(l => l.prodottoId === p.id).sort((a, b) => (a.scadenza || '9').localeCompare(b.scadenza || '9'));
    if (gia.length) {
      html += `<div class="section-title"><h2>Già in negozio</h2><span class="count">${fq(p, gia.reduce((t, l) => t + (+l.quantita || 0), 0))}</span></div>
        <div class="faint small">Per correggere una data o ${p.sfuso ? 'le quantità già caricate' : 'i pezzi già caricati'} tocca <b>Modifica</b>.</div>
        <div class="list">${gia.map(l => rigaConfezione(l, { arrivo: true })).join('')}</div>`;
    }
  }
  const oggi = [...S.lotti.values()].filter(l => l.arrivo === todayISO() && (l.origine || 'arrivo') === CS.modo).sort((a, b) => b.creato - a.creato);
  html += `<div class="section-title"><h2>${inv ? 'Contati oggi' : 'Arrivati oggi'}</h2><span class="count">${oggi.length}</span></div>`;
  html += oggi.length ? `<div class="list">${oggi.map(l => {
    const pp = prodotto(l.prodottoId);
    return `<div class="item" style="flex-wrap:wrap"><div class="main tappable" style="flex:1 1 60%" data-act="lot-modifica" data-id="${esc(l.id)}" role="button" tabindex="0"><div class="name">${esc(pp ? pp.nome : '?')}</div><div class="sub">${l.sacchi ? fmtSacchi(l.sacchi, pp) + ' = ' : ''}${fq(pp, l.quantita)} · ${l.scadenza ? 'scade ' + fmtDate(l.scadenza) : 'senza scadenza'}</div></div>
      <div class="conf-acts"><button class="btn small" type="button" data-act="lot-modifica" data-id="${esc(l.id)}">${ICO_MATITA} Modifica</button><button class="btn small ghost" type="button" data-act="lotto-annulla" data-id="${esc(l.id)}">Togli</button></div></div>`;
  }).join('')}</div>` : `<div class="empty">Ancora niente oggi.</div>`;
  return { title: inv ? 'Inventario' : 'Arrivo merce', html, tab: 'carico', onScan: caricoScan };
};
async function caricoScan(code) {
  const p = byCode(code);
  const go = p2 => { CS = caricoPer(p2, CS.modo); render(); };
  if (CS.pid) {
    if (p && p.id === CS.pid) {
      if (p.sfuso && CS.unita === 'kg') {
        if (!p.pesoSacco) { toast(`Scrivi i ${nomeBase(p)} con i tasti`, { err: true }); return; }
        CS.qta = fmtNum(r3((parseNum(CS.qta) || 0) + p.pesoSacco)); CS.qtaFresh = false; render(); toast(`${inLitri(p) ? 'Litri' : 'Kg'}: ${CS.qta}`); return;
      }
      CS.qta = String((parseInt(CS.qta, 10) || 0) + 1); render(); toast(`${p.sfuso ? (inLitri(p) ? 'Taniche' : 'Sacchi') : 'Quantità'}: ${CS.qta}`); return;
    }
    const pronto = CS.senza || parseScadenza(CS.scad);
    if (!pronto) { toast(`Prima scrivi la scadenza di ${prodotto(CS.pid).nome}, oppure premi Annulla`, { err: true }); return; }
    const ok = await salvaCarico(); if (!ok) return;
  }
  if (p) go(p); else collegaCodice(code, go);
}
async function salvaCarico() {
  const p = prodotto(CS.pid); if (!p) return false;
  const qc = qtaCarico(p), qta = qc.q;
  if (!(qta > 0)) { toast(p.sfuso && CS.unita === 'kg' ? `Scrivi quanti ${nomeBase(p)}` : 'La quantità deve essere almeno 1', { err: true }); return false; }
  let scad = null;
  if (!CS.senza) {
    const r = parseScadenza(CS.scad);
    if (!r) { toast('Scrivi la scadenza: 6 cifre, per esempio 280527', { err: true }); return false; }
    scad = r.iso;
    if (daysUntil(scad) < 0 && !(await confirmBox(`La data ${fmtDate(scad)} è già passata. Salvo lo stesso?`, { ok: 'Salva' }))) return false;
  }
  const l = { id: uid('l'), prodottoId: p.id, quantita: qta, scadenza: scad, arrivo: todayISO(), creato: Date.now(), stato: 'attivo', gestito: false, nota: '', ordineId: null, origine: CS.modo, sprechi: [] };
  if (qc.sacchi) l.sacchi = qc.sacchi;
  if (CS.modo === 'arrivo') {
    const info = infoOrdine(p);
    if (info) {
      const righe = info.o.righe.map(r => r.prodottoId === p.id ? { ...r, ricevuto: r3((r.ricevuto || 0) + qc.ordine) } : r);
      await save('ordini', { ...info.o, righe }); l.ordineId = info.o.id; l.ordineQta = qc.ordine;
    }
  }
  await save('lotti', l);
  const cosa = p.sfuso ? `${qc.sacchi ? fmtSacchi(qc.sacchi, p) + ' (' + fmtSf(p, qta) + ')' : fmtSf(p, qta)} di ${p.nome}` : `${qta} × ${p.nome}`;
  toast(`Salvato: ${cosa}${scad ? ' · scade ' + fmtDate(scad) : ''}`, { action: { label: 'Annulla', run: () => annullaLotto(l.id) } });
  CS = nuovoCarico(CS.modo);
  render();
  return true;
}
async function annullaLotto(id) {
  const l = S.lotti.get(id); if (!l) return;
  if (l.ordineId) {
    const o = S.ordini.get(l.ordineId);
    if (o) await save('ordini', { ...o, righe: o.righe.map(r => r.prodottoId === l.prodottoId ? { ...r, ricevuto: Math.max(0, r3((r.ricevuto || 0) - (l.ordineQta ?? l.quantita))) } : r) });
  }
  await remove('lotti', id); toast('Tolto'); render();
}

/* =========================================================
   SCADENZE
   ========================================================= */
let SZ = { filtro: 'urgenti', q: '' };
const FILTRI = [['urgenti', 'Urgenti'], ['scaduti', 'Scaduti'], ['30', 'Entro 30 giorni'], ['tutti', 'Tutti'], ['gestiti', 'Gestiti']];
const FASCE = [['scaduto', 'Scaduti'], ['rosso', 'Scadono a brevissimo'], ['arancio', 'Scadono presto'], ['giallo', 'Entro il mese'], ['ok', 'Più avanti']];
function lottiFiltrati() {
  const q = norm(SZ.q);
  return lottiAttivi().filter(l => {
    if (q) { const p = prodotto(l.prodottoId); return !!p && q.split(' ').every(w => norm(p.nome).includes(w)); }
    if (!l.scadenza) return SZ.filtro === 'tutti';
    const f = fascia(l);
    if (SZ.filtro === 'gestiti') { if (!l.gestito) return false; }
    else if (SZ.filtro === 'urgenti') { if (l.gestito || !['scaduto', 'rosso', 'arancio'].includes(f)) return false; }
    else if (SZ.filtro === 'scaduti') { if (f !== 'scaduto') return false; }
    else if (SZ.filtro === '30') { if (f === 'ok') return false; }
    return true;
  }).sort((a, b) => (a.scadenza || '9').localeCompare(b.scadenza || '9'));
}
function rigaLotto(l) {
  const p = prodotto(l.prodottoId), f = fascia(l);
  const when = l.scadenza ? `${fmtDate(l.scadenza)}<small>${relDays(daysUntil(l.scadenza))}</small>` : `—<small>senza scadenza</small>`;
  return `<div class="lot ${f} ${l.gestito ? 'gestito' : ''}">
    <div class="top" data-act="lot-modifica" data-id="${esc(l.id)}" role="button" tabindex="0" aria-label="Modifica ${esc(p ? p.nome : '')}"><div class="spacer"><div class="name" style="font-weight:650">${esc(p ? p.nome : '?')}</div>
      <div class="sub small muted">${esc(p ? nomeForn(p.fornitoreId) : '')} · ${fq(p, l.quantita)} ${tagTipo(p)}${p && p.sfuso ? '<span class="tag sfuso">sfuso</span>' : ''}</div>
      ${l.gestito ? `<div class="small" style="font-weight:700;color:var(--accent)">Gestito: ${esc(l.nota || 'sì')}</div>` : ''}</div>
      <div class="when">${when}</div></div>
    <div class="acts">
      <button class="btn small" type="button" data-act="lot-modifica" data-id="${esc(l.id)}">${ICO_MATITA} Modifica</button>
      <button class="btn small" type="button" data-act="lot-gestito" data-id="${esc(l.id)}">${l.gestito ? 'Non gestito' : 'Gestito'}</button>
      <button class="btn small" type="button" data-act="lot-esaurito" data-id="${esc(l.id)}">Esaurito</button>
      <button class="btn small danger" type="button" data-act="lot-buttato" data-id="${esc(l.id)}">Buttato</button></div></div>`;
}
function listaScadenzeHTML() {
  const ls = lottiFiltrati();
  if (!ls.length) {
    const msg = SZ.q ? 'Nessun prodotto caricato con questo nome.' : SZ.filtro === 'urgenti' ? 'Niente di urgente. Ottimo!' : 'Niente da mostrare.';
    const altri = !SZ.q && SZ.filtro !== 'tutti' && lottiAttivi().length;
    return `<div class="empty">${msg}${altri ? `<div style="margin-top:10px"><button class="btn small" type="button" data-act="sz-filtro" data-f="tutti">Vedi tutti i prodotti caricati</button></div>` : ''}</div>`;
  }
  let html = '';
  if (SZ.q && SZ.filtro !== 'tutti') html += `<div class="faint small">Ricerca su tutti i prodotti caricati, non solo «${esc((FILTRI.find(x => x[0] === SZ.filtro) || ['', ''])[1])}».</div>`;
  for (const [k, label] of [...FASCE, ['nessuna', 'Senza scadenza']]) {
    const g = ls.filter(l => fascia(l) === k);
    if (!g.length) continue;
    html += `<div class="section-title"><h2>${label}</h2><span class="count">${g.length}</span></div><div class="list">${g.map(rigaLotto).join('')}</div>`;
  }
  return html;
}
routes.scadenze = arg => {
  if (current.fresh && arg && FILTRI.some(f => f[0] === arg)) SZ.filtro = arg;
  const html = `${segScad('s')}<div class="chips">${FILTRI.map(([k, l]) => `<button class="chip ${SZ.filtro === k ? 'on' : ''}" type="button" data-act="sz-filtro" data-f="${k}">${l}</button>`).join('')}</div>
    <div class="row"><input type="search" id="szQ" placeholder="Cerca un prodotto" value="${esc(SZ.q)}" autocomplete="off"><button class="btn small" type="button" data-act="sz-condividi">Condividi</button></div>
    <div id="szList" class="stack">${listaScadenzeHTML()}</div>`;
  return {
    title: 'Scadenze', html, tab: 'scadenze',
    mount: b => { const i = b.querySelector('#szQ'); i.addEventListener('input', () => { SZ.q = i.value; b.querySelector('#szList').innerHTML = listaScadenzeHTML(); }); },
    onScan: code => { const p = byCode(code); if (p) { SZ.q = p.nome; SZ.filtro = 'tutti'; render(); } else collegaCodice(code, p2 => { SZ.q = p2.nome; SZ.filtro = 'tutti'; render(); }); }
  };
};
function testoScadenze() {
  const ls = lottiAttivi().filter(l => l.scadenza && ['scaduto', 'rosso', 'arancio'].includes(fascia(l))).sort((a, b) => a.scadenza.localeCompare(b.scadenza));
  if (!ls.length) return 'Nessun prodotto in scadenza a breve.';
  return `Scadenze ${fmtDate(todayISO())}:\n` + ls.map(l => { const p = prodotto(l.prodottoId); return `- ${fmtDate(l.scadenza)} ${p ? p.nome : '?'} (${fq(p, l.quantita)})${l.gestito ? ' – ' + (l.nota || 'gestito') : ''}`; }).join('\n');
}

/* =========================================================
   SPRECHI
   ========================================================= */
const MOTIVI = ['Scaduto', 'In scadenza', 'Rovinato', 'Consumo interno', 'Omaggio', 'Reso al fornitore', 'Altro'];
const perso = r => r.motivo !== 'Reso al fornitore';   // il reso al fornitore esce dal negozio ma non è una perdita
async function migraSprechi() {
  if (S.meta.sprechiMigrati) return;
  const recs = [];
  for (const l of S.lotti.values()) for (const sp of (l.sprechi || [])) {
    const p = prodotto(l.prodottoId);
    recs.push({ id: uid('s'), prodottoId: l.prodottoId, qta: sp.qta, data: sp.data, motivo: 'Scaduto', lottoId: l.id, scadenza: l.scadenza, prezzoAcquisto: p ? (p.prezzoAcquisto ?? null) : null, creato: Date.now() });
  }
  if (recs.length) await saveMany('sprechi', recs);
  await setMeta('sprechiMigrati', true);
}
function sprecoModal({ lot = null, prod = null, qta = null, vuoto = false }) {
  const p = lot ? prodotto(lot.prodottoId) : prod;
  if (!p) return;
  const sf = isSfuso(p);
  const max = lot ? lot.quantita : 9999;
  const iniziale = sf ? (vuoto ? null : qta != null ? qta : (lot ? lot.quantita : null)) : Math.min(max, qta || (lot ? lot.quantita : 1));
  let motivo = lot && lot.scadenza ? (daysUntil(lot.scadenza) < 0 ? 'Scaduto' : 'In scadenza') : 'Rovinato';
  openModal(`${mhead(sf ? 'Quanto ne togli?' : 'Quanti ne togli?')}
    <div class="faint">${esc(p.nome)}${lot && lot.scadenza ? ' · scade ' + fmtDate(lot.scadenza) : ''}${lot ? ' · in negozio ' + fq(p, lot.quantita) : ''}</div>
    ${sf ? `<label class="field">${inLitri(p) ? 'Litri <span class="hint">con la virgola: 0,25 = 250 ml</span>' : 'Kg <span class="hint">con la virgola: 0,25 = 250 g</span>'}<input type="text" inputmode="decimal" id="bQ" value="${iniziale != null ? fmtNum(r3(iniziale)) : ''}" autocomplete="off"></label>
    <div class="chips">${[0.1, 0.25, 0.5, 1].map(k => `<button type="button" class="chip" data-kg="${k}">${fmtSf(p, k)}</button>`).join('')}${lot ? `<button type="button" class="chip" data-kg="${r3(lot.quantita)}">Tutto (${fmtSf(p, lot.quantita)})</button>` : ''}</div>`
    : `<div class="stepper"><button type="button" data-x="-" aria-label="Meno">−</button><input type="number" inputmode="numeric" id="bQ" value="${iniziale}" min="1" ${lot ? `max="${max}"` : ''}><button type="button" data-x="+" aria-label="Più">+</button></div>`}
    <div class="field" style="font-weight:600">Perché
      <div class="chips" id="bMot">${MOTIVI.map(m => `<button type="button" class="chip ${m === motivo ? 'on' : ''}" data-m="${m}">${m}</button>`).join('')}</div>
      <input type="text" id="bAltro" placeholder="Scrivi il motivo" hidden></div>
    <button class="btn primary block" type="button" data-x="ok" style="background:var(--red);border-color:var(--red)">Registra</button>`, b => {
    const i = b.querySelector('#bQ'), altro = b.querySelector('#bAltro');
    if (sf) { $$('[data-kg]', b).forEach(c => c.onclick = () => { i.value = fmtNum(+c.dataset.kg); }); if (!i.value) setTimeout(() => i.focus(), 50); }
    else {
      b.querySelector('[data-x="-"]').onclick = () => { i.value = Math.max(1, (+i.value || 1) - 1); };
      b.querySelector('[data-x="+"]').onclick = () => { i.value = Math.min(max, (+i.value || 0) + 1); };
    }
    $$('#bMot [data-m]', b).forEach(c => c.onclick = () => {
      motivo = c.dataset.m; $$('#bMot [data-m]', b).forEach(x => x.classList.toggle('on', x === c));
      altro.hidden = motivo !== 'Altro'; if (!altro.hidden) altro.focus();
    });
    b.querySelector('[data-x=ok]').onclick = async () => {
      let n;
      if (sf) { n = r3(parseNum(i.value)); if (!(n > 0)) { toast(`Scrivi quanti ${nomeBase(p)}`, { err: true }); return; } n = Math.min(r3(max), n); }
      else n = Math.min(max, Math.max(1, parseInt(i.value, 10) || 1));
      const m = motivo === 'Altro' ? (altro.value.trim() || 'Altro') : motivo;
      closeModal();
      await registraSpreco({ p, lot, qta: n, motivo: m });
    };
  });
}
async function registraSpreco({ p, lot, qta, motivo }) {
  const rec = { id: uid('s'), prodottoId: p.id, qta, data: todayISO(), motivo, lottoId: lot ? lot.id : null, scadenza: lot ? lot.scadenza : null, prezzoAcquisto: p.prezzoAcquisto ?? null, creato: Date.now() };
  await save('sprechi', rec);
  if (lot) {
    const cur = S.lotti.get(lot.id) || lot;
    await save('lotti', qta >= r3(cur.quantita) ? { ...cur, stato: 'buttato', chiuso: todayISO() } : { ...cur, quantita: r3(cur.quantita - qta) });
  }
  const v = perso(rec) && rec.prezzoAcquisto != null ? ' · ' + fmtEuro(rec.prezzoAcquisto * qta) : '';
  toast(`Tolti ${isSfuso(p) ? fmtSf(p, qta) : fmtNum(qta)} · ${motivo}${v}`, { action: { label: 'Annulla', run: () => annullaSpreco(rec.id) } });
  render();
}
async function annullaSpreco(id) {
  const r = S.sprechi.get(id); if (!r) return;
  if (r.lottoId) {
    const l = S.lotti.get(r.lottoId);
    if (l) await save('lotti', l.stato === 'buttato' ? { ...l, stato: 'attivo', chiuso: null } : { ...l, quantita: r3(l.quantita + r.qta) });
  }
  await remove('sprechi', id); toast('Spreco annullato'); render();
}
let SPF = 'mese';
const PERIODI = [['mese', 'Questo mese'], ['scorso', 'Mese scorso'], ['anno', 'Ultimi 12 mesi'], ['tutto', 'Tutto']];
function periodo(f) {
  const t = new Date(), y = t.getFullYear(), m = t.getMonth();
  if (f === 'mese') return [todayISO(new Date(y, m, 1)), todayISO(t)];
  if (f === 'scorso') return [todayISO(new Date(y, m - 1, 1)), todayISO(new Date(y, m, 0))];
  if (f === 'anno') return [todayISO(new Date(y - 1, m, t.getDate() + 1)), todayISO(t)];
  return ['0000-00-00', '9999-12-31'];
}
const valoreSpreco = r => perso(r) && r.prezzoAcquisto != null ? r.prezzoAcquisto * r.qta : null;
function sprechiPeriodo(f) { const [da, a] = periodo(f); return [...S.sprechi.values()].filter(r => r.data >= da && r.data <= a).sort((x, y) => y.data.localeCompare(x.data) || y.creato - x.creato); }
const segScad = on => `<div class="segmented"><a href="#scadenze" class="${on === 's' ? 'on' : ''}">Scadenze</a><a href="#sprechi" class="${on === 'w' ? 'on' : ''}">Sprechi</a></div>`;
routes.sprechi = () => {
  const list = sprechiPeriodo(SPF);
  const pezzi = list.filter(perso).reduce((t, r) => t + r.qta, 0);
  const tot = list.reduce((t, r) => t + (valoreSpreco(r) || 0), 0);
  const senzaPrezzo = list.filter(r => perso(r) && r.prezzoAcquisto == null).length;
  const per = new Map();
  for (const r of list.filter(perso)) { const e = per.get(r.prodottoId) || { qta: 0, val: 0 }; e.qta += r.qta; e.val += valoreSpreco(r) || 0; per.set(r.prodottoId, e); }
  const top = [...per.entries()].sort((a, b) => b[1].val - a[1].val || b[1].qta - a[1].qta).slice(0, 5);
  let html = segScad('w') + `<div class="chips">${PERIODI.map(([k, l]) => `<button class="chip ${SPF === k ? 'on' : ''}" type="button" data-act="sp-periodo" data-f="${k}">${l}</button>`).join('')}</div>
    <div class="stats" style="grid-template-columns:1fr 1fr"><div class="stat ${pezzi ? 'red' : ''}"><b${totaleQta(list.filter(perso)).includes('kg') ? ' style="font-size:1.35rem"' : ''}>${totaleQta(list.filter(perso))}</b><span>Buttati</span></div>
      <div class="stat ${tot ? 'red' : ''}"><b style="font-size:1.5rem">${fmtEuro(tot)}</b><span>Valore perso (prezzo d'acquisto)</span></div></div>
    ${senzaPrezzo ? `<div class="notice"><span>Per ${senzaPrezzo} ${senzaPrezzo === 1 ? 'riga manca' : 'righe manca'} il prezzo d'acquisto: non ${senzaPrezzo === 1 ? 'è contata' : 'sono contate'} nel valore.</span></div>` : ''}
    <div class="btn-grid" style="grid-template-columns:1fr 1fr"><button class="btn primary" type="button" data-act="spreco-nuovo">Registra uno spreco</button><button class="btn" type="button" data-act="sp-condividi" ${list.length ? '' : 'disabled'}>Condividi</button></div>
    <div class="faint small" style="text-align:center">Puoi anche scansionare il prodotto da buttare.</div>`;
  if (top.length > 1) html += `<div class="section-title"><h2>Più buttati</h2></div><div class="list">${top.map(([pid, e]) => { const p = prodotto(pid); return `<div class="item"><div class="main"><div class="name">${esc(p ? p.nome : '?')}</div><div class="sub">${esc(p ? nomeForn(p.fornitoreId) : '')}</div></div><div style="text-align:right;font-weight:700">${fq(p, e.qta)}<div class="faint small">${e.val ? fmtEuro(e.val) : ''}</div></div></div>`; }).join('')}</div>`;
  html += `<div class="section-title"><h2>Elenco</h2><span class="count">${list.length}</span></div>`;
  html += list.length ? `<div class="list">${list.map(r => {
    const p = prodotto(r.prodottoId), v = valoreSpreco(r);
    return `<div class="item"><div class="main"><div class="name">${esc(p ? p.nome : 'Prodotto eliminato')}</div>
      <div class="sub">${fmtDate(r.data)} · ${fq(p, r.qta)} · ${esc(r.motivo)}${r.scadenza ? ' · scadenza ' + fmtDate(r.scadenza) : ''}${p ? ' · ' + esc(nomeForn(p.fornitoreId)) : ''}</div></div>
      <div style="text-align:right;font-weight:700;white-space:nowrap">${v != null ? fmtEuro(v) : '–'}</div>
      <button class="btn small" type="button" data-act="spreco-mod" data-id="${esc(r.id)}">Modifica</button></div>`;
  }).join('')}</div>` : `<div class="empty">Nessuno spreco in questo periodo.</div>`;
  return {
    title: 'Archivio sprechi', html, tab: 'scadenze',
    onScan: code => { const p = byCode(code); if (p) sprecoModal({ prod: p }); else collegaCodice(code, p2 => sprecoModal({ prod: p2 })); }
  };
};
function testoSprechi() {
  const list = sprechiPeriodo(SPF), lab = PERIODI.find(x => x[0] === SPF)[1];
  const tot = list.reduce((t, r) => t + (valoreSpreco(r) || 0), 0);
  return `Sprechi – ${lab.toLowerCase()}: ${totaleQta(list.filter(perso))}, ${fmtEuro(tot)}\n` +
    list.map(r => { const p = prodotto(r.prodottoId), v = valoreSpreco(r); return `- ${fmtDate(r.data)} ${p ? p.nome : '?'}: ${fq(p, r.qta)} (${r.motivo})${v != null ? ' ' + fmtEuro(v) : ''}`; }).join('\n');
}

/* =========================================================
   BANCO: vendita, reso e spreco al banco
   - il cassiere batte in cassa come sempre e intanto scansiona qui
   - ogni vendita toglie i pezzi dalla confezione che scade prima
   - un codice sconosciuto non blocca: la vendita resta "da sistemare"
   ========================================================= */
const ICO_ANNULLA = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICO_GRIGLIA = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';
const MODI_BANCO = [['vendita', 'Vendita'], ['reso', 'Reso'], ['spreco', 'Spreco']];
const RAGGRUPPA_MS = 3 * 60 * 1000;   // lo stesso prodotto scansionato di nuovo entro 3 minuti va sulla stessa riga
let BANCO = { modo: 'vendita', tutte: false };

const prezzoVendita = p => p ? (p.prezzoManuale ?? prezzoCalcolato(p) ?? p.prezzoVendita ?? null) : null;
const prezzoRiga = v => v.prezzo ?? (v.prodottoId ? prezzoVendita(prodotto(v.prodottoId)) : null);
/* arrotonda ai centesimi come la cassa (0,525 → 0,53), senza gli errori dei decimali del computer */
const centesimi = x => Math.sign(x) * Math.round(Math.abs(x) * 100 + 1e-6) / 100;
const importo = v => { const pr = prezzoRiga(v); return pr == null ? null : centesimi(pr * v.qta * (v.tipo === 'reso' ? -1 : 1)); };
/* pezzi venduti che non risultavano in negozio; per lo sfuso si ignora il piccolo avanzo del sacco */
const mancaVisibile = v => (v.mancanti || 0) > (isSfuso(prodotto(v.prodottoId)) ? Math.max(tolleranza(prodotto(v.prodottoId)), 0.001) : 0);
const fmtOra = ts => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const venditeDel = data => [...S.vendite.values()].filter(v => v.data === data).sort((a, b) => b.creato - a.creato);
const ultimaRiga = () => venditeDel(todayISO())[0] || null;
const daSistemare = () => [...S.vendite.values()].filter(v => !v.prodottoId && v.codice);

/* le operazioni del banco vanno in fila, così due scansioni veloci non si pestano i piedi */
let codaBanco = Promise.resolve();
function inCoda(fn) {
  codaBanco = codaBanco.then(fn).catch(err => { console.error(err); toast('Qualcosa non ha funzionato: ' + err.message, { err: true }); });
  return codaBanco;
}

/* confezioni di un prodotto, prima quella che scade prima */
function lottiFEFO(pid) {
  return lottiAttivi().filter(l => l.prodottoId === pid && (+l.quantita || 0) > 0)
    .sort((a, b) => (a.scadenza || '9999-99-99').localeCompare(b.scadenza || '9999-99-99') || (a.creato || 0) - (b.creato || 0));
}
function unisci(a, b) {
  const m = new Map();
  for (const x of [...(a || []), ...(b || [])]) m.set(x.lottoId, (m.get(x.lottoId) || 0) + x.qta);
  return [...m.entries()].map(([lottoId, qta]) => ({ lottoId, qta })).filter(x => x.qta > 0);
}
/* segno -1: toglie i pezzi dalle confezioni (a zero diventano esaurite); +1: li rimette */
async function muovi(prelievi, segno) {
  const mod = new Map();
  for (const pr of prelievi || []) {
    const l = mod.get(pr.lottoId) || S.lotti.get(pr.lottoId);
    if (!l || !pr.qta) continue;
    let n;
    if (segno > 0) n = l.stato === 'attivo' ? { ...l, quantita: r3((+l.quantita || 0) + pr.qta) } : { ...l, stato: 'attivo', chiuso: null, esauritoDaVendita: false, quantita: r3((l.avanzo || 0) + pr.qta), avanzo: 0 };
    else {
      const q = Math.max(0, r3((+l.quantita || 0) - pr.qta));
      n = q > 0 ? { ...l, quantita: q } : { ...l, quantita: 0, stato: 'esaurito', chiuso: todayISO(), esauritoDaVendita: true };
    }
    mod.set(l.id, n);
  }
  if (mod.size) await saveMany('lotti', [...mod.values()]);
}
async function preleva(pid, qta) {
  const prelievi = []; let resto = r3(qta);
  for (const l of lottiFEFO(pid)) {
    if (resto <= 0) break;
    const t = r3(Math.min(+l.quantita || 0, resto));
    if (t > 0) { prelievi.push({ lottoId: l.id, qta: t }); resto = r3(resto - t); }
  }
  await muovi(prelievi, -1);
  const tol = tolleranza(prodotto(pid));
  if (tol > 0) await chiudiAvanzi(pid, tol);
  return { prelievi, mancanti: resto };   // mancanti: venduti ma non risultavano in negozio
}
/* sfuso: il sacco più vecchio con solo un piccolo avanzo si considera finito e si passa al successivo.
   L'avanzo resta scritto sulla confezione, così "annulla" lo rimette a posto. */
async function chiudiAvanzi(pid, tol) {
  const ls = lottiFEFO(pid), chiusi = [];
  for (let i = 0; i < ls.length - 1; i++) {
    const l = ls[i];
    if ((+l.quantita || 0) >= tol) break;
    chiusi.push({ ...l, avanzo: r3(l.quantita), quantita: 0, stato: 'esaurito', chiuso: todayISO(), esauritoDaVendita: true });
  }
  if (chiusi.length) await saveMany('lotti', chiusi);
}
async function vendiPeso(p, kg, { origine = 'scansione' } = {}) {
  const ora = Date.now(), r = await preleva(p.id, kg);
  await save('vendite', { id: uid('v'), tipo: 'vendita', data: todayISO(), creato: ora, aggiornato: ora, prodottoId: p.id, codice: null, qta: r3(kg), prezzo: prezzoVendita(p), sfuso: true, prelievi: r.prelievi, mancanti: r.mancanti, origine });
  render();
}

async function vendi(p, { origine = 'scansione' } = {}) {
  const u = ultimaRiga(), ora = Date.now();
  if (u && u.tipo === 'vendita' && u.prodottoId === p.id && ora - (u.aggiornato || u.creato) < RAGGRUPPA_MS) return cambiaQta(u.id, 1);
  const r = await preleva(p.id, 1);
  await save('vendite', { id: uid('v'), tipo: 'vendita', data: todayISO(), creato: ora, aggiornato: ora, prodottoId: p.id, codice: null, qta: 1, prezzo: prezzoVendita(p), prelievi: r.prelievi, mancanti: r.mancanti, origine });
  render();
}
async function vendiSconosciuto(code) {
  const u = ultimaRiga(), ora = Date.now();
  if (u && u.tipo === 'vendita' && !u.prodottoId && u.codice === code && ora - (u.aggiornato || u.creato) < RAGGRUPPA_MS) return cambiaQta(u.id, 1);
  await save('vendite', { id: uid('v'), tipo: 'vendita', data: todayISO(), creato: ora, aggiornato: ora, prodottoId: null, codice: code, qta: 1, prezzo: null, prelievi: [], mancanti: 0, origine: 'scansione' });
  render();
}
async function cambiaQta(id, delta) {
  const v = S.vendite.get(id);
  delta = r3(delta);
  if (!v || !delta || r3(v.qta + delta) < (v.sfuso ? 0.001 : 1)) return;
  const ora = Date.now(), nuova = r3(v.qta + delta);
  if (!v.prodottoId) await save('vendite', { ...v, qta: nuova, aggiornato: ora });
  else if (v.tipo === 'reso') {
    const lottoId = v.prelievi[0].lottoId;
    await muovi([{ lottoId, qta: Math.abs(delta) }], delta > 0 ? 1 : -1);
    await save('vendite', { ...v, qta: nuova, prelievi: [{ lottoId, qta: nuova }], aggiornato: ora });
  } else if (delta > 0) {
    const r = await preleva(v.prodottoId, delta);
    await save('vendite', { ...v, qta: nuova, prelievi: unisci(v.prelievi, r.prelievi), mancanti: r3((v.mancanti || 0) + r.mancanti), pesoMancante: null, aggiornato: ora });
  } else {
    let togli = -delta, mancanti = v.mancanti || 0;
    const m = Math.min(mancanti, togli); mancanti = r3(mancanti - m); togli = r3(togli - m);
    const prel = (v.prelievi || []).map(x => ({ ...x })), indietro = [];
    for (let i = prel.length - 1; i >= 0 && togli > 0; i--) { const t = r3(Math.min(prel[i].qta, togli)); prel[i].qta = r3(prel[i].qta - t); togli = r3(togli - t); indietro.push({ lottoId: prel[i].lottoId, qta: t }); }
    await muovi(indietro, 1);
    await save('vendite', { ...v, qta: nuova, prelievi: prel.filter(x => x.qta > 0), mancanti, aggiornato: ora });
  }
  render();
}
/* reso del cliente: il pezzo torna nella confezione da cui era uscito */
async function rendi(p, qta = 1) {
  BANCO.modo = 'vendita'; qta = r3(qta);
  const ultimaV = [...S.vendite.values()].filter(v => v.tipo === 'vendita' && v.prodottoId === p.id && (v.prelievi || []).length).sort((a, b) => b.creato - a.creato)[0];
  let lottoId = ultimaV ? ultimaV.prelievi[ultimaV.prelievi.length - 1].lottoId : null;
  if (!lottoId || !S.lotti.has(lottoId)) { const fe = lottiFEFO(p.id); lottoId = fe.length ? fe[fe.length - 1].id : null; }
  let nuovo = false;
  if (lottoId) await muovi([{ lottoId, qta }], 1);
  else {
    const l = { id: uid('l'), prodottoId: p.id, quantita: qta, scadenza: null, arrivo: todayISO(), creato: Date.now(), stato: 'attivo', gestito: false, nota: '', ordineId: null, origine: 'reso', sprechi: [] };
    await save('lotti', l); lottoId = l.id; nuovo = true;
  }
  const ora = Date.now();
  await save('vendite', { id: uid('v'), tipo: 'reso', data: todayISO(), creato: ora, aggiornato: ora, prodottoId: p.id, codice: null, qta, prezzo: prezzoVendita(p), sfuso: isSfuso(p) || undefined, prelievi: [{ lottoId, qta }], mancanti: 0, lottoNuovo: nuovo, origine: 'scansione' });
  toast(`Reso: ${isSfuso(p) ? fmtSf(p, qta) + ' di ' : ''}${p.nome} torna in negozio`);
  render();
}
async function annullaRiga(id) {
  const v = S.vendite.get(id); if (!v) return;
  if (v.tipo === 'reso') {
    const l = v.prelievi[0] && S.lotti.get(v.prelievi[0].lottoId);
    if (v.lottoNuovo && l && l.stato === 'attivo' && (+l.quantita || 0) <= v.qta) await remove('lotti', l.id);
    else await muovi(v.prelievi, -1);
  } else await muovi(v.prelievi, 1);
  await remove('vendite', id);
  const p = prodotto(v.prodottoId);
  toast(`Annullato: ${p && v.sfuso ? fmtSf(p, v.qta) + ' di' : fmtNum(v.qta) + ' ×'} ${p ? p.nome : v.codice || '?'}`);
  render();
}
/* vendite con codice sconosciuto: quando il codice viene collegato, i pezzi escono dal magazzino */
async function sistemaCodici() {
  let n = 0;
  for (const v0 of daSistemare()) {
    const p = byCode(v0.codice); if (!p) continue;
    const v = S.vendite.get(v0.id); if (!v || v.prodottoId) continue;
    if (isSfuso(p)) {   // il peso non si conosce: si collega il prodotto ma il magazzino non cambia
      await save('vendite', { ...v, prodottoId: p.id, prezzo: prezzoVendita(p), sfuso: true, qta: 0, pesoMancante: v.qta, prelievi: [], mancanti: 0, sistemato: Date.now() });
      n++; continue;
    }
    const r = await preleva(p.id, v.qta);
    await save('vendite', { ...v, prodottoId: p.id, prezzo: prezzoVendita(p), prelievi: r.prelievi, mancanti: r.mancanti, sistemato: Date.now() });
    n++;
  }
  return n;
}
async function sistemaEAvvisa() {
  const n = await sistemaCodici();
  if (n) { toast(n === 1 ? 'Codice collegato: la vendita è uscita dal magazzino' : `Codici collegati: ${n} vendite sono uscite dal magazzino`); render(); }
}
const daCollegarePronti = () => daSistemare().some(v => byCode(v.codice));

function bancoScan(code) {
  return inCoda(async () => {
    const p = byCode(code);
    if (BANCO.modo === 'reso') {
      if (p) { if (isSfuso(p)) resoPeso(p); else await rendi(p); }
      else collegaCodice(code, p2 => isSfuso(p2) ? resoPeso(p2) : inCoda(() => rendi(p2)));
      return;
    }
    if (BANCO.modo === 'spreco') { if (p) sprecoBanco(p); else collegaCodice(code, sprecoBanco); return; }
    if (p && isSfuso(p)) { vendiPesoModal(p); return; }
    if (p) await vendi(p); else await vendiSconosciuto(code);
  });
}
function vendiPesoModal(p, origine = 'scansione') { pesoModal(p, { onOk: kg => inCoda(() => vendiPeso(p, kg, { origine })) }); }
function resoPeso(p) { pesoModal(p, { titolo: 'Reso: quanto riporta?', ok: 'Rimetti in negozio', onOk: kg => inCoda(() => rendi(p, kg)) }); }
function azioneBanco(p) {
  if (BANCO.modo === 'reso') { if (isSfuso(p)) return resoPeso(p); return inCoda(() => rendi(p)); }
  if (BANCO.modo === 'spreco') return sprecoBanco(p);
  if (isSfuso(p)) return vendiPesoModal(p, 'ricerca');
  return inCoda(() => vendi(p, { origine: 'ricerca' }));
}
function sprecoBanco(p) {
  BANCO.modo = 'vendita';
  render();
  const lot = lottiFEFO(p.id)[0];
  sprecoModal(lot ? { lot, qta: isSfuso(p) ? null : 1, vuoto: isSfuso(p) } : { prod: p });
}

/* finestra del peso: i grammi letti sulla bilancia (i ml per i liquidi alla spina) */
function pesoModal(p, { titolo = null, ok = 'Aggiungi', iniziale = 0, onOk }) {
  let g = iniziale ? String(Math.round(iniziale * 1000)) : '';
  const pr = prezzoVendita(p), lt = inLitri(p), mu = lt ? 'ml' : 'g';
  const grammi = () => parseInt(g, 10) || 0;
  const conferma = () => { const gr = grammi(); if (!gr) return false; closeModal(); onOk(r3(gr / 1000)); return true; };
  const draw = b => {
    const gr = grammi();
    b.querySelector('#pgVal').textContent = gr.toLocaleString('it-IT');
    b.querySelector('#pgKg').textContent = gr ? `= ${fmtSf(p, gr / 1000)}` : (lt ? 'Scrivi i ml' : 'Scrivi i grammi letti sulla bilancia');
    b.querySelector('#pgEuro').textContent = pr != null && gr ? fmtEuro(centesimi(pr * gr / 1000)) : '';
    const bo = b.querySelector('#pgOk'); bo.textContent = gr ? `${ok} · ${fmtSf(p, gr / 1000)}` : ok; bo.disabled = !gr;
  };
  const veloci = lt ? [250, 500, 750, 1000] : [100, 250, 500, 1000];
  openModal(`${mhead(titolo || (lt ? 'Quanti ml?' : 'Quanto pesa?'))}
    <div class="peso-prod"><b>${esc(p.nome)}</b><span>${pr != null ? fmtEuro(perUnita(p, pr)) + alKg(p) : 'Prezzo' + alKg(p) + ' non impostato'} · in negozio ${fmtSf(p, giacenza(p.id))}</span></div>
    <div class="peso-display" aria-live="polite"><span id="pgVal">0</span><small>${mu}</small></div>
    <div class="peso-info"><span id="pgKg"></span><b id="pgEuro"></b></div>
    <div class="peso-veloci">${veloci.map(x => `<button type="button" class="chip" data-g="${x}">${x === 1000 ? (lt ? '1 litro' : '1 kg') : x + ' ' + mu}</button>`).join('')}</div>
    <div class="keypad peso-kp">${'123456789'.split('').map(k => `<button type="button" data-k="${k}">${k}</button>`).join('')}<button type="button" data-k="C" aria-label="Cancella tutto">C</button><button type="button" data-k="0">0</button><button type="button" data-k="back" aria-label="Cancella una cifra">⌫</button></div>
    <button class="btn primary block" type="button" id="pgOk">${ok}</button>`, b => {
    b.addEventListener('click', e => {
      const k = e.target.closest('[data-k]'), q = e.target.closest('[data-g]');
      if (k) {
        const c = k.dataset.k;
        if (c === 'C') g = ''; else if (c === 'back') g = g.slice(0, -1); else if (g.length < 5) g = (g + c).replace(/^0+(?=\d)/, '');
        draw(b);
      } else if (q) { g = q.dataset.g; draw(b); }
    });
    b.querySelector('#pgOk').onclick = conferma;
    draw(b);
  }, {
    // nuova scansione con la finestra aperta: si conferma il peso scritto e si passa al prodotto dopo
    onScan: code => {
      if (!grammi()) { toast(`Scrivi prima ${lt ? 'i ml' : 'il peso'} di ${p.nome}`, { err: true }); return; }
      conferma(); if (current.onScan) current.onScan(code);
    }
  });
}

function infoLotti(v) {
  const ls = (v.prelievi || []).map(x => S.lotti.get(x.lottoId)).filter(Boolean);
  if (!ls.length) return '';
  const sc = ls.map(l => l.scadenza).filter(Boolean).sort();
  const p = prodotto(v.prodottoId), fem = !v.sfuso || inLitri(p);
  const c = v.sfuso ? nomeSacco(p, 1) : 'confezione', cc = v.sfuso ? nomeSacco(p, 2) : 'confezioni';
  if (v.tipo === 'reso') return sc.length ? `nel${fem ? 'la' : ''} ${c} che scade ${fmtDate(sc[0])}` : `in ${fem ? 'una' : 'un'} ${c} senza scadenza`;
  if (ls.length > 1) return `da ${ls.length} ${cc}${sc.length ? `, ${fem ? 'la prima' : 'il primo'} scade ` + fmtDate(sc[0]) : ''}`;
  return sc.length ? `dal${fem ? 'la' : ''} ${c} che scade ${fmtDate(sc[0])}` : `da ${fem ? 'una' : 'un'} ${c} senza scadenza`;
}
function cartaUltima(v) {
  const qtaCtl = `<div class="qta" role="group" aria-label="Quantità"><button type="button" data-act="banco-qta" data-d="-1" data-id="${esc(v.id)}" aria-label="Togli un pezzo" ${v.qta <= 1 ? 'disabled' : ''}>−</button><b>${fmtNum(v.qta)}</b><button type="button" data-act="banco-qta" data-d="1" data-id="${esc(v.id)}" aria-label="Aggiungi un pezzo">+</button></div>`;
  if (!v.prodottoId) {
    return `<section class="vcard sconosciuto" aria-label="Codice non riconosciuto">
      <div class="lab"><span>Codice non riconosciuto</span><time>${fmtOra(v.creato)}</time></div>
      <div class="nome mono">${esc(v.codice)}</div>
      <div class="info">Battilo in cassa come sempre. Il codice resta in «Da sistemare»: quando lo colleghi a un prodotto, il magazzino si aggiorna da solo.</div>
      <div class="bottom"><button class="btn" type="button" data-act="ds-collega" data-c="${esc(v.codice)}">Collega a un prodotto</button>${qtaCtl}</div></section>`;
  }
  const p = prodotto(v.prodottoId), imp = importo(v), reso = v.tipo === 'reso', sf = !!v.sfuso;
  const manca = mancaVisibile(v)
    ? `<div class="notice orange"><span><b>${sf ? fmtSf(p, v.mancanti) + ' non risultavano' : v.mancanti === 1 ? '1 pezzo non risultava' : fmtNum(v.mancanti) + ' pezzi non risultavano'} in negozio.</b> La vendita è registrata lo stesso: controlla gli arrivi di questo prodotto.</span></div>` : '';
  const lt = sf && inLitri(p);
  const destra = sf ? `<button class="btn" type="button" data-act="banco-peso" data-id="${esc(v.id)}">${lt ? 'Cambia ml' : 'Cambia peso'}</button>` : qtaCtl;
  const sotto = sf ? (v.pesoMancante ? `<small>${lt ? 'Quantità non scritta' : 'Peso non scritto'}</small>` : `<small>${fmtSf(p, v.qta)} × ${fmtEuro(perUnita(p, prezzoRiga(v)))}${alKg(p)}</small>`) : (imp != null && v.qta > 1 ? `<small>${fmtNum(v.qta)} × ${fmtEuro(prezzoRiga(v))}</small>` : '');
  return `<section class="vcard ${reso ? 'reso' : ''} ${sf ? 'peso' : ''}" aria-label="Ultima registrazione">
    <div class="lab"><span>${reso ? 'Reso del cliente' : sf ? (lt ? 'Venduto alla spina' : 'Venduto a peso') : 'Venduto'}</span><time>${fmtOra(v.creato)}</time></div>
    <div class="nome">${esc(p ? p.nome : 'Prodotto eliminato')}</div>
    <div class="info">${[infoLotti(v), 'in negozio ' + fq(p, giacenza(v.prodottoId))].filter(Boolean).join(' · ')}</div>
    ${manca}
    <div class="bottom"><div class="tot">${imp == null ? '<small>Prezzo non impostato</small>' : fmtEuro(imp)}${sotto}</div>${destra}</div></section>`;
}
function rigaVendita(v) {
  const p = prodotto(v.prodottoId), imp = importo(v);
  const nome = v.prodottoId ? (p ? p.nome : 'Prodotto eliminato') : v.codice;
  const sub = [v.tipo === 'reso' ? 'reso' : '', v.sfuso ? 'sfuso · ' + fmtSf(p, v.qta) : fmtNum(v.qta) + ' pz', mancaVisibile(v) ? 'non risultava in negozio' : ''].filter(Boolean).join(' · ');
  return `<button class="item vrow" type="button" data-act="vendita-apri" data-id="${esc(v.id)}"><div class="main"><div class="name ${v.prodottoId ? '' : 'mono'}">${esc(nome)}</div><div class="sub">${esc(sub)}${v.prodottoId ? '' : ' <span class="tag warn">da sistemare</span>'}</div></div>
    <span class="prezzo">${imp == null ? '–' : fmtEuro(imp)}</span><time>${fmtOra(v.creato)}</time></button>`;
}
routes.banco = () => {
  const righe = venditeDel(todayISO());
  const tot = righe.reduce((t, v) => t + (importo(v) || 0), 0);
  const codiciDS = new Set(daSistemare().map(v => v.codice)).size;
  const vend = BANCO.modo === 'vendita', u = righe[0];
  let html = `<div class="segmented banco-modi">${MODI_BANCO.map(([k, l]) => `<button type="button" data-act="banco-modo" data-m="${k}" class="${BANCO.modo === k ? 'on ' + k : ''}" aria-pressed="${BANCO.modo === k}">${l}</button>`).join('')}</div>`;
  if (!vend) html += `<div class="notice ${BANCO.modo === 'reso' ? 'blue' : 'red'}"><span class="spacer">${BANCO.modo === 'reso' ? '<b>Reso:</b> il prodotto che scansioni torna in negozio.' : '<b>Spreco:</b> il prodotto che scansioni esce dal negozio senza essere venduto.'} Dopo si torna in Vendita.</span><button class="btn small" type="button" data-act="banco-modo" data-m="vendita">Annulla</button></div>`;
  if (vend && u) html += cartaUltima(u);
  else html += scanbox(BANCO.modo === 'reso' ? 'Scansiona il prodotto reso' : BANCO.modo === 'spreco' ? 'Scansiona il prodotto da togliere' : 'Scansiona il prodotto venduto',
    vend ? 'Battilo in cassa come sempre: qui il magazzino scende da solo.' : 'Se non ha codice, cercalo per nome.', 'banco-senza');
  html += `<div class="btn-grid banco-az" style="grid-template-columns:1fr 1fr"><button class="btn" type="button" data-act="banco-annulla" ${u ? '' : 'disabled'}>${ICO_ANNULLA} Annulla ultima</button><button class="btn soft" type="button" data-act="banco-senza">${ICO_GRIGLIA} Senza codice</button></div>`;
  if (codiciDS) html += `<button class="notice orange tappable" type="button" data-act="ds-apri"><span class="spacer"><b>${codiciDS === 1 ? '1 codice' : codiciDS + ' codici'} da sistemare</b> · venduti ma non ancora collegati a un prodotto</span><span class="chev">›</span></button>`;
  html += `<div class="oggi-bar"><span>Oggi <b>${totaleQta(righe, v => v.tipo === 'reso' ? -1 : 1)}</b> · <b>${fmtEuro(tot)}</b></span><a class="btn small" href="#chiusura">Chiusura di oggi</a></div>`;
  const resto = vend ? righe.slice(1) : righe;
  if (resto.length) {
    const max = BANCO.tutte ? resto.length : 25;
    html += `<div class="section-title"><h2>${vend ? 'Prima' : 'Oggi'}</h2><span class="count">${resto.length}</span></div><div class="list">${resto.slice(0, max).map(rigaVendita).join('')}</div>`;
    if (resto.length > max) html += `<button class="btn block" type="button" data-act="banco-tutte">Mostra tutte (${resto.length})</button>`;
  }
  return { title: 'Banco', html, tab: 'banco', onScan: bancoScan, mount: () => { if (daCollegarePronti()) inCoda(sistemaEAvvisa); } };
};
function piuVendutiSenzaCodice(n = 12) {
  const da = todayISO(new Date(Date.now() - 60 * 86400000));
  const m = new Map();
  for (const v of S.vendite.values()) if (v.tipo === 'vendita' && v.prodottoId && v.data >= da) m.set(v.prodottoId, (m.get(v.prodottoId) || 0) + (v.sfuso ? 1 : v.qta));
  return [...m.entries()].map(([id, q]) => [prodotto(id), q]).filter(([p]) => p && !(p.codici || []).length).sort((a, b) => b[1] - a[1]).slice(0, n).map(x => x[0]);
}
function senzaCodiceModal() {
  const titolo = { vendita: 'Vendi senza codice', reso: 'Reso: cerca il prodotto', spreco: 'Spreco: cerca il prodotto' }[BANCO.modo];
  const top = piuVendutiSenzaCodice();
  openModal(`${mhead(titolo)}<div class="stack" id="scWrap">
    <label class="field">Cerca per nome<input type="search" id="scQ" placeholder="Scrivi le prime lettere" autocomplete="off"></label>
    <div id="scRis"></div>
    <div class="section-title"><h2>I più venduti senza codice</h2></div>
    ${top.length ? `<div class="grid-prod">${top.map(p => `<button type="button" data-pid="${esc(p.id)}">${esc(p.nome)}<small>${prezzoBreve(p)}</small></button>`).join('')}</div>` : '<div class="faint small">Qui compariranno da soli i prodotti senza codice venduti più spesso.</div>'}</div>`, b => {
    const i = b.querySelector('#scQ'), ris = b.querySelector('#scRis');
    i.addEventListener('input', () => {
      const q = i.value.trim();
      if (!q) { ris.innerHTML = ''; return; }
      const r = cerca(q, { limit: 12 });
      ris.innerHTML = r.items.length ? `<div class="list">${r.items.map(p => `<button class="item" type="button" data-pid="${esc(p.id)}"><div class="main"><div class="name">${esc(p.nome)}</div><div class="sub">${esc(nomeForn(p.fornitoreId))}${p.formato ? ' · ' + esc(p.formato) : ''} · in negozio ${fq(p, giacenza(p.id))}</div></div><span class="prezzo">${prezzoBreve(p)}</span></button>`).join('')}</div>${r.total > r.items.length ? `<div class="faint small">Altri ${r.total - r.items.length}: scrivi di più per restringere</div>` : ''}` : '<div class="empty">Nessun prodotto trovato.</div>';
    });
    b.querySelector('#scWrap').addEventListener('click', e => {
      const el = e.target.closest('[data-pid]'); if (!el) return;
      const p = prodotto(el.dataset.pid); closeModal(); if (p) azioneBanco(p);
    });
    setTimeout(() => i.focus(), 50);
  }, { onScan: code => { closeModal(); bancoScan(code); } });
}
function daSistemareModal() {
  const g = new Map();
  for (const v of daSistemare()) { const x = g.get(v.codice) || { codice: v.codice, qta: 0, ultima: '' }; x.qta += v.qta; if (v.data > x.ultima) x.ultima = v.data; g.set(v.codice, x); }
  const gruppi = [...g.values()].sort((a, b) => b.ultima.localeCompare(a.ultima));
  openModal(`${mhead('Da sistemare')}
    <p class="muted small" style="margin:0">Codici venduti che l'app non conosceva. Collega ognuno al prodotto giusto: i pezzi venduti escono dal magazzino da soli.</p>
    ${gruppi.length ? `<div class="list">${gruppi.map(x => `<div class="item" style="flex-wrap:wrap"><div class="main" style="flex:1 1 60%"><div class="name mono">${esc(x.codice)}</div><div class="sub">${fmtNum(x.qta)} pz venduti · ultima volta ${fmtDate(x.ultima)}</div></div>
      <div class="conf-acts"><button class="btn small" type="button" data-act="ds-collega" data-c="${esc(x.codice)}">Collega</button><button class="btn small ghost" type="button" data-act="ds-elimina" data-c="${esc(x.codice)}">Elimina</button></div></div>`).join('')}</div>` : '<div class="empty">Niente da sistemare.</div>'}`);
}

/* =========================================================
   CHIUSURA DI FINE GIORNATA
   ========================================================= */
let CH = null;
const fmtImporto = n => n == null ? '' : Number(n).toFixed(2).replace('.', ',');
function datiChiusura() {
  const oggi = todayISO(), righe = venditeDel(oggi);
  const scansionato = Math.round(righe.reduce((t, v) => t + (importo(v) || 0), 0) * 100) / 100;
  const inc = parseNum(CH.incasso), fr = parseNum(CH.frutta);
  const confronto = inc == null ? null : Math.round((inc - (fr || 0)) * 100) / 100;
  const diff = confronto == null ? null : Math.round((scansionato - confronto) * 100) / 100;
  const pct = confronto ? Math.abs(diff) / confronto * 100 : null;
  return { oggi, righe, scansionato, inc, fr, confronto, diff, pct };
}
function riepilogoChiusuraHTML() {
  const d = datiChiusura();
  let h = `<dl class="kv"><dt>Da confrontare</dt><dd>${d.confronto == null ? '–' : fmtEuro(d.confronto)}</dd><dt>Scansionato nell'app</dt><dd>${fmtEuro(d.scansionato)}</dd></dl>`;
  if (d.diff == null) return h + `<div class="faint small">Scrivi l'incasso per vedere la differenza.</div>`;
  const ok = Math.abs(d.diff) < 0.005 || (d.pct != null && d.pct < 2);
  h += `<div class="row"><div class="spacer"><b>Differenza</b><div><span class="tag ${ok ? 'ok' : 'warn'}">${d.pct == null ? '' : fmtNum(d.pct.toFixed(1)) + '% · '}${ok ? 'va bene' : 'da controllare'}</span></div></div><span class="diff">${d.diff > 0 ? '+ ' : d.diff < 0 ? '− ' : ''}${fmtEuro(Math.abs(d.diff))}</span></div>`;
  if (!ok) h += `<div class="faint small">${d.diff < 0 ? 'Nell\'app c\'è meno che in cassa: forse qualche prodotto non è stato scansionato.' : 'Nell\'app c\'è più che in cassa: controlla scansioni doppie o prezzi diversi da quelli della cassa.'}</div>`;
  return h;
}
routes.chiusura = () => {
  const oggi = todayISO(), salvata = S.chiusure.get('c' + oggi);
  if (!CH || CH.data !== oggi) CH = { data: oggi, incasso: salvata ? fmtImporto(salvata.incasso) : '', frutta: salvata ? fmtImporto(salvata.frutta) : '' };
  const righe = venditeDel(oggi);
  const senzaPrezzo = new Set(righe.filter(v => v.prodottoId && prezzoRiga(v) == null).map(v => v.prodottoId)).size;
  const senzaCarico = new Set(righe.filter(v => v.tipo === 'vendita' && mancaVisibile(v)).map(v => v.prodottoId)).size;
  const codiciDS = new Set(daSistemare().map(v => v.codice)).size;
  const voce = (act, extra, titolo, sotto) => `<button class="item" type="button" data-act="${act}" ${extra}><span class="dot" aria-hidden="true"></span><div class="main"><div class="name">${titolo}</div><div class="sub">${sotto}</div></div><span class="chev">›</span></button>`;
  const controlli = [];
  if (codiciDS) controlli.push(voce('ds-apri', '', codiciDS === 1 ? '1 codice da sistemare' : `${codiciDS} codici da sistemare`, 'Venduti ma non ancora collegati a un prodotto'));
  if (senzaCarico) controlli.push(voce('ch-lista', 'data-l="carico"', senzaCarico === 1 ? '1 prodotto venduto senza carico' : `${senzaCarico} prodotti venduti senza carico`, 'Probabile arrivo non registrato'));
  if (senzaPrezzo) controlli.push(voce('ch-lista', 'data-l="prezzo"', senzaPrezzo === 1 ? '1 prodotto senza prezzo' : `${senzaPrezzo} prodotti senza prezzo`, 'Non contano nel confronto con la cassa'));
  const html = `<div><h2 style="margin:0">${esc(fmtDateLong(oggi))}</h2>${salvata ? `<div class="faint">Chiusura salvata alle ${fmtOra(salvata.creato)}: puoi correggerla e salvarla di nuovo.</div>` : ''}</div>
    <div class="card"><h3>Dalla cassa</h3>
      <label class="field">Incasso totale €<input type="text" inputmode="decimal" id="chInc" value="${esc(CH.incasso)}" autocomplete="off" placeholder="es. 612,40"></label>
      <label class="field">Di cui frutta e verdura € <span class="hint">dalla chiusura per reparto della cassa; se la cassa non lo separa, lascia vuoto</span><input type="text" inputmode="decimal" id="chFr" value="${esc(CH.frutta)}" autocomplete="off"></label></div>
    <div class="card" id="chRis" aria-live="polite">${riepilogoChiusuraHTML()}</div>
    <div class="section-title"><h2>Da controllare</h2></div>
    ${controlli.length ? `<div class="list">${controlli.join('')}</div>` : '<div class="notice green"><span>Niente da controllare.</span></div>'}
    <button class="btn primary block" type="button" data-act="ch-chiudi">Chiudi la giornata e fai il backup</button>
    <div class="faint small" style="text-align:center">Il backup va sul Google Drive del negozio.</div>`;
  return {
    title: 'Chiusura di oggi', html, back: '#banco', tab: 'banco',
    mount: b => {
      const upd = () => { CH.incasso = b.querySelector('#chInc').value; CH.frutta = b.querySelector('#chFr').value; b.querySelector('#chRis').innerHTML = riepilogoChiusuraHTML(); };
      b.querySelector('#chInc').addEventListener('input', upd);
      b.querySelector('#chFr').addEventListener('input', upd);
      if (daCollegarePronti()) inCoda(sistemaEAvvisa);
    },
    onScan: () => toast('Sei nella chiusura: per vendere torna al Banco', { err: true })
  };
};

/* =========================================================
   ORDINI
   ========================================================= */
const METODI ={ whatsapp: 'WhatsApp', email: 'Email', sito: 'Sito', telefono: 'Telefono', interno: 'Produzione interna', '': 'Da impostare' };
async function aggiungiOrdine(pid, qta = 1, { silent = false } = {}) {
  const p = prodotto(pid); if (!p) return;
  if (!p.fornitoreId) { toast(`${p.nome} non ha un fornitore: aggiungilo nella scheda prodotto`, { err: true }); return; }
  let o = ordineAperto(p.fornitoreId);
  if (!o) o = { id: uid('o'), fornitoreId: p.fornitoreId, stato: 'aperto', righe: [], creato: Date.now(), inviato: null, chiuso: null };
  const righe = o.righe.map(r => ({ ...r }));
  const r = righe.find(r => r.prodottoId === pid);
  if (r) r.qta += qta; else righe.push({ prodottoId: pid, qta, ricevuto: 0 });
  await save('ordini', { ...o, righe });
  if (!silent) {
    const u = ultimoOrdine(pid);
    toast(`Da ordinare: ${p.nome}${u ? ` · ultima volta ${p.sfuso ? fmtSacchi(u.qta, p) : fmtNum(u.qta)} il ${fmtDate(u.data)}` : ''}`);
  }
}
function normTel(t) {
  let d = String(t || '').replace(/[^\d+]/g, '');
  if (d.startsWith('+')) d = d.slice(1); else if (d.startsWith('00')) d = d.slice(2);
  else if (d.length >= 9 && d.length <= 10) d = '39' + d;
  return d;
}
function testoOrdine(o) {
  const righe = o.righe.filter(r => r.qta > 0).map(r => { const p = prodotto(r.prodottoId); return isSfuso(p) ? `- ${fmtSacchi(r.qta, p)} ${p.pesoSacco ? 'da ' + fmtSf(p, p.pesoSacco) + ' ' : ''}di ${p.nome}` : `- ${fmtNum(r.qta)} x ${p ? p.nome : '?'}`; });
  return `Buongiorno,\nvorrei ordinare:\n${righe.join('\n')}\n\nGrazie,\n${settings().negozio}`;
}
function ordiniHTML() {
  const aperti = [...S.ordini.values()].filter(o => o.stato === 'aperto' && o.righe.length).sort((a, b) => nomeForn(a.fornitoreId).localeCompare(nomeForn(b.fornitoreId), 'it'));
  const inviati = ordiniInviati();
  const chiusi = [...S.ordini.values()].filter(o => o.stato === 'chiuso').sort((a, b) => (b.chiuso || '').localeCompare(a.chiuso || '')).slice(0, 10);
  let html = scanbox('Giro ordini: scansiona quello che sta finendo', 'Ogni scansione aggiunge 1 al prossimo ordine di quel fornitore.', 'ord-cerca');
  html += `<div class="section-title"><h2>Da ordinare</h2><span class="count">${aperti.length ? aperti.length + ' fornitori' : ''}</span></div>`;
  if (!aperti.length) html += `<div class="empty">La lista è vuota. Scansiona i prodotti che stanno finendo, anche durante la settimana.</div>`;
  for (const o of aperti) {
    const f = fornitore(o.fornitoreId);
    html += `<section class="supplier"><header><div class="main"><h3>${esc(nomeForn(o.fornitoreId))}</h3><div class="faint">${METODI[(f && f.metodo) || '']}${f && f.note ? ' · ' + esc(f.note) : ''}</div></div>
      <a class="btn small ghost" href="#fornitore/${encodeURIComponent(o.fornitoreId)}">Contatti</a></header>
      ${o.righe.map(r => {
      const p = prodotto(r.prodottoId), u = ultimoOrdine(r.prodottoId);
      return `<div class="item ord-row"><div class="main"><div class="name">${esc(p ? p.nome : '?')}${p && p.sfuso ? ` <span class="tag sfuso">${nomeSacco(p, 2)}${p.pesoSacco ? ' da ' + fmtSf(p, p.pesoSacco) : ''}</span>` : ''}</div><div class="sub">${u ? `ultima volta ${p && p.sfuso ? fmtSacchi(u.qta, p) : fmtNum(u.qta)} il ${fmtDate(u.data)}` : 'mai ordinato nell\'app'}${p ? ' · in negozio ' + fq(p, giacenza(p.id)) : ''}</div></div>
        <div class="mini-stepper"><button type="button" data-act="riga-" data-o="${esc(o.id)}" data-p="${esc(r.prodottoId)}" aria-label="Meno">−</button><input type="number" inputmode="numeric" min="0" value="${r.qta}" data-riga="${esc(o.id)}|${esc(r.prodottoId)}" aria-label="Quantità"><button type="button" data-act="riga+" data-o="${esc(o.id)}" data-p="${esc(r.prodottoId)}" aria-label="Più">+</button></div>
        <button class="btn small ghost" type="button" data-act="riga-del" data-o="${esc(o.id)}" data-p="${esc(r.prodottoId)}" aria-label="Togli">×</button></div>`;
    }).join('')}
      <footer><button class="btn primary" type="button" data-act="ord-invia" data-o="${esc(o.id)}">Invia ordine</button></footer></section>`;
  }
  if (inviati.length) {
    html += `<div class="section-title"><h2>In arrivo</h2><span class="count">${inviati.length}</span></div>`;
    for (const o of inviati) {
      const tot = o.righe.length, ok = o.righe.filter(r => (r.ricevuto || 0) >= r.qta).length;
      html += `<section class="supplier"><header><div class="main"><h3>${esc(nomeForn(o.fornitoreId))}</h3><div class="faint">inviato il ${fmtDate(o.inviato)} · arrivati ${ok} su ${tot}</div></div></header>
        ${o.righe.map(r => { const p = prodotto(r.prodottoId), ric = r.ricevuto || 0; const st = ric >= r.qta ? 'ok' : ric > 0 ? 'warn' : ''; return `<div class="item"><div class="main"><div class="name">${esc(p ? p.nome : '?')}</div></div><span class="progress tag ${st}">${fmtNum(Math.round(ric * 100) / 100)} / ${fmtNum(r.qta)}</span><button class="btn small" type="button" data-act="ord-riga-mod" data-o="${esc(o.id)}" data-p="${esc(r.prodottoId)}">Modifica</button></div>`; }).join('')}
        <footer><button class="btn" type="button" data-act="ord-riapri" data-o="${esc(o.id)}">Riapri</button><button class="btn" type="button" data-act="ord-chiudi" data-o="${esc(o.id)}">Chiudi ordine</button></footer></section>`;
    }
  }
  if (chiusi.length) {
    html += `<div class="section-title"><h2>Ultimi ordini chiusi</h2></div><div class="list">${chiusi.map(o => `<div class="item" style="flex-wrap:wrap"><div class="main" style="flex:1 1 60%"><div class="name">${esc(nomeForn(o.fornitoreId))}</div><div class="sub">inviato ${fmtDate(o.inviato)} · chiuso ${fmtDate(o.chiuso)} · ${o.righe.length} prodotti</div></div>
      <div class="row" style="gap:6px"><button class="btn small" type="button" data-act="ord-riapri-chiuso" data-o="${esc(o.id)}">Riapri</button><button class="btn small ghost" type="button" data-act="ord-elimina" data-o="${esc(o.id)}" aria-label="Elimina ordine">×</button></div></div>`).join('')}</div>`;
  }
  return html;
}
routes.ordini = () => ({
  title: 'Ordini', html: ordiniHTML(), tab: 'ordini',
  mount: b => {
    b.addEventListener('change', async e => {
      const i = e.target.closest('[data-riga]'); if (!i) return;
      const [oid, pid] = i.dataset.riga.split('|'); const o = S.ordini.get(oid); const v = Math.max(0, parseInt(i.value, 10) || 0);
      await save('ordini', { ...o, righe: o.righe.map(r => r.prodottoId === pid ? { ...r, qta: v } : r) });
    });
  },
  onScan: code => { const p = byCode(code); if (p) { aggiungiOrdine(p.id).then(() => render()); } else collegaCodice(code, p2 => aggiungiOrdine(p2.id).then(() => render())); }
});
function inviaOrdineModal(o) {
  const f = fornitore(o.fornitoreId) || {};
  const tel = normTel(f.telefono);
  const testo = testoOrdine(o);
  openModal(`${mhead('Invia ordine a ' + nomeForn(o.fornitoreId))}
    <label class="field">Testo dell'ordine <span class="hint">puoi modificarlo prima di inviare</span><textarea id="ordTxt">${esc(testo)}</textarea></label>
    ${!tel && !f.email && !f.sito ? `<div class="notice"><span>Per questo fornitore non ci sono contatti. <a href="#fornitore/${encodeURIComponent(o.fornitoreId)}">Aggiungili</a>, oppure usa Condividi.</span></div>` : ''}
    <div class="stack">
      ${tel ? `<button class="btn primary block" type="button" data-x="wa">Apri WhatsApp</button>` : ''}
      ${f.email ? `<button class="btn ${tel ? '' : 'primary'} block" type="button" data-x="mail">Apri email</button>` : ''}
      ${f.sito ? `<button class="btn block" type="button" data-x="sito">Apri il sito del fornitore</button>` : ''}
      <div class="btn-grid" style="grid-template-columns:1fr 1fr"><button class="btn" type="button" data-x="copia">Copia testo</button><button class="btn" type="button" data-x="share">Condividi</button></div>
      <button class="btn block" type="button" data-x="fatto" style="border-color:var(--accent);color:var(--accent)">Segna come inviato</button>
    </div>`, b => {
    const txt = () => b.querySelector('#ordTxt').value;
    const on = (k, fn) => { const el = b.querySelector(`[data-x=${k}]`); if (el) el.onclick = fn; };
    on('wa', () => window.open(`https://wa.me/${tel}?text=${encodeURIComponent(txt())}`, '_blank'));
    on('mail', () => { location.href = `mailto:${encodeURIComponent(f.email)}?subject=${encodeURIComponent('Ordine ' + settings().negozio)}&body=${encodeURIComponent(txt())}`; });
    on('sito', () => { let u = f.sito; if (!/^https?:/i.test(u)) u = 'https://' + u; window.open(u, '_blank'); });
    on('copia', async () => { try { await navigator.clipboard.writeText(txt()); toast('Testo copiato'); } catch (e) { b.querySelector('#ordTxt').select(); toast('Seleziona e copia il testo', { err: true }); } });
    on('share', () => condividiTesto(txt(), 'Testo'));
    on('fatto', async () => {
      await save('ordini', { ...o, stato: 'inviato', inviato: todayISO(), righe: o.righe.filter(r => r.qta > 0), testo: txt() });
      closeModal(); toast('Ordine segnato come inviato'); render();
    });
  });
}

/* =========================================================
   CATALOGO, PRODOTTO, FORNITORI
   ========================================================= */
let CAT = { q: '', forn: '', limite: 60, senzaCodice: false, sfuso: false };
function catListHTML() {
  const res = cerca(CAT.q, { fornitoreId: CAT.forn, limit: CAT.limite, soloSenzaCodice: CAT.senzaCodice, soloSfuso: CAT.sfuso });
  if (!res.total) return `<div class="empty">Nessun prodotto.</div>`;
  const prima = new Map();
  for (const l of lottiAttivi()) if (l.scadenza) { const x = prima.get(l.prodottoId); if (!x || l.scadenza < x) prima.set(l.prodottoId, l.scadenza); }
  return `<div class="faint">${res.total} prodotti</div><div class="list">${res.items.map(p => {
    const g = giacenza(p.id), s = prima.get(p.id);
    return `<a class="item" href="#prodotto/${encodeURIComponent(p.id)}"><div class="main"><div class="name">${esc(p.nome)}</div>
      <div class="sub">${esc(nomeForn(p.fornitoreId))}${p.formato ? ' · ' + esc(p.formato) : ''}${g ? ' · in negozio ' + fq(p, g) : ''}${s ? ' · scade ' + fmtDate(s) : ''}</div></div>
      ${p.sfuso ? '<span class="tag sfuso">sfuso</span>' : ''}${(p.codici || []).length ? '<span class="tag ok">codice</span>' : ''}<span class="chev">›</span></a>`;
  }).join('')}</div>${res.total > res.items.length ? `<button class="btn block" type="button" data-act="cat-altri">Mostra altri (${res.total - res.items.length})</button>` : ''}`;
}
const segCat = on => `<div class="segmented"><a href="#catalogo" class="${on === 'p' ? 'on' : ''}">Prodotti</a><a href="#fornitori" class="${on === 'f' ? 'on' : ''}">Fornitori</a></div>`;
routes.catalogo = arg => {
  if (current.fresh && arg) { CAT.forn = arg; CAT.q = ''; CAT.limite = 60; }
  const forn = [...S.fornitori.values()].sort((a, b) => a.nome.localeCompare(b.nome, 'it'));
  const html = `${segCat('p')}
    <input type="search" id="catQ" placeholder="Cerca per nome o codice" value="${esc(CAT.q)}" autocomplete="off">
    <div class="row wrap"><select id="catF" style="flex:1;min-width:200px"><option value="">Tutti i fornitori</option>${forn.map(f => `<option value="${esc(f.id)}" ${CAT.forn === f.id ? 'selected' : ''}>${esc(f.nome)}</option>`).join('')}</select>
      <label class="check"><input type="checkbox" id="catSC" ${CAT.senzaCodice ? 'checked' : ''}> Senza codice</label>
      <label class="check"><input type="checkbox" id="catSF" ${CAT.sfuso ? 'checked' : ''}> Sfuso</label></div>
    ${[...S.prodotti.values()].some(p => p.sfuso) ? '<a class="btn block" href="#etichette">Etichette dei contenitori sfusi</a>' : ''}
    <div id="catList" class="stack">${catListHTML()}</div>
    <button class="btn block" type="button" data-act="nuovo-prodotto">+ Nuovo prodotto</button>`;
  return {
    title: 'Catalogo', html, tab: 'catalogo',
    mount: b => {
      const upd = () => { CAT.limite = 60; b.querySelector('#catList').innerHTML = catListHTML(); };
      b.querySelector('#catQ').addEventListener('input', e => { CAT.q = e.target.value; upd(); });
      b.querySelector('#catF').addEventListener('change', e => { CAT.forn = e.target.value; upd(); });
      b.querySelector('#catSC').addEventListener('change', e => { CAT.senzaCodice = e.target.checked; upd(); });
      b.querySelector('#catSF').addEventListener('change', e => { CAT.sfuso = e.target.checked; upd(); });
    },
    onScan: code => { const p = byCode(code); if (p) location.hash = '#prodotto/' + encodeURIComponent(p.id); else collegaCodice(code, p2 => { location.hash = '#prodotto/' + encodeURIComponent(p2.id); }); }
  };
};
/* scheda prodotto: codici e etichetta si aggiornano senza perdere quello che si sta scrivendo */
const codiciHtml = p => (p.codici || []).map(c => `<span class="tag" style="font-size:.9rem;padding:6px 10px">${esc(c)} <button type="button" data-act="p-codice-del" data-c="${esc(c)}" style="border:0;background:none;font-size:1rem;cursor:pointer" aria-label="Togli codice">×</button></span>`).join('') || '<span class="faint">Nessun codice: scansiona ora il prodotto per collegarlo.</span>';
const infoSfuso = u => u === 'l' ? 'Magazzino in litri, prezzo al litro. Al banco si scansiona l\'etichetta e si scrivono i ml.'
  : `Magazzino in kg, prezzo ${UNITA[u].al}. Al banco si scansiona l'etichetta del contenitore e si scrivono i grammi.`;
function boxEtichetta(p) {
  if (!(p.codici || []).length) return `<label class="check"><input type="checkbox" id="pCrea" checked> Crea il codice a barre e stampa l'etichetta</label>
    <div class="faint small">Se il sacco ha già il suo codice, togli la spunta e scansionalo adesso: si collega da solo.</div>`;
  if (!p.sfuso) return `<div class="faint small">L'etichetta userà il codice ${esc(codiceEtichetta(p))}: dopo aver salvato la stampi da qui.</div>`;
  return `<button class="btn block" type="button" data-act="p-stampa-eti" data-id="${esc(p.id)}">Stampa l'etichetta</button>`;
}
function aggiornaCodici() {
  const p = prodotto(current.arg); if (!p) return;
  const c = $('#pCodici'); if (c) c.innerHTML = codiciHtml(p);
  const e = $('#pEtiBox'); if (e) e.innerHTML = boxEtichetta(p);
}
routes.prodotto = id => {
  const p = prodotto(id);
  if (!p) return { title: 'Prodotto', html: '<div class="empty">Prodotto non trovato.</div>', back: '#catalogo', tab: 'catalogo' };
  const forn = [...S.fornitori.values()].sort((a, b) => a.nome.localeCompare(b.nome, 'it'));
  const lotti = lottiAttivi().filter(l => l.prodottoId === p.id).sort((a, b) => (a.scadenza || '9').localeCompare(b.scadenza || '9'));
  const calc = prezzoCalcolato(p);
  const html = `<div><h2 style="margin:0">${esc(p.nome)}</h2><div class="faint">${esc(nomeForn(p.fornitoreId))}${p.formato ? ' · ' + esc(p.formato) : ''}</div></div>
    <div class="section-title"><h2>In negozio</h2><span class="count">${fq(p, giacenza(p.id))}</span></div>
    ${lotti.length ? `<div class="faint small">Per cambiare la scadenza o ${p.sfuso ? 'i ' + nomeBase(p) : 'i pezzi'} tocca <b>Modifica</b>.</div><div class="list">${lotti.map(l => rigaConfezione(l, { arrivo: true })).join('')}</div>` : '<div class="empty">Nessuna confezione registrata.</div>'}
    <div class="btn-grid" style="grid-template-columns:1fr 1fr"><button class="btn" type="button" data-act="sr-carico" data-id="${esc(p.id)}">Arrivo merce</button><button class="btn" type="button" data-act="sr-ordina" data-id="${esc(p.id)}">Aggiungi all'ordine</button></div>
    <div class="section-title"><h2>Dati del prodotto</h2></div>
    <div class="card">
      <label class="field">Nome<textarea id="pNome" rows="2" style="min-height:0">${esc(p.nome)}</textarea></label>
      <label class="field">Fornitore<select id="pForn"><option value="">— nessuno —</option>${forn.map(f => `<option value="${esc(f.id)}" ${p.fornitoreId === f.id ? 'selected' : ''}>${esc(f.nome)}</option>`).join('')}</select></label>
      <div class="btn-grid" style="grid-template-columns:1fr 1fr">
        <label class="field">Formato<input type="text" id="pFormato" value="${esc(p.formato)}"></label>
        <label class="field">Categoria<input type="text" id="pCat" value="${esc(p.categoria)}"></label></div>
      <label class="field">Tipo di scadenza<select id="pTipo"><option value="preferibilmente" ${p.tipoScadenza !== 'entro' ? 'selected' : ''}>Preferibilmente entro (secchi, conserve)</option><option value="entro" ${p.tipoScadenza === 'entro' ? 'selected' : ''}>Da consumarsi entro (freschi)</option></select></label>
      <div class="field" style="font-weight:600">Codici a barre
        <div class="row wrap" id="pCodici">${codiciHtml(p)}</div></div>
    </div>
    <div class="card"><h3>Sfuso</h3>
      <label class="check"><input type="checkbox" id="pSfuso" ${p.sfuso ? 'checked' : ''}> Sfuso (a peso o alla spina)</label>
      <div class="stack" id="pSfusoBox" ${p.sfuso ? '' : 'hidden'}>
        ${campoUnita('pUnita', unitaDi(p))}
        <label class="field"><span data-sacco-lab>${testoSacco(unitaDi(p))}</span> <span class="hint" data-sacco-hint>${hintSacco(unitaDi(p))}</span><input type="text" inputmode="decimal" id="pSacco" value="${p.pesoSacco ? fmtNum(p.pesoSacco) : ''}"></label>
        <div class="faint small" id="pSfInfo">${infoSfuso(unitaDi(p))}</div>
        <div class="stack" id="pEtiBox">${boxEtichetta(p)}</div>
      </div></div>
    <div class="card"><h3>Prezzi</h3>
      <div class="btn-grid" style="grid-template-columns:1fr 1fr">
        <label class="field"><span>Acquisto €<span class="u-base">${alBase(p)}</span></span><input type="text" inputmode="decimal" id="pAcq" value="${p.prezzoAcquisto != null ? fmtNum(p.prezzoAcquisto) : ''}"></label>
        <label class="field">IVA<select id="pIva"><option value="">—</option>${[4, 10, 22].map(v => `<option value="${v}" ${p.iva === v ? 'selected' : ''}>${v}%</option>`).join('')}</select></label>
        <label class="field">Ricarico<select id="pRic"><option value="50" ${p.ricarico !== 40 ? 'selected' : ''}>50%</option><option value="40" ${p.ricarico === 40 ? 'selected' : ''}>40% (eccezione)</option></select></label>
        <label class="field"><span>Prezzo a mano €<span class="u-kg">${alKg(p)}</span></span><input type="text" inputmode="decimal" id="pMan" value="${p.prezzoManuale != null ? fmtNum(Math.round(p.prezzoManuale * (isSfuso(p) ? UNITA[unitaDi(p)].f : 1) * 1000) / 1000) : ''}" placeholder="vuoto = calcolato"></label></div>
      <dl class="kv"><dt>Prezzo calcolato</dt><dd id="pCalc">${fmtEuro(perUnita(p, calc))}<span class="u-kg">${alKg(p)}</span></dd><dt>Prezzo nel listino</dt><dd>${fmtEuro(p.prezzoVendita)}</dd></dl>
      <div class="faint small">Calcolato: acquisto + ricarico + IVA, arrotondato ai 10 centesimi superiori.</div></div>
    <div class="card"><label class="field">Note<textarea id="pNote" style="min-height:80px">${esc(p.note)}</textarea></label>
      ${p.origine ? `<div class="faint small">Origine: ${esc(p.origine)}</div>` : ''}</div>
    <button class="btn primary block" type="button" data-act="p-salva" data-id="${esc(p.id)}">Salva modifiche</button>
    <button class="btn danger block" type="button" data-act="p-elimina" data-id="${esc(p.id)}">Elimina prodotto</button>`;
  return {
    title: 'Scheda prodotto', html, back: '#catalogo', tab: 'catalogo',
    mount: b => {
      // la scheda com'è nel modulo, anche prima di salvare
      const forma = () => ({ sfuso: b.querySelector('#pSfuso').checked, unita: b.querySelector('#pUnita').value });
      const upd = () => {
        const tmp = { prezzoAcquisto: parseNum(b.querySelector('#pAcq').value), iva: parseNum(b.querySelector('#pIva').value), ricarico: +b.querySelector('#pRic').value };
        b.querySelector('#pCalc').innerHTML = fmtEuro(perUnita(forma(), prezzoCalcolato(tmp))) + `<span class="u-kg">${alKg(forma())}</span>`;
      };
      const unitaTesti = () => {
        const fp = forma();
        $$('.u-kg', b).forEach(x => { x.textContent = alKg(fp); });
        $$('.u-base', b).forEach(x => { x.textContent = alBase(fp); });
        aggiornaTestiSacco(b, fp.unita); b.querySelector('#pSfInfo').textContent = infoSfuso(fp.unita);
        upd();
      };
      ['#pAcq', '#pIva', '#pRic'].forEach(s => b.querySelector(s).addEventListener('input', upd));
      b.querySelector('#pSfuso').addEventListener('change', e => {
        b.querySelector('#pSfusoBox').hidden = !e.target.checked;
        unitaTesti();
        if (e.target.checked) setTimeout(() => b.querySelector('#pSacco').focus(), 50);
      });
      // da kg a etto e ritorno: il prezzo a mano già scritto si converte
      let unitaPrima = b.querySelector('#pUnita').value;
      b.querySelector('#pUnita').addEventListener('change', e => {
        const m = b.querySelector('#pMan'), v = parseNum(m.value);
        if (v != null && m.value.trim()) m.value = fmtNum(Math.round(v * UNITA[e.target.value].f / UNITA[unitaPrima].f * 100) / 100);
        unitaPrima = e.target.value; unitaTesti();
      });
    },
    onScan: async code => {
      const prima = byCode(code);
      if (prima && prima.id === p.id) { toast('Questo codice è già collegato'); return; }
      if (prima && !(await confirmBox(`Il codice è collegato a "${prima.nome}". Lo sposto su questo prodotto?`, { ok: 'Sposta' }))) return;
      if (prima) await save('prodotti', { ...prima, codici: prima.codici.filter(c => c !== code) });
      const cur = prodotto(p.id);
      await save('prodotti', { ...cur, codici: [...new Set([...(cur.codici || []), code])] });
      toast('Codice collegato'); aggiornaCodici();
    }
  };
};
routes.fornitori = () => {
  const counts = new Map(); for (const p of S.prodotti.values()) counts.set(p.fornitoreId, (counts.get(p.fornitoreId) || 0) + 1);
  const all = [...S.fornitori.values()];
  const dn = all.filter(f => f.daNominare).sort((a, b) => a.nome.localeCompare(b.nome, 'it'));
  const ok = all.filter(f => !f.daNominare).sort((a, b) => a.nome.localeCompare(b.nome, 'it'));
  const row = f => `<a class="item" href="#fornitore/${encodeURIComponent(f.id)}"><div class="main"><div class="name">${esc(f.nome)}</div><div class="sub">${counts.get(f.id) || 0} prodotti · ${METODI[f.metodo || '']}</div></div>${f.daNominare ? '<span class="tag warn">da nominare</span>' : ''}<span class="chev">›</span></a>`;
  const html = `${segCat('f')}
    ${dn.length ? `<div class="section-title"><h2>Da nominare</h2><span class="count">${dn.length}</span></div><div class="faint small">Nei listini questi fogli non avevano il nome del fornitore. Apri e scrivi il nome giusto.</div><div class="list">${dn.map(row).join('')}</div>` : ''}
    <div class="section-title"><h2>Fornitori</h2><span class="count">${ok.length}</span></div>
    <div class="list">${ok.map(row).join('') || '<div class="empty">Nessun fornitore.</div>'}</div>
    <button class="btn block" type="button" data-act="nuovo-fornitore">+ Nuovo fornitore</button>`;
  return { title: 'Fornitori', html, tab: 'catalogo' };
};
routes.fornitore = id => {
  const f = fornitore(id);
  if (!f) return { title: 'Fornitore', html: '<div class="empty">Fornitore non trovato.</div>', back: '#fornitori', tab: 'catalogo' };
  const n = [...S.prodotti.values()].filter(p => p.fornitoreId === f.id).length;
  const html = `<div class="card">
      <label class="field">Nome<input type="text" id="fNome" value="${esc(f.nome)}"></label>
      <label class="field">Come si ordina<select id="fMet">${Object.entries(METODI).map(([k, v]) => `<option value="${k}" ${(f.metodo || '') === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label class="field">Telefono / WhatsApp<input type="tel" id="fTel" value="${esc(f.telefono)}" placeholder="es. 333 1234567"></label>
      <label class="field">Email<input type="email" id="fMail" value="${esc(f.email)}"></label>
      <label class="field">Sito per gli ordini<input type="url" id="fSito" value="${esc(f.sito)}" placeholder="es. www.fornitore.it"></label>
      <label class="field">Note <span class="hint">giorni di consegna, ordine minimo, trasporto</span><textarea id="fNote" style="min-height:80px">${esc(f.note)}</textarea></label>
      <button class="btn primary block" type="button" data-act="f-salva" data-id="${esc(f.id)}">Salva</button></div>
    <a class="btn block" href="#catalogo/${encodeURIComponent(f.id)}">Vedi i ${n} prodotti</a>
    ${n ? '' : `<button class="btn danger block" type="button" data-act="f-elimina" data-id="${esc(f.id)}">Elimina fornitore</button>`}`;
  return { title: 'Fornitore', html, back: '#fornitori', tab: 'catalogo' };
};

/* =========================================================
   CODICI A BARRE ED ETICHETTE DEI CONTENITORI SFUSI
   - EAN-13 / EAN-8 / UPC-A: come quelli dei sacchi; Code 128 per gli altri
   - codici creati dall'app: EAN-13 che inizia con 29 (uso interno del negozio)
   ========================================================= */
const EAN_L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const EAN_G = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111'];
const EAN_R = ['1110010', '1100110', '1101100', '1000010', '1011100', '1001110', '1010000', '1000100', '1001000', '1110100'];
const EAN_PAR = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];
const C128 = ['212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213', '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132', '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211', '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313', '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331', '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111', '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214', '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111', '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141', '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141', '114131', '311141', '411131', '211412', '211214', '211232', '2331112'];
function eanCheck(d) { let s = 0; for (let i = 0; i < d.length; i++) s += (+d[d.length - 1 - i]) * (i % 2 === 0 ? 3 : 1); return (10 - s % 10) % 10; }
function barreCodice(code) {
  code = String(code || '').trim();
  if (/^\d{12}$/.test(code)) code = '0' + code;   // UPC-A
  if (/^\d{13}$/.test(code)) {
    const par = EAN_PAR[+code[0]]; let b = '101';
    for (let i = 1; i <= 6; i++) b += (par[i - 1] === 'L' ? EAN_L : EAN_G)[+code[i]];
    b += '01010';
    for (let i = 7; i <= 12; i++) b += EAN_R[+code[i]];
    return b + '101';
  }
  if (/^\d{8}$/.test(code)) {
    let b = '101';
    for (let i = 0; i < 4; i++) b += EAN_L[+code[i]];
    b += '01010';
    for (let i = 4; i < 8; i++) b += EAN_R[+code[i]];
    return b + '101';
  }
  const vals = [104];
  for (const ch of code) { const c = ch.charCodeAt(0); if (c < 32 || c > 126) return null; vals.push(c - 32); }
  let sum = 104; for (let i = 1; i < vals.length; i++) sum += vals[i] * i;
  vals.push(sum % 103, 106);
  let b = '';
  for (const v of vals) { const w = C128[v]; for (let j = 0; j < w.length; j++) b += (j % 2 === 0 ? '1' : '0').repeat(+w[j]); }
  return b;
}
function barcodeSVG(code) {
  const bits = barreCodice(code); if (!bits) return '';
  const q = 10, w = bits.length + 2 * q;
  let r = '', i = 0;
  while (i < bits.length) {
    if (bits[i] === '1') { let j = i; while (j < bits.length && bits[j] === '1') j++; r += `<rect x="${i + q}" y="0" width="${j - i}" height="50"/>`; i = j; } else i++;
  }
  return `<svg class="barre" viewBox="0 0 ${w} 50" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg" aria-label="Codice ${esc(code)}" role="img"><rect width="${w}" height="50" fill="#fff"/><g fill="#000">${r}</g></svg>`;
}
/* con più dispositivi, ognuno ha il suo numero (10-99) dentro il codice: due dispositivi non creano mai lo stesso codice */
function formaCodice(n) {
  const slot = S.meta.syncSlot;
  const d = slot ? '29' + String(slot).padStart(2, '0') + String(n).padStart(8, '0') : '29' + String(n).padStart(10, '0');
  return d + eanCheck(d);
}
async function codiceInterno() {
  let n = S.meta.ultimoCodiceInterno || 0, code;
  do { n++; code = formaCodice(n); } while (codeIndex.has(code));
  await setMeta('ultimoCodiceInterno', n);
  return code;
}
/* codice da stampare: quello del sacco se c'è (meglio un EAN), altrimenti nessuno */
const codiceEtichetta = p => { const cs = p.codici || []; return cs.find(c => /^\d{13}$/.test(c)) || cs.find(c => /^\d{8}$|^\d{12}$/.test(c)) || cs[0] || null; };

/* si ricordano solo quelle tolte: un prodotto appena diventato sfuso è già spuntato */
let ETI = { tolte: new Set() };
const prodottiSfusi = () => [...S.prodotti.values()].filter(p => p.sfuso).sort((a, b) => a.nome.localeCompare(b.nome, 'it'));
const etiScelte = () => prodottiSfusi().filter(p => !ETI.tolte.has(p.id));
const testoScelte = n => n === 1 ? '1 etichetta' : `${n} etichette`;
routes.etichette = () => {
  const lista = prodottiSfusi();
  const n = etiScelte().length;
  const html = lista.length ? `<div class="notice"><span>Per fogli A4 di etichette adesive <b>70 × 37 mm</b> (24 per foglio). Qui sotto vedi come vengono: togli la spunta a quelle che non ti servono.</span></div>
    <div class="row"><button class="btn small" type="button" data-act="eti-tutte">Tutte</button><button class="btn small" type="button" data-act="eti-nessuna">Nessuna</button><span class="spacer"></span><span class="faint" id="etiN">${testoScelte(n)}</span></div>
    <div class="list" id="etiList">${lista.map(p => `<label class="item eti-riga${ETI.tolte.has(p.id) ? ' tolta' : ''}"><input type="checkbox" data-eti="${esc(p.id)}" ${ETI.tolte.has(p.id) ? '' : 'checked'}><div class="eti-anteprima">${htmlEtichetta(p, true)}</div></label>`).join('')}</div>
    <button class="btn primary block" type="button" data-act="eti-stampa" id="etiStampa"${n ? '' : ' disabled'}>Stampa ${testoScelte(n)}</button>
`
    : `<div class="empty">Nessun prodotto sfuso.<br>Apri un prodotto in Catalogo e spunta «Sfuso».</div><a class="btn block" href="#catalogo">Vai al Catalogo</a>`;
  return {
    title: 'Etichette sfuso', html, back: '#catalogo', tab: 'catalogo',
    mount: b => {
      const l = b.querySelector('#etiList'); if (!l) return;
      l.addEventListener('change', e => {
        const c = e.target.closest('[data-eti]'); if (!c) return;
        if (c.checked) ETI.tolte.delete(c.dataset.eti); else ETI.tolte.add(c.dataset.eti);
        c.closest('.eti-riga').classList.toggle('tolta', !c.checked);
        const n = etiScelte().length, bt = b.querySelector('#etiStampa');
        b.querySelector('#etiN').textContent = testoScelte(n);
        bt.textContent = 'Stampa ' + testoScelte(n); bt.disabled = !n;
      });
    }
  };
};
function htmlEtichetta(p, anteprima = false) {
  const c = codiceEtichetta(p), pr = prezzoVendita(p);
  const prezzo = pr != null ? `${fmtEuro(perUnita(p, pr))} <small>${UNITA[unitaDi(p)].al}</small>` : (anteprima ? '<span class="eti-manca">prezzo da scrivere</span>' : '');
  const codice = c ? `${barcodeSVG(c)}<div class="eti-cod">${esc(c)}</div>` : (anteprima ? '<div class="eti-manca">il codice lo crea l\'app quando stampi</div>' : '');
  return `<div class="eti"><div class="eti-nome">${esc(p.nome)}</div><div class="eti-prezzo">${prezzo}</div>${codice}</div>`;
}
window.addEventListener('afterprint', () => { const st = document.getElementById('stampa'); if (st) st.remove(); });

/* finestra di stampa: anteprima e da quale etichetta del foglio partire.
   L'app ricorda dove si è fermata, così un foglio iniziato si rimette nella stampante e si continua. */
const ETI_FOGLIO = 24;
function stampaModal(ids, { titolo = null } = {}) {
  ids = ids.filter(id => S.prodotti.has(id)); if (!ids.length) return;
  const n = ids.length, p1 = prodotto(ids[0]);
  let start = Math.min(ETI_FOGLIO - 1, Math.max(0, parseInt(S.meta.etiPosizione, 10) || 0));
  const draw = b => {
    b.querySelector('#spGrid').innerHTML = Array.from({ length: ETI_FOGLIO }, (_, i) => {
      const cls = i < start ? 'usata' : i < start + n ? 'nuova' : '';
      return `<button type="button" data-pos="${i}" class="${cls}" aria-label="Parti dall'etichetta ${i + 1}">${cls === 'nuova' ? i - start + 1 : ''}</button>`;
    }).join('');
    const oltre = start + n > ETI_FOGLIO;
    b.querySelector('#spInfo').innerHTML = (start === 0 ? 'Foglio nuovo: parte dalla <b>prima</b> etichetta.' : `${start === 1 ? 'La prima è già usata' : `Le prime ${start} sono già usate`}: parte dalla <b>n. ${start + 1}</b>.`)
      + (oltre ? ' Poi continua su un altro foglio.' : '') + '<br><span class="faint">Tocca il foglio per cambiare.</span>';
  };
  openModal(`${mhead(titolo || `Stampa ${testoScelte(n)}`)}
    ${n === 1 ? `<div class="eti-anteprima">${htmlEtichetta(p1, true)}</div>` : `<div class="faint">${ids.slice(0, 4).map(id => esc(prodotto(id).nome)).join(' · ')}${n > 4 ? ` e altre ${n - 4}` : ''}</div>`}
    <div class="sp-foglio"><div class="sp-grid" id="spGrid" role="group" aria-label="Foglio di etichette"></div>
      <div class="sp-testo"><b>Dove sul foglio?</b><span id="spInfo"></span><button class="btn small" type="button" data-x="nuovo">Foglio nuovo</button></div></div>
    <button class="btn primary block" type="button" data-x="stampa">Stampa</button>
    <div class="faint small" style="text-align:center">Si apre la stampa del telefono: scegli la stampante oppure «Salva come PDF». A4, margini «Nessuno», scala 100%.</div>`, b => {
    b.querySelector('#spGrid').addEventListener('click', e => { const c = e.target.closest('[data-pos]'); if (!c) return; start = +c.dataset.pos; draw(b); });
    b.querySelector('[data-x=nuovo]').onclick = () => { start = 0; draw(b); };
    b.querySelector('[data-x=stampa]').onclick = () => stampaEtichette(ids, start);
    draw(b);
  });
}
/* tutto senza attese: alcuni telefoni aprono la stampa solo se parte subito dal tocco */
function stampaEtichette(ids, start = 0) {
  let n = S.meta.ultimoCodiceInterno || 0;
  const nuovi = [];
  const lista = ids.map(prodotto).filter(Boolean).map(p => {
    if (codiceEtichetta(p)) return p;
    let code;
    do { n++; code = formaCodice(n); } while (codeIndex.has(code));
    const np = { ...p, codici: [...(p.codici || []), code] };
    codeIndex.set(code, np.id); nuovi.push(np);
    return np;
  });
  if (nuovi.length) { setMeta('ultimoCodiceInterno', n); saveMany('prodotti', nuovi); }
  setMeta('etiPosizione', (start + lista.length) % ETI_FOGLIO);
  const celle = [...Array(start).fill('<div class="eti"></div>'), ...lista.map(p => htmlEtichetta(p))];
  const fogli = [];
  for (let i = 0; i < celle.length; i += ETI_FOGLIO) fogli.push(`<div class="foglio">${celle.slice(i, i + ETI_FOGLIO).join('')}</div>`);
  let st = document.getElementById('stampa');
  if (!st) { st = document.createElement('div'); st.id = 'stampa'; document.body.appendChild(st); }
  st.innerHTML = fogli.join('');
  closeModal();
  if (nuovi.length) { if (current.name === 'prodotto') aggiornaCodici(); else render(); }
  window.print();
}

/* =========================================================
   SINCRONIZZAZIONE tra i dispositivi del negozio (Firebase)
   - ogni modifica entra in una coda salvata sul dispositivo e parte appena c'è internet
   - sul server ogni record è un documento; si mandano solo i campi cambiati
   - la quantità di una confezione è la somma dei contributi dei dispositivi: ognuno scrive
     solo il suo (campo q_<numero del dispositivo>, sempre il totale, mai un "aggiungi"),
     così due vendite in contemporanea dallo stesso sacco non si perdono e un invio
     ripetuto dopo una risposta persa non conta due volte
   - si scarica solo quello che è cambiato dall'ultima volta (più 15 secondi di margine)
   ========================================================= */
const SYNC_CONF = { apiKey: '', projectId: '', email: '' };
const SYNC_STORES = ['fornitori', 'prodotti', 'lotti', 'ordini', 'sprechi', 'vendite', 'chiusure'];
const SYNC_META = ['settings', 'etiPosizione'];
const syncConf = () => ({ ...SYNC_CONF, ...(S.meta.syncConf || {}) });
const syncPronta = () => !!(syncConf().apiKey && syncConf().projectId);
function syncAttiva() { return !!(S.meta.syncAuth && S.meta.syncAuth.refreshToken); }
let SYNC = { stato: 'spento', msg: '', ultimo: null, corre: false, ancora: false, timer: null, presto: null, ridisegna: false, dispositivi: null };
const nomiFs = c => `projects/${c.projectId}/databases/(default)/documents`;
const docId = (st, id) => encodeURIComponent(st + '~' + id);
const campo = k => /^[A-Za-z_][A-Za-z_0-9]*$/.test(k) ? k : '`' + k.replace(/[`\\]/g, m => '\\' + m) + '`';
const tsMs = t => { const m = Date.parse(t); return isNaN(m) ? 0 : m; };

async function accedi(email, password) {
  const c = syncConf();
  let r;
  try {
    r = await fetch(`${c.authUrl || 'https://identitytoolkit.googleapis.com/v1'}/accounts:signInWithPassword?key=${encodeURIComponent(c.apiKey)}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, returnSecureToken: true }) });
  } catch (e) { throw new Error('Serve internet per collegare il dispositivo'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const m = (j.error && j.error.message) || '';
    if (/INVALID_LOGIN_CREDENTIALS|INVALID_PASSWORD|EMAIL_NOT_FOUND|INVALID_EMAIL|MISSING_PASSWORD/.test(m)) throw new Error('Email o password sbagliate');
    if (/TOO_MANY_ATTEMPTS/.test(m)) throw new Error('Troppi tentativi: riprova tra qualche minuto');
    if (/OPERATION_NOT_ALLOWED|PASSWORD_LOGIN_DISABLED/.test(m)) throw new Error('Su Firebase l\'accesso con email e password non è attivo');
    if (/API.?KEY/i.test(m)) throw new Error('La chiave del progetto (apiKey) non è giusta');
    throw new Error('Accesso non riuscito' + (m ? ': ' + m : ''));
  }
  return { idToken: j.idToken, refreshToken: j.refreshToken, exp: Date.now() + (+j.expiresIn || 3600) * 1000, email: (j.email || email).toLowerCase() };
}
/* il "biglietto" di accesso dura un'ora: si rinnova da solo, senza chiedere niente */
async function tokenValido() {
  const a = S.meta.syncAuth; if (!a) throw new Error('Dispositivo non collegato');
  if (a.idToken && a.exp - 120000 > Date.now()) return a.idToken;
  const c = syncConf();
  const r = await fetch(`${c.tokenUrl || 'https://securetoken.googleapis.com/v1'}/token?key=${encodeURIComponent(c.apiKey)}`,
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(a.refreshToken) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(r.status >= 400 && r.status < 500 ? 'Accesso scaduto: ricollega questo dispositivo in Impostazioni' : 'Il server non risponde');
    e.accesso = r.status >= 400 && r.status < 500; throw e;
  }
  const n = { ...a, idToken: j.id_token, refreshToken: j.refresh_token || a.refreshToken, exp: Date.now() + (+j.expires_in || 3600) * 1000 };
  await setMeta('syncAuth', n);
  return n.idToken;
}
async function chiamaFs(path, body, method = 'POST', riprova = true) {
  const c = syncConf(), t = await tokenValido();
  const r = await fetch(`${c.firestoreUrl || 'https://firestore.googleapis.com/v1'}/${nomiFs(c)}${path}`,
    { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t }, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 404 && method === 'GET') return null;
  if (r.status === 401 && riprova) {   // biglietto non più valido: lo rinnovo e riprovo una volta
    await setMeta('syncAuth', { ...S.meta.syncAuth, exp: 0 });
    return chiamaFs(path, body, method, false);
  }
  const j = await r.json().catch(() => null);
  if (!r.ok) {
    const m = (j && j.error && j.error.message) || r.statusText || String(r.status);
    throw new Error(r.status === 403 ? 'Il server non accetta questo utente: controlla l\'email nelle regole di Firestore'
      : /does not exist|NOT_FOUND/i.test(m) ? 'Su Firebase manca il database Firestore' : 'Errore del server: ' + m);
  }
  return j;
}
/* --- invio: la coda raggruppata per record, al massimo 400 record per volta --- */
function scrittura(x, nb) {
  const fields = { st: { stringValue: x.st }, rid: { stringValue: String(x.id) }, del: { booleanValue: !!x.del } };
  const mask = ['st', 'rid', 'del'];
  if (!x.del) for (const [k, v] of Object.entries(x.set)) { fields['f_' + k] = { stringValue: JSON.stringify(v ?? null) }; mask.push(campo('f_' + k)); }
  if (!x.del && x.mio !== undefined) { const f = 'q_' + (S.meta.syncSlot || 0); fields[f] = { doubleValue: x.mio }; mask.push(f); }
  return { update: { name: `${nb}/dati/${docId(x.st, x.id)}`, fields }, updateMask: { fieldPaths: mask }, updateTransforms: [{ fieldPath: 'srv', setToServerValue: 'REQUEST_TIME' }] };
}
async function invia() {
  const voci = [...S.coda.values()].sort((a, b) => a.k - b.k);
  if (!voci.length) return 0;
  const per = new Map();
  for (const e of voci) {
    const key = e.st + '~' + e.id;
    let x = per.get(key);
    if (!x) { x = { st: e.st, id: e.id, set: {}, dq: 0, del: false, keys: [] }; per.set(key, x); }
    x.keys.push(e.k);
    if (e.del) { x.del = true; x.set = {}; x.dq = 0; }
    else { x.del = false; Object.assign(x.set, e.set || {}); x.dq = r3(x.dq + (e.dq || 0)); }
  }
  const tutti = [...per.values()], nb = nomiFs(syncConf());
  // confezioni: il mio contributo totale = quello già confermato dal server + le differenze in coda
  for (const x of tutti) if (x.st === 'lotti' && !x.del && x.dq) { const l = S.lotti.get(x.id); x.mio = r3(((l && l._mio) || 0) + x.dq); }
  for (let i = 0; i < tutti.length; i += 400) {
    const parte = tutti.slice(i, i + 400);
    await chiamaFs(':commit', { writes: parte.map(x => scrittura(x, nb)) });
    const ks = parte.flatMap(x => x.keys);
    const conf = parte.filter(x => x.mio !== undefined && S.lotti.has(x.id)).map(x => { const n = { ...S.lotti.get(x.id), _mio: x.mio }; S.lotti.set(x.id, n); return n; });
    ks.forEach(k => S.coda.delete(k));
    await new Promise((res, rej) => {
      const t = db.transaction(['coda', 'lotti'], 'readwrite');
      const c = t.objectStore('coda'); ks.forEach(k => c.delete(k));
      const l = t.objectStore('lotti'); conf.forEach(n => l.put(n));
      t.oncomplete = res; t.onerror = () => rej(t.error);
    });
    mostraStato();
  }
  return tutti.length;
}
/* --- ricezione --- */
function leggiDoc(d) {
  const f = d.fields || {};
  const st = f.st && f.st.stringValue, rid = f.rid && f.rid.stringValue;
  if (!st || rid == null) return null;
  const rec = {};
  for (const [k, v] of Object.entries(f)) if (k.startsWith('f_') && v.stringValue != null) { try { rec[k.slice(2)] = JSON.parse(v.stringValue); } catch (e) { } }
  if (st === 'lotti') {
    let q = 0;
    for (const [k, v] of Object.entries(f)) if (/^q_\d+$/.test(k)) q += +(v.doubleValue ?? v.integerValue ?? 0);
    rec.quantita = r3(q);
    const mio = f['q_' + (S.meta.syncSlot || 0)];
    rec._mio = mio ? r3(+(mio.doubleValue ?? mio.integerValue ?? 0)) : 0;
  }
  return { st, id: rec.id !== undefined ? rec.id : rid, del: !!(f.del && f.del.booleanValue), rec, srv: f.srv && f.srv.timestampValue };
}
const firma = o => JSON.stringify(Object.keys(o).filter(k => o[k] != null).sort().map(k => [k, o[k]]));
async function applica(recs) {
  const inCoda = new Set([...S.coda.values()].map(e => e.st + '~' + e.id));
  const ops = new Map(); let n = 0;
  const op = (st, f) => { if (!ops.has(st)) ops.set(st, []); ops.get(st).push(f); };
  for (const r of recs) {
    if (r.st === 'sys') { if (r.id === 'dispositivi') SYNC.dispositivi = Object.values(r.rec).filter(x => x && x.nome); continue; }
    if (inCoda.has(r.st + '~' + r.id)) continue;      // ho modifiche mie non ancora partite: lo riprendo dopo l'invio
    if (r.st === 'meta') {
      if (!SYNC_META.includes(r.id) || r.del) continue;
      const v = r.rec.value;
      if (JSON.stringify(S.meta[r.id] ?? null) === JSON.stringify(v ?? null)) continue;
      S.meta[r.id] = v; op('meta', s => s.put({ key: r.id, value: v })); n++; continue;
    }
    if (!SYNC_STORES.includes(r.st)) continue;
    const cur = S[r.st].get(r.id);
    if (r.del) { if (cur) { S[r.st].delete(r.id); op(r.st, s => s.delete(r.id)); n++; } continue; }
    const rec = { ...r.rec, id: r.id };
    if (cur && firma(cur) === firma(rec)) continue;
    S[r.st].set(r.id, rec); op(r.st, s => s.put(rec)); n++;
  }
  for (const [st, fs] of ops) await tx(st, s => fs.forEach(f => f(s)));
  if (ops.has('prodotti')) rebuildCodeIndex();
  return n;
}
async function ricevi() {
  const LIM = 300;
  const da = S.meta.syncDa ? new Date(tsMs(S.meta.syncDa) - 15000).toISOString() : '1970-01-01T00:00:00Z';
  let cursore = null, max = S.meta.syncDa || null, n = 0;
  for (;;) {
    const q = {
      from: [{ collectionId: 'dati' }],
      where: { fieldFilter: { field: { fieldPath: 'srv' }, op: 'GREATER_THAN_OR_EQUAL', value: { timestampValue: da } } },
      orderBy: [{ field: { fieldPath: 'srv' }, direction: 'ASCENDING' }, { field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
      limit: LIM
    };
    if (cursore) q.startAt = { values: [{ timestampValue: cursore.srv }, { referenceValue: cursore.name }], before: false };
    const docs = ((await chiamaFs(':runQuery', { structuredQuery: q })) || []).filter(x => x.document).map(x => x.document);
    const recs = docs.map(leggiDoc).filter(Boolean);
    n += await applica(recs);
    for (const r of recs) if (r.srv && (!max || tsMs(r.srv) > tsMs(max))) max = r.srv;
    if (docs.length < LIM) break;
    const ul = docs[docs.length - 1]; cursore = { srv: ul.fields.srv.timestampValue, name: ul.name };
  }
  if (max && max !== S.meta.syncDa) await setMeta('syncDa', max);
  return n;
}
/* --- il giro: prima mando, poi ricevo --- */
async function giro() {
  if (!syncAttiva()) return;
  if (SYNC.corre) { SYNC.ancora = true; return; }
  SYNC.corre = true;
  try {
    if (navigator.onLine === false) { SYNC.stato = 'offline'; return; }
    let volte = 0;
    do {
      SYNC.ancora = false;
      await invia();
      const n = await ricevi();
      SYNC.stato = 'ok'; SYNC.msg = ''; SYNC.ultimo = Date.now();
      if (n || SYNC.ridisegna) aggiornaVista();
    } while (SYNC.ancora && ++volte < 3);
  } catch (e) {
    SYNC.stato = e.accesso ? 'accesso' : e instanceof TypeError ? 'offline' : 'errore';
    SYNC.msg = e.message;
  } finally { SYNC.corre = false; mostraStato(); }
}
function syncPresto() { if (!syncAttiva()) return; clearTimeout(SYNC.presto); SYNC.presto = setTimeout(giro, 1200); mostraStato(); }
function avviaSync() {
  clearInterval(SYNC.timer);
  if (!syncAttiva()) { SYNC.stato = 'spento'; return; }
  SYNC.timer = setInterval(() => { if (!document.hidden) giro(); }, 20000);
  giro();
}
window.addEventListener('online', () => giro());
document.addEventListener('visibilitychange', () => { if (!document.hidden) giro(); });
/* arrivano modifiche dagli altri: si ridisegna, ma non mentre si scrive in un modulo */
function aggiornaVista() {
  aggiornaBadge();
  const ae = document.activeElement;
  if (modal.open || ['prodotto', 'fornitore', 'impostazioni', 'chiusura'].includes(current.name) || (ae && ae.matches && ae.matches('input,textarea,select'))) { SYNC.ridisegna = true; return; }
  render();
}
function testoStato() {
  const n = S.coda.size, attesa = n ? ` · ${n === 1 ? '1 modifica' : n + ' modifiche'} da inviare` : '';
  switch (SYNC.stato) {
    case 'ok': return `Sincronizzato alle ${fmtOra(SYNC.ultimo)}${attesa}`;
    case 'offline': return `Senza internet${attesa}. Si sincronizza appena torna.`;
    case 'accesso': return 'Accesso scaduto: ricollega questo dispositivo in Impostazioni';
    case 'errore': return `Sincronizzazione non riuscita: ${SYNC.msg}${attesa}`;
    default: return syncAttiva() ? `Sincronizzo…${attesa}` : '';
  }
}
function mostraStato() {
  const el = document.getElementById('syncStato'); if (!el) return;
  el.textContent = testoStato();
  el.className = 'sync-stato ' + (SYNC.stato === 'ok' ? 'ok' : SYNC.stato === 'errore' || SYNC.stato === 'accesso' ? 'err' : '');
}
/* --- collegare un dispositivo --- */
async function registraDispositivo(nome) {
  const d = await chiamaFs('/dati/' + docId('sys', 'dispositivi'), null, 'GET');
  const usati = new Set();
  if (d && d.fields) for (const k of Object.keys(d.fields)) if (/^f_\d+$/.test(k)) usati.add(+k.slice(2));
  let slot = S.meta.syncSlot;
  if (!slot) { const liberi = []; for (let i = 10; i < 100; i++) if (!usati.has(i)) liberi.push(i); slot = liberi[Math.floor(Math.random() * liberi.length)] || 99; }
  await chiamaFs(':commit', { writes: [scrittura({ st: 'sys', id: 'dispositivi', set: { [slot]: { nome, dal: todayISO() } } }, nomiFs(syncConf()))] });
  await setMeta('syncSlot', slot);
}
function cardSync() {
  if (!syncPronta()) return `<div class="card"><h2>Più dispositivi insieme</h2><p class="muted small">Per usare telefono e tablet insieme, con gli stessi dati. Non è ancora configurata per il negozio.</p></div>`;
  if (!syncAttiva()) return `<div class="card"><h2>Più dispositivi insieme</h2>
    <p class="muted small">Collega questo dispositivo al negozio: vendite, arrivi, scadenze e prodotti saranno uguali su tutti i dispositivi collegati, anche se si lavora insieme. Serve internet solo per collegarlo; dopo funziona anche senza e si aggiorna appena torna la rete.</p>
    <label class="field">Email del negozio<input type="email" id="syEmail" autocomplete="username" value="${esc(syncConf().email || '')}"></label>
    <label class="field">Password<input type="password" id="syPw" autocomplete="current-password"></label>
    <label class="field">Nome di questo dispositivo<input type="text" id="syNome" value="${/tablet|ipad/i.test(navigator.userAgent) || (Math.min(screen.width, screen.height) >= 600) ? 'Tablet' : 'Telefono'}"></label>
    <button class="btn primary block" type="button" data-act="sync-collega">Collega questo dispositivo</button></div>`;
  const disp = SYNC.dispositivi && SYNC.dispositivi.length ? SYNC.dispositivi.map(d => esc(d.nome)).join(', ') : '';
  return `<div class="card"><h2>Più dispositivi insieme</h2>
    <dl class="kv"><dt>Questo dispositivo</dt><dd>${esc(S.meta.syncDev || '')}</dd><dt>Account</dt><dd>${esc(S.meta.syncAuth.email || '')}</dd>${disp ? `<dt>Collegati</dt><dd>${disp}</dd>` : ''}</dl>
    <div id="syncStato" class="sync-stato">${esc(testoStato())}</div>
    <button class="btn block" type="button" data-act="sync-ora">Sincronizza ora</button>
    <button class="btn ghost block" type="button" data-act="sync-scollega">Scollega questo dispositivo</button></div>`;
}

/* =========================================================
   IMPOSTAZIONI, BACKUP
   ========================================================= */
let persistito = null;
routes.impostazioni = () => {
  const s = settings();
  const lb = S.meta.lastBackup;
  const html = `<div class="card"><h2>Backup su Drive</h2>
      <p class="muted small">${syncAttiva() ? 'I dati sono anche sugli altri dispositivi collegati, ma il backup resta la copia di sicurezza.' : 'I dati stanno solo su questo telefono.'} Il backup crea un file: nel menu che si apre scegli <b>Drive</b>, poi in alto l'<b>account del negozio</b> e la cartella. Fallo ogni giorno a fine lavoro.</p>
      <div class="faint">Ultimo backup: ${lb ? fmtDate(lb.slice(0, 10)) : 'mai'}</div>
      <button class="btn primary block" type="button" data-act="backup">Fai backup ora</button>
      <button class="btn block" type="button" data-act="ripristina">Ripristina da un backup</button></div>
    ${cardSync()}
    <div class="card"><h2>Catalogo</h2>
      <dl class="kv"><dt>Prodotti</dt><dd>${S.prodotti.size}</dd><dt>Fornitori</dt><dd>${S.fornitori.size}</dd><dt>Con codice a barre</dt><dd>${[...S.prodotti.values()].filter(p => (p.codici || []).length).length}</dd><dt>Confezioni in negozio</dt><dd>${lottiAttivi().length}</dd></dl>
      <button class="btn block" type="button" data-act="import-catalogo">Carica catalogo dai listini</button>
      <div class="faint small">Aggiunge solo prodotti e fornitori che non ci sono già.</div></div>
    <div class="card"><h2>Avvisi di scadenza</h2>
      <p class="muted small">Giorni prima della scadenza in cui il prodotto diventa rosso, arancione e giallo.</p>
      ${['preferibilmente', 'entro'].map(t => `<div class="field" style="font-weight:600">${t === 'entro' ? 'Freschi (da consumarsi entro)' : 'Secchi e conserve (preferibilmente entro)'}
        <div class="btn-grid" style="grid-template-columns:repeat(3,1fr)">${s.soglie[t].map((v, i) => `<label class="field"><span class="hint">${['rosso', 'arancione', 'giallo'][i]}</span><input type="number" inputmode="numeric" min="0" data-soglia="${t}|${i}" value="${v}"></label>`).join('')}</div></div>`).join('')}
      <label class="field">Nome del negozio nei messaggi<input type="text" id="sNeg" value="${esc(s.negozio)}"></label>
      <button class="btn primary block" type="button" data-act="s-salva">Salva impostazioni</button></div>
    <div class="card"><h2>Sfuso</h2>
      <p class="muted small">Quando al sacco più vecchio resta meno di questa parte (polvere, pesate), l'app lo considera finito e passa al sacco dopo.</p>
      <label class="field">Avanzo del sacco, in %<input type="number" inputmode="numeric" min="0" max="30" id="sAvanzo" value="${s.avanzoSfuso}"></label>
      <button class="btn primary block" type="button" data-act="s-salva">Salva impostazioni</button>
      <a class="btn block" href="#etichette">Etichette dei contenitori</a></div>
    <div class="card"><h2>Prova del lettore</h2>
      <p class="muted small">Scansiona un codice qualsiasi stando su questa pagina: qui sotto vedi cosa arriva al telefono.</p>
      <dl class="kv"><dt>Ultimo codice letto</dt><dd id="diagCodice">${esc(ultimoCodice || 'nessuno')}</dd></dl>
      <div class="faint small">Tasti ricevuti: <span id="diagTasti" style="font-family:ui-monospace,monospace;overflow-wrap:anywhere">${esc(tastiRicevuti.join(' ') || '—')}</span></div>
      <button class="btn small" type="button" data-act="camera">Prova con la fotocamera</button></div>
    <div class="card"><h2>Informazioni</h2>
      <dl class="kv"><dt>Versione</dt><dd>${VERSIONE}</dd><dt>Dati protetti dalla pulizia del browser</dt><dd id="persist">${persistito == null ? '…' : persistito ? 'sì' : 'no'}</dd></dl>
      ${installPrompt ? `<button class="btn block" type="button" data-act="installa">Installa l'app sul telefono</button>` : ''}</div>`;
  return {
    title: 'Impostazioni', html, back: '#home',
    onScan: code => { const el = $('#diagCodice'); if (el) el.textContent = code; toast('Lettura riuscita: ' + code); },
    mount: () => { if (navigator.storage && navigator.storage.persisted) navigator.storage.persisted().then(v => { persistito = v; const el = $('#persist'); if (el) el.textContent = v ? 'sì' : 'no'; }); }
  };
};
async function faiBackup() {
  const data = { app: 'spesasfusa-magazzino', versione: 2, esportato: new Date().toISOString(), impostazioni: S.meta.settings || {} };
  for (const s of DATI) data[s] = [...S[s].values()];
  // Chrome su Android condivide solo alcuni tipi di file: il testo sì, il .json no.
  // Il backup è salvato come .txt (dentro c'è lo stesso contenuto) così si può scegliere Drive, l'account e la cartella.
  const nome = `magazzino-backup-${todayISO()}.txt`;
  const testo = JSON.stringify(data);
  const file = new File([testo], nome, { type: 'text/plain' });
  let puoCondividere = false;
  try { puoCondividere = !!(navigator.canShare && navigator.canShare({ files: [file] })); } catch (e) { }
  if (puoCondividere) {
    try {
      await navigator.share({ files: [file], title: 'Backup magazzino' });
      await setMeta('lastBackup', todayISO());
      toast('Backup inviato. Controlla che sia finito su Drive, nell\'account del negozio.'); render(); return;
    } catch (e) {
      if (e && e.name === 'AbortError') { toast('Backup annullato: non è stato salvato', { err: true }); return; }
    }
  }
  scaricaFile(testo, nome);
  await setMeta('lastBackup', todayISO());
  render();
  openModal(`${mhead('Backup salvato nei Download')}
    <p>Questo telefono non mi permette di aprire il menu per scegliere Drive, quindi il file <b>${esc(nome)}</b> è nella cartella <b>Download</b>.</p>
    <p class="muted small">Per metterlo su Drive: apri l'app <b>Drive</b> → scegli l'account del negozio → pulsante <b>+</b> → <b>Carica</b> → cartella Download → il file.</p>
    <button class="btn primary block" type="button" data-act="close-modal">Ho capito</button>`);
}
function scaricaFile(testo, nome) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([testo], { type: 'text/plain' })); a.download = nome;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
let fileMode = null;
$('#fileInput').addEventListener('change', async e => {
  const f = e.target.files && e.target.files[0]; e.target.value = '';
  if (!f) return;
  let data;
  try { data = JSON.parse(await f.text()); } catch (err) { toast('Il file non è leggibile', { err: true }); return; }
  try {
    if (fileMode === 'catalogo') {
      if (data.app !== 'spesasfusa-catalogo' || !Array.isArray(data.prodotti)) throw new Error('Questo file non è un catalogo dell\'app');
      const fs = (data.fornitori || []).filter(x => !S.fornitori.has(x.id)).map(x => ({ id: x.id, nome: x.nome, daNominare: !!x.daNominare, metodo: x.metodo || '', telefono: x.telefono || '', email: x.email || '', sito: x.sito || '', note: x.note || '' }));
      const ps = data.prodotti.filter(x => !S.prodotti.has(x.id)).map(x => ({ id: x.id, nome: x.nome, fornitoreId: x.fornitoreId || '', categoria: x.categoria || '', formato: x.formato || '', prezzoAcquisto: x.prezzoAcquisto ?? null, iva: x.iva ?? null, prezzoVendita: x.prezzoVendita ?? null, prezzoManuale: null, ricarico: x.ricarico || 50, codici: x.codici || (x.barcode ? [x.barcode] : []), tipoScadenza: x.tipoScadenza || 'preferibilmente', note: x.note || '', origine: x.origine || '' }));
      await saveMany('fornitori', fs); await saveMany('prodotti', ps);
      toast(`Catalogo caricato: ${ps.length} prodotti, ${fs.length} fornitori`);
    } else if (fileMode === 'ripristina') {
      if (data.app !== 'spesasfusa-magazzino') throw new Error('Questo file non è un backup dell\'app');
      const vecchio = !data.vendite && S.vendite.size ? ' Attenzione: è di una versione precedente e non contiene le vendite al banco.' : '';
      if (!(await confirmBox(`Il backup è del ${fmtDate((data.esportato || '').slice(0, 10))}. Sostituisco tutti i dati di questo telefono?${vecchio}`, { ok: 'Ripristina', danger: true }))) return;
      for (const s of DATI) { await tx(s, st => st.clear()); await tx(s, st => (data[s] || []).forEach(o => st.put(o))); }
      await setMeta('settings', data.impostazioni || {});
      await loadAll(); rebuildCodeIndex();
      if (!data.sprechi) { await setMeta('sprechiMigrati', false); await migraSprechi(); }
      toast('Dati ripristinati');
    }
    render();
  } catch (err) { toast(err.message, { err: true }); }
});

/* =========================================================
   Azioni (pulsanti)
   ========================================================= */
const A = {};
/* sincronizzazione */
A['sync-collega'] = async el => {
  const email = $('#syEmail').value.trim().toLowerCase(), pw = $('#syPw').value, nome = ($('#syNome').value || '').trim() || 'Dispositivo';
  if (!email || !pw) { toast('Scrivi email e password', { err: true }); return; }
  el.disabled = true; el.textContent = 'Collego…';
  try {
    const auth = await accedi(email, pw);
    await setMeta('syncAuth', auth);
    // sul server ci sono già i dati del negozio?
    const prova = ((await chiamaFs(':runQuery', { structuredQuery: { from: [{ collectionId: 'dati' }], limit: 3 } })) || [])
      .filter(x => x.document).map(x => leggiDoc(x.document)).filter(r => r && r.st !== 'sys');
    const vuoto = !prova.length;
    const locali = SYNC_STORES.reduce((t, st) => t + S[st].size, 0);
    if (!vuoto && locali) {
      const ok = await confirmBox('Sul server ci sono già i dati del negozio. Questo dispositivo ha dei dati suoi: li sostituisco con quelli del negozio? Prima ne salvo una copia nella cartella Download.', { ok: 'Usa i dati del negozio', danger: true });
      if (!ok) { await setMeta('syncAuth', null); render(); return; }
      const copia = { app: 'spesasfusa-magazzino', versione: 2, esportato: new Date().toISOString(), impostazioni: S.meta.settings || {} };
      for (const st of DATI) copia[st] = [...S[st].values()];
      scaricaFile(JSON.stringify(copia), `magazzino-prima-del-collegamento-${todayISO()}.txt`);
      for (const st of SYNC_STORES) { S[st] = new Map(); await tx(st, x => x.clear()); }
      rebuildCodeIndex();
    }
    await registraDispositivo(nome);
    await setMeta('syncDev', nome);
    await setMeta('syncDa', null);
    if (vuoto) {   // primo dispositivo: manda tutto quello che ha
      const pulite = [...S.lotti.values()].filter(l => l._mio !== undefined).map(l => { const n = { ...l }; delete n._mio; S.lotti.set(n.id, n); return n; });
      if (pulite.length) await tx('lotti', x => pulite.forEach(n => x.put(n)));
      const voci = [];
      for (const st of SYNC_STORES) for (const o of S[st].values()) voci.push(...codaPer(st, [[undefined, o]]));
      for (const k of SYNC_META) if (S.meta[k] !== undefined) voci.push(voceCoda({ st: 'meta', id: k, set: { value: S.meta[k] } }));
      voci.forEach(e => S.coda.set(e.k, e));
      await tx('coda', x => voci.forEach(e => x.put(e)));
    }
    toast(vuoto ? 'Collegato: mando i dati del negozio al server' : 'Collegato: scarico i dati del negozio', { ms: 5000 });
    SYNC.stato = 'via';
    render(); avviaSync();
  } catch (e) {
    if (!S.meta.syncDev) await setMeta('syncAuth', null);
    toast(e.message, { err: true });
    if (document.contains(el)) { el.disabled = false; el.textContent = 'Collega questo dispositivo'; }
  }
};
A['sync-ora'] = async () => { await giro(); if (SYNC.stato === 'ok') toast('Sincronizzato'); else toast(testoStato(), { err: true }); render(); };
A['sync-scollega'] = async () => {
  const n = S.coda.size;
  if (!(await confirmBox(`Scollego questo dispositivo? I dati restano qui, ma non si aggiornano più con gli altri dispositivi.${n ? ` Attenzione: ${n === 1 ? '1 modifica non è ancora partita' : n + ' modifiche non sono ancora partite'}, gli altri non le riceveranno.` : ''}`, { ok: 'Scollega', danger: true }))) return;
  clearInterval(SYNC.timer);
  for (const k of ['syncAuth', 'syncDa', 'syncDev']) await setMeta(k, null);
  S.coda.clear(); await tx('coda', x => x.clear());
  SYNC.stato = 'spento'; toast('Dispositivo scollegato'); render();
};
A['close-modal'] = () => closeModal();
A['close-modal-link'] = el => { closeModal(); location.hash = el.getAttribute('href'); };
A.back = () => { if (current.back) location.hash = current.back; else history.back(); };
A.camera = () => openCamera();
A['scrivi-codice'] = () => scriviCodice();
A.backup = () => faiBackup();
A.ripristina = () => {
  if (syncAttiva()) { toast('Con più dispositivi collegati non si ripristina un backup: i dati arrivano dagli altri. Prima scollega questo dispositivo.', { err: true, ms: 6000 }); return; }
  fileMode = 'ripristina'; $('#fileInput').click();
};
A['import-catalogo'] = () => { fileMode = 'catalogo'; $('#fileInput').click(); };
A.installa = async () => { if (!installPrompt) return; installPrompt.prompt(); try { await installPrompt.userChoice; } catch (e) { } installPrompt = null; render(); };
A['sr-carico'] = el => { closeModal(); const p = prodotto(el.dataset.id); if (!p) return; CS = caricoPer(p, 'arrivo'); location.hash = '#carico/keep'; if (current.name === 'carico') render(); };
A['sr-ordina'] = async el => { closeModal(); await aggiungiOrdine(el.dataset.id); render(); };
/* arrivo merce */
A.modo = el => { const m = el.dataset.m; if (CS.pid && CS.modo !== m) { toast('Prima salva o annulla il prodotto aperto', { err: true }); return; } CS = nuovoCarico(m); location.hash = m === 'inventario' ? '#carico/inventario' : '#carico'; render(); };
A['carico-cerca'] = () => pickerModal({ title: 'Cerca il prodotto', onPick: p => { CS = caricoPer(p, CS.modo); render(); } });
A.unita = el => { const u = el.dataset.u; if (CS.unita === u) return; CS.unita = u; CS.qta = u === 'sacchi' ? '1' : ''; CS.field = 'qta'; CS.qtaFresh = true; render(); };
A['carico-annulla'] = () => { CS = nuovoCarico(CS.modo); render(); };
A['carico-salva'] = () => salvaCarico();
A['kp-field'] = el => { CS.field = el.dataset.f; if (CS.field === 'qta') CS.qtaFresh = true; render(); };
A.kp = el => {
  const k = el.dataset.k;
  if (CS.field === 'qta') {
    const kg = CS.unita === 'kg';
    if (k === 'back') CS.qta = CS.qtaFresh ? '' : CS.qta.slice(0, -1);
    else if (k === ',') {
      if (!kg) return;
      const base = CS.qtaFresh ? '' : CS.qta;
      if (!base.includes(',')) CS.qta = (base || '0') + ',';
    } else {
      let v = (CS.qtaFresh ? '' : CS.qta) + k;
      if (kg) { const [i, d = null] = v.split(','); v = i.replace(/^0+(?=\d)/, '').slice(0, 4) + (d !== null ? ',' + d.slice(0, 3) : ''); }
      else v = v.replace(/^0+(?=\d)/, '').slice(0, 4);
      CS.qta = v;
    }
    CS.qtaFresh = false;
  } else {
    if (CS.senza || k === ',') return;
    if (k === 'back') CS.scad = CS.scad.slice(0, -1);
    else if (CS.scad.length < 8) CS.scad += k;
  }
  render();
};
A['qta-'] = () => { CS.qta = String(Math.max(1, (parseInt(CS.qta, 10) || 1) - 1)); render(); };
A['qta+'] = () => { CS.qta = String((parseInt(CS.qta, 10) || 0) + 1); render(); };
A['lotto-annulla'] = el => annullaLotto(el.dataset.id);
/* scadenze */
A['sz-filtro'] = el => { SZ.filtro = el.dataset.f; render(); };
async function condividiTesto(t, cosa) {
  if (navigator.share) {
    try { await navigator.share({ text: t }); return; }
    catch (e) { if (e && e.name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(t); toast(`${cosa} copiato: incollalo dove vuoi`); }
  catch (e) { toast('Non riesco né a condividere né a copiare', { err: true }); }
}
A['sz-condividi'] = () => condividiTesto(testoScadenze(), 'Elenco');
A['lot-gestito'] = async el => {
  const l = S.lotti.get(el.dataset.id); if (!l) return;
  if (l.gestito) { await save('lotti', { ...l, gestito: false, nota: '' }); render(); return; }
  openModal(`${mhead('Cosa avete fatto?')}<div class="stack">
    ${['Messo in sconto', 'Messo in vista', 'Usato in laboratorio'].map(t => `<button class="btn block" type="button" data-n="${esc(t)}">${esc(t)}</button>`).join('')}
    <label class="field">Altro<input type="text" id="gAltro" placeholder="scrivi cosa"></label>
    <button class="btn primary block" type="button" data-n="">Salva</button></div>`, b => {
    $$('[data-n]', b).forEach(x => x.onclick = async () => {
      const nota = x.dataset.n || b.querySelector('#gAltro').value.trim() || 'gestito';
      await save('lotti', { ...l, gestito: true, nota }); closeModal(); render();
    });
  });
};
A['lot-esaurito'] = async el => {
  const l = S.lotti.get(el.dataset.id); if (!l) return;
  await save('lotti', { ...l, stato: 'esaurito', chiuso: todayISO() });
  toast('Segnato come esaurito', { action: { label: 'Annulla', run: async () => { await save('lotti', l); render(); } } }); render();
};
A['lot-buttato'] = el => { const l = S.lotti.get(el.dataset.id); if (l) sprecoModal({ lot: l }); };
A['lot-modifica'] = el => {
  const l = S.lotti.get(el.dataset.id); if (!l) return;
  const p = prodotto(l.prodottoId);
  const [y, m, d] = (l.scadenza || '--').split('-');
  openModal(`${mhead('Modifica')}<div class="faint">${esc(p ? p.nome : '')}${l.arrivo ? ' · arrivato ' + fmtDate(l.arrivo) : ''}</div>
    ${isSfuso(p) ? `<label class="field">${inLitri(p) ? 'Litri' : 'Kg'} in negozio <span class="hint">con la virgola, es. 2,5</span><input type="text" inputmode="decimal" id="mQ" value="${fmtNum(r3(l.quantita))}"></label>` : `<label class="field">Quantità in negozio<input type="number" inputmode="numeric" id="mQ" value="${l.quantita}" min="1"></label>`}
    <label class="field">Scadenza <span class="hint">6 cifre, es. 280527 · 4 cifre = solo mese e anno</span><input type="text" inputmode="numeric" id="mS" value="${l.scadenza ? d + m + y.slice(2) : ''}" ${l.scadenza ? '' : 'disabled'}></label>
    <div class="date-preview" id="mPrev"></div>
    <label class="check"><input type="checkbox" id="mSenza" ${l.scadenza ? '' : 'checked'}> Senza scadenza</label>
    <button class="btn primary block" type="button" id="mOk">Salva</button>
    <button class="btn danger block" type="button" id="mDel">Elimina questa riga</button>`, b => {
    const iS = b.querySelector('#mS'), cb = b.querySelector('#mSenza'), pv = b.querySelector('#mPrev');
    const prev = () => { if (cb.checked) { pv.textContent = ''; return; } const r = parseScadenza(iS.value); pv.textContent = r ? fmtDateLong(r.iso) + ' · ' + relDays(daysUntil(r.iso)) : (iS.value.replace(/\D/g, '').length >= 4 ? 'Data non valida' : ''); pv.classList.toggle('err', !r); };
    iS.addEventListener('input', prev); iS.addEventListener('focus', () => iS.select());
    cb.addEventListener('change', () => { iS.disabled = cb.checked; prev(); if (!cb.checked) iS.focus(); }); prev();
    b.querySelector('#mOk').onclick = async () => {
      const q = isSfuso(p) ? r3(parseNum(b.querySelector('#mQ').value)) : parseInt(b.querySelector('#mQ').value, 10);
      if (!q || q <= 0 || (!isSfuso(p) && q < 1)) { toast('Quantità non valida', { err: true }); return; }
      let scad = null;
      if (!cb.checked) { const r = parseScadenza(iS.value); if (!r) { toast('Data non valida: 6 cifre, es. 280527', { err: true }); return; } scad = r.iso; }
      let extra = {};
      if (l.ordineId && q !== l.quantita) {
        const o = S.ordini.get(l.ordineId);
        const prima = l.ordineQta ?? l.quantita, dopo = isSfuso(p) && p.pesoSacco ? r3(q / p.pesoSacco) : q;
        if (o) await save('ordini', { ...o, righe: o.righe.map(r => r.prodottoId === l.prodottoId ? { ...r, ricevuto: Math.max(0, r3((r.ricevuto || 0) + dopo - prima)) } : r) });
        extra = { ordineQta: dopo };
      }
      if (q !== l.quantita) extra.sacchi = null;
      await save('lotti', { ...l, ...extra, quantita: q, scadenza: scad }); closeModal(); toast('Modificato'); render();
    };
    b.querySelector('#mDel').onclick = async () => { closeModal(); if (await confirmBox('Elimino questa riga? Non conta come spreco.', { ok: 'Elimina', danger: true })) annullaLotto(l.id); };
  });
};
/* ordini già inviati e chiusi */
A['ord-riga-mod'] = el => {
  const o = S.ordini.get(el.dataset.o); if (!o) return;
  const r = o.righe.find(x => x.prodottoId === el.dataset.p); if (!r) return;
  const p = prodotto(r.prodottoId);
  openModal(`${mhead('Modifica riga dell\'ordine')}<div class="faint">${esc(p ? p.nome : '')}</div>
    <div class="btn-grid" style="grid-template-columns:1fr 1fr">
      <label class="field">Ordinati<input type="number" inputmode="numeric" id="oQ" min="0" value="${r.qta}"></label>
      <label class="field">Arrivati<input type="number" inputmode="numeric" id="oR" min="0" value="${r.ricevuto || 0}"></label></div>
    <button class="btn primary block" type="button" id="oOk">Salva</button>
    <button class="btn danger block" type="button" id="oDel">Togli dall'ordine</button>`, b => {
    b.querySelector('#oOk').onclick = async () => {
      const q = Math.max(0, parseInt(b.querySelector('#oQ').value, 10) || 0), ric = Math.max(0, parseInt(b.querySelector('#oR').value, 10) || 0);
      await save('ordini', { ...o, righe: o.righe.map(x => x.prodottoId === r.prodottoId ? { ...x, qta: q, ricevuto: ric } : x) }); closeModal(); toast('Modificato'); render();
    };
    b.querySelector('#oDel').onclick = async () => { await save('ordini', { ...o, righe: o.righe.filter(x => x.prodottoId !== r.prodottoId) }); closeModal(); toast('Tolto dall\'ordine'); render(); };
  });
};
A['ord-riapri'] = async el => {
  const o = S.ordini.get(el.dataset.o); if (!o) return;
  const aperto = ordineAperto(o.fornitoreId);
  if (aperto && aperto.id !== o.id) {
    const righe = aperto.righe.map(r => ({ ...r }));
    for (const r of o.righe) { const g = righe.find(x => x.prodottoId === r.prodottoId); if (g) g.qta += r.qta; else righe.push({ prodottoId: r.prodottoId, qta: r.qta, ricevuto: 0 }); }
    await save('ordini', { ...aperto, righe }); await remove('ordini', o.id);
  } else await save('ordini', { ...o, stato: 'aperto', inviato: null, chiuso: null });
  toast('Ordine riaperto: lo trovi in "Da ordinare"'); render();
};
A['ord-riapri-chiuso'] = async el => { const o = S.ordini.get(el.dataset.o); if (!o) return; await save('ordini', { ...o, stato: 'inviato', chiuso: null }); toast('Ordine di nuovo "in arrivo"'); render(); };
A['ord-elimina'] = async el => { const o = S.ordini.get(el.dataset.o); if (!o) return; if (await confirmBox(`Elimino l'ordine a ${nomeForn(o.fornitoreId)}?`, { ok: 'Elimina', danger: true })) { await remove('ordini', o.id); toast('Ordine eliminato'); render(); } };
/* sprechi: modifica */
A['spreco-mod'] = el => {
  const r = S.sprechi.get(el.dataset.id); if (!r) return;
  const p = prodotto(r.prodottoId);
  let motivo = r.motivo;
  const standard = MOTIVI.includes(motivo);
  const [y, m, d] = r.data.split('-');
  openModal(`${mhead('Modifica spreco')}<div class="faint">${esc(p ? p.nome : '')}</div>
    <label class="field">Quantità ${r.lottoId ? '<span class="hint">viene da una scadenza: per cambiarla annulla lo spreco e registralo di nuovo</span>' : ''}<input type="${isSfuso(p) ? 'text' : 'number'}" inputmode="${isSfuso(p) ? 'decimal' : 'numeric'}" id="eQ" min="1" value="${isSfuso(p) ? fmtNum(r.qta) : r.qta}" ${r.lottoId ? 'disabled' : ''}></label>
    <label class="field">Data <span class="hint">6 cifre, es. 051026</span><input type="text" inputmode="numeric" id="eD" value="${d + m + y.slice(2)}"></label>
    <div class="field" style="font-weight:600">Perché<div class="chips" id="eMot">${MOTIVI.map(x => `<button type="button" class="chip ${(standard ? x === motivo : x === 'Altro') ? 'on' : ''}" data-m="${x}">${x}</button>`).join('')}</div>
      <input type="text" id="eAltro" value="${standard ? '' : esc(motivo)}" placeholder="Scrivi il motivo" ${standard ? 'hidden' : ''}></div>
    <button class="btn primary block" type="button" id="eOk">Salva</button>
    <button class="btn danger block" type="button" id="eDel">Annulla lo spreco</button>`, b => {
    let scelto = standard ? motivo : 'Altro';
    const altro = b.querySelector('#eAltro');
    $$('#eMot [data-m]', b).forEach(c => c.onclick = () => { scelto = c.dataset.m; $$('#eMot [data-m]', b).forEach(x => x.classList.toggle('on', x === c)); altro.hidden = scelto !== 'Altro'; });
    b.querySelector('#eOk').onclick = async () => {
      const dt = parseScadenza(b.querySelector('#eD').value);
      if (!dt) { toast('Data non valida', { err: true }); return; }
      const q = r.lottoId ? r.qta : isSfuso(p) ? Math.max(0.001, r3(parseNum(b.querySelector('#eQ').value) || 0)) : Math.max(1, parseInt(b.querySelector('#eQ').value, 10) || 1);
      await save('sprechi', { ...r, qta: q, data: dt.iso, motivo: scelto === 'Altro' ? (altro.value.trim() || 'Altro') : scelto });
      closeModal(); toast('Modificato'); render();
    };
    b.querySelector('#eDel').onclick = async () => { closeModal(); if (await confirmBox('Annullo questo spreco? Se veniva da una scadenza, il prodotto torna in elenco.', { ok: 'Annulla lo spreco' })) annullaSpreco(r.id); };
  });
};
/* sprechi */
A['sp-periodo'] = el => { SPF = el.dataset.f; render(); };
A['spreco-nuovo'] = () => pickerModal({ title: 'Cosa avete buttato?', onPick: p => sprecoModal({ prod: p }) });
A['spreco-annulla'] = async el => { if (await confirmBox('Annullo questo spreco? Se veniva da una scadenza, il prodotto torna in elenco.', { ok: 'Annulla lo spreco' })) annullaSpreco(el.dataset.id); };
A['sp-condividi'] = () => condividiTesto(testoSprechi(), 'Elenco');
/* ordini */
A['ord-cerca'] = () => pickerModal({ title: 'Aggiungi all\'ordine', onPick: async p => { await aggiungiOrdine(p.id); render(); } });
const cambiaRiga = async (el, fn) => {
  const o = S.ordini.get(el.dataset.o); if (!o) return;
  const righe = o.righe.map(r => r.prodottoId === el.dataset.p ? fn(r) : r).filter(Boolean);
  await save('ordini', { ...o, righe }); render();
};
A['riga-'] = el => cambiaRiga(el, r => ({ ...r, qta: Math.max(0, r.qta - 1) }));
A['riga+'] = el => cambiaRiga(el, r => ({ ...r, qta: r.qta + 1 }));
A['riga-del'] = el => cambiaRiga(el, () => null);
A['ord-invia'] = el => { const o = S.ordini.get(el.dataset.o); if (!o) return; if (!o.righe.some(r => r.qta > 0)) { toast('Non c\'è niente da ordinare', { err: true }); return; } inviaOrdineModal(o); };
A['ord-chiudi'] = async el => {
  const o = S.ordini.get(el.dataset.o); if (!o) return;
  const mancano = o.righe.filter(r => (r.ricevuto || 0) < r.qta).length;
  if (mancano && !(await confirmBox(`Mancano ancora ${mancano} prodotti. Chiudo lo stesso l'ordine?`, { ok: 'Chiudi ordine' }))) return;
  await save('ordini', { ...o, stato: 'chiuso', chiuso: todayISO() }); toast('Ordine chiuso'); render();
};
/* catalogo */
A['cat-altri'] = () => { CAT.limite += 100; $('#catList').innerHTML = catListHTML(); };
A['nuovo-prodotto'] = () => nuovoProdottoModal({ fornitoreId: CAT.forn, onDone: p => { location.hash = '#prodotto/' + encodeURIComponent(p.id); } });
A['p-salva'] = async el => {
  const p = prodotto(el.dataset.id); if (!p) return;
  const nome = $('#pNome').value.replace(/\s+/g, ' ').trim(); if (!nome) { toast('Il nome non può essere vuoto', { err: true }); return; }
  const sfuso = $('#pSfuso').checked, sacco = parseNum($('#pSacco').value);
  const unita = sfuso ? $('#pUnita').value : p.unita;
  const fp = { sfuso, unita };                       // il prodotto come sarà dopo il salvataggio
  const f = sfuso ? UNITA[unitaDi(fp)].f : 1;         // il prezzo a mano è scritto nell'unità di vendita (es. all'etto)
  const crea = sfuso && !(p.codici || []).length && !!($('#pCrea') && $('#pCrea').checked);
  const manTxt = $('#pMan').value.trim(), manRaw = manTxt ? parseNum(manTxt) : null;
  const dati = {
    nome, fornitoreId: $('#pForn').value, formato: $('#pFormato').value.trim(), categoria: $('#pCat').value.trim(), tipoScadenza: $('#pTipo').value,
    prezzoAcquisto: parseNum($('#pAcq').value), iva: parseNum($('#pIva').value), ricarico: +$('#pRic').value,
    prezzoManuale: manRaw != null ? Math.round(manRaw / f * 10000) / 10000 : null, note: $('#pNote').value.trim()
  };
  if (sfuso && $('#pSacco').value.trim() && !(sacco > 0)) { toast(`${inLitri(fp) ? 'I litri della tanica non sono' : 'Il peso del sacco non è'} un numero valido`, { err: true }); return; }
  dati.sfuso = sfuso; dati.unita = unita; dati.pesoSacco = sfuso && sacco > 0 ? sacco : (sfuso ? null : p.pesoSacco ?? null);
  let confezioni = [];
  if (sfuso && !p.sfuso) {
    // diventa sfuso: i prezzi del listino possono essere per il sacco intero, le confezioni contate a pezzi
    const intero = inLitri(fp) ? 'la tanica intera' : 'il sacco intero';
    if (sacco > 0 && (dati.prezzoAcquisto != null || manRaw != null)) {
      const quali = [dati.prezzoAcquisto != null ? 'acquisto ' + fmtEuro(dati.prezzoAcquisto) : '', manRaw != null ? 'a mano ' + fmtEuro(manRaw) : ''].filter(Boolean).join(', ');
      const perSacco = await sceltaBox(`I prezzi scritti (${quali}) sono per ${intero} da ${fmtSf(fp, sacco)}?`, { si: `Sì: li divido per ${fmtNum(sacco)}`, no: 'No, sono già giusti', title: 'Prezzi' });
      if (perSacco === null) return;
      if (perSacco) {
        if (dati.prezzoAcquisto != null) dati.prezzoAcquisto = Math.round(dati.prezzoAcquisto / sacco * 10000) / 10000;
        if (manRaw != null) dati.prezzoManuale = Math.round(manRaw / sacco * 100) / 100;
      }
    }
    const att = lottiAttivi().filter(l => l.prodottoId === p.id);
    if (sacco > 0 && att.length) {
      const n = att.reduce((t, l) => t + (+l.quantita || 0), 0);
      const sacchi = await sceltaBox(`In negozio risultano ${fmtNum(n)} confezioni di questo prodotto. Sono ${nomeSacco(fp, 2)} da ${fmtSf(fp, sacco)}?`, { si: `Sì: diventano ${fmtSf(fp, n * sacco)}`, no: `No, sono già ${nomeBase(fp)}`, title: `Quantità in ${nomeBase(fp)}` });
      if (sacchi === null) return;
      if (sacchi) confezioni = att.map(l => ({ ...l, quantita: r3(l.quantita * sacco), sacchi: l.quantita }));
    }
  }
  if (crea) dati.codici = [...(p.codici || []), await codiceInterno()];
  await save('prodotti', { ...p, ...dati });
  if (confezioni.length) await saveMany('lotti', confezioni);
  if (!sfuso && p.sfuso && lottiAttivi().some(l => l.prodottoId === p.id)) toast(`Salvato. Le quantità erano in ${nomeBase(p)}: controllale nelle confezioni`, { ms: 5000 });
  else toast(crea ? 'Salvato, codice creato' : 'Salvato');
  render();
  if (crea) etichettaPronta(p.id);
};
A['p-stampa-eti'] = el => stampaModal([el.dataset.id]);
/* etichette */
A['eti-tutte'] = () => { ETI.tolte = new Set(); render(); };
A['eti-nessuna'] = () => { ETI.tolte = new Set(prodottiSfusi().map(p => p.id)); render(); };
A['eti-stampa'] = () => {
  const ids = etiScelte().map(p => p.id);
  if (!ids.length) { toast('Spunta almeno un\'etichetta', { err: true }); return; }
  stampaModal(ids);
};
A['p-codice-del'] = async el => { const p = prodotto(current.arg); if (!p) return; await save('prodotti', { ...p, codici: (p.codici || []).filter(c => c !== el.dataset.c) }); aggiornaCodici(); };
A['p-elimina'] = async el => {
  const p = prodotto(el.dataset.id); if (!p) return;
  if (!(await confirmBox(`Elimino "${p.nome}" dal catalogo? Le sue scadenze restano nello storico.`, { ok: 'Elimina', danger: true }))) return;
  await remove('prodotti', p.id); location.hash = '#catalogo';
};
A['nuovo-fornitore'] = async () => {
  const f = { id: uid('f'), nome: 'Nuovo fornitore', daNominare: false, metodo: '', telefono: '', email: '', sito: '', note: '' };
  await save('fornitori', f); location.hash = '#fornitore/' + encodeURIComponent(f.id);
};
A['f-salva'] = async el => {
  const f = fornitore(el.dataset.id); if (!f) return;
  const nome = $('#fNome').value.trim(); if (!nome) { toast('Il nome non può essere vuoto', { err: true }); return; }
  await save('fornitori', { ...f, nome, daNominare: f.daNominare && /^da nominare/i.test(nome), metodo: $('#fMet').value, telefono: $('#fTel').value.trim(), email: $('#fMail').value.trim(), sito: $('#fSito').value.trim(), note: $('#fNote').value.trim() });
  toast('Salvato'); render();
};
A['f-elimina'] = async el => { const f = fornitore(el.dataset.id); if (!f) return; if (!(await confirmBox(`Elimino il fornitore "${f.nome}"?`, { ok: 'Elimina', danger: true }))) return; await remove('fornitori', f.id); location.hash = '#fornitori'; };
/* impostazioni */
A['s-salva'] = async () => {
  const s = settings(); const soglie = JSON.parse(JSON.stringify(s.soglie));
  $$('[data-soglia]').forEach(i => { const [t, k] = i.dataset.soglia.split('|'); soglie[t][+k] = Math.max(0, parseInt(i.value, 10) || 0); });
  for (const t in soglie) soglie[t].sort((a, b) => a - b);
  const av = parseInt($('#sAvanzo').value, 10);
  await setMeta('settings', { soglie, negozio: $('#sNeg').value.trim() || DEFAULT_SETTINGS.negozio, avanzoSfuso: isNaN(av) ? DEFAULT_SETTINGS.avanzoSfuso : Math.min(30, Math.max(0, av)) });
  toast('Impostazioni salvate'); render();
};
/* banco */
A['banco-modo'] = el => { BANCO.modo = el.dataset.m; render(); };
A['banco-senza'] = () => senzaCodiceModal();
A['banco-annulla'] = () => inCoda(async () => { const u = ultimaRiga(); if (u) await annullaRiga(u.id); });
A['banco-qta'] = el => { const id = el.dataset.id, d = +el.dataset.d; return inCoda(() => cambiaQta(id, d)); };
A['banco-tutte'] = () => { BANCO.tutte = true; render(); };
A['banco-peso'] = el => {
  const v = S.vendite.get(el.dataset.id); if (!v) return;
  const p = prodotto(v.prodottoId); if (!p) return;
  pesoModal(p, { titolo: inLitri(p) ? 'Cambia i ml' : 'Cambia il peso', ok: 'Salva', iniziale: v.qta, onOk: kg => inCoda(() => cambiaQta(v.id, r3(kg - v.qta))) });
};
A['banco-annulla-riga'] = el => { const id = el.dataset.id; closeModal(); return inCoda(() => annullaRiga(id)); };
A['vendita-apri'] = el => {
  const v = S.vendite.get(el.dataset.id); if (!v) return;
  const p = prodotto(v.prodottoId), imp = importo(v);
  openModal(`${mhead(v.tipo === 'reso' ? 'Reso del cliente' : 'Vendita')}
    <div><b>${esc(v.prodottoId ? (p ? p.nome : 'Prodotto eliminato') : v.codice)}</b><div class="faint">${fmtDate(v.data)} alle ${fmtOra(v.creato)} · ${v.sfuso ? fmtKg(v.qta) : fmtNum(v.qta) + ' pz'}${imp != null ? ' · ' + fmtEuro(imp) : ''}</div></div>
    ${v.prodottoId ? `<div class="faint small">${esc(infoLotti(v) || 'Nessuna confezione toccata')}${mancaVisibile(v) ? ` · ${fq(p, v.mancanti)} non risultavano in negozio` : ''}</div>` : '<div class="notice orange"><span>Codice da sistemare: collegalo a un prodotto e il magazzino si aggiorna.</span></div>'}
    <div class="stack">
      ${v.prodottoId ? '' : `<button class="btn primary block" type="button" data-act="ds-collega" data-c="${esc(v.codice)}">Collega a un prodotto</button>`}
      ${p ? `<a class="btn block" href="#prodotto/${encodeURIComponent(p.id)}" data-act="close-modal-link">Apri la scheda del prodotto</a>` : ''}
      <button class="btn danger block" type="button" data-act="banco-annulla-riga" data-id="${esc(v.id)}">Annulla questa ${v.tipo === 'reso' ? 'riga' : 'vendita'}</button>
    </div>`);
};
A['ds-apri'] = () => daSistemareModal();
A['ds-collega'] = el => { const c = el.dataset.c; collegaCodice(c, () => inCoda(sistemaEAvvisa)); };
A['ds-elimina'] = async el => {
  const c = el.dataset.c, vs = daSistemare().filter(v => v.codice === c);
  closeModal();
  if (!(await confirmBox(`Elimino ${vs.length === 1 ? 'la vendita' : `le ${vs.length} vendite`} con il codice ${c}? Il magazzino non cambia.`, { ok: 'Elimina', danger: true }))) return;
  for (const v of vs) await remove('vendite', v.id);
  toast('Eliminate'); render();
};
/* chiusura */
A['ch-lista'] = el => {
  const righe = venditeDel(todayISO()), carico = el.dataset.l === 'carico';
  const sel = carico ? righe.filter(v => v.tipo === 'vendita' && mancaVisibile(v)) : righe.filter(v => v.prodottoId && prezzoRiga(v) == null);
  const m = new Map(); for (const v of sel) m.set(v.prodottoId, (m.get(v.prodottoId) || 0) + (carico ? v.mancanti : v.qta));
  openModal(`${mhead(carico ? 'Venduti senza carico' : 'Prodotti senza prezzo')}
    <p class="muted small" style="margin:0">${carico ? 'Questi pezzi sono stati venduti ma non risultavano in negozio: probabilmente l\'arrivo non è stato registrato. Registralo in Arrivi.' : 'Questi prodotti non hanno un prezzo nell\'app. Aggiungilo nella scheda: così contano nel confronto con la cassa.'}</p>
    <div class="list">${[...m.entries()].map(([pid, q]) => { const p = prodotto(pid); return `<a class="item" href="#prodotto/${encodeURIComponent(pid)}" data-act="close-modal-link"><div class="main"><div class="name">${esc(p ? p.nome : '?')}</div><div class="sub">${fq(p, q)}</div></div><span class="chev">›</span></a>`; }).join('')}</div>`);
};
A['ch-chiudi'] = async () => {
  const d = datiChiusura();
  if (CH.incasso.trim() && d.inc == null) { toast('L\'incasso non è un numero valido', { err: true }); return; }
  if (d.inc == null && !(await confirmBox('Non hai scritto l\'incasso della cassa. Faccio solo il backup?', { ok: 'Solo backup' }))) return;
  if (d.inc != null) await save('chiusure', { id: 'c' + d.oggi, data: d.oggi, incasso: d.inc, frutta: d.fr, scansionato: d.scansionato, differenza: d.diff, creato: Date.now() });
  await faiBackup();
};

document.addEventListener('click', async e => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const h = A[el.dataset.act];
  if (!h) return;
  if (el.type === 'checkbox') { if (el.dataset.act === 'senza') { CS.senza = el.checked; if (CS.senza) CS.field = 'qta'; else CS.field = 'scad'; render(); } return; }
  e.preventDefault();
  try { await h(el, e); } catch (err) { console.error(err); toast('Qualcosa non ha funzionato: ' + err.message, { err: true }); }
  if (el.tagName === 'BUTTON' && document.contains(el)) el.blur();
});
A.senza = () => { };

/* =========================================================
   Avvio
   ========================================================= */
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt = e; if (['home', 'impostazioni'].includes(current.name)) render(); });
async function init() {
  try { db = await openDB(); await loadAll(); }
  catch (e) { $('#view').innerHTML = `<div class="notice red">Non riesco ad aprire i dati sul telefono: ${esc(e.message)}</div>`; return; }
  rebuildCodeIndex();
  try { await migraSprechi(); } catch (e) { }
  route();
  avviaSync();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persisted().then(p => { persistito = p; if (!p) navigator.storage.persist().then(v => { persistito = v; }); });
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    if (navigator.serviceWorker.controller) {
      let ricaricato = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (ricaricato) return;
        if (CS.pid || modal.open) { toast('È pronta una nuova versione dell\'app', { action: { label: 'Aggiorna', run: () => location.reload() } }); return; }
        ricaricato = true; location.reload();
      });
    }
    navigator.serviceWorker.register('sw.js').then(reg => {
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        if (w) w.addEventListener('statechange', () => { if (w.state === 'activated' && navigator.serviceWorker.controller) toast('È pronta una nuova versione dell\'app', { action: { label: 'Aggiorna', run: () => location.reload() } }); });
      });
    }).catch(() => { });
  }
  window.__app = { S, onScan, parseScadenza, save, VERSIONE, giro, SYNC: () => SYNC, setMeta };
}
init();
})();
