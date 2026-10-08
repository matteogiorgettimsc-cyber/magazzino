/* Magazzino – La Spesa Sfusa
   App offline: vendita al banco, scadenze e ordini. Dati salvati sul telefono (IndexedDB), backup su Drive. */
(function () {
'use strict';

const VERSIONE = '1.14.1';

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
/* nome da mostrare per una vendita: se il prodotto è stato tolto dal catalogo, quello scritto nella vendita (dalla 1.14.1) */
const nomeVendita = v => !v.prodottoId ? (v.codice || '?') : prodotto(v.prodottoId) ? prodotto(v.prodottoId).nome : v.nome ? `${v.nome} (eliminato)` : 'Prodotto eliminato';
const ELIMINATI = 'Prodotti eliminati';
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
const STORES = ['fornitori', 'prodotti', 'lotti', 'ordini', 'sprechi', 'vendite', 'chiusure', 'fatture', 'spese', 'meta'];
const DATI = ['fornitori', 'prodotti', 'lotti', 'ordini', 'sprechi', 'vendite', 'chiusure', 'fatture', 'spese'];   // archivi salvati nel backup
let db;
const S = { fornitori: new Map(), prodotti: new Map(), lotti: new Map(), ordini: new Map(), sprechi: new Map(), vendite: new Map(), chiusure: new Map(), fatture: new Map(), spese: new Map(), meta: {}, coda: new Map() };

function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 6);
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
/* ANNULLA L'ULTIMA MODIFICA: ogni azione di chi usa l'app (un tocco, un tasto, una scansione) è un gruppo;
   per ogni scrittura del gruppo si ricorda com'era prima e com'è dopo, così «Annulla» la rimette com'era
   (e «Rifai» la ripete). Le scritture fatte all'avvio o ricevute dagli altri dispositivi non contano. */
const ANN = { pila: [], rifare: null, gruppo: 0, applico: false };
['pointerdown', 'keydown'].forEach(t => document.addEventListener(t, e => { if (!(e.target.closest && e.target.closest('#undoBtn'))) ANN.gruppo++; }, true));
const copia = o => o === undefined ? undefined : JSON.parse(JSON.stringify(o));
function ricorda(store, prima, dopo) {
  if (ANN.applico || !ANN.gruppo) return;
  const id = (dopo || prima || {}).id; if (id == null) return;
  let v = ANN.pila[ANN.pila.length - 1];
  if (!v || v.gruppo !== ANN.gruppo) { v = { gruppo: ANN.gruppo, voci: new Map() }; ANN.pila.push(v); if (ANN.pila.length > 30) ANN.pila.shift(); }
  const k = store + '~' + id, x = v.voci.get(k);
  if (x) x.dopo = copia(dopo); else v.voci.set(k, { store, id, prima: copia(prima), dopo: copia(dopo) });
  ANN.rifare = null;
  aggiornaUndo();
}
function aggiornaUndo() { const bt = document.getElementById('undoBtn'); if (bt) bt.hidden = !ANN.pila.length; }
/* ogni scrittura passa da qui: con la sincronizzazione attiva, la modifica entra nella coda
   nella stessa transazione, così non si perde nemmeno se l'app si chiude subito dopo */
async function save(store, obj) {
  const prev = S[store].get(obj.id);
  ricorda(store, prev, obj);
  S[store].set(obj.id, obj);
  const q = codaPer(store, [[prev, obj]]);
  await txConCoda(store, s => s.put(obj), q);
  if (store === 'prodotti') rebuildCodeIndex();
  if (store === 'lotti') dopoLotti([[prev, obj]]);
}
async function saveMany(store, arr) {
  const coppie = arr.map(o => [S[store].get(o.id), o]);
  coppie.forEach(([a, b]) => ricorda(store, a, b));
  arr.forEach(o => S[store].set(o.id, o));
  const q = codaPer(store, coppie);
  await txConCoda(store, s => arr.forEach(o => s.put(o)), q);
  if (store === 'prodotti') rebuildCodeIndex();
  if (store === 'lotti') dopoLotti(coppie);
}
async function remove(store, id) {
  const prev = S[store].get(id);
  if (prev) ricorda(store, prev, undefined);
  S[store].delete(id);
  const q = prev && syncAttiva() && SYNC_STORES.includes(store) ? [voceCoda({ st: store, id, del: true })] : [];
  await txConCoda(store, s => s.delete(id), q);
  if (store === 'prodotti') rebuildCodeIndex();
  if (store === 'lotti' && prev) dopoLotti([[prev, undefined]]);
}
/* scorta minima: quando la merce di un prodotto SCENDE fino alla soglia (vendita, spreco, esaurito…),
   il prodotto va da solo nell'ordine da preparare. Solo nel momento in cui la soglia si passa:
   un prodotto mai contato (0 in negozio) non fa scattare niente, e le modifiche ricevute
   dagli altri dispositivi non passano da qui (così non si ordina due volte). */
function dopoLotti(coppie) {
  const c = l => l && l.stato === 'attivo' ? (+l.quantita || 0) : 0;
  const delta = new Map();
  for (const [prev, obj] of coppie) { const pid = (obj || prev).prodottoId; delta.set(pid, (delta.get(pid) || 0) + c(obj) - c(prev)); }
  for (const [pid, d] of delta) {
    const dopo = giacenza(pid);
    if (d < 0) controllaScorta(pid, r3(dopo - d), dopo);
    else if (d > 0 && (S.meta.riordinoTolti || {})[pid]) { const s = sogliaScorta(prodotto(pid)); if (s == null || dopo > s) setTimeout(() => segnaTolto(pid, false), 0); }
  }
}
async function removeMany(store, ids) {
  const prev = ids.map(id => S[store].get(id)).filter(Boolean);
  prev.forEach(p => ricorda(store, p, undefined));
  ids.forEach(id => S[store].delete(id));
  const q = syncAttiva() && SYNC_STORES.includes(store) ? prev.map(p => voceCoda({ st: store, id: p.id, del: true })) : [];
  await txConCoda(store, s => ids.forEach(id => s.delete(id)), q);
  if (store === 'prodotti') rebuildCodeIndex();
}
async function setMeta(key, value) {
  if (key === 'settings') ricorda('meta', { id: key, value: S.meta[key] }, { id: key, value });
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

const DEFAULT_SETTINGS = { soglie: { preferibilmente: [7, 15, 30], entro: [2, 5, 10] }, negozio: 'La Spesa Sfusa', avanzoSfuso: 5, scortaMin: 3 };
function settings() {
  const s = S.meta.settings || {};
  return { negozio: s.negozio || DEFAULT_SETTINGS.negozio, soglie: Object.assign({}, DEFAULT_SETTINGS.soglie, s.soglie || {}), avanzoSfuso: s.avanzoSfuso ?? DEFAULT_SETTINGS.avanzoSfuso, scortaMin: s.scortaMin ?? DEFAULT_SETTINGS.scortaMin };
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
function cerca(q, { fornitoreId = '', limit = 60, soloSenzaCodice = false, soloSfuso = false, categoria = '' } = {}) {
  const nq = norm(q), words = nq ? nq.split(' ') : [], code = String(q || '').trim();
  const out = [];
  for (const p of S.prodotti.values()) {
    if (fornitoreId && p.fornitoreId !== fornitoreId) continue;
    if (soloSenzaCodice && (p.codici || []).length) continue;
    if (soloSfuso && !p.sfuso) continue;
    if (categoria && (catDi(p) || SENZA_CAT) !== categoria) continue;
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
function pickerModal({ title, intro = '', code = null, onPick, q0 = '', fornitoreId = '', nomeNuovo = null }) {
  let q = q0;
  const draw = b => {
    const res = cerca(q, { limit: 40 });
    b.querySelector('#pkList').innerHTML = res.items.length
      ? res.items.map(p => rigaProdotto(p, 'pk-pick')).join('') + (res.total > res.items.length ? `<div class="item faint">Altri ${res.total - res.items.length}: scrivi di più per restringere</div>` : '')
      : `<div class="empty">Nessun prodotto trovato.</div>`;
  };
  openModal(`${mhead(title)}${intro}
    <input type="search" id="pkQ" placeholder="Cerca per nome, es. mozzarella bufala" autocomplete="off" value="${esc(q0)}">
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
    b.querySelector('#pkNew').onclick = () => nuovoProdottoModal({ code, nome: nomeNuovo || q, fornitoreId, onDone: onPick });
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
      <div class="btn-grid" style="grid-template-columns:1fr 1fr"><button class="btn primary" type="button" data-act="sr-carico" data-id="${esc(p.id)}">Arrivo merce</button><button class="btn primary" type="button" data-act="sr-inventario" data-id="${esc(p.id)}">Inventario</button></div>
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
/* =========================================================
   SALVATAGGIO AUTOMATICO delle schede (prodotto, fornitore, impostazioni)
   - si salva all'uscita da un campo, poco dopo aver smesso di scrivere e lasciando la pagina
   - i valori si leggono subito (anche mentre la pagina sta cambiando); i salvataggi vanno in fila
   ========================================================= */
let paginaSalva = null, autoCtrl = null;   // salva adesso la pagina aperta, se c'è qualcosa di cambiato
function salvaPagina() {
  if (paginaSalva) { const f = paginaSalva; paginaSalva = null; try { f(); } catch (e) { console.error(e); } }
  if (autoCtrl) { autoCtrl.abort(); autoCtrl = null; }
}
function autoSalva(b, leggi) {
  if (autoCtrl) autoCtrl.abort();
  autoCtrl = new AbortController();
  const signal = autoCtrl.signal;
  let timer = null, coda = Promise.resolve(), sporco = false;
  const mostra = (t, err) => b.querySelectorAll('.salva-stato').forEach(x => { x.textContent = t; x.classList.toggle('err', !!err); });
  const ora = () => {
    clearTimeout(timer); timer = null;
    if (!sporco) return coda;
    sporco = false;
    let r;
    try { r = leggi(); } catch (e) { console.error(e); return coda; }
    if (!r) return coda;
    if (r.errore) { mostra(r.errore, true); return coda; }
    coda = coda.then(() => r.salva()).then(esito => { if (esito !== false) mostra(`Salvato alle ${fmtOra(Date.now())}`); })
      .catch(e => { console.error(e); mostra('Non salvato: ' + e.message, true); });
    return coda;
  };
  b.addEventListener('input', e => {
    if (!e.target.closest('[data-auto]')) return;
    sporco = true; clearTimeout(timer); timer = setTimeout(ora, 900);
  }, { signal });
  b.addEventListener('change', e => { if (e.target.closest('[data-auto]')) { sporco = true; ora(); } }, { signal });
  signal.addEventListener('abort', () => clearTimeout(timer));
  paginaSalva = ora;
  return ora;
}
document.addEventListener('visibilitychange', () => { if (document.hidden && paginaSalva) paginaSalva(); });
function route() {
  salvaPagina();   // prima di cambiare pagina: quello che è stato scritto si salva
  const h = decodeURIComponent((location.hash || '#home').slice(1));
  const i = h.indexOf('/');
  const name = i < 0 ? h : h.slice(0, i), arg = i < 0 ? null : h.slice(i + 1);
  current = { name: routes[name] ? name : 'home', arg, onScan: null, back: null };
  if (modal.open) closeModal();
  $('#toast').hidden = true;
  render(true);
}
function render(scrollTop = false) {
  salvaPagina();
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
  {
    const fat = [...S.fatture.values()], daC = fat.filter(f => f.stato !== 'controllata').length;
    const pag = tuttiPagamenti().filter(x => !x.pagata && x.data <= piuGiorni(7)).length;
    const sub = fat.length || pag ? [fat.length ? (daC ? `${daC} da controllare` : 'tutte controllate') : '', pag ? `${pag} ${pag === 1 ? 'pagamento' : 'pagamenti'} entro 7 giorni` : ''].filter(Boolean).join(' · ') : 'Carica le fatture dei fornitori';
    if (conFatture()) html += `<a class="card tight" href="#fatture" style="text-decoration:none"><div class="row"><div class="spacer"><b>Fatture e pagamenti</b><div class="faint small ${pag ? 'arancio' : ''}">${sub}</div></div><span class="chev">›</span></div></a>`;
    else if (conPagamenti()) html += `<a class="card tight" href="#pagamenti" style="text-decoration:none"><div class="row"><div class="spacer"><b>Pagamenti</b><div class="faint small ${pag ? 'arancio' : ''}">${pag ? `${pag} ${pag === 1 ? 'pagamento' : 'pagamenti'} entro 7 giorni` : 'Affitto, bollette e altre spese da pagare'}</div></div><span class="chev">›</span></div></a>`;
    const n = numeriPeriodo('mese');
    html += `<a class="card tight" href="#cruscotto" style="text-decoration:none"><div class="row"><div class="spacer"><b>Cruscotto</b><div class="faint small">${n.chiusure.length || n.ricavo ? [n.chiusure.length ? `Incassi del mese ${fmtEuro(n.incassi)}` : '', n.perc != null ? `margine ${fmtNum(n.perc)}%` : ''].filter(Boolean).join(' · ') : 'Incassi, spese, margini, riepilogo per la contabilità'}</div></div><span class="chev">›</span></div></a>`;
  }
  const spm = sprechiPeriodo('mese').filter(perso);
  if (spm.length) html += `<a class="card tight" href="#sprechi" style="text-decoration:none"><div class="row"><div class="spacer"><b>Sprechi di questo mese</b><div class="faint small">${totaleQta(spm)} · ${fmtEuro(spm.reduce((t, r) => t + (valoreSpreco(r) || 0), 0))}</div></div><span class="chev">›</span></div></a>`;
  html += `<div class="faint" style="text-align:center">Puoi anche scansionare un prodotto in qualsiasi momento per vedere cosa fare.</div>`;
  const warn = giorniBk == null || giorniBk >= 3;
  html += `<div class="notice ${warn ? 'red' : 'green'}"><div class="spacer">${giorniBk == null ? '<b>Nessun backup ancora.</b> Fallo ogni giorno a fine lavoro.' : giorniBk === 0 ? 'Backup fatto oggi.' : `Ultimo backup: <b>${giorniBk === 1 ? 'ieri' : giorniBk + ' giorni fa'}</b>.`}</div>
    <button class="btn small ${warn ? 'primary' : ''}" type="button" data-act="backup">Fai backup</button></div>`;
  if (installPrompt) html += `<button class="btn block" type="button" data-act="installa">Installa l'app sul telefono</button>`;
  if (syncAttiva()) html += `<div id="syncStato" class="${classeStato()}" style="text-align:center">${esc(testoStato())}</div>`;
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
  if (arg === 'inventario' && CS.modo !== 'inventario') CS = cambiaModo('inventario');
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
  if (CS.modo === 'arrivo') l.qtaIniziale = qta;   // per il confronto con le fatture
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

/* prezzo di vendita: quello scritto a mano comanda; se non c'è, il calcolato (il prezzo del listino non si usa più) */
const prezzoVendita = p => p ? (p.prezzoManuale ?? prezzoCalcolato(p) ?? null) : null;
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
    // confezione cancellata, o di un prodotto tolto dal catalogo: resta com'è (non torna in negozio)
    if (!l || !pr.qta || l.stato === 'eliminato' || !S.prodotti.has(l.prodottoId)) continue;
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
  await save('vendite', { id: uid('v'), tipo: 'vendita', data: todayISO(), creato: ora, aggiornato: ora, prodottoId: p.id, nome: p.nome, codice: null, qta: r3(kg), prezzo: prezzoVendita(p), sfuso: true, prelievi: r.prelievi, mancanti: r.mancanti, origine });
  render();
}

async function vendi(p, { origine = 'scansione' } = {}) {
  const u = ultimaRiga(), ora = Date.now();
  if (u && u.tipo === 'vendita' && u.prodottoId === p.id && ora - (u.aggiornato || u.creato) < RAGGRUPPA_MS) return cambiaQta(u.id, 1);
  const r = await preleva(p.id, 1);
  await save('vendite', { id: uid('v'), tipo: 'vendita', data: todayISO(), creato: ora, aggiornato: ora, prodottoId: p.id, nome: p.nome, codice: null, qta: 1, prezzo: prezzoVendita(p), prelievi: r.prelievi, mancanti: r.mancanti, origine });
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
  await save('vendite', { id: uid('v'), tipo: 'reso', data: todayISO(), creato: ora, aggiornato: ora, prodottoId: p.id, nome: p.nome, codice: null, qta, prezzo: prezzoVendita(p), sfuso: isSfuso(p) || undefined, prelievi: [{ lottoId, qta }], mancanti: 0, lottoNuovo: nuovo, origine: 'scansione' });
  toast(`Reso: ${isSfuso(p) ? fmtSf(p, qta) + ' di ' : ''}${p.nome} torna in negozio`);
  render();
}
async function annullaRiga(id, { silenzioso = false } = {}) {
  const v = S.vendite.get(id); if (!v) return;
  if (v.tipo === 'reso') {
    const l = v.prelievi[0] && S.lotti.get(v.prelievi[0].lottoId);
    if (v.lottoNuovo && l && l.stato === 'attivo' && (+l.quantita || 0) <= v.qta) await remove('lotti', l.id);
    else await muovi(v.prelievi, -1);
  } else await muovi(v.prelievi, 1);
  await remove('vendite', id);
  if (silenzioso) return;
  const p = prodotto(v.prodottoId);
  toast(`Annullato: ${p && v.sfuso ? fmtSf(p, v.qta) + ' di' : fmtNum(v.qta) + ' ×'} ${nomeVendita(v)}`);
  render();
}
/* vendite con codice sconosciuto: quando il codice viene collegato, i pezzi escono dal magazzino */
async function sistemaCodici() {
  let n = 0;
  for (const v0 of daSistemare()) {
    const p = byCode(v0.codice); if (!p) continue;
    const v = S.vendite.get(v0.id); if (!v || v.prodottoId) continue;
    if (isSfuso(p)) {   // il peso non si conosce: si collega il prodotto ma il magazzino non cambia
      await save('vendite', { ...v, prodottoId: p.id, nome: p.nome, prezzo: prezzoVendita(p), sfuso: true, qta: 0, pesoMancante: v.qta, prelievi: [], mancanti: 0, sistemato: Date.now() });
      n++; continue;
    }
    const r = await preleva(p.id, v.qta);
    await save('vendite', { ...v, prodottoId: p.id, nome: p.nome, prezzo: prezzoVendita(p), prelievi: r.prelievi, mancanti: r.mancanti, sistemato: Date.now() });
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
    <div class="nome">${esc(nomeVendita(v))}</div>
    <div class="info">${[infoLotti(v), 'in negozio ' + fq(p, giacenza(v.prodottoId))].filter(Boolean).join(' · ')}</div>
    ${manca}
    <div class="bottom"><div class="tot">${imp == null ? '<small>Prezzo non impostato</small>' : fmtEuro(imp)}${sotto}</div>${destra}</div></section>`;
}
function rigaVendita(v) {
  const p = prodotto(v.prodottoId), imp = importo(v);
  const nome = nomeVendita(v);
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
    <div class="faint small" style="text-align:center">Il backup va sul Google Drive del negozio.</div>
    <a class="btn ghost block" href="#cassa">Storico di cassa: correggi i giorni passati</a>`;
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
/* soglia: pezzi (di base quella delle impostazioni, 3) oppure kg/litri per lo sfuso (solo se scritta nella scheda) */
function sogliaScorta(p) {
  if (!p) return null;
  if (isSfuso(p)) return p.scortaMin > 0 ? p.scortaMin : null;
  const v = p.scortaMin ?? settings().scortaMin;
  return v > 0 ? v : null;
}
function controllaScorta(pid, prima, dopo) {
  const s = sogliaScorta(prodotto(pid));
  if (s == null || !(prima > s) || dopo > s) return;
  setTimeout(() => riordina(pid, dopo).catch(e => console.error(e)), 0);
}
const inArrivo = pid => ordiniInviati().some(o => o.righe.some(r => r.prodottoId === pid && (r.ricevuto || 0) < r.qta));
const riordinoInCorso = new Set();   // due vendite ravvicinate non devono aggiungere il prodotto due volte
async function riordina(pid, resto) {
  if (riordinoInCorso.has(pid)) return;
  riordinoInCorso.add(pid);
  try { await riordinaOra(pid, resto); } finally { riordinoInCorso.delete(pid); }
}
async function riordinaOra(pid, resto) {
  const p = prodotto(pid); if (!p) return;
  const quanto = fq(p, resto);
  if (!p.fornitoreId) { toast(`Sta finendo ${p.nome} (restano ${quanto}), ma non ha un fornitore: aggiungilo nella scheda`, { err: true, ms: 6000 }); return; }
  const o = ordineAperto(p.fornitoreId);
  if (o && o.righe.some(r => r.prodottoId === pid)) return;     // c'è già in Da ordinare
  if (inArrivo(pid)) return;                                      // già ordinato, sta arrivando
  const u = ultimoOrdine(pid);
  await aggiungiOrdine(pid, u && u.qta > 0 ? u.qta : 1, { silent: true, auto: true });
  aggiornaBadge();
  toast(`Sta finendo ${p.nome} (restano ${quanto}): messo in Da ordinare`, { action: { label: 'Togli', run: () => togliDaOrdine(pid) } });
}
async function togliDaOrdine(pid) {
  const p = prodotto(pid), o = p && ordineAperto(p.fornitoreId);
  if (!o) return;
  await save('ordini', { ...o, righe: o.righe.filter(r => r.prodottoId !== pid) });
  await segnaTolto(pid, true);
  toast(`Tolto da Da ordinare: ${p.nome}`); render();
}
/* tolto a mano da Da ordinare: non ce lo rimetto finché la merce non risale sopra la soglia */
async function segnaTolto(pid, si) {
  const t = { ...(S.meta.riordinoTolti || {}) };
  if (si ? t[pid] : !t[pid]) return;
  if (si) t[pid] = todayISO(); else delete t[pid];
  await setMeta('riordinoTolti', t);
}
/* controllo di tutte le scorte: prodotti già contati (con almeno una confezione registrata, anche finita)
   che sono alla soglia o sotto, e non ancora ordinati. Serve per la merce caricata con pochi pezzi
   (inventario, arrivi) e per quello che è finito prima della 1.8.0. */
function daRiordinare() {
  const g = new Map(), contati = new Set();
  for (const l of S.lotti.values()) { contati.add(l.prodottoId); if (l.stato === 'attivo') g.set(l.prodottoId, (g.get(l.prodottoId) || 0) + (+l.quantita || 0)); }
  const tolti = S.meta.riordinoTolti || {}, out = [];
  for (const p of S.prodotti.values()) {
    if (!contati.has(p.id) || !p.fornitoreId || tolti[p.id]) continue;
    const s = sogliaScorta(p);
    if (s == null || r3(g.get(p.id) || 0) > s) continue;
    const o = ordineAperto(p.fornitoreId);
    if (o && o.righe.some(r => r.prodottoId === p.id)) continue;
    if (inArrivo(p.id)) continue;
    out.push(p);
  }
  return out;
}
let controlloInCorso = false;
async function controlloScorte({ avviso = true } = {}) {
  if (controlloInCorso) return 0;
  controlloInCorso = true;
  try {
    // chi è risalito sopra la soglia esce dai «tolti»
    const t = S.meta.riordinoTolti || {}, via = Object.keys(t).filter(pid => { const p = prodotto(pid), s = sogliaScorta(p); return !p || s == null || giacenza(pid) > s; });
    if (via.length) { const n = { ...t }; via.forEach(k => delete n[k]); await setMeta('riordinoTolti', n); }
    const lista = daRiordinare();
    for (const p of lista) { const u = ultimoOrdine(p.id); await aggiungiOrdine(p.id, u && u.qta > 0 ? u.qta : 1, { silent: true, auto: true }); }
    if (lista.length) {
      aggiornaBadge();
      if (avviso) toast(lista.length === 1 ? `Sta finendo ${lista[0].nome}: messo in Da ordinare` : `${lista.length} prodotti stanno finendo: messi in Da ordinare`,
        { action: { label: 'Vedi', run: () => { location.hash = '#ordini'; } } });
    }
    return lista.length;
  } finally { controlloInCorso = false; }
}
async function aggiungiOrdine(pid, qta = 1, { silent = false, auto = false } = {}) {
  const p = prodotto(pid); if (!p) return;
  if (!p.fornitoreId) { toast(`${p.nome} non ha un fornitore: aggiungilo nella scheda prodotto`, { err: true }); return; }
  let o = ordineAperto(p.fornitoreId);
  if (!o) o = { id: uid('o'), fornitoreId: p.fornitoreId, stato: 'aperto', righe: [], creato: Date.now(), inviato: null, chiuso: null };
  const righe = o.righe.map(r => ({ ...r }));
  const r = righe.find(r => r.prodottoId === pid);
  if (r) r.qta += qta; else righe.push(auto ? { prodottoId: pid, qta, ricevuto: 0, auto: true } : { prodottoId: pid, qta, ricevuto: 0 });
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
      return `<div class="item ord-row"><div class="main"><div class="name">${esc(p ? p.nome : '?')}${p && p.sfuso ? ` <span class="tag sfuso">${nomeSacco(p, 2)}${p.pesoSacco ? ' da ' + fmtSf(p, p.pesoSacco) : ''}</span>` : ''}${r.auto ? ' <span class="tag warn">sta finendo</span>' : ''}</div><div class="sub">${u ? `ultima volta ${p && p.sfuso ? fmtSacchi(u.qta, p) : fmtNum(u.qta)} il ${fmtDate(u.data)}` : 'mai ordinato nell\'app'}${p ? ' · in negozio ' + fq(p, giacenza(p.id)) : ''}</div></div>
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
    if (current.fresh) controlloScorte({ avviso: false }).then(n => { if (n && current.name === 'ordini') render(); });
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
      for (const r of o.righe) if (!(r.qta > 0)) await segnaTolto(r.prodottoId, true);   // messo a 0: non serviva
      await save('ordini', { ...o, stato: 'inviato', inviato: todayISO(), righe: o.righe.filter(r => r.qta > 0), testo: txt() });
      closeModal(); toast('Ordine segnato come inviato'); render();
    });
  });
}

/* =========================================================
   CATALOGO, PRODOTTO, FORNITORI
   ========================================================= */
let CAT = { q: '', forn: '', cat: '', limite: 60, senzaCodice: false, sfuso: false, sel: null };   // sel: prodotti scelti per eliminarli (null = scelta spenta)
const filtroCat = (limit = CAT.limite) => cerca(CAT.q, { fornitoreId: CAT.forn, limit, soloSenzaCodice: CAT.senzaCodice, soloSfuso: CAT.sfuso, categoria: CAT.cat });
function catListHTML() {
  const res = filtroCat(), sel = CAT.sel;
  if (!res.total) return `<div class="empty">Nessun prodotto.</div>`;
  const prima = new Map();
  for (const l of lottiAttivi()) if (l.scadenza) { const x = prima.get(l.prodottoId); if (!x || l.scadenza < x) prima.set(l.prodottoId, l.scadenza); }
  const testa = sel
    ? `<div class="row wrap"><b class="spacer" id="selN">${testoSel(sel.size, 'prodotto', 'prodotti')}</b><button class="btn small" type="button" data-act="cat-sel-tutti">Tutti i ${res.total}</button><button class="btn small" type="button" data-act="cat-sel-nessuno">Nessuno</button><button class="btn small" type="button" data-act="cat-categoria">Categoria…</button></div>`
    : `<div class="row"><span class="faint spacer">${res.total} prodotti</span><button class="btn small" type="button" data-act="cat-sel">Seleziona</button></div>`;
  return `${testa}<div class="list">${res.items.map(p => {
    const g = giacenza(p.id), s = prima.get(p.id);
    const pv = prezzoVendita(p);
    const corpo = `<div class="main"><div class="name">${esc(p.nome)}</div>
      <div class="sub">${esc(nomeForn(p.fornitoreId))}${p.formato ? ' · ' + esc(p.formato) : ''}${g ? ' · in negozio ' + fq(p, g) : ''}${s ? ' · scade ' + fmtDate(s) : ''}</div></div>
      ${p.sfuso ? '<span class="tag sfuso">sfuso</span>' : ''}${(p.codici || []).length ? '<span class="tag ok">codice</span>' : ''}
      ${pv == null ? '<span class="tag warn">senza prezzo</span>' : `<span class="prezzo cat-prezzo">${prezzoBreve(p)}${p.prezzoManuale != null ? '<small>a mano</small>' : ''}</span>`}`;
    return sel ? `<label class="item sel-riga"><input type="checkbox" data-sel="${esc(p.id)}" ${sel.has(p.id) ? 'checked' : ''}>${corpo}</label>`
      : `<a class="item" href="#prodotto/${encodeURIComponent(p.id)}">${corpo}<span class="chev">›</span></a>`;
  }).join('')}</div>${res.total > res.items.length ? `<button class="btn block" type="button" data-act="cat-altri">Mostra altri (${res.total - res.items.length})</button>` : ''}`;
}
const testoSel = (n, uno, tanti) => n === 1 ? `1 ${uno} scelto` : `${n} ${tanti} scelti`;
/* barra in fondo mentre si sceglie cosa eliminare */
const barraSel = (n, uno, tanti, act, fine) => `<div class="sel-barra"><button class="btn" type="button" data-act="${fine}">Annulla</button>
  <button class="btn danger" type="button" data-act="${act}" id="selDel" ${n ? '' : 'disabled'}>Elimina ${n === 1 ? '1 ' + uno : n + ' ' + tanti}</button></div>`;
function aggiornaSel(b, sel, uno, tanti) {
  const n = sel.size, t = b.querySelector('#selN'), d = b.querySelector('#selDel');
  if (t) t.textContent = testoSel(n, uno, tanti);
  if (d) { d.textContent = `Elimina ${n === 1 ? '1 ' + uno : n + ' ' + tanti}`; d.disabled = !n; }
}
const segCat = on => `<div class="segmented"><a href="#catalogo" class="${on === 'p' ? 'on' : ''}">Prodotti</a><a href="#fornitori" class="${on === 'f' ? 'on' : ''}">Fornitori</a></div>`;
routes.catalogo = arg => {
  if (current.fresh) CAT.sel = null;     // la scelta per eliminare si spegne uscendo dalla pagina
  if (current.fresh && arg) { CAT.forn = arg; CAT.q = ''; CAT.limite = 60; }
  const forn = [...S.fornitori.values()].sort((a, b) => a.nome.localeCompare(b.nome, 'it'));
  const html = `${segCat('p')}
    <input type="search" id="catQ" placeholder="Cerca per nome o codice" value="${esc(CAT.q)}" autocomplete="off">
    <div class="row wrap"><select id="catF" style="flex:1;min-width:200px"><option value="">Tutti i fornitori</option>${forn.map(f => `<option value="${esc(f.id)}" ${CAT.forn === f.id ? 'selected' : ''}>${esc(f.nome)}</option>`).join('')}</select>
      <label class="check"><input type="checkbox" id="catSC" ${CAT.senzaCodice ? 'checked' : ''}> Senza codice</label>
      <label class="check"><input type="checkbox" id="catSF" ${CAT.sfuso ? 'checked' : ''}> Sfuso</label></div>
    <select id="catC"><option value="">Tutte le categorie</option>${[...categorieUsate().filter(c => [...S.prodotti.values()].some(p => catDi(p) === c)), SENZA_CAT].map(c => `<option value="${esc(c)}" ${CAT.cat === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
    ${!CAT.sel && [...S.prodotti.values()].some(p => p.sfuso) ? '<a class="btn block" href="#etichette">Etichette dei contenitori sfusi</a>' : ''}
    <div id="catList" class="stack">${catListHTML()}</div>
    ${CAT.sel ? barraSel(CAT.sel.size, 'prodotto', 'prodotti', 'cat-elimina', 'cat-sel-fine') : '<button class="btn block" type="button" data-act="nuovo-prodotto">+ Nuovo prodotto</button>'}`;
  return {
    title: 'Catalogo', html, tab: 'catalogo',
    mount: b => {
      const upd = () => { CAT.limite = 60; b.querySelector('#catList').innerHTML = catListHTML(); };
      b.querySelector('#catList').addEventListener('change', e => {
        const c = e.target.closest('[data-sel]'); if (!c || !CAT.sel) return;
        if (c.checked) CAT.sel.add(c.dataset.sel); else CAT.sel.delete(c.dataset.sel);
        aggiornaSel(b, CAT.sel, 'prodotto', 'prodotti');
      });
      b.querySelector('#catQ').addEventListener('input', e => { CAT.q = e.target.value; upd(); });
      b.querySelector('#catF').addEventListener('change', e => { CAT.forn = e.target.value; upd(); });
      b.querySelector('#catSC').addEventListener('change', e => { CAT.senzaCodice = e.target.checked; upd(); });
      b.querySelector('#catSF').addEventListener('change', e => { CAT.sfuso = e.target.checked; upd(); });
      b.querySelector('#catC').addEventListener('change', e => { CAT.cat = e.target.value; upd(); });
    },
    onScan: code => { const p = byCode(code); if (p) location.hash = '#prodotto/' + encodeURIComponent(p.id); else collegaCodice(code, p2 => { location.hash = '#prodotto/' + encodeURIComponent(p2.id); }); }
  };
};
/* il prezzo che vale davvero: a mano se c'è, altrimenti calcolato */
function valeHtml(p, calc, man) {
  if (man != null && !isNaN(man)) return `Prezzo di vendita: <b>${fmtEuro(perUnita(p, man))}</b>${alKg(p)} <span class="tag">scritto a mano</span>`;
  if (calc != null) return `Prezzo di vendita: <b>${fmtEuro(perUnita(p, calc))}</b>${alKg(p)} <span class="tag ok">calcolato</span>`;
  return `<span class="arancio">Senza prezzo di vendita: scrivi acquisto e IVA, oppure il prezzo a mano.</span>`;
}
/* scorta minima nella scheda: pezzi per i prodotti normali, kg (o litri) per lo sfuso */
const unitaScorta = p => isSfuso(p) ? nomeBase(p) : 'pezzi';
const segnapostoScorta = p => isSfuso(p) ? 'nessuna' : String(settings().scortaMin);
const aiutoScorta = p => isSfuso(p)
  ? `Scrivi i ${nomeBase(p)}: quando in negozio ne restano così pochi, va in «Da ordinare» (${inLitri(p) ? 'una tanica' : 'un sacco'}, o quanti l'ultima volta). Vuoto = mai da solo.`
  : `Vuoto = ${settings().scortaMin}, come tutti gli altri prodotti. 0 = mai da solo. Si ordina la quantità dell'ultimo ordine (o 1).`;
/* scheda prodotto: codici e etichetta si aggiornano senza perdere quello che si sta scrivendo */
const codiciHtml = p => (p.codici || []).map(c => `<span class="tag" style="font-size:.9rem;padding:6px 10px">${esc(c)} <button type="button" data-act="p-codice-del" data-c="${esc(c)}" style="border:0;background:none;font-size:1rem;cursor:pointer" aria-label="Togli codice">×</button></span>`).join('') || '<span class="faint">Nessun codice: scansiona ora il prodotto per collegarlo.</span>';
const infoSfuso = u => u === 'l' ? 'Magazzino in litri, prezzo al litro. Al banco si scansiona l\'etichetta e si scrivono i ml.'
  : `Magazzino in kg, prezzo ${UNITA[u].al}. Al banco si scansiona l'etichetta del contenitore e si scrivono i grammi.`;
function boxEtichetta(p) {
  if (!(p.codici || []).length) return `<button class="btn block" type="button" data-act="p-crea-codice" data-id="${esc(p.id)}" id="pCrea">Crea il codice a barre e stampa l'etichetta</button>
    <div class="faint small">Se il sacco ha già il suo codice, non serve: scansionalo adesso e si collega da solo.</div>`;
  if (!p.sfuso) return `<div class="faint small">L'etichetta userà il codice ${esc(codiceEtichetta(p))}.</div>`;
  return `<button class="btn block" type="button" data-act="p-stampa-eti" data-id="${esc(p.id)}">Stampa l'etichetta</button>`;
}
function aggiornaCodici() {
  const p = prodotto(current.arg); if (!p) return;
  const c = $('#pCodici'); if (c) c.innerHTML = codiciHtml(p);
  const e = $('#pEtiBox'); if (e) e.innerHTML = boxEtichetta(p);
}
const lottiScheda = p => { const lotti = lottiAttivi().filter(l => l.prodottoId === p.id).sort((a, b) => (a.scadenza || '9').localeCompare(b.scadenza || '9'));
  return lotti.length ? `<div class="faint small">Per cambiare la scadenza o ${p.sfuso ? 'i ' + nomeBase(p) : 'i pezzi'} tocca <b>Modifica</b>.</div><div class="list">${lotti.map(l => rigaConfezione(l, { arrivo: true })).join('')}</div>` : '<div class="empty">Nessuna confezione registrata.</div>'; };
routes.prodotto = id => {
  const p = prodotto(id);
  if (!p) return { title: 'Prodotto', html: '<div class="empty">Prodotto non trovato.</div>', back: '#catalogo', tab: 'catalogo' };
  const forn = [...S.fornitori.values()].sort((a, b) => a.nome.localeCompare(b.nome, 'it'));
  const calc = prezzoCalcolato(p);
  const html = `<div><h2 style="margin:0" id="pTitolo">${esc(p.nome)}</h2><div class="faint" id="pSotto">${esc(nomeForn(p.fornitoreId))}${p.formato ? ' · ' + esc(p.formato) : ''}</div></div>
    <div class="section-title"><h2>In negozio</h2><span class="count" id="pGiac">${fq(p, giacenza(p.id))}</span></div>
    <div class="stack" id="pLotti">${lottiScheda(p)}</div>
    <div class="btn-grid" style="grid-template-columns:1fr 1fr"><button class="btn" type="button" data-act="sr-carico" data-id="${esc(p.id)}">Arrivo merce</button><button class="btn" type="button" data-act="sr-inventario" data-id="${esc(p.id)}">Inventario</button><button class="btn" type="button" data-act="sr-ordina" data-id="${esc(p.id)}" style="grid-column:1/-1">Aggiungi all'ordine</button></div>
    <div class="section-title"><h2>Dati del prodotto</h2></div>
    <div class="faint small salva-stato">Ogni modifica si salva da sola.</div>
    <div class="stack" data-auto>
    <div class="card">
      <label class="field">Nome<textarea id="pNome" rows="2" style="min-height:0">${esc(p.nome)}</textarea></label>
      <label class="field">Fornitore<select id="pForn"><option value="">— nessuno —</option>${forn.map(f => `<option value="${esc(f.id)}" ${p.fornitoreId === f.id ? 'selected' : ''}>${esc(f.nome)}</option>`).join('')}</select></label>
      <label class="field">Categoria${campoCategoria('pCat', p.categoria)}</label>
      <label class="field">Formato<input type="text" id="pFormato" value="${esc(p.formato)}"></label>
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
    <div class="card"><h3>Riordino</h3>
      <label class="field"><span>Va da solo in «Da ordinare» quando ne restano</span>
        <span class="row" style="gap:10px"><input type="text" inputmode="decimal" id="pScorta" value="${p.scortaMin != null ? fmtNum(p.scortaMin) : ''}" placeholder="${esc(segnapostoScorta(p))}" style="flex:1"><span class="faint" data-scorta-u>${unitaScorta(p)}</span></span></label>
      <div class="faint small" data-scorta-hint>${aiutoScorta(p)}</div></div>
    <div class="card"><h3>Prezzi</h3>
      <div class="btn-grid" style="grid-template-columns:1fr 1fr">
        <label class="field"><span>Acquisto €<span class="u-base">${alBase(p)}</span></span><input type="text" inputmode="decimal" id="pAcq" value="${p.prezzoAcquisto != null ? fmtNum(p.prezzoAcquisto) : ''}"></label>
        <label class="field">IVA<select id="pIva"><option value="">—</option>${[4, 10, 22].map(v => `<option value="${v}" ${p.iva === v ? 'selected' : ''}>${v}%</option>`).join('')}</select></label>
        <label class="field">Ricarico<select id="pRic"><option value="50" ${p.ricarico !== 40 ? 'selected' : ''}>50%</option><option value="40" ${p.ricarico === 40 ? 'selected' : ''}>40% (eccezione)</option></select></label>
        <label class="field"><span>Prezzo a mano €<span class="u-kg">${alKg(p)}</span></span><input type="text" inputmode="decimal" id="pMan" value="${p.prezzoManuale != null ? fmtNum(Math.round(p.prezzoManuale * (isSfuso(p) ? UNITA[unitaDi(p)].f : 1) * 1000) / 1000) : ''}" placeholder="vuoto = calcolato"></label></div>
      <dl class="kv"><dt>Prezzo calcolato</dt><dd id="pCalc">${fmtEuro(perUnita(p, calc))}<span class="u-kg">${alKg(p)}</span></dd></dl>
      <div class="prezzo-vale" id="pVale">${valeHtml(p, calc, p.prezzoManuale)}</div>
      <div class="faint small">Calcolato: acquisto + ricarico + IVA, arrotondato ai 10 centesimi superiori. Se scrivi un prezzo a mano, vale quello.</div></div>
    <div class="card"><label class="field">Note<textarea id="pNote" style="min-height:80px">${esc(p.note)}</textarea></label>
      ${p.origine ? `<div class="faint small">Origine: ${esc(p.origine)}</div>` : ''}</div>
    </div>
    <div class="salva-riga"><span class="salva-stato" aria-live="polite">Ogni modifica si salva da sola.</span></div>
    <button class="btn danger block" type="button" data-act="p-elimina" data-id="${esc(p.id)}">Elimina prodotto</button>`;
  return {
    title: 'Scheda prodotto', html, back: '#catalogo', tab: 'catalogo',
    mount: b => {
      // com'era il prodotto quando si è aperta la scheda (resta uguale anche se la pagina si ridisegna)
      if (!PSTATO || PSTATO.id !== p.id || current.fresh) PSTATO = { id: p.id, eraSfuso: !!p.sfuso, chiesto: false };
      const stato = PSTATO;
      autoSalva(b, () => leggiScheda(p.id, b, stato));
      // la scheda com'è nel modulo, anche prima di salvare
      const forma = () => ({ sfuso: b.querySelector('#pSfuso').checked, unita: b.querySelector('#pUnita').value });
      const upd = () => {
        const tmp = { prezzoAcquisto: parseNum(b.querySelector('#pAcq').value), iva: parseNum(b.querySelector('#pIva').value), ricarico: +b.querySelector('#pRic').value };
        const cc = prezzoCalcolato(tmp), mt = b.querySelector('#pMan').value.trim(), mv = mt ? parseNum(mt) : null;
        b.querySelector('#pCalc').innerHTML = fmtEuro(perUnita(forma(), cc)) + `<span class="u-kg">${alKg(forma())}</span>`;
        b.querySelector('#pVale').innerHTML = valeHtml(forma(), cc, mv != null ? mv / (isSfuso(forma()) ? UNITA[unitaDi(forma())].f : 1) : null);
      };
      const unitaTesti = () => {
        const fp = forma();
        $$('.u-kg', b).forEach(x => { x.textContent = alKg(fp); });
        $$('.u-base', b).forEach(x => { x.textContent = alBase(fp); });
        aggiornaTestiSacco(b, fp.unita); b.querySelector('#pSfInfo').textContent = infoSfuso(fp.unita);
        b.querySelector('[data-scorta-u]').textContent = unitaScorta(fp);
        b.querySelector('[data-scorta-hint]').textContent = aiutoScorta(fp);
        b.querySelector('#pScorta').placeholder = segnapostoScorta(fp);
        upd();
      };
      ['#pAcq', '#pIva', '#pRic', '#pMan'].forEach(s => b.querySelector(s).addEventListener('input', upd));
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
let FSEL = null;   // fornitori scelti per eliminarli (null = scelta spenta)
routes.fornitori = () => {
  const counts = new Map(); for (const p of S.prodotti.values()) counts.set(p.fornitoreId, (counts.get(p.fornitoreId) || 0) + 1);
  const all = [...S.fornitori.values()];
  const dn = all.filter(f => f.daNominare).sort((a, b) => a.nome.localeCompare(b.nome, 'it'));
  const ok = all.filter(f => !f.daNominare).sort((a, b) => a.nome.localeCompare(b.nome, 'it'));
  if (current.fresh) FSEL = null;
  if (FSEL) for (const id of [...FSEL]) if (!S.fornitori.has(id)) FSEL.delete(id);
  const corpo = f => `<div class="main"><div class="name">${esc(f.nome)}</div><div class="sub">${counts.get(f.id) || 0} prodotti · ${METODI[f.metodo || '']}</div></div>${f.daNominare ? '<span class="tag warn">da nominare</span>' : ''}`;
  const row = f => FSEL ? `<label class="item sel-riga"><input type="checkbox" data-sel="${esc(f.id)}" ${FSEL.has(f.id) ? 'checked' : ''}>${corpo(f)}</label>`
    : `<a class="item" href="#fornitore/${encodeURIComponent(f.id)}">${corpo(f)}<span class="chev">›</span></a>`;
  const testa = FSEL
    ? `<div class="row wrap"><b class="spacer" id="selN">${testoSel(FSEL.size, 'fornitore', 'fornitori')}</b><button class="btn small" type="button" data-act="for-sel-tutti">Tutti</button><button class="btn small" type="button" data-act="for-sel-nessuno">Nessuno</button></div>`
    : `<div class="row"><span class="faint spacer">${all.length} fornitori</span><button class="btn small" type="button" data-act="for-sel">Seleziona</button></div>`;
  const html = `${segCat('f')}
    ${all.length ? testa : ''}
    ${dn.length ? `<div class="section-title"><h2>Da nominare</h2><span class="count">${dn.length}</span></div><div class="faint small">Nei listini questi fogli non avevano il nome del fornitore. Apri e scrivi il nome giusto.</div><div class="list">${dn.map(row).join('')}</div>` : ''}
    <div class="section-title"><h2>Fornitori</h2><span class="count">${ok.length}</span></div>
    <div class="list">${ok.map(row).join('') || '<div class="empty">Nessun fornitore.</div>'}</div>
    ${FSEL ? barraSel(FSEL.size, 'fornitore', 'fornitori', 'for-elimina', 'for-sel-fine') : '<button class="btn block" type="button" data-act="nuovo-fornitore">+ Nuovo fornitore</button>'}`;
  return {
    title: 'Fornitori', html, tab: 'catalogo',
    mount: b => b.addEventListener('change', e => {
      const c = e.target.closest('[data-sel]'); if (!c || !FSEL) return;
      if (c.checked) FSEL.add(c.dataset.sel); else FSEL.delete(c.dataset.sel);
      aggiornaSel(b, FSEL, 'fornitore', 'fornitori');
    })
  };
};
routes.fornitore = id => {
  const f = fornitore(id);
  if (!f) return { title: 'Fornitore', html: '<div class="empty">Fornitore non trovato.</div>', back: '#fornitori', tab: 'catalogo' };
  const n = [...S.prodotti.values()].filter(p => p.fornitoreId === f.id).length;
  const html = `<div class="card" data-auto>
      <label class="field">Nome<input type="text" id="fNome" value="${esc(f.nome)}"></label>
      <label class="field">Partita IVA <span class="hint">serve a riconoscere le sue fatture</span><input type="text" id="fPiva" value="${esc(f.piva || '')}" autocomplete="off" placeholder="es. IT01234567890"></label>
      <label class="field">Come si ordina<select id="fMet">${Object.entries(METODI).map(([k, v]) => `<option value="${k}" ${(f.metodo || '') === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label class="field">Telefono / WhatsApp<input type="tel" id="fTel" value="${esc(f.telefono)}" placeholder="es. 333 1234567"></label>
      <label class="field">Email<input type="email" id="fMail" value="${esc(f.email)}"></label>
      <label class="field">Sito per gli ordini<input type="url" id="fSito" value="${esc(f.sito)}" placeholder="es. www.fornitore.it"></label>
      <label class="field">Note <span class="hint">giorni di consegna, ordine minimo, trasporto</span><textarea id="fNote" style="min-height:80px">${esc(f.note)}</textarea></label>
      <div class="faint small salva-stato" aria-live="polite">Ogni modifica si salva da sola.</div></div>
    <a class="btn block" href="#catalogo/${encodeURIComponent(f.id)}">Vedi i ${n} prodotti</a>
    <button class="btn danger block" type="button" data-act="f-elimina" data-id="${esc(f.id)}">Elimina fornitore</button>`;
  return { title: 'Fornitore', html, back: '#fornitori', tab: 'catalogo', mount: b => autoSalva(b, () => leggiFornitore(f.id, b)) };
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
   FATTURE DEI FORNITORI (FatturaPA)
   - si caricano i file scaricati da «Fatture e Corrispettivi»: .xml, .p7m firmati o un .zip con tanti file
   - la fattura NON carica la merce (si carica scansionando, per le scadenze): serve a controllare
     fatturato e arrivato, ad aggiornare i prezzi d'acquisto e a tenere le scadenze dei pagamenti
   - le righe collegate a un prodotto si ricordano per fornitore (codice articolo o descrizione)
   ========================================================= */
/* --- .zip: indice centrale, file salvati o compressi (deflate) --- */
async function apriZip(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let e = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new Error('il file .zip non è leggibile');
  const n = dv.getUint16(e + 10, true); let off = dv.getUint32(e + 16, true);
  const out = [];
  for (let k = 0; k < n; k++) {
    if (dv.getUint32(off, true) !== 0x02014b50) break;
    const metodo = dv.getUint16(off + 10, true), csize = dv.getUint32(off + 20, true);
    const nl = dv.getUint16(off + 28, true), el = dv.getUint16(off + 30, true), cl = dv.getUint16(off + 32, true), loc = dv.getUint32(off + 42, true);
    const nome = new TextDecoder().decode(u8.subarray(off + 46, off + 46 + nl));
    off += 46 + nl + el + cl;
    if (nome.endsWith('/')) continue;
    const ini = loc + 30 + dv.getUint16(loc + 26, true) + dv.getUint16(loc + 28, true);
    const dati = u8.subarray(ini, ini + csize);
    let bytes = null;
    if (metodo === 0) bytes = dati;
    else if (metodo === 8) bytes = new Uint8Array(await new Response(new Blob([dati]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
    if (bytes) out.push({ nome: nome.split('/').pop(), bytes });
  }
  return out;
}
/* --- .p7m: la fattura sta dentro la busta firmata (CMS SignedData), a volte scritta in base64 --- */
function contenutoP7m(u8) {
  if (u8[0] !== 0x30) {
    try { const t = new TextDecoder('latin1').decode(u8).replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''); u8 = Uint8Array.from(atob(t), c => c.charCodeAt(0)); } catch (e) { return null; }
  }
  const leggi = p => {
    const tag = u8[p]; let q = p + 1, len = u8[q++];
    if (len & 0x80) { const nb = len & 0x7f; if (!nb) len = -1; else { len = 0; for (let i = 0; i < nb; i++) len = len * 256 + u8[q++]; } }
    return { tag, cons: !!(tag & 0x20), len, start: q };
  };
  const fine = n => { if (n.len >= 0) return n.start + n.len; let p = n.start; while (!(u8[p] === 0 && u8[p + 1] === 0)) p = fine(leggi(p)); return p + 2; };
  const figli = n => {
    const out = []; let p = n.start; const e = n.len >= 0 ? n.start + n.len : u8.length;
    while (p < e) { if (n.len < 0 && u8[p] === 0 && u8[p + 1] === 0) break; const c = leggi(p); out.push(c); p = fine(c); }
    return out;
  };
  const ottetti = n => n.cons ? figli(n).flatMap(ottetti) : [u8.subarray(n.start, n.start + n.len)];
  try {
    const ci = figli(leggi(0));                         // ContentInfo: tipo, [0]
    const sd = figli(figli(ci[1])[0]);                  // SignedData: versione, algoritmi, contenuto, …
    const eci = figli(sd[2]);                           // EncapsulatedContentInfo: tipo, [0]
    const pezzi = ottetti(figli(eci[1])[0]);
    const r = new Uint8Array(pezzi.reduce((t, x) => t + x.length, 0)); let o = 0;
    for (const x of pezzi) { r.set(x, o); o += x.length; }
    return r;
  } catch (e) {
    // ripiego: il testo XML in chiaro dentro la busta
    const t = new TextDecoder('latin1').decode(u8), a = t.indexOf('<?xml'), m = t.match(/<\/[\w.-]*:?FatturaElettronica>/);
    return a >= 0 && m ? u8.subarray(a, m.index + m[0].length) : null;
  }
}
function testoXml(u8) {
  const m = new TextDecoder('latin1').decode(u8.subarray(0, 200)).match(/encoding=["']([^"']+)/i);
  let enc = m ? m[1].toLowerCase() : 'utf-8';
  if (/^(iso-?8859-?(1|15)|latin-?1|windows-1252|cp1252)$/.test(enc)) enc = 'windows-1252';
  try { return new TextDecoder(enc).decode(u8); } catch (e) { return new TextDecoder().decode(u8); }
}
/* --- lettura della FatturaPA: un file può contenere più fatture (lotto) --- */
const xFigli = (el, n) => el ? [...el.children].filter(c => c.localName === n) : [];
const xFiglio = (el, n) => xFigli(el, n)[0] || null;
const xVia = (el, path) => path.split('/').reduce((e, n) => xFiglio(e, n), el);
const xTesto = (el, path) => { const e = path ? xVia(el, path) : el; return e ? e.textContent.trim() : ''; };
const xNum = t => { if (t === '' || t == null) return null; const v = parseFloat(String(t).replace(',', '.')); return isNaN(v) ? null : v; };
const r2 = x => Math.round((+x || 0) * 100) / 100;
function leggiFatturaPA(xml, file) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('XML non valido');
  const root = doc.documentElement;
  if (root.localName !== 'FatturaElettronica') return [];      // ricevute, notifiche, metadati: si saltano
  const h = xFiglio(root, 'FatturaElettronicaHeader');
  const ced = xVia(h, 'CedentePrestatore/DatiAnagrafici'), an = xFiglio(ced, 'Anagrafica');
  const codice = xTesto(ced, 'IdFiscaleIVA/IdCodice');
  const forn = {
    nome: xTesto(an, 'Denominazione') || [xTesto(an, 'Nome'), xTesto(an, 'Cognome')].filter(Boolean).join(' ') || 'Fornitore senza nome',
    piva: codice ? (xTesto(ced, 'IdFiscaleIVA/IdPaese') || 'IT') + codice : '',
    cf: xTesto(ced, 'CodiceFiscale')
  };
  return xFigli(root, 'FatturaElettronicaBody').map(b => {
    const dg = xFiglio(b, 'DatiGenerali'), g = xFiglio(dg, 'DatiGeneraliDocumento');
    const tipo = xTesto(g, 'TipoDocumento'), numero = xTesto(g, 'Numero'), data = xTesto(g, 'Data');
    const bs = xFiglio(b, 'DatiBeniServizi');
    const righe = xFigli(bs, 'DettaglioLinee').map(l => {
      const qta = xNum(xTesto(l, 'Quantita')), totale = xNum(xTesto(l, 'PrezzoTotale')), pu = xNum(xTesto(l, 'PrezzoUnitario'));
      return {
        n: +xTesto(l, 'NumeroLinea') || 0,
        codici: xFigli(l, 'CodiceArticolo').map(c => ({ tipo: xTesto(c, 'CodiceTipo'), valore: xTesto(c, 'CodiceValore') })).filter(c => c.valore),
        descrizione: xTesto(l, 'Descrizione'), qta, um: xTesto(l, 'UnitaMisura'),
        prezzo: qta && totale != null ? Math.round(totale / qta * 10000) / 10000 : pu,     // netto: comprende gli sconti di riga
        totale, iva: xNum(xTesto(l, 'AliquotaIVA')), cessione: xTesto(l, 'TipoCessionePrestazione')
      };
    });
    const riepilogo = xFigli(bs, 'DatiRiepilogo').map(r => ({ aliquota: xNum(xTesto(r, 'AliquotaIVA')), natura: xTesto(r, 'Natura'), imponibile: xNum(xTesto(r, 'ImponibileImporto')) || 0, imposta: xNum(xTesto(r, 'Imposta')) || 0 }));
    const pagamenti = xFigli(b, 'DatiPagamento').flatMap(p => xFigli(p, 'DettaglioPagamento').map(d => ({
      modalita: xTesto(d, 'ModalitaPagamento'), scadenza: xTesto(d, 'DataScadenzaPagamento') || null, importo: xNum(xTesto(d, 'ImportoPagamento')), iban: xTesto(d, 'IBAN'), pagata: null
    })));
    let totale = xNum(xTesto(g, 'ImportoTotaleDocumento'));
    if (totale == null) totale = r2(riepilogo.reduce((t, r) => t + r.imponibile + r.imposta, 0));
    const chi = (forn.piva || forn.cf || norm(forn.nome)).replace(/[^A-Za-z0-9]/g, '');
    return {
      id: `fa-${chi}-${data}-${numero.replace(/[^A-Za-z0-9]/g, '_')}-${tipo}`,
      tipo, numero, data, totale, divisa: xTesto(g, 'Divisa') || 'EUR',
      fornitore: forn, fornitoreId: null,
      ddt: xFigli(dg, 'DatiDDT').map(d => ({ numero: xTesto(d, 'NumeroDDT'), data: xTesto(d, 'DataDDT') })),
      righe, riepilogo, pagamenti, file, importata: Date.now(), stato: 'nuova'
    };
  });
}
/* --- da un file scelto alle fatture (anche dentro uno zip, anche firmate) --- */
async function fattureDaFile(nome, u8, prof = 0) {
  if (u8[0] === 0x50 && u8[1] === 0x4b) {                // PK: zip
    if (prof > 1) return { fatture: [], saltati: [nome] };
    const out = { fatture: [], saltati: [] };
    for (const x of await apriZip(u8)) { const r = await fattureDaFile(x.nome, x.bytes, prof + 1); out.fatture.push(...r.fatture); out.saltati.push(...r.saltati); }
    return out;
  }
  let xmlBytes = u8;
  if (/\.p7m$/i.test(nome) || u8[0] === 0x30) xmlBytes = contenutoP7m(u8);
  if (!xmlBytes) return { fatture: [], saltati: [nome] };
  try {
    const f = leggiFatturaPA(testoXml(xmlBytes), nome.replace(/\.p7m$/i, ''));
    return { fatture: f, saltati: f.length ? [] : [nome] };
  } catch (e) { return { fatture: [], saltati: [nome] }; }
}
const fornPerPiva = piva => piva ? [...S.fornitori.values()].find(f => f.piva && f.piva.replace(/\s/g, '').toUpperCase() === piva.toUpperCase()) : null;
async function caricaFatture(files) {
  let nuove = 0, doppie = 0; const saltati = [], perFornitore = new Set();
  for (const file of files) {
    let r;
    try { r = await fattureDaFile(file.name, new Uint8Array(await file.arrayBuffer())); }
    catch (e) { saltati.push(file.name); continue; }
    saltati.push(...r.saltati);
    for (const fa of r.fatture) {
      if (S.fatture.has(fa.id)) { doppie++; continue; }
      const f = fornPerPiva(fa.fornitore.piva);
      if (f) fa.fornitoreId = f.id;
      await save('fatture', fa); nuove++; perFornitore.add(fa.fornitore.nome);
      if (fa.fornitoreId) await imparaDaEan([fa]);
    }
  }
  return { nuove, doppie, saltati };
}
/* --- righe: collegamento ai prodotti, ricordato sul fornitore --- */
const chiaviRiga = r => [...r.codici.map(c => 'c:' + norm(c.valore)), 'd:' + norm(r.descrizione)];
const nonProdotto = r => !!r.cessione || (r.qta == null && !r.codici.length) || (r.totale != null && r.totale < 0);
function prodottoRiga(fa, r) {
  const f = fornitore(fa.fornitoreId), mappa = (f && f.articoli) || {};
  for (const k of chiaviRiga(r)) if (k in mappa) return mappa[k] === '-' ? { no: true } : (S.prodotti.has(mappa[k]) ? { p: prodotto(mappa[k]), certo: true } : null);
  if (nonProdotto(r)) return { no: true, auto: true };
  for (const c of r.codici) { const p = /^\d{8}$|^\d{12,14}$/.test(c.valore) ? byCode(c.valore) : null; if (p) return { p, certo: true, ean: true }; }
  // un suggerimento per nome tra i prodotti di quel fornitore (va confermato)
  const parole = norm(r.descrizione).split(' ').filter(w => w.length > 2);
  if (!parole.length) return null;
  let best = null, punti = 0;
  for (const p of S.prodotti.values()) {
    if (fa.fornitoreId && p.fornitoreId !== fa.fornitoreId) continue;
    const n = norm(p.nome), x = parole.filter(w => n.includes(w)).length / parole.length;
    if (x > punti) { punti = x; best = p; }
  }
  return best && punti >= 0.6 ? { p: best, certo: false } : null;
}
async function ricordaRiga(fa, r, pid) {
  const f = fornitore(fa.fornitoreId); if (!f) return;
  const articoli = { ...(f.articoli || {}) };
  for (const k of chiaviRiga(r)) articoli[k] = pid;
  await save('fornitori', { ...f, articoli });
}
/* le righe riconosciute dal codice a barre insegnano anche il codice articolo del fornitore,
   così le fatture dopo (a volte senza codice a barre) si riconoscono lo stesso */
async function imparaDaEan(fatture) {
  const perForn = new Map();
  for (const fa of fatture) {
    const f = fornitore(fa.fornitoreId); if (!f) continue;
    const art = perForn.get(f.id) || { ...(f.articoli || {}) };
    for (const r of fa.righe) {
      if (chiaviRiga(r).some(k => k in art)) continue;
      const c = r.codici.find(c => /^\d{8}$|^\d{12,14}$/.test(c.valore) && byCode(c.valore));
      if (c) for (const k of chiaviRiga(r)) art[k] = byCode(c.valore).id;
    }
    perForn.set(f.id, art);
  }
  for (const [fid, articoli] of perForn) if (JSON.stringify(articoli) !== JSON.stringify(fornitore(fid).articoli || {})) await save('fornitori', { ...fornitore(fid), articoli });
}
/* quantità e prezzo della riga nell'unità del magazzino (pezzi, kg o litri) */
function qtaRiga(p, r) {
  if (r.qta == null) return null;
  if (!isSfuso(p)) return r.qta;
  const um = (r.um || '').toLowerCase().replace(/[^a-z]/g, '');
  if (/^(kg|kgs|kgm|kilo|kili|chilo|chili|chilogrammi)$/.test(um)) return r.qta;
  if (/^(g|gr|grammi)$/.test(um)) return r.qta / 1000;
  if (/^(l|lt|lit|litro|litri)$/.test(um)) return r.qta;
  if (um === 'ml') return r.qta / 1000;
  return p.pesoSacco ? r.qta * p.pesoSacco : r.qta;
}
function prezzoRigaFattura(p, r) {
  const q = qtaRiga(p, r);
  if (q && r.totale != null) return Math.round(r.totale / q * 10000) / 10000;
  return r.prezzo;
}
/* arrivato nell'app intorno alla data della fattura (o dei documenti di trasporto) */
function finestraFattura(fa) {
  const date = (fa.ddt || []).map(d => d.data).filter(Boolean).sort();
  const sposta = (d, g) => { const x = new Date(d + 'T12:00:00'); x.setDate(x.getDate() + g); return x.toISOString().slice(0, 10); };
  return date.length ? [sposta(date[0], -3), sposta(date[date.length - 1], 5)] : [sposta(fa.data, -12), sposta(fa.data, 5)];
}
function arrivatoNellApp(pid, fa) {
  const [da, a] = finestraFattura(fa);
  return r3([...S.lotti.values()].filter(l => l.prodottoId === pid && (l.origine || 'arrivo') === 'arrivo' && l.stato !== 'eliminato' && l.arrivo >= da && l.arrivo <= a)
    .reduce((t, l) => t + (+(l.qtaIniziale ?? l.quantita) || 0), 0));
}
/* tutto quello che serve per mostrare e controllare una riga */
function esameRiga(fa, r) {
  const m = prodottoRiga(fa, r);
  const e = { r, m, p: m && m.p ? m.p : null };
  if (!e.p || !m.certo) return e;
  const p = e.p, nota = fa.tipo === 'TD04';
  e.qta = qtaRiga(p, r);
  if (!nota && e.qta != null) { e.arrivato = arrivatoNellApp(p.id, fa); e.diff = Math.abs(e.arrivato - e.qta) > 0.001; }
  const nuovo = prezzoRigaFattura(p, r);
  if (!nota && nuovo != null && nuovo > 0) {
    e.prezzo = nuovo; e.prima = p.prezzoAcquisto;
    e.cambia = p.prezzoAcquisto == null || Math.abs(nuovo - p.prezzoAcquisto) >= 0.005;
    e.strano = p.prezzoAcquisto > 0 && (nuovo / p.prezzoAcquisto > 3 || nuovo / p.prezzoAcquisto < 1 / 3);   // forse è il prezzo di un cartone
  }
  return e;
}
function statoFattura(fa) {
  const es = fa.righe.map(r => esameRiga(fa, r));
  return {
    es,
    daCollegare: es.filter(e => !e.m || (e.m.p && !e.m.certo)).length,
    prezzi: es.filter(e => e.cambia && !e.strano).length,
    strani: es.filter(e => e.cambia && e.strano).length,
    differenze: es.filter(e => e.diff).length
  };
}
const NOMI_TIPO = { TD01: 'Fattura', TD02: 'Acconto', TD04: 'Nota di credito', TD05: 'Nota di debito', TD06: 'Parcella', TD24: 'Fattura differita', TD25: 'Fattura differita' };
const NOMI_PAGAMENTO = { MP01: 'contanti', MP02: 'assegno', MP05: 'bonifico', MP08: 'carta', MP12: 'RiBa', MP19: 'addebito SEPA', MP20: 'addebito SEPA', MP21: 'addebito SEPA', MP23: 'PagoPA' };
const segnoFattura = fa => fa.tipo === 'TD04' ? -1 : 1;
/* pagamenti: ogni scadenza di ogni fattura, più le altre spese (affitto, bollette…) */
const voceFattura = (fa, p, i) => ({ k: 'f', fa, i, p, data: p.scadenza || fa.data, importo: r2((p.importo ?? fa.totale) * segnoFattura(fa)), nome: nomeFornFattura(fa), pagata: p.pagata || null });
const voceSpesa = sp => ({ k: 's', s: sp, data: sp.scadenza, importo: r2(sp.importo), nome: sp.descrizione, pagata: sp.pagata || null });
function tuttiPagamenti() {
  const out = [];
  if (conFatture()) for (const fa of S.fatture.values()) (fa.pagamenti || []).forEach((p, i) => out.push(voceFattura(fa, p, i)));
  if (conPagamenti()) for (const sp of S.spese.values()) out.push(voceSpesa(sp));
  return out.sort((a, b) => a.data.localeCompare(b.data) || a.nome.localeCompare(b.nome, 'it'));
}
const nomeFornFattura = fa => fa.fornitoreId && fornitore(fa.fornitoreId) ? fornitore(fa.fornitoreId).nome : fa.fornitore.nome;
function rigaFattura(fa) {
  const st = statoFattura(fa), tag = [];
  if (st.daCollegare) tag.push(`<span class="tag warn">${st.daCollegare} da collegare</span>`);
  const np = st.prezzi + st.strani;
  if (np) tag.push(`<span class="tag">${np === 1 ? '1 prezzo cambiato' : np + ' prezzi cambiati'}</span>`);
  if (st.differenze) tag.push(`<span class="tag warn">${st.differenze === 1 ? '1 differenza' : st.differenze + ' differenze'}</span>`);
  if (!fa.fornitoreId) tag.unshift('<span class="tag warn">fornitore da collegare</span>');
  return `<a class="item" href="#fattura/${encodeURIComponent(fa.id)}"><div class="main"><div class="name">${esc(nomeFornFattura(fa))}</div>
    <div class="sub">${NOMI_TIPO[fa.tipo] && fa.tipo !== 'TD01' ? esc(NOMI_TIPO[fa.tipo]) + ' ' : ''}n. ${esc(fa.numero)} del ${fmtDate(fa.data)}${tag.length ? '<br>' + tag.join(' ') : ''}</div></div>
    <span class="prezzo">${fmtEuro(fa.totale * segnoFattura(fa))}</span><span class="chev">›</span></a>`;
}
let FAT = { tutte: false };
/* sezione Fatture spenta per ora (ottobre 2026): restano codice e dati, si riaccende con S.meta.sezioneFatture */
const conFatture = () => !!S.meta.sezioneFatture;
/* anche la sezione Pagamenti è spenta per ora: le spese restano salvate, si riaccende con S.meta.sezionePagamenti */
const conPagamenti = () => !!S.meta.sezionePagamenti;
const nomeSpese = () => conFatture() ? 'Altre spese' : 'Spese';
const segFatture = on => `<div class="segmented"><a href="#fatture" class="${on === 'f' ? 'on' : ''}">Fatture</a><a href="#pagamenti" class="${on === 'p' ? 'on' : ''}">Pagamenti</a></div>`;
routes.fatture = arg => {
  if (arg === 'pagamenti' || !conFatture()) return routes.pagamenti();
  const tutte = [...S.fatture.values()].sort((a, b) => b.data.localeCompare(a.data) || b.importata - a.importata);
  const nuove = tutte.filter(f => f.stato !== 'controllata'), vecchie = tutte.filter(f => f.stato === 'controllata');
  let html = segFatture('f') + `<button class="btn primary block" type="button" data-act="fatture-carica">Carica fatture</button>
    <div class="faint small">Scaricale da <b>Fatture e Corrispettivi</b> (Agenzia delle Entrate, con SPID): fatture ricevute. Puoi scegliere più file insieme: .xml, .p7m o un .zip.</div>`;
  html += `<div class="section-title"><h2>Da controllare</h2><span class="count">${nuove.length}</span></div>`;
  html += nuove.length ? `<div class="list">${nuove.map(rigaFattura).join('')}</div>` : '<div class="empty">Nessuna fattura da controllare.</div>';
  if (vecchie.length) {
    const mostra = FAT.tutte ? vecchie : vecchie.slice(0, 20);
    html += `<div class="section-title"><h2>Controllate</h2><span class="count">${vecchie.length}</span></div><div class="list">${mostra.map(rigaFattura).join('')}</div>`;
    if (mostra.length < vecchie.length) html += `<button class="btn block" type="button" data-act="fatture-tutte">Mostra tutte (${vecchie.length})</button>`;
  }
  html += `<a class="btn ghost block" href="#riepilogo">Riepilogo del mese per la contabilità</a>`;
  return { title: 'Fatture e pagamenti', html, back: '#home', tab: 'home' };
};
/* una riga di pagamento: scadenza di una fattura o spesa */
function rigaPagamento(x, cls) {
  const pag = x.pagata, rossa = cls === 'red' && !pag;
  const dett = x.k === 'f'
    ? [NOMI_PAGAMENTO[x.p.modalita] || x.p.modalita || '', 'fattura ' + x.fa.numero]
    : [x.s.modalita || '', nomeRipeti(x.s.ripeti), x.s.note || ''];
  const testa = `<div class="name">${esc(x.nome)}</div><div class="sub ${rossa ? 'arancio' : ''}">${[pag ? 'pagata il ' + fmtDate(pag) : 'scade ' + fmtDate(x.data), ...dett].filter(Boolean).map(esc).join(' · ')}</div>`;
  const main = x.k === 'f'
    ? `<a class="main" href="#fattura/${encodeURIComponent(x.fa.id)}" style="color:inherit;text-decoration:none">${testa}</a>`
    : `<button class="main pag-apri" type="button" data-act="spesa-mod" data-id="${esc(x.s.id)}">${testa}</button>`;
  const dati = x.k === 'f' ? `data-f="${esc(x.fa.id)}" data-i="${x.i}"` : `data-s="${esc(x.s.id)}"`;
  return `<div class="item pag" style="flex-wrap:wrap">${main}<span class="prezzo">${fmtEuro(x.importo)}</span>
    <button class="btn small ${pag ? 'ghost' : ''}" type="button" data-act="pag-segna" ${dati}>${pag ? 'Non pagata' : 'Pagata'}</button></div>`;
}
routes.fattura = id => {
  if (!conFatture()) return routes.pagamenti();
  const fa = S.fatture.get(id);
  if (!fa) return { title: 'Fattura', html: '<div class="empty">Fattura non trovata.</div>', back: '#fatture', tab: 'home' };
  const st = statoFattura(fa), nota = fa.tipo === 'TD04';
  const forn = [...S.fornitori.values()].sort((a, b) => a.nome.localeCompare(b.nome, 'it'));
  // proposta: il fornitore del catalogo che ha una parola lunga del nome in comune con quello della fattura
  const nf = ' ' + norm(fa.fornitore.nome) + ' ';
  const simile = !fa.fornitoreId ? (forn.find(f => nf.includes(' ' + norm(f.nome) + ' ')) ||
    forn.find(f => norm(f.nome).split(' ').some(w => w.length > 3 && !/^(srl|srls|spa|snc|sas|societa|soc|coop|cooperativa)$/.test(w) && nf.includes(' ' + w + ' ')))) : null;
  let html = `<div class="card"><div class="row"><div class="spacer"><h2 style="margin:0">${esc(nomeFornFattura(fa))}</h2>
      <div class="faint">${esc(NOMI_TIPO[fa.tipo] || fa.tipo)} n. ${esc(fa.numero)} del ${fmtDate(fa.data)}${fa.fornitore.piva ? ' · P.IVA ' + esc(fa.fornitore.piva) : ''}</div>
      ${fa.ddt && fa.ddt.length ? `<div class="faint small">Documenti di trasporto: ${fa.ddt.map(d => esc(d.numero) + (d.data ? ' del ' + fmtDate(d.data) : '')).join(', ')}</div>` : ''}</div>
      <b style="font-size:1.25rem">${fmtEuro(fa.totale * segnoFattura(fa))}</b></div>
      <div class="faint small">${(fa.riepilogo || []).map(r => `IVA ${r.aliquota != null ? fmtNum(r.aliquota) + '%' : esc(r.natura)}: imponibile ${fmtEuro(r.imponibile)}, imposta ${fmtEuro(r.imposta)}`).join(' · ')}</div></div>`;
  if (!fa.fornitoreId) html += `<div class="card"><h3>Di quale fornitore è?</h3>
      <p class="muted small">«${esc(fa.fornitore.nome)}» non è ancora collegato a un fornitore del catalogo. Scegli quello giusto: la prossima volta lo riconosco dalla partita IVA.</p>
      <select id="faForn"><option value="">— scegli —</option>${forn.map(f => `<option value="${esc(f.id)}" ${simile && simile.id === f.id ? 'selected' : ''}>${esc(f.nome)}</option>`).join('')}</select>
      <div class="btn-grid" style="grid-template-columns:1fr 1fr"><button class="btn primary" type="button" data-act="fa-forn" data-id="${esc(fa.id)}">Collega</button><button class="btn" type="button" data-act="fa-forn-nuovo" data-id="${esc(fa.id)}">Nuovo fornitore</button></div></div>`;
  if (nota) html += `<div class="notice"><span>È una <b>nota di credito</b>: un rimborso o uno sconto del fornitore. Non cambia i prezzi.</span></div>`;
  if (st.prezzi > 1) html += `<button class="btn block" type="button" data-act="fa-prezzi" data-id="${esc(fa.id)}">Aggiorna tutti i prezzi cambiati (${st.prezzi})</button>`;
  html += `<div class="section-title"><h2>Righe</h2><span class="count">${fa.righe.length}</span></div><div class="list">${st.es.map((e, i) => rigaFatturaRiga(fa, e, i)).join('')}</div>`;
  if ((fa.pagamenti || []).length) html += `<div class="section-title"><h2>Pagamento</h2></div><div class="list">${fa.pagamenti.map((p, i) => rigaPagamento(voceFattura(fa, p, i), p.scadenza && p.scadenza < todayISO() ? 'red' : '')).join('')}</div>`;
  else if (!nota) html += `<div class="section-title"><h2>Pagamento</h2></div><div class="card"><p class="muted small" style="margin:0">La fattura non dice quando pagarla.</p>
      <div class="btn-grid" style="grid-template-columns:1fr 1fr"><button class="btn" type="button" data-act="fa-pag-scad" data-id="${esc(fa.id)}">Scrivi la scadenza</button><button class="btn" type="button" data-act="fa-pag-fatto" data-id="${esc(fa.id)}">Già pagata</button></div></div>`;
  html += fa.stato === 'controllata'
    ? `<div class="faint small" style="text-align:center">Controllata${fa.controllata ? ' il ' + fmtDate(fa.controllata) : ''}.</div><button class="btn ghost block" type="button" data-act="fa-stato" data-id="${esc(fa.id)}">Rimetti da controllare</button>`
    : `<button class="btn primary block" type="button" data-act="fa-stato" data-id="${esc(fa.id)}">Fatto: segna come controllata</button>`;
  html += `<button class="btn danger block" type="button" data-act="fa-elimina" data-id="${esc(fa.id)}">Elimina questa fattura</button>`;
  return { title: NOMI_TIPO[fa.tipo] || 'Fattura', html, back: '#fatture', tab: 'home' };
};
function rigaFatturaRiga(fa, e, i) {
  const r = e.r, m = e.m, nota = fa.tipo === 'TD04';
  const qt = r.qta != null ? `${fmtNum(r.qta)}${r.um ? ' ' + esc(r.um.toLowerCase()) : ''} × ${fmtEuro(r.prezzo)}` : '';
  const testa = `<div class="name">${esc(r.descrizione || 'Riga ' + r.n)}</div><div class="sub">${[qt, r.totale != null ? 'totale ' + fmtEuro(r.totale) : '', r.iva != null ? 'IVA ' + fmtNum(r.iva) + '%' : ''].filter(Boolean).join(' · ')}${r.codici.length ? ' · cod. ' + esc(r.codici[0].valore) : ''}</div>`;
  const dati = `data-f="${esc(fa.id)}" data-i="${i}"`;
  let corpo;
  if (m && m.no) corpo = `<div class="fr-riga faint">Non è un prodotto del magazzino${m.auto ? '' : ` · <button class="link" type="button" data-act="fr-collega" ${dati}>collega</button>`}</div>`;
  else if (!m) corpo = `<div class="fr-riga"><button class="btn small primary" type="button" data-act="fr-collega" ${dati}>Collega a un prodotto</button><button class="btn small ghost" type="button" data-act="fr-no" ${dati}>Non è un prodotto</button></div>`;
  else if (!m.certo) corpo = `<div class="fr-riga"><span>È <b>${esc(m.p.nome)}</b>?</span><button class="btn small primary" type="button" data-act="fr-si" ${dati} data-p="${esc(m.p.id)}">Sì</button><button class="btn small" type="button" data-act="fr-collega" ${dati}>No, scegli</button></div>`;
  else {
    const p = e.p, righe = [`<div class="fr-riga"><span>→ <a href="#prodotto/${encodeURIComponent(p.id)}"><b>${esc(p.nome)}</b></a></span><button class="link" type="button" data-act="fr-collega" ${dati}>cambia</button></div>`];
    if (e.arrivato != null && !nota) righe.push(`<div class="fr-riga ${e.diff ? 'arancio' : 'verde'}">${e.diff ? (e.arrivato ? `Arrivati nell'app: ${fq(p, e.arrivato)} su ${fq(p, e.qta)} fatturati` : `Arrivo non registrato nell'app (fatturati ${fq(p, e.qta)})`) : `Arrivati ${fq(p, e.qta)} ✓`}</div>`);
    if (e.cambia) {
      const iva = p.iva ?? r.iva, dopo = prezzoCalcolato({ ...p, prezzoAcquisto: e.prezzo, iva });
      const perc = e.prima ? ` (${e.prezzo > e.prima ? '+' : ''}${fmtNum(Math.round((e.prezzo / e.prima - 1) * 1000) / 10)}%)` : '';
      // il prezzo scritto a mano comanda: resta quello, ma si avvisa se ora è sotto il costo (acquisto + IVA)
      const costo = iva != null ? e.prezzo * (1 + iva / 100) : e.prezzo;
      const vendita = p.prezzoManuale != null
        ? (p.prezzoManuale < costo - 0.0001
          ? `<span class="arancio">vendita${alKg(p)} scritta a mano ${fmtEuro(perUnita(p, p.prezzoManuale))}: <b>sotto il costo</b> (${fmtEuro(perUnita(p, costo))} con IVA), cambiala nella scheda</span>`
          : `vendita${alKg(p)} scritta a mano ${fmtEuro(perUnita(p, p.prezzoManuale))}: resta quella${dopo != null ? ` (calcolata sarebbe ${fmtEuro(perUnita(p, dopo))})` : ''}`)
        : `vendita${alKg(p)}: ${prezzoVendita(p) != null ? fmtEuro(perUnita(p, prezzoVendita(p))) : 'senza prezzo'} → <b>${fmtEuro(perUnita(p, dopo))}</b>`;
      righe.push(`<div class="fr-riga fr-prezzo"><span>Acquisto${alBase(p)}: ${e.prima != null ? fmtEuro(e.prima) + ' → ' : ''}<b>${fmtEuro(e.prezzo)}</b>${perc}${e.strano ? ' <span class="tag warn">unità diversa? controlla</span>' : ''}<br>
        <span class="faint">${vendita}</span></span>
        <button class="btn small" type="button" data-act="fr-prezzo" ${dati}>Aggiorna</button></div>`);
    } else if (e.prezzo != null) righe.push(`<div class="fr-riga faint">Prezzo d'acquisto uguale ✓</div>`);
    corpo = righe.join('');
  }
  return `<div class="item fr"><div class="main">${testa}${corpo}</div></div>`;
}
/* aggiornare il prezzo d'acquisto di una riga: il prezzo di vendita si ricalcola (se non è scritto a mano) */
async function aggiornaPrezzoRiga(fa, e) {
  const p = prodotto(e.p.id); if (!p || e.prezzo == null) return null;
  const prima = prezzoVendita(p);
  const np = { ...p, prezzoAcquisto: e.prezzo, iva: p.iva ?? e.r.iva };
  await save('prodotti', np);
  const dopo = prezzoVendita(np);
  return dopo !== prima && np.prezzoManuale == null ? { p: np, prima, dopo } : null;
}
function avvisoCassa(cambi) {
  cambi = cambi.filter(Boolean); if (!cambi.length) { toast('Prezzi aggiornati'); return; }
  openModal(`${mhead('Cambia anche in cassa')}
    <p class="muted small">Il prezzo di vendita di questi prodotti è cambiato nell'app. Cambialo anche sul registratore di cassa, altrimenti la chiusura non torna.</p>
    <div class="list">${cambi.map(c => `<div class="item"><div class="main"><div class="name">${esc(c.p.nome)}</div><div class="sub">${c.prima != null ? fmtEuro(perUnita(c.p, c.prima)) : 'senza prezzo'} → <b>${fmtEuro(perUnita(c.p, c.dopo))}</b>${alKg(c.p)}</div></div></div>`).join('')}</div>
    <button class="btn primary block" type="button" data-act="close-modal">Ho capito</button>`);
}
async function collegaFornitoreFattura(fa, fid) {
  const f = fornitore(fid); if (!f) return;
  if (fa.fornitore.piva && !f.piva) await save('fornitori', { ...f, piva: fa.fornitore.piva });
  const stesse = [...S.fatture.values()].filter(x => !x.fornitoreId && (x.id === fa.id || (fa.fornitore.piva && x.fornitore.piva === fa.fornitore.piva)));
  await saveMany('fatture', stesse.map(x => ({ ...x, fornitoreId: fid })));
  await imparaDaEan(stesse.map(x => S.fatture.get(x.id)).sort((a, b) => a.data.localeCompare(b.data)));
}
async function importaFatture(files) {
  toast('Leggo le fatture…', { ms: 15000 });
  let r;
  try { r = await caricaFatture(files); } catch (e) { toast('Non riesco a leggere i file: ' + e.message, { err: true }); return; }
  const parti = [];
  if (r.nuove) parti.push(r.nuove === 1 ? '1 fattura caricata' : r.nuove + ' fatture caricate');
  if (r.doppie) parti.push(r.doppie === 1 ? '1 era già caricata' : r.doppie + ' erano già caricate');
  if (r.saltati.length) parti.push(`${r.saltati.length} file saltati (non sono fatture)`);
  const msg = parti.join(' · ') || 'Nessuna fattura trovata nei file scelti';
  if (current.name === 'fatture') render(); else location.hash = '#fatture';
  setTimeout(() => toast(msg, { err: !r.nuove && !r.doppie, ms: 6000 }), 150);
}

/* =========================================================
   PAGAMENTI: scadenze delle fatture e altre spese (affitto, bollette…)
   - una spesa che si ripete, quando è pagata, prepara da sola la prossima
   ========================================================= */
const RIPETI = [[0, 'Una volta'], [1, 'Ogni mese'], [2, 'Ogni 2 mesi'], [3, 'Ogni 3 mesi'], [6, 'Ogni 6 mesi'], [12, 'Ogni anno']];
const nomeRipeti = n => n ? (RIPETI.find(r => r[0] === +n) || [0, ''])[1].toLowerCase() : '';
const MODI_SPESA = ['', 'bonifico', 'addebito SEPA', 'contanti', 'carta', 'F24'];
const SPESE_SUGG = ['Affitto', 'Luce', 'Gas', 'Acqua', 'Telefono e internet', 'Rifiuti (TARI)', 'Assicurazione', 'F24 tasse e contributi', 'Commissioni POS e banca', 'Pulizie'];
function piuGiorni(n) { const d = new Date(); d.setDate(d.getDate() + n); return todayISO(d); }
/* stessa data tra n mesi (il 31 diventa l'ultimo del mese, poi torna al 31 quando c'è) */
function piuMesi(iso, n, giorno) {
  const [y, m, d] = iso.split('-').map(Number), g = giorno || d;
  const ultimo = new Date(y, m - 1 + n + 1, 0).getDate();
  return todayISO(new Date(y, m - 1 + n, Math.min(g, ultimo)));
}
const totale = l => r2(l.reduce((t, x) => t + (x.importo || 0), 0));
routes.pagamenti = () => {
  if (!conPagamenti() && !conFatture()) return routes.home();
  const oggi = todayISO(), tra30 = piuGiorni(30);
  const tutti = tuttiPagamenti(), aperti = tutti.filter(x => !x.pagata);
  const scaduti = aperti.filter(x => x.data < oggi), prossimi = aperti.filter(x => x.data >= oggi && x.data <= tra30), dopo = aperti.filter(x => x.data > tra30);
  let html = (conFatture() ? segFatture('p') : '') + `<div class="stats" style="grid-template-columns:1fr 1fr">
      <div class="stat ${scaduti.length ? 'red' : ''}"><b class="euro">${fmtEuro(totale(scaduti))}</b><span>Scaduti${scaduti.length ? ' · ' + scaduti.length : ''}</span></div>
      <div class="stat ${prossimi.length ? 'orange' : ''}"><b class="euro">${fmtEuro(totale(prossimi))}</b><span>Nei prossimi 30 giorni${prossimi.length ? ' · ' + prossimi.length : ''}</span></div></div>
    <button class="btn block" type="button" data-act="spesa-nuova">+ Aggiungi una spesa: affitto, bollette…</button>`;
  for (const [tit, l, cls] of [['Scaduti', scaduti, 'red'], ['Nei prossimi 30 giorni', prossimi, ''], ['Più avanti', dopo, '']]) {
    if (!l.length && tit !== 'Nei prossimi 30 giorni') continue;
    html += `<div class="section-title"><h2>${tit}</h2><span class="count">${l.length ? fmtEuro(totale(l)) : ''}</span></div>`;
    html += l.length ? `<div class="list">${l.map(x => rigaPagamento(x, cls)).join('')}</div>` : '<div class="empty">Niente da pagare.</div>';
  }
  const perF = new Map();
  for (const x of aperti.filter(x => x.k === 'f')) perF.set(x.nome, r2((perF.get(x.nome) || 0) + x.importo));
  if (perF.size > 1) html += `<div class="section-title"><h2>Da pagare per fornitore</h2></div><div class="list">${[...perF.entries()].sort((a, b) => b[1] - a[1]).map(([n, v]) => `<div class="item"><div class="main"><div class="name">${esc(n)}</div></div><span class="prezzo">${fmtEuro(v)}</span></div>`).join('')}</div>`;
  const fatti = tutti.filter(x => x.pagata && x.pagata >= piuGiorni(-45)).sort((a, b) => b.pagata.localeCompare(a.pagata)).slice(0, 15);
  if (fatti.length) html += `<div class="section-title"><h2>Pagati di recente</h2></div><div class="list">${fatti.map(x => rigaPagamento(x, '')).join('')}</div>`;
  html += `<div class="faint small" style="text-align:center">${conFatture() ? 'Le scadenze delle fatture arrivano da sole quando carichi le fatture. Qui aggiungi le altre spese del negozio.' : 'Scrivi qui le spese del negozio: affitto, bollette, F24, fornitori da pagare…'}</div>`;
  return { title: conFatture() ? 'Fatture e pagamenti' : 'Pagamenti', html, back: '#home', tab: 'home' };
};
function spesaModal(id) {
  const sp = id ? S.spese.get(id) : null;
  const rip = sp ? +sp.ripeti || 0 : 1;
  openModal(`${mhead(sp ? 'Spesa' : 'Nuova spesa')}
    <label class="field">Che spesa è<input type="text" id="spDesc" list="spSugg" value="${esc(sp ? sp.descrizione : '')}" placeholder="es. Affitto" autocomplete="off"></label>
    <datalist id="spSugg">${SPESE_SUGG.map(x => `<option value="${esc(x)}">`).join('')}</datalist>
    <div class="btn-grid" style="grid-template-columns:1fr 1fr">
      <label class="field">Importo €<input type="text" inputmode="decimal" id="spImp" value="${sp ? fmtImporto(sp.importo) : ''}" autocomplete="off"></label>
      <label class="field">Scadenza<input type="date" id="spScad" value="${sp ? sp.scadenza : todayISO()}"></label></div>
    <div class="btn-grid" style="grid-template-columns:1fr 1fr">
      <label class="field">Si ripete<select id="spRip">${RIPETI.map(([v, l]) => `<option value="${v}" ${rip === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="field">Come si paga<select id="spMod">${MODI_SPESA.map(m => `<option value="${esc(m)}" ${(sp ? sp.modalita || '' : '') === m ? 'selected' : ''}>${m || '—'}</option>`).join('')}</select></label></div>
    <label class="field">Note<input type="text" id="spNote" value="${esc(sp ? sp.note || '' : '')}" autocomplete="off"></label>
    ${sp && sp.pagata ? `<div class="notice green"><span>Pagata il ${fmtDate(sp.pagata)}.</span></div>` : ''}
    <button class="btn primary block" type="button" data-x="ok">Salva</button>
    ${sp ? `<button class="btn danger block" type="button" data-x="del">Elimina questa spesa</button>` : ''}
    <div class="faint small">Se si ripete, quando la segni pagata compare da sola la prossima. Per smettere: «Si ripete» → «Una volta».</div>`, b => {
    b.querySelector('[data-x=ok]').onclick = async () => {
      const descrizione = b.querySelector('#spDesc').value.trim(), importo = parseNum(b.querySelector('#spImp').value), scadenza = b.querySelector('#spScad').value;
      if (!descrizione) { toast('Scrivi che spesa è', { err: true }); return; }
      if (importo == null || importo <= 0) { toast('Scrivi l\'importo', { err: true }); return; }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(scadenza)) { toast('Scegli la data di scadenza', { err: true }); return; }
      const ripeti = +b.querySelector('#spRip').value || 0;
      const nuovo = { ...(sp || { id: uid('sp'), pagata: null, creato: Date.now() }), descrizione, importo: r2(importo), scadenza, ripeti, giorno: +scadenza.slice(8, 10), modalita: b.querySelector('#spMod').value, note: b.querySelector('#spNote').value.trim() };
      if (!nuovo.serie) nuovo.serie = nuovo.id;
      await save('spese', nuovo); closeModal(); render();
      setTimeout(() => toast(sp ? 'Spesa salvata' : `Spesa aggiunta: scade il ${fmtDate(scadenza)}`), 120);
    };
    const del = b.querySelector('[data-x=del]');
    if (del) del.onclick = async () => {
      const prima = { ...sp };
      await remove('spese', sp.id); closeModal(); render();
      setTimeout(() => toast('Spesa eliminata', { action: { label: 'Annulla', run: async () => { await save('spese', prima); render(); } } }), 120);
    };
  });
}
async function segnaSpesa(id) {
  const sp = S.spese.get(id); if (!sp) return;
  if (sp.pagata) { await save('spese', { ...sp, pagata: null }); render(); return; }
  await save('spese', { ...sp, pagata: todayISO() });
  let dopo = null;
  const serie = sp.serie || sp.id;
  if (+sp.ripeti > 0 && ![...S.spese.values()].some(x => x.id !== sp.id && (x.serie || x.id) === serie && x.scadenza > sp.scadenza)) {
    dopo = { ...sp, id: uid('sp'), scadenza: piuMesi(sp.scadenza, +sp.ripeti, sp.giorno), pagata: null, serie, creato: Date.now() };
    await save('spese', dopo);
  }
  render();
  setTimeout(() => toast(dopo ? `Pagata. La prossima: ${fmtDate(dopo.scadenza)}` : 'Pagata', { action: { label: 'Annulla', run: async () => {
    if (dopo) await remove('spese', dopo.id);
    const cur = S.spese.get(id); if (cur) await save('spese', { ...cur, pagata: null });
    render();
  } } }), 60);
}
function scadenzaFatturaModal(fa) {
  openModal(`${mhead('Scadenza del pagamento')}
    <p class="muted small" style="margin:0">${esc(nomeFornFattura(fa))} · fattura ${esc(fa.numero)} · ${fmtEuro(fa.totale)}</p>
    <label class="field">Da pagare entro il<input type="date" id="fsData" value="${piuMesi(fa.data, 1)}"></label>
    <label class="field">Come si paga<select id="fsMod">${[['', '—'], ['MP05', 'bonifico'], ['MP12', 'RiBa'], ['MP19', 'addebito SEPA'], ['MP01', 'contanti'], ['MP08', 'carta'], ['MP02', 'assegno']].map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label>
    <button class="btn primary block" type="button" data-x="ok">Salva</button>`, b => {
    b.querySelector('[data-x=ok]').onclick = async () => {
      const d = b.querySelector('#fsData').value;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) { toast('Scegli la data', { err: true }); return; }
      await save('fatture', { ...S.fatture.get(fa.id), pagamenti: [{ modalita: b.querySelector('#fsMod').value, scadenza: d, importo: fa.totale, pagata: null }] });
      closeModal(); render();
    };
  });
}

/* =========================================================
   CRUSCOTTO: i numeri del negozio in una pagina
   - incassi dalle chiusure di cassa, acquisti dalle fatture, altre spese
   - margine stimato sulle vendite scansionate (prezzo senza IVA meno prezzo d'acquisto di oggi)
   ========================================================= */
let CRU = 'mese';
const PERIODI_CRU = [['mese', 'Questo mese'], ['scorso', 'Mese scorso'], ['anno', 'Ultimi 12 mesi']];
const segnoVendita = v => v.tipo === 'reso' ? -1 : 1;
function numeriPeriodo(f) {
  const [da, a] = periodo(f), dentro = d => !!d && d >= da && d <= a, oggi = todayISO();
  const chiusure = [...S.chiusure.values()].filter(c => dentro(c.data));
  const incassi = r2(chiusure.reduce((t, c) => t + (+c.incasso || 0), 0));
  const vendite = [...S.vendite.values()].filter(v => dentro(v.data));
  const senzaChiusura = [...new Set(vendite.map(v => v.data))].filter(d => d !== oggi && !S.chiusure.has('c' + d)).sort();
  const fatture = conFatture() ? [...S.fatture.values()].filter(fa => dentro(fa.data)) : [];
  const acquisti = r2(fatture.reduce((t, fa) => t + (+fa.totale || 0) * segnoFattura(fa), 0));
  const spese = conPagamenti() ? [...S.spese.values()].filter(sp => dentro(sp.scadenza)) : [];
  const altreSpese = r2(spese.reduce((t, sp) => t + (+sp.importo || 0), 0));
  let scansionato = 0, ricavo = 0, costo = 0, senzaCosto = new Set();
  const perProd = new Map();
  for (const v of vendite) {
    const imp = importo(v); if (imp == null) continue;
    scansionato += imp;
    if (!v.prodottoId) continue;
    const e = perProd.get(v.prodottoId) || { imp: 0, qta: 0, v }; e.imp += imp; e.qta += v.qta * segnoVendita(v); perProd.set(v.prodottoId, e);
    const p = prodotto(v.prodottoId);
    if (!p) continue;   // prodotto eliminato: fuori dal margine
    if (p.prezzoAcquisto == null || p.iva == null) { senzaCosto.add(v.prodottoId); continue; }
    ricavo += imp / (1 + p.iva / 100); costo += p.prezzoAcquisto * v.qta * segnoVendita(v);
  }
  const sprechi = sprechiPeriodo(f).filter(perso);
  return {
    da, a, chiusure, incassi, senzaChiusura, vendite, fatture, acquisti, spese, altreSpese,
    scansionato: r2(scansionato), ricavo: r2(ricavo), costo: r2(costo), margine: r2(ricavo - costo),
    perc: ricavo > 0 ? Math.round((ricavo - costo) / ricavo * 1000) / 10 : null, senzaCosto: senzaCosto.size,
    piuVenduti: [...perProd.entries()].filter(([, e]) => e.imp > 0).sort((x, y) => y[1].imp - x[1].imp).slice(0, 5),
    sprechi: r2(sprechi.reduce((t, r) => t + (valoreSpreco(r) || 0), 0)), nSprechi: sprechi.length
  };
}
/* merce in negozio al prezzo d'acquisto, e merce ferma: niente vendite da 60 giorni */
function numeriMerce() {
  const limite = piuGiorni(-60), ultimaVendita = new Map();
  for (const v of S.vendite.values()) if (v.prodottoId && v.tipo !== 'reso' && (!ultimaVendita.has(v.prodottoId) || v.data > ultimaVendita.get(v.prodottoId))) ultimaVendita.set(v.prodottoId, v.data);
  let valore = 0, senzaPrezzo = 0; const perProd = new Map();
  for (const l of lottiAttivi()) {
    const p = prodotto(l.prodottoId), q = +l.quantita || 0; if (!p || q <= 0) continue;
    const e = perProd.get(p.id) || { q: 0, val: 0, arrivo: l.arrivo || '' };
    e.q += q; if (l.arrivo && l.arrivo < e.arrivo) e.arrivo = l.arrivo;
    if (p.prezzoAcquisto != null) { e.val += p.prezzoAcquisto * q; valore += p.prezzoAcquisto * q; } else senzaPrezzo++;
    perProd.set(p.id, e);
  }
  const fermi = [...perProd.entries()].filter(([pid, e]) => e.arrivo && e.arrivo <= limite && !((ultimaVendita.get(pid) || '') > limite))
    .map(([pid, e]) => ({ p: prodotto(pid), ...e, ultima: ultimaVendita.get(pid) || null })).sort((x, y) => y.val - x.val);
  return { valore: r2(valore), senzaPrezzo, fermi, valoreFermi: r2(fermi.reduce((t, x) => t + x.val, 0)) };
}
function cosaDaFare() {
  const oggi = todayISO(), tra7 = piuGiorni(7), out = [];
  const aperti = tuttiPagamenti().filter(x => !x.pagata);
  const scad = aperti.filter(x => x.data < oggi), presto = aperti.filter(x => x.data >= oggi && x.data <= tra7);
  if (scad.length) out.push(['#pagamenti', `${scad.length === 1 ? '1 pagamento scaduto' : scad.length + ' pagamenti scaduti'}`, fmtEuro(totale(scad)), 'red']);
  if (presto.length) out.push(['#pagamenti', `${presto.length === 1 ? '1 pagamento' : presto.length + ' pagamenti'} entro 7 giorni`, fmtEuro(totale(presto)), 'orange']);
  const daC = conFatture() ? [...S.fatture.values()].filter(f => f.stato !== 'controllata').length : 0;
  if (daC) out.push(['#fatture', daC === 1 ? '1 fattura da controllare' : `${daC} fatture da controllare`, '', '']);
  const urg = lottiAttivi().filter(l => !l.gestito && ['scaduto', 'rosso', 'arancio'].includes(fascia(l))).length;
  if (urg) out.push(['#scadenze/urgenti', urg === 1 ? '1 prodotto in scadenza' : `${urg} prodotti in scadenza o scaduti`, '', '']);
  const righe = [...S.ordini.values()].filter(o => o.stato === 'aperto').reduce((t, o) => t + o.righe.length, 0);
  if (righe) out.push(['#ordini', righe === 1 ? '1 prodotto da ordinare' : `${righe} prodotti da ordinare`, '', '']);
  const lb = S.meta.lastBackup, gg = lb ? -daysUntil(lb.slice(0, 10)) : null;
  if (gg == null || gg >= 3) out.push(['#impostazioni', gg == null ? 'Nessun backup ancora' : `Ultimo backup ${gg} giorni fa`, '', 'red']);
  return out;
}
routes.cruscotto = () => {
  const n = numeriPeriodo(CRU), m = numeriMerce(), fare = cosaDaFare();
  const diff = r2(n.incassi - n.acquisti - n.altreSpese);
  let html = `<div class="chips">${PERIODI_CRU.map(([k, l]) => `<button class="chip ${CRU === k ? 'on' : ''}" type="button" data-act="cru-periodo" data-f="${k}">${l}</button>`).join('')}</div>`;
  html += `<div class="section-title"><h2>Da fare</h2></div>` + (fare.length
    ? `<div class="list dafare">${fare.map(([h, t, v, c]) => `<a class="item" href="${h}"><span class="dot ${c}" aria-hidden="true"></span><div class="main"><div class="name">${t}</div></div>${v ? `<span class="prezzo">${v}</span>` : ''}<span class="chev">›</span></a>`).join('')}</div>`
    : '<div class="notice green"><span>Niente di urgente. Tutto in ordine.</span></div>');
  html += `<div class="section-title"><h2>Entrate e uscite</h2><span class="count">${fmtDate(n.da)} – ${fmtDate(n.a)}</span></div>
    ${conFatture() ? `<div class="stats cru">
      <a class="stat green" href="#cassa"><b class="euro">${fmtEuro(n.incassi)}</b><span>Incassi (dalla cassa) · ${n.chiusure.length} ${n.chiusure.length === 1 ? 'giorno' : 'giorni'}</span></a>
      <a class="stat" href="#fatture"><b class="euro">${fmtEuro(n.acquisti)}</b><span>Fatture dei fornitori · ${n.fatture.length}</span></a>
      <a class="stat" href="#pagamenti"><b class="euro">${fmtEuro(n.altreSpese)}</b><span>Altre spese · ${n.spese.length}</span></a>
      <div class="stat ${diff < 0 ? 'red' : ''}"><b class="euro">${fmtEuro(diff)}</b><span>Incassi meno uscite</span></div></div>
    <div class="faint small">Un'idea, non il bilancio: la merce comprata in questo periodo si vende anche dopo. Fatture e spese con IVA.</div>` : `<div class="stats" style="grid-template-columns:1fr 1fr">
      <a class="stat green" href="#cassa"><b class="euro">${fmtEuro(n.incassi)}</b><span>Incassi (dalla cassa) · ${n.chiusure.length} ${n.chiusure.length === 1 ? 'giorno' : 'giorni'}</span></a>
      ${conPagamenti() ? `<a class="stat" href="#pagamenti"><b class="euro">${fmtEuro(n.altreSpese)}</b><span>Spese · ${n.spese.length}</span></a>` : `<div class="stat"><b class="euro">${n.chiusure.length ? fmtEuro(r2(n.incassi / n.chiusure.length)) : '–'}</b><span>Media al giorno</span></div>`}</div>
    ${conPagamenti() ? '<div class="faint small">Le spese sono quelle scritte in Pagamenti, con scadenza nel periodo.</div>' : ''}`}`;
  if (n.senzaChiusura.length) html += `<div class="notice"><span>${n.senzaChiusura.length === 1 ? `Il ${fmtDate(n.senzaChiusura[0])} ci sono vendite ma manca la chiusura` : `In ${n.senzaChiusura.length} giorni ci sono vendite ma manca la chiusura`}: l'incasso di ${n.senzaChiusura.length === 1 ? 'quel giorno' : 'quei giorni'} non è contato.</span></div>`;
  html += `<div class="card"><h3 style="margin:0">Margine sulle vendite scansionate</h3>
      ${n.ricavo > 0 ? `<div class="margine"><div><b>${fmtEuro(n.margine)}</b><span>guadagno lordo</span></div><div><b>${n.perc != null ? fmtNum(n.perc) + '%' : '–'}</b><span>del venduto senza IVA</span></div></div>
      <div class="barra-m" aria-hidden="true"><i style="width:${Math.max(0, Math.min(100, n.perc || 0))}%"></i></div>
      <dl class="kv"><dt>Venduto (con IVA)</dt><dd>${fmtEuro(n.scansionato)}</dd><dt>Venduto senza IVA</dt><dd>${fmtEuro(n.ricavo)}</dd><dt>Costo della merce venduta</dt><dd>${fmtEuro(n.costo)}</dd></dl>` : '<p class="muted small" style="margin:0">Nessuna vendita scansionata in questo periodo.</p>'}
      ${n.senzaCosto ? `<div class="faint small">${n.senzaCosto === 1 ? '1 prodotto venduto non ha' : n.senzaCosto + ' prodotti venduti non hanno'} prezzo d'acquisto o IVA: non ${n.senzaCosto === 1 ? 'è contato' : 'sono contati'} nel margine.</div>` : ''}
      <div class="faint small">Con il ricarico del 50% il margine è circa il 33%; con il 40%, circa il 29%. Frutta e verdura non sono contate.</div></div>`;
  if (n.piuVenduti.length) html += `<div class="section-title"><h2>Più venduti</h2></div><div class="list venduti">${n.piuVenduti.map(([pid, e]) => {
    const p = prodotto(pid), dentro = `<div class="main"><div class="name">${esc(nomeVendita(e.v))}</div><div class="sub">${p ? fq(p, r3(e.qta)) : `${e.v.sfuso ? fmtKg(r3(e.qta)) : fmtNum(r3(e.qta)) + ' pz'} · non è più nel catalogo`}</div></div><span class="prezzo">${fmtEuro(r2(e.imp))}</span>`;
    return p ? `<a class="item" href="#prodotto/${encodeURIComponent(pid)}">${dentro}</a>` : `<div class="item">${dentro}</div>`;
  }).join('')}</div>`;
  if (n.vendite.length) html += `<button class="btn ghost block" type="button" data-act="cru-prove">Erano prove? Cancella le vendite scansionate (${n.vendite.length})</button>`;
  const vc = venditeCategorie(CRU);
  if (vc.lista.some(e => e.imp > 0)) html += `<div class="section-title"><h2>Per categoria</h2></div>${barreHTML(vc.lista.filter(e => e.imp > 0).slice(0, 5).map(e => ({ nome: e.nome, valore: e.imp, href: '#categoria/' + encodeURIComponent(e.nome), sotto: Math.round(e.quota) + '% del venduto' + (e.perc != null ? ' · margine ' + fmtNum(e.perc) + '%' : '') })), vc.lista[0].imp)}`;
  html += `<a class="btn block" href="#categorie">Vendite per categoria e grafici</a>`;
  html += `<div class="section-title"><h2>Merce</h2></div><div class="stats" style="grid-template-columns:1fr 1fr">
      <div class="stat"><b class="euro">${fmtEuro(m.valore)}</b><span>In negozio, al prezzo d'acquisto</span></div>
      <a class="stat ${n.sprechi ? 'red' : ''}" href="#sprechi"><b class="euro">${fmtEuro(n.sprechi)}</b><span>Buttati nel periodo · ${n.nSprechi}</span></a></div>`;
  if (m.fermi.length) html += `<div class="section-title"><h2>Ferma da più di 60 giorni</h2><span class="count">${m.fermi.length} · ${fmtEuro(m.valoreFermi)}</span></div>
    <div class="list fermi">${m.fermi.slice(0, 6).map(x => `<a class="item" href="#prodotto/${encodeURIComponent(x.p.id)}"><div class="main"><div class="name">${esc(x.p.nome)}</div><div class="sub">${fq(x.p, r3(x.q))} · ${x.ultima ? 'ultima vendita ' + fmtDate(x.ultima) : 'mai venduto nell\'app'}</div></div><span class="prezzo">${x.val ? fmtEuro(r2(x.val)) : ''}</span></a>`).join('')}</div>
    <div class="faint small">Da valutare: metterli in vista, in sconto, o non riordinarli.</div>`;
  html += `<a class="btn primary block" href="#riepilogo">Riepilogo del mese per la contabilità</a>`;
  return { title: 'Cruscotto', html, back: '#home', tab: 'home' };
};

/* =========================================================
   RIEPILOGO DEL MESE per la contabilità (anche in Excel)
   ========================================================= */
const nomeMese = ym => { const [y, m] = ym.split('-').map(Number); const n = MESI[m - 1]; return n[0].toUpperCase() + n.slice(1) + ' ' + y; };
const meseVicino = (ym, d) => { const [y, m] = ym.split('-').map(Number); const x = new Date(y, m - 1 + d, 1); return `${x.getFullYear()}-${pad(x.getMonth() + 1)}`; };
function datiRiepilogo(mese) {
  const dentro = d => !!d && d.slice(0, 7) === mese;
  const incassi = [...S.chiusure.values()].filter(c => dentro(c.data)).sort((a, b) => a.data.localeCompare(b.data));
  const perGiorno = new Map();
  for (const v of S.vendite.values()) if (dentro(v.data)) { const imp = importo(v); if (imp != null) perGiorno.set(v.data, (perGiorno.get(v.data) || 0) + imp); }
  const mancano = [...perGiorno.keys()].filter(d => !S.chiusure.has('c' + d)).sort().map(d => ({ data: d, scansionato: r2(perGiorno.get(d)) }));
  const fatture = (conFatture() ? [...S.fatture.values()] : []).filter(fa => dentro(fa.data)).sort((a, b) => a.data.localeCompare(b.data) || String(a.numero).localeCompare(String(b.numero)));
  const iva = new Map();
  let imponibile = 0, imposta = 0;
  for (const fa of fatture) for (const r of fa.riepilogo || []) {
    const k = r.aliquota != null && +r.aliquota > 0 ? fmtNum(+r.aliquota) + '%' : (r.natura ? '0% (' + r.natura + ')' : '0%');
    const e = iva.get(k) || { imponibile: 0, imposta: 0, al: +r.aliquota || 0 }, sg = segnoFattura(fa);
    e.imponibile += (+r.imponibile || 0) * sg; e.imposta += (+r.imposta || 0) * sg; iva.set(k, e);
    imponibile += (+r.imponibile || 0) * sg; imposta += (+r.imposta || 0) * sg;
  }
  const spese = (conPagamenti() ? [...S.spese.values()] : []).filter(sp => dentro(sp.scadenza)).sort((a, b) => a.scadenza.localeCompare(b.scadenza));
  const tutti = tuttiPagamenti();
  const pagati = tutti.filter(x => dentro(x.pagata)).sort((a, b) => a.pagata.localeCompare(b.pagata));
  const daPagare = tutti.filter(x => !x.pagata && dentro(x.data));
  const sprechi = [...S.sprechi.values()].filter(r => dentro(r.data) && perso(r)).sort((a, b) => a.data.localeCompare(b.data));
  return {
    mese, incassi, mancano, totIncassi: r2(incassi.reduce((t, c) => t + (+c.incasso || 0), 0)), totFrutta: r2(incassi.reduce((t, c) => t + (+c.frutta || 0), 0)),
    fatture, iva: [...iva.entries()].sort((a, b) => a[1].al - b[1].al), imponibile: r2(imponibile), imposta: r2(imposta),
    totFatture: r2(fatture.reduce((t, fa) => t + (+fa.totale || 0) * segnoFattura(fa), 0)),
    spese, totSpese: r2(spese.reduce((t, sp) => t + (+sp.importo || 0), 0)),
    pagati, totPagati: totale(pagati), daPagare, totDaPagare: totale(daPagare),
    sprechi, totSprechi: r2(sprechi.reduce((t, r) => t + (valoreSpreco(r) || 0), 0))
  };
}
routes.riepilogo = arg => {
  const oggiM = todayISO().slice(0, 7), mese = /^\d{4}-\d{2}$/.test(arg || '') && arg <= oggiM ? arg : oggiM;
  const NUM = ['Incasso', 'Frutta e verdura', 'Totale', 'Imponibile', 'IVA', 'Importo', 'Margine'];
  const d = datiRiepilogo(mese), t = (l, testa) => `<table class="tab"><thead><tr>${testa.map(h => `<th${NUM.includes(h) ? ' class="n"' : ''}>${h}</th>`).join('')}</tr></thead><tbody>${l}</tbody></table>`;
  let html = `<div class="mese-nav"><a class="btn small" href="#riepilogo/${meseVicino(mese, -1)}" aria-label="Mese prima">‹</a><h2>${nomeMese(mese)}</h2>${mese < oggiM ? `<a class="btn small" href="#riepilogo/${meseVicino(mese, 1)}" aria-label="Mese dopo">›</a>` : '<span class="btn small" style="visibility:hidden">›</span>'}</div>
    <div class="card"><dl class="kv riep">
      <dt>Incassi (dalla cassa)</dt><dd>${fmtEuro(d.totIncassi)}</dd>
      ${d.totFrutta ? `<dt>di cui frutta e verdura</dt><dd>${fmtEuro(d.totFrutta)}</dd>` : ''}
      ${conFatture() ? `<dt>Fatture dei fornitori</dt><dd>${fmtEuro(d.totFatture)}</dd>
      <dt>di cui IVA</dt><dd>${fmtEuro(d.imposta)}</dd>` : ''}
      ${conPagamenti() || conFatture() ? `${conPagamenti() ? `<dt>${nomeSpese()}</dt><dd>${fmtEuro(d.totSpese)}</dd>` : ''}
      <dt>Pagato nel mese</dt><dd>${fmtEuro(d.totPagati)}</dd>
      <dt>Ancora da pagare (scadenze del mese)</dt><dd class="${d.daPagare.length ? 'arancio' : ''}">${fmtEuro(d.totDaPagare)}</dd>` : `<dt>Venduto nell'app (scansionato)</dt><dd>${fmtEuro(venditeMese(mese).totale)}</dd>`}
      <dt>Merce buttata (al costo)</dt><dd>${fmtEuro(d.totSprechi)}</dd></dl>
      <button class="btn primary block" type="button" data-act="riep-excel" data-m="${mese}">Scarica in Excel</button></div>`;
  html += `<div class="section-title"><h2>Incassi</h2><span class="count">${fmtEuro(d.totIncassi)}</span></div>`;
  html += d.incassi.length ? t(d.incassi.map(c => `<tr><td>${fmtDate(c.data)}</td><td class="n">${fmtEuro(c.incasso)}</td><td class="n faint">${c.frutta ? fmtEuro(c.frutta) : ''}</td></tr>`).join(''), ['Giorno', 'Incasso', 'Frutta e verdura']) : '<div class="empty">Nessuna chiusura di cassa in questo mese.</div>';
  if (d.mancano.length) html += `<div class="notice"><span>Manca la chiusura: ${d.mancano.map(x => `${fmtDate(x.data)} (scansionati ${fmtEuro(x.scansionato)})`).join(', ')}. Scrivi l'incasso nello storico di cassa.</span></div>`;
  html += `<a class="btn ghost block" href="#cassa/${mese}">Correggi gli incassi: storico di cassa</a>`;
  if (conFatture()) html += `<div class="section-title"><h2>Fatture dei fornitori</h2><span class="count">${d.fatture.length}</span></div>` + (d.fatture.length ? t(d.fatture.map(fa => { const sg = segnoFattura(fa); const imp = (fa.riepilogo || []).reduce((x, r) => x + (+r.imponibile || 0), 0) * sg; return `<tr><td>${fmtDate(fa.data)}</td><td><a href="#fattura/${encodeURIComponent(fa.id)}">${esc(nomeFornFattura(fa))}</a><div class="faint">${fa.tipo === 'TD04' ? 'nota di credito ' : 'n. '}${esc(fa.numero)}</div></td><td class="n">${fmtEuro(fa.totale * sg)}<div class="faint">impon. ${fmtEuro(r2(imp))}</div></td></tr>`; }).join(''), ['Data', 'Fornitore', 'Totale']) : '<div class="empty">Nessuna fattura in questo mese.</div>');
  if (d.iva.length) html += `<div class="section-title"><h2>IVA sugli acquisti</h2></div>` + t(d.iva.map(([k, e]) => `<tr><td>${k}</td><td class="n">${fmtEuro(r2(e.imponibile))}</td><td class="n">${fmtEuro(r2(e.imposta))}</td></tr>`).join('') + `<tr class="tot"><td>Totale</td><td class="n">${fmtEuro(d.imponibile)}</td><td class="n">${fmtEuro(d.imposta)}</td></tr>`, ['Aliquota', 'Imponibile', 'IVA']);
  if (conPagamenti()) html += `<div class="section-title"><h2>${nomeSpese()}</h2><span class="count">${fmtEuro(d.totSpese)}</span></div>` + (d.spese.length ? t(d.spese.map(sp => `<tr><td>${fmtDate(sp.scadenza)}</td><td>${esc(sp.descrizione)}${sp.pagata ? '' : ' <span class="tag warn">da pagare</span>'}</td><td class="n">${fmtEuro(sp.importo)}</td></tr>`).join(''), ['Scadenza', 'Spesa', 'Importo']) : '<div class="empty">Nessuna spesa in questo mese. Si aggiungono in Pagamenti.</div>');
  if (conPagamenti() || conFatture()) html += `<div class="section-title"><h2>Pagamenti fatti</h2><span class="count">${fmtEuro(d.totPagati)}</span></div>` + (d.pagati.length ? t(d.pagati.map(x => `<tr><td>${fmtDate(x.pagata)}</td><td>${esc(x.nome)}<div class="faint">${x.k === 'f' ? 'fattura ' + esc(x.fa.numero) : 'spesa'}</div></td><td class="n">${fmtEuro(x.importo)}</td></tr>`).join(''), ['Pagato il', 'A chi', 'Importo']) : '<div class="empty">Nessun pagamento segnato in questo mese.</div>');
  const vm = venditeMese(mese).lista.filter(e => e.imp);
  html += `<div class="section-title"><h2>Venduto per categoria</h2><span class="count">${fmtEuro(venditeMese(mese).totale)}</span></div>` + (vm.length ? t(vm.map(e => `<tr><td><a href="#categoria/${encodeURIComponent(e.nome)}">${esc(e.nome)}</a><div class="faint">${qtaCat(e)}</div></td><td class="n">${e.perc != null ? fmtNum(e.perc) + '%' : ''}</td><td class="n">${fmtEuro(e.imp)}</td></tr>`).join(''), ['Categoria', 'Margine', 'Importo']) : '<div class="empty">Nessuna vendita scansionata in questo mese.</div>');
  if (conFatture()) html += `<div class="faint small" style="text-align:center">L'IVA delle vendite è nel riepilogo dei corrispettivi della cassa.</div>`;
  return { title: 'Riepilogo del mese', html, back: '#cruscotto', tab: 'home' };
};

/* --- Excel (.xlsx) senza librerie: un archivio zip di file xml --- */
const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(u8) { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC_T[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function creaZip(files, tipo) {
  const enc = new TextEncoder(), parti = [], centrale = []; let off = 0;
  for (const f of files) {
    const nome = enc.encode(f.nome), dati = typeof f.dati === 'string' ? enc.encode(f.dati) : f.dati, crc = crc32(dati), n = dati.length;
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(12, 0x21, true);
    h.setUint32(14, crc, true); h.setUint32(18, n, true); h.setUint32(22, n, true); h.setUint16(26, nome.length, true);
    parti.push(new Uint8Array(h.buffer), nome, dati);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(14, 0x21, true);
    c.setUint32(16, crc, true); c.setUint32(20, n, true); c.setUint32(24, n, true); c.setUint16(28, nome.length, true); c.setUint32(42, off, true);
    centrale.push(new Uint8Array(c.buffer), nome);
    off += 30 + nome.length + n;
  }
  const lenC = centrale.reduce((t, x) => t + x.length, 0), e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, lenC, true); e.setUint32(16, off, true);
  return new Blob([...parti, ...centrale, new Uint8Array(e.buffer)], { type: tipo || 'application/zip' });
}
const xmlEsc = s => String(s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c])).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
const colonna = i => { let s = ''; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = (i - m - 1) / 26; } return s; };
const serialeData = iso => { const [y, m, d] = iso.split('-').map(Number); return (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000; };
/* celle: testo, numero, {e: euro}, {et: euro in grassetto}, {d: data}, {t: titolo in grassetto} */
function cellaXml(v, ref) {
  if (v == null || v === '') return '';
  const testo = (x, st) => `<c r="${ref}"${st ? ` s="${st}"` : ''} t="inlineStr"><is><t xml:space="preserve">${xmlEsc(x)}</t></is></c>`;
  if (typeof v === 'number') return isFinite(v) ? `<c r="${ref}"><v>${v}</v></c>` : '';
  if (typeof v === 'string') return testo(v);
  if ('e' in v) return v.e == null || isNaN(v.e) ? '' : `<c r="${ref}" s="1"><v>${r2(v.e)}</v></c>`;
  if ('et' in v) return v.et == null || isNaN(v.et) ? '' : `<c r="${ref}" s="4"><v>${r2(v.et)}</v></c>`;
  if ('d' in v) return v.d ? `<c r="${ref}" s="2"><v>${serialeData(v.d)}</v></c>` : '';
  if ('t' in v) return testo(v.t, 3);
  return '';
}
const STILI_XLSX = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<numFmts count="2"><numFmt numFmtId="164" formatCode="#,##0.00\\ &quot;€&quot;"/><numFmt numFmtId="165" formatCode="dd/mm/yyyy"/></numFmts>' +
  '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  '<xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/></cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
function creaXlsx(fogli) {
  const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main', NR = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships', TESTA = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const files = [
    { nome: '[Content_Types].xml', dati: `${TESTA}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${fogli.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>` },
    { nome: '_rels/.rels', dati: `${TESTA}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${NR}/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { nome: 'xl/workbook.xml', dati: `${TESTA}<workbook xmlns="${NS}" xmlns:r="${NR}"><sheets>${fogli.map((f, i) => `<sheet name="${xmlEsc(f.nome)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>` },
    { nome: 'xl/_rels/workbook.xml.rels', dati: `${TESTA}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${fogli.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${NR}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${fogli.length + 1}" Type="${NR}/styles" Target="styles.xml"/></Relationships>` },
    { nome: 'xl/styles.xml', dati: STILI_XLSX }
  ];
  fogli.forEach((f, i) => {
    const cols = f.larghezze ? `<cols>${f.larghezze.map((w, j) => `<col min="${j + 1}" max="${j + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` : '';
    const rows = f.righe.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => cellaXml(v, colonna(ci) + (ri + 1))).join('')}</row>`).join('');
    files.push({ nome: `xl/worksheets/sheet${i + 1}.xml`, dati: `${TESTA}<worksheet xmlns="${NS}">${cols}<sheetData>${rows}</sheetData></worksheet>` });
  });
  return creaZip(files, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
}
function fogliRiepilogo(mese) {
  const fogli = tuttiFogli(mese);
  return fogli.filter(f => (conFatture() || (f.nome !== 'Fatture' && f.nome !== 'IVA acquisti')) && (conPagamenti() || (f.nome !== nomeSpese())) && (conPagamenti() || conFatture() || f.nome !== 'Pagamenti'));
}
function tuttiFogli(mese) {
  const d = datiRiepilogo(mese), T = x => ({ t: x }), E = x => ({ e: x }), D = x => ({ d: x });
  const neg = settings().negozio;
  return [
    { nome: 'Riepilogo', larghezze: [38, 16], righe: [
      [T(`${neg} – ${nomeMese(mese)}`)], [],
      ['Incassi (dalla cassa)', E(d.totIncassi)], ['di cui frutta e verdura', E(d.totFrutta)],
      ...(conFatture() ? [['Fatture dei fornitori (totale)', E(d.totFatture)], ['Fatture: imponibile', E(d.imponibile)], ['Fatture: IVA', E(d.imposta)]] : []),
      ...(conPagamenti() ? [[nomeSpese(), E(d.totSpese)]] : []), ...(conPagamenti() || conFatture() ? [['Pagato nel mese', E(d.totPagati)], ['Ancora da pagare (scadenze del mese)', E(d.totDaPagare)]] : []),
      ['Venduto nell\'app (scansionato)', E(venditeMese(mese).totale)],
      ['Merce buttata (al costo)', E(d.totSprechi)], [],
      [d.mancano.length ? `Mancano le chiusure di ${d.mancano.length} giorni: vedi il foglio Incassi.` : ''],
      [`Preparato dall'app Magazzino il ${fmtDate(todayISO())}.`]] },
    { nome: 'Incassi', larghezze: [12, 16, 18, 22, 14, 34], righe: [
      ['Giorno', 'Incasso cassa', 'Frutta e verdura', 'Scansionato nell\'app', 'Differenza', 'Nota'].map(T),
      ...[...d.incassi.map(c => ({ data: c.data, c })), ...d.mancano.map(x => ({ data: x.data, x }))].sort((a, b) => a.data.localeCompare(b.data)).map(r => r.c
        ? [D(r.c.data), E(r.c.incasso), E(r.c.frutta), E(r.c.scansionato), E(r.c.differenza), '']
        : [D(r.x.data), '', '', E(r.x.scansionato), '', 'manca la chiusura: scrivi l\'incasso della cassa']),
      [T('Totale'), { et: d.totIncassi }, { et: d.totFrutta }]] },
    { nome: 'Fatture', larghezze: [12, 30, 16, 16, 16, 14, 14, 14, 14, 20], righe: [
      ['Data', 'Fornitore', 'Partita IVA', 'Numero', 'Tipo', 'Imponibile', 'IVA', 'Totale', 'Scadenza', 'Pagata il'].map(T),
      ...d.fatture.map(fa => { const sg = segnoFattura(fa), rp = fa.riepilogo || [], p0 = (fa.pagamenti || [])[0] || {};
        return [D(fa.data), nomeFornFattura(fa), fa.fornitore.piva || '', String(fa.numero), NOMI_TIPO[fa.tipo] || fa.tipo, E(rp.reduce((t, r) => t + (+r.imponibile || 0), 0) * sg), E(rp.reduce((t, r) => t + (+r.imposta || 0), 0) * sg), E(fa.totale * sg), D(p0.scadenza), D(p0.pagata)]; }),
      [T('Totale'), '', '', '', '', { et: d.imponibile }, { et: d.imposta }, { et: d.totFatture }]] },
    { nome: 'IVA acquisti', larghezze: [16, 16, 16], righe: [
      ['Aliquota', 'Imponibile', 'IVA'].map(T), ...d.iva.map(([k, e]) => [k, E(e.imponibile), E(e.imposta)]), [T('Totale'), { et: d.imponibile }, { et: d.imposta }]] },
    { nome: nomeSpese(), larghezze: [12, 30, 14, 12, 16, 16, 30], righe: [
      ['Scadenza', 'Spesa', 'Importo', 'Pagata il', 'Come', 'Si ripete', 'Note'].map(T),
      ...d.spese.map(sp => [D(sp.scadenza), sp.descrizione, E(sp.importo), D(sp.pagata), sp.modalita || '', nomeRipeti(sp.ripeti), sp.note || '']),
      [T('Totale'), '', { et: d.totSpese }]] },
    { nome: 'Pagamenti', larghezze: [12, 30, 26, 14, 12], righe: [
      ['Pagato il', 'A chi', 'Cosa', 'Importo', 'Scadenza'].map(T),
      ...d.pagati.map(x => [D(x.pagata), x.nome, x.k === 'f' ? 'fattura ' + x.fa.numero : 'spesa', E(x.importo), D(x.data)]),
      [T('Totale'), '', '', { et: d.totPagati }], [],
      [T('Ancora da pagare (scadenze del mese)')],
      ...d.daPagare.map(x => [D(x.data), x.nome, x.k === 'f' ? 'fattura ' + x.fa.numero : 'spesa', E(x.importo)])] },
    { nome: 'Categorie', larghezze: [30, 16, 22, 16, 12], righe: [
      ['Categoria', 'Venduto', 'Quantità', 'Margine', 'Margine %'].map(T),
      ...venditeMese(mese).lista.filter(e => e.imp).map(e => [e.nome, E(e.imp), qtaCat(e), E(r2(e.ricavo - e.costo)), e.perc != null ? e.perc : '']),
      [], ['Vendite scansionate al banco; margine sul prezzo senza IVA, con il prezzo d\'acquisto di oggi.']] },
    { nome: 'Merce buttata', larghezze: [12, 34, 14, 22, 14], righe: [
      ['Giorno', 'Prodotto', 'Quantità', 'Motivo', 'Valore (costo)'].map(T),
      ...d.sprechi.map(r => { const p = prodotto(r.prodottoId); return [D(r.data), p ? p.nome : '?', p && isSfuso(p) ? fmtSf(p, r.qta) : r.qta, r.motivo, E(valoreSpreco(r))]; }),
      [T('Totale'), '', '', '', { et: d.totSprechi }]] }
  ];
}
/* un file da mettere su Drive o aprire con Excel: si condivide se il telefono lo permette, altrimenti va nei Download */
async function mandaFile(blob, nome, titolo) {
  const file = new File([blob], nome, { type: blob.type });
  let ok = false;
  try { ok = !!(navigator.canShare && navigator.canShare({ files: [file] })); } catch (e) { }
  if (ok) {
    try { await navigator.share({ files: [file], title: titolo }); return 'condiviso'; }
    catch (e) { if (e && e.name === 'AbortError') return 'annullato'; }
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = nome;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  return 'scaricato';
}
async function riepilogoExcel(mese) {
  const blob = creaXlsx(fogliRiepilogo(mese));
  const nome = `riepilogo-${mese}-${settings().negozio.replace(/[^A-Za-z0-9]+/g, '-')}.xlsx`;
  const r = await mandaFile(blob, nome, 'Riepilogo ' + nomeMese(mese));
  if (r === 'scaricato') openModal(`${mhead('Excel salvato nei Download')}
    <p>Il file <b>${esc(nome)}</b> è nella cartella <b>Download</b>.</p>
    <p class="muted small">Si apre con Excel o Fogli Google. Per metterlo su Drive: app <b>Drive</b> → account del negozio → <b>+</b> → <b>Carica</b> → Download → il file.</p>
    <button class="btn primary block" type="button" data-act="close-modal">Ho capito</button>`);
  else if (r === 'annullato') toast('Excel non salvato', { err: true });
}

/* =========================================================
   STORICO DI CASSA: gli incassi giorno per giorno, da correggere o cancellare (per esempio le prove)
   ========================================================= */
const GIORNI_SETT = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];
const nomeGiorno = iso => { const d = isoToDate(iso), s = GIORNI_SETT[d.getDay()]; return `${s[0].toUpperCase() + s.slice(1)} ${d.getDate()} ${MESI[d.getMonth()]}`; };
const scansionatoDel = data => r2(venditeDel(data).reduce((t, v) => t + (importo(v) || 0), 0));
routes.cassa = arg => {
  const oggiM = todayISO().slice(0, 7), mese = /^\d{4}-\d{2}$/.test(arg || '') && arg <= oggiM ? arg : oggiM;
  const giorni = new Set([...S.chiusure.values()].filter(c => (c.data || '').slice(0, 7) === mese).map(c => c.data));
  for (const v of S.vendite.values()) if ((v.data || '').slice(0, 7) === mese) giorni.add(v.data);
  const lista = [...giorni].sort().reverse(), chiuse = lista.map(d => S.chiusure.get('c' + d)).filter(Boolean);
  const tot = r2(chiuse.reduce((t, c) => t + (+c.incasso || 0), 0));
  let html = `<div class="mese-nav"><a class="btn small" href="#cassa/${meseVicino(mese, -1)}" aria-label="Mese prima">‹</a><h2>${nomeMese(mese)}</h2>${mese < oggiM ? `<a class="btn small" href="#cassa/${meseVicino(mese, 1)}" aria-label="Mese dopo">›</a>` : '<span class="btn small" style="visibility:hidden">›</span>'}</div>
    <div class="stats" style="grid-template-columns:1fr 1fr"><div class="stat green"><b class="euro">${fmtEuro(tot)}</b><span>Incassi del mese</span></div>
      <div class="stat"><b class="euro">${chiuse.length ? fmtEuro(r2(tot / chiuse.length)) : '–'}</b><span>Media al giorno · ${chiuse.length} ${chiuse.length === 1 ? 'giorno' : 'giorni'}</span></div></div>
    <button class="btn block" type="button" data-act="cassa-nuova" data-m="${mese}">+ Scrivi l'incasso di un giorno</button>`;
  html += lista.length ? `<div class="list">${lista.map(d => {
    const c = S.chiusure.get('c' + d), sc = scansionatoDel(d);
    const sotto = c ? [c.frutta ? 'frutta e verdura ' + fmtEuro(c.frutta) : '', sc ? 'scansionato ' + fmtEuro(sc) : ''].filter(Boolean).join(' · ') : `manca la chiusura · scansionati ${fmtEuro(sc)}`;
    return `<button class="item" type="button" data-act="cassa-mod" data-d="${d}"><div class="main"><div class="name">${nomeGiorno(d)}</div><div class="sub ${c ? '' : 'arancio'}">${sotto}</div></div><span class="prezzo">${c ? fmtEuro(c.incasso) : '–'}</span><span class="chev">›</span></button>`;
  }).join('')}</div>` : '<div class="empty">Nessun incasso in questo mese.</div>';
  html += `<div class="faint small" style="text-align:center">Tocca un giorno per correggere l'incasso o cancellarlo, per esempio una prova.</div>`;
  const vm = [...S.vendite.values()].filter(v => (v.data || '').slice(0, 7) === mese);
  if (vm.length) html += `<button class="btn ghost block" type="button" data-act="vendite-prova" data-m="${mese}">Erano prove: cancella tutte le vendite scansionate di ${nomeMese(mese).toLowerCase()} (${vm.length})</button>`;
  return { title: 'Storico di cassa', html, back: '#cruscotto', tab: 'banco' };
};
/* vendite di prova (scansioni fatte per provare): si cancellano rimettendo in magazzino quello che avevano tolto */
async function cancellaVendite(lista, quando) {
  if (!lista.length) return;
  const tot = r2(lista.reduce((t, v) => t + (importo(v) || 0), 0));
  if (!(await confirmBox(`Cancello ${lista.length === 1 ? 'la vendita' : 'le ' + lista.length + ' vendite'} ${quando} (${fmtEuro(tot)})? Usale solo se erano prove: i pezzi tornano in magazzino e non contano più nel cruscotto.`, { ok: 'Cancella', danger: true, title: 'Vendite di prova' }))) return;
  for (const v of [...lista].sort((a, b) => b.creato - a.creato)) await annullaRiga(v.id, { silenzioso: true });
  render();
  setTimeout(() => toast(`${lista.length === 1 ? 'Cancellata 1 vendita' : 'Cancellate ' + lista.length + ' vendite'}: si può annullare con la freccia in alto`, { ms: 5000 }), 120);
}
function cassaModal(data, mese) {
  const c = data ? S.chiusure.get('c' + data) : null, oggi = todayISO();
  const proposta = mese && mese < oggi.slice(0, 7) ? `${mese}-01` : oggi;
  openModal(`${mhead(data ? nomeGiorno(data) : 'Incasso di un giorno')}
    ${data ? '' : `<label class="field">Giorno<input type="date" id="caData" max="${oggi}" value="${proposta}"></label>`}
    <label class="field">Incasso totale €<input type="text" inputmode="decimal" id="caInc" value="${c ? fmtImporto(c.incasso) : ''}" autocomplete="off" placeholder="es. 612,40"></label>
    <label class="field">Di cui frutta e verdura € <span class="hint">se la cassa non lo separa, lascia vuoto</span><input type="text" inputmode="decimal" id="caFr" value="${c && c.frutta != null ? fmtImporto(c.frutta) : ''}" autocomplete="off"></label>
    ${data ? `<div class="faint small">Scansionato nell'app quel giorno: ${fmtEuro(scansionatoDel(data))}${venditeDel(data).length ? ` (${venditeDel(data).length} ${venditeDel(data).length === 1 ? 'vendita' : 'vendite'})` : ''}</div>` : ''}
    <button class="btn primary block" type="button" data-x="ok">Salva</button>
    ${c ? `<button class="btn danger block" type="button" data-x="del">Cancella l'incasso di questo giorno</button>` : ''}
    ${data && venditeDel(data).length ? `<button class="btn ghost block" type="button" data-x="vend">Erano prove: cancella le vendite scansionate</button>` : ''}`, b => {
    const vb = b.querySelector('[data-x=vend]');
    if (vb) vb.onclick = async () => { const l = venditeDel(data); closeModal(); await cancellaVendite(l, `del ${fmtDate(data)}`); };
    b.querySelector('[data-x=ok]').onclick = async () => {
      const d = data || b.querySelector('#caData').value;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || d > oggi) { toast('Scegli un giorno, al massimo oggi', { err: true }); return; }
      const inc = parseNum(b.querySelector('#caInc').value), fr = parseNum(b.querySelector('#caFr').value);
      if (inc == null || inc < 0) { toast('Scrivi l\'incasso della cassa', { err: true }); return; }
      const prima = S.chiusure.get('c' + d), sc = scansionatoDel(d);
      await save('chiusure', { ...(prima || {}), id: 'c' + d, data: d, incasso: r2(inc), frutta: fr == null ? null : r2(fr), scansionato: sc, differenza: r2(sc - (inc - (fr || 0))), creato: prima ? prima.creato : Date.now(), modificato: Date.now() });
      CH = null; closeModal(); render();
      setTimeout(() => toast(`Incasso del ${fmtDate(d)} salvato`), 120);
    };
    const del = b.querySelector('[data-x=del]');
    if (del) del.onclick = async () => {
      const prima = { ...c };
      await remove('chiusure', c.id); CH = null; closeModal(); render();
      setTimeout(() => toast(`Incasso del ${fmtDate(data)} cancellato`, { action: { label: 'Annulla', run: async () => { await save('chiusure', prima); CH = null; render(); } } }), 120);
    };
  });
}

/* =========================================================
   CATEGORIE: cosa si vende di più e di meno, con i grafici
   - la categoria è un campo libero del prodotto; c'è un elenco di base
   - "Proponi dal nome" la scrive per i prodotti che non ce l'hanno (si può annullare)
   ========================================================= */
const CATEGORIE_BASE = ['Frutta e verdura', 'Pasta', 'Riso e cereali', 'Farine, lieviti e preparati', 'Legumi', 'Frutta secca e semi',
  'Pane, crackers e snack salati', 'Biscotti e dolci', 'Cioccolato e caramelle', 'Miele, confetture e creme', 'Latte, formaggi e uova',
  'Salumi e carne', 'Pesce', 'Gastronomia e pasta fresca', 'Sughi, conserve e sottoli', 'Olio, aceto e condimenti', 'Spezie, sale e brodi',
  'Caffè, tè e tisane', 'Bevande e succhi', 'Vino, birra e liquori', 'Zucchero e dolcificanti', 'Detersivi e casa', 'Cura della persona', 'Altro'];
const SENZA_CAT = 'Senza categoria';
const catDi = p => (p && p.categoria || '').trim();
const categorieUsate = () => [...new Set([...CATEGORIE_BASE, ...[...S.prodotti.values()].map(catDi).filter(Boolean)])].sort((a, b) => a.localeCompare(b, 'it'));
/* per i prodotti nuovi: la categoria dal nome. L'ordine conta: «farina di ceci» è una farina, «latte di avena» una bevanda */
const [C_FV, C_PA, C_RI, C_FA, C_LE, C_FS, C_PN, C_BD, C_CC, C_MI, C_LA, C_SA, C_PE, C_GA, C_SU, C_OL, C_SP, C_CT, C_BE, C_VI, C_ZU, C_DE, C_CU] = CATEGORIE_BASE;
const REGOLE_CAT = [
  [C_CU, /\b(dentifric|shampoo|shampo|bagnodoccia|bagnoschiuma|balsamo (labbra|solido|capelli)|deo\b|deodorant|crema (viso|corpo|mani)|bb cream|sapone|saponett|struccant|collutorio|colluttorio)/],
  [C_DE, /\b(detersiv|detergent|ammorbident|bucato|lavatrice|lavastoviglie|stoviglie|sgrass|anticalcare|candeggin|percarbonat|acido citrico|bicarbonato|pavimenti|vetri|igieniz|carta igienica|pannocarta|tovaglio|sacchett|shopper|spugn)/],
  [C_VI, /\b(vino|rosso conero|verdicchio|prosecco|moscato|igt|doc|docg|(?<!lievito di )birra|liquore|grappa|spumante|gin)\b/],
  [C_CT, /\b(caffe|espresso|cialde|capsule|chicchi|miscela|orzo (solubile|anice|classico)|te verde|te nero|tisan|infuso|camomilla|rooibos|matcha|earl grey|bancha|sencha|chai)/],
  [C_CC, /\b(cioccolat|tavolett|cacao|caramell|liquirizi|gianduiott|praline|cremino|uovo di pasqua)/],
  [C_MI, /\b(miele|millefiori|composta|confettur|marmellat|crema (di |nocciol|pistacch|mandorl|arachid)|spalmabil|nocciolata|polline|propoli|pappa reale|burro di (arachidi|mandorl|nocciol))/],
  [C_PE, /\b(tonno|acciugh|alici|sgombro|salmone|baccala|trota|branzino|orata|sardin|pesce|merluzz|polpo|gamber|cozze|vongol|bottarga|insalata di mare)/],
  [C_SA, /\b(prosciutt|salam(?!oia)|salsicc|ciauscol|bresaola|speck|mortadell|porchetta|coppa|lonza|guanciale|pancett|lardo|wurstel|tacchino|pollo|manzo|vitell|maiale|suino|agnello|coniglio|hamburger|scottona|arista|spezzatino|roastbeef|carne|cotechino|zampone|nduja)/],
  [C_BE, /\blatte (di |d )?(avena|soia|riso|mandorl|cocco|nocciol|farro|anacard)/],
  [C_LA, /\b(latte|yogurt|yoghurt|kefir|formagg|caciott|mozzarell|ricott|burro|panna|stracchin|parmigian|pecorin|grana|robiola|tomino|primo sale|scamorz|provola|fontina|asiago|gorgonzola|taleggio|stracciatell|bocconcin|uova|uovo|feta|mascarpone|emmental|camembert)/],
  [C_GA, /\b(lasagn(?!e senza uova)|tortellin|raviol|gnocchi di patate|insalata russa|piatti pronti|polpett|crocchett|arancin|frittat|parmigiana|pulled|torta salata|sformat|olive ascolane|burger)/],
  [C_SU, /\b(passata|pelati|polpa di pomodoro|sugo|sughi|pesto|ragu|conserv|sottolio|sott olio|in olio|carciof|olive|capperi|giardiniera|semiconcentrato|cipolline|borettane|caponata|pate|zuppa|vellutat|minestron|hummus|humus|funghi secchi|porcini secchi|pomodori secchi|pomodori essiccati)/],
  [C_OL, /\b(olio|aceto|balsamic|salsa di soia|tamari|shoyu|senape|maionese|ketchup|condiment|gomasio|miso\b|aglio nero)/],
  [C_SP, /\b(sale\b|spezi|pepe\b|curcuma|paprika|cannella|zenzero|origano|rosmarino|timo\b|curry|noce moscata|chiodi di garofano|cumino|peperoncino|erbe\b|vaniglia|alloro|anice stellato|coriandolo|zafferano|brodo|dado\b|lievito alimentare|ginepro)/],
  [C_ZU, /\b(zucchero|dolcificant|stevia|eritritolo|sciroppo d agave|sciroppo d acero|malto|panela|fruttosio|xilitolo)/],
  [C_BE, /\b(succo|succhi|bevanda|drink|acqua (natur|frizz|di cocco)|kombucha|spremut|nettare|aranciata|limonata|chinotto|gassosa|sciroppo)/],
  [C_FA, /\b(farina|semola|amido|fecola|lievit|crusca|preparato|mix (per|pane|pizza|dolci)|pasta madre|colorante|pan di spagna|frolla)/],
  [C_PA, /\b(pasta|spaghett|penne|fusill|maccheron|rigaton|tagliatell|fettuccin|lasagne|linguin|farfall|orecchiett|gnocchett|vermicell|ditalin|mezze maniche|paccher|trofie|strozzapret|bucatin|sedanin|conchigli|tagliolin|pappardell|casarecc|mafald|stellin|calamarata|maltagliati|filini|cannelloni|tortiglion|anellini|risoni|grano duro)/],
  [C_BD, /\b(biscott|cantucci|torta|crostat|plumcake|frollin|amaretti|torrone|panettone|pandoro|colomba|wafer|merendin|macarons|pasticcin|muffin|ciambell|savoiardi|tozzetti|maritozz|dolc)/],
  [C_PN, /\b(pane|panin|focacc|piadin|cracker|gallett|grissin|taralli|fette biscottate|pizzett|chips|patatin|snack|bretzel|frisell|crostin|schiacciat|sfoglie)/],
  [C_RI, /\b(riso|carnaroli|arborio|basmati|venere|quinoa|miglio|grano saraceno|orzo|farro|avena|fiocchi|muesli|granola|amaranto|sorgo|polenta|mais|corn ?flakes|cereali|teff|kamut|segale|couscous|cous cous|bulgur)/],
  [C_LE, /\b(ceci|lenticch|fagiol|piselli|lupin|soia|cicerchi|fave|azuki|edamame|legumi|borlotti|cannellini)/],
  [C_FS, /\b(mandorl|noci|noce|gherigli|nocciol|anacard|pistacch|arachid|pinoli|semi|uvetta|uva sultanina|datter|fichi secchi|albicocche secche|prugne secche|goji|cranberry|frutta secca|disidratat|essiccat|cocco|candit|granella)/],
  [C_FV, /\b(mele|mela|pere|pera|banan|aranc|limon|mandarin|clementin|kiwi|patate|batata|zucchin|carot|insalat|lattuga|cipoll|aglio|melanzan|peperon|spinac|cavol|broccol|finocch|sedan|verdur|frutta|albicocch|ananas|anguria|avocado|bieta|cetriol|ciliegi|fragol|lampon|mirtill|pesche|pesca|prugne|susin|uva|melone|cocomer|pomodor|radicchi|rucola|scarola|zucca|zucche|funghi|asparag|porri|rape|ravanell|fagiolini|melograno|cachi|castagne|cicoria|basilico|prezzemolo)/],
];
/* menu a tendina delle categorie, con «Scrivine un'altra…» per una categoria nuova */
function campoCategoria(id, valore) {
  const v = (valore || '').trim(), lista = categorieUsate();
  return `<select id="${id}Sel" data-cat-sel="${id}"><option value="">— nessuna —</option>${lista.map(c => `<option value="${esc(c)}" ${c === v ? 'selected' : ''}>${esc(c)}</option>`).join('')}<option value="__altra">✎ Scrivine un'altra…</option></select>
    <input type="text" id="${id}" value="" placeholder="scrivi la categoria nuova" autocomplete="off" hidden>`;
}
const categoriaScelta = (root, id) => { const sel = root.querySelector('#' + id + 'Sel'); if (!sel) return null; return sel.value === '__altra' ? root.querySelector('#' + id).value.replace(/\s+/g, ' ').trim() : sel.value; };
document.addEventListener('change', e => {
  const sel = e.target.closest('[data-cat-sel]'); if (!sel) return;
  const inp = document.getElementById(sel.dataset.catSel); if (!inp) return;
  inp.hidden = sel.value !== '__altra';
  if (!inp.hidden) setTimeout(() => inp.focus(), 30);
}, true);
function categoriaDalNome(nome) { const n = norm(nome); for (const [c, re] of REGOLE_CAT) if (re.test(n)) return c; return ''; }
/* le categorie preparate per il catalogo iniziale (file categorie_catalogo.js): si scrivono una volta sola,
   solo nei prodotti che non ne hanno una o che hanno ancora l'appunto del listino in quel campo */
const impronta = s => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16); };
async function categorieDalCatalogo() {
  const cc = window.CATEGORIE_CATALOGO;
  if (!cc || !S.prodotti.size || (S.meta.categorieCatalogo || 0) >= cc.versione) return 0;
  const nuovi = [];
  for (const riga of cc.prodotti.split(';')) {
    const [id, i, h] = riga.split(','), p = S.prodotti.get(id), c = cc.nomi[+i];
    if (!p || !c || catDi(p) === c) continue;
    if (catDi(p) && !(h && impronta(norm(p.categoria)) === h)) continue;    // scritta in negozio: resta
    // l'appunto del listino che stava nel campo categoria non si perde: va nelle note
    const vecchio = catDi(p), nota = vecchio && !(p.note || '').includes(vecchio) ? [p.note, 'Dal listino: ' + vecchio].filter(Boolean).join(' · ') : p.note;
    nuovi.push({ ...p, categoria: c, note: nota });
  }
  if (nuovi.length) await saveMany('prodotti', nuovi);
  await setMeta('categorieCatalogo', cc.versione);
  return nuovi.length;
}
function proponiCategorie() {
  const prop = [...S.prodotti.values()].filter(p => !catDi(p)).map(p => [p, categoriaDalNome(p.nome)]);
  const si = prop.filter(x => x[1]), conta = new Map();
  for (const [, c] of si) conta.set(c, (conta.get(c) || 0) + 1);
  if (!prop.length) { toast('Tutti i prodotti hanno già una categoria'); return; }
  openModal(`${mhead('Categorie dal nome')}
    <p style="margin:0">Riconosco la categoria di <b>${si.length}</b> prodotti su ${prop.length} senza categoria.</p>
    ${si.length ? `<div class="list">${[...conta.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) => `<div class="item"><div class="main"><div class="name">${esc(c)}</div></div><b>${n}</b></div>`).join('')}</div>` : ''}
    <p class="muted small" style="margin:0">Quelli che non riconosco restano «${SENZA_CAT}»: si sistemano dal Catalogo (Seleziona → Categoria) o nella scheda del prodotto. Le categorie già scritte non cambiano.</p>
    ${si.length ? `<button class="btn primary block" type="button" data-x="ok">Scrivi le categorie (${si.length})</button>` : ''}
    <button class="btn block" type="button" data-act="close-modal">${si.length ? 'Non ora' : 'Chiudi'}</button>`, b => {
    const ok = b.querySelector('[data-x=ok]');
    if (ok) ok.onclick = async () => {
      const prima = si.map(([p]) => ({ ...p }));
      await saveMany('prodotti', si.map(([p, c]) => ({ ...p, categoria: c })));
      closeModal(); render();
      setTimeout(() => toast(`Categoria scritta per ${si.length} prodotti`, { action: { label: 'Annulla', run: async () => { await saveMany('prodotti', prima.map(p => ({ ...S.prodotti.get(p.id) || p, categoria: '' }))); render(); } } }), 120);
    };
  });
}
function categoriaModal(ids) {
  openModal(`${mhead('Categoria')}
    <p class="muted small" style="margin:0">${ids.length === 1 ? '1 prodotto scelto' : ids.length + ' prodotti scelti'}.</p>
    <label class="field">Categoria${campoCategoria('cgNome', '')}</label>
    <button class="btn primary block" type="button" data-x="ok">Salva</button>`, b => {
    b.querySelector('[data-x=ok]').onclick = async () => {
      const c = categoriaScelta(b, 'cgNome');
      const prima = ids.map(id => S.prodotti.get(id)).filter(Boolean).map(p => ({ ...p }));
      await saveMany('prodotti', prima.map(p => ({ ...p, categoria: c })));
      CAT.sel = null; closeModal(); render();
      setTimeout(() => toast(`${c || SENZA_CAT}: ${prima.length === 1 ? '1 prodotto' : prima.length + ' prodotti'}`, { action: { label: 'Annulla', run: async () => { await saveMany('prodotti', prima.map(p => ({ ...(S.prodotti.get(p.id) || p), categoria: p.categoria || '' }))); render(); } } }), 120);
    };
  });
}
/* vendite di un periodo raggruppate per categoria e per prodotto */
function venditeCategorie(f) {
  const [da, a] = Array.isArray(f) ? f : periodo(f), per = new Map(), nuova = () => ({ imp: 0, ricavo: 0, costo: 0, pz: 0, kg: 0, l: 0, prodotti: new Map(), merce: 0, sprechi: 0 });
  const voce = c => { if (!per.has(c)) per.set(c, nuova()); return per.get(c); };
  let totale = 0;
  for (const v of S.vendite.values()) {
    if (!v.prodottoId || v.data < da || v.data > a) continue;
    const imp = importo(v); if (imp == null) continue;
    const p = prodotto(v.prodottoId), e = voce(p ? catDi(p) || SENZA_CAT : ELIMINATI), q = v.qta * segnoVendita(v);
    e.imp += imp; totale += imp;
    if (p ? !isSfuso(p) : !v.sfuso) e.pz += q; else if (p && inLitri(p)) e.l += q; else e.kg += q;
    if (p && p.prezzoAcquisto != null && p.iva != null) { e.ricavo += imp / (1 + p.iva / 100); e.costo += p.prezzoAcquisto * q; }
    const x = e.prodotti.get(v.prodottoId) || { imp: 0, qta: 0, v }; x.imp += imp; x.qta += q; e.prodotti.set(v.prodottoId, x);
  }
  for (const l of lottiAttivi()) { const p = prodotto(l.prodottoId); if (p && p.prezzoAcquisto != null && l.quantita > 0) voce(catDi(p) || SENZA_CAT).merce += p.prezzoAcquisto * l.quantita; }
  for (const r of S.sprechi.values()) if (r.data >= da && r.data <= a && perso(r)) voce(prodotto(r.prodottoId) ? catDi(prodotto(r.prodottoId)) || SENZA_CAT : ELIMINATI).sprechi += valoreSpreco(r) || 0;
  const lista = [...per.entries()].map(([nome, e]) => ({ nome, ...e, imp: r2(e.imp), perc: e.ricavo > 0 ? Math.round((e.ricavo - e.costo) / e.ricavo * 1000) / 10 : null, quota: totale ? e.imp / totale * 100 : 0 }))
    .sort((x, y) => y.imp - x.imp || y.merce - x.merce);
  return { da, a, lista, totale: r2(totale) };
}
const venditeMese = mese => venditeCategorie([`${mese}-01`, `${mese}-31`]);
/* vendite di prodotti che non sono più nel catalogo (di solito prove) */
const venditeEliminati = (da, a) => [...S.vendite.values()].filter(v => v.prodottoId && !S.prodotti.has(v.prodottoId) && v.data >= da && v.data <= a);
const qtaCat = e => [e.pz ? `${fmtNum(r3(e.pz))} pz` : '', e.kg ? fmtKg(e.kg) : '', e.l ? fmtLitri(e.l) : ''].filter(Boolean).join(' + ');
/* barre orizzontali: una riga per voce (nome e valore sopra, barra sotto), dal più al meno */
function barreHTML(voci, max) {
  return `<div class="list barre">${voci.map(v => `<a class="item hbar" href="${v.href}"><div class="main"><div class="hb-testa"><span class="name">${esc(v.nome)}</span><b>${fmtEuro(v.valore)}</b></div>
    <div class="hb-traccia" aria-hidden="true"><i style="width:${max > 0 ? Math.max(v.valore > 0 ? 1.5 : 0, v.valore / max * 100).toFixed(1) : 0}%"></i></div>
    ${v.sotto ? `<div class="sub">${v.sotto}</div>` : ''}</div><span class="chev">›</span></a>`).join('')}</div>`;
}
/* andamento nel tempo: colonne (un giorno o un mese ciascuna), una serie alla volta */
let VC = { periodo: 'mese', serie: 'cassa' };
function puntiAndamento(f, serie) {
  const [da, a] = periodo(f), mesi = f === 'anno';
  const chiave = d => mesi ? d.slice(0, 7) : d, punti = new Map();
  if (mesi) { const [y, m] = a.split('-').map(Number); for (let i = 11; i >= 0; i--) { const x = new Date(y, m - 1 - i, 1); punti.set(`${x.getFullYear()}-${pad(x.getMonth() + 1)}`, 0); } }
  else { for (let d = isoToDate(da); todayISO(d) <= a; d.setDate(d.getDate() + 1)) punti.set(todayISO(d), 0); }
  if (serie === 'cassa') { for (const c of S.chiusure.values()) if (c.data >= da && c.data <= a && punti.has(chiave(c.data))) punti.set(chiave(c.data), punti.get(chiave(c.data)) + (+c.incasso || 0)); }
  else for (const v of S.vendite.values()) if (v.data >= da && v.data <= a && punti.has(chiave(v.data))) { const imp = importo(v); if (imp != null) punti.set(chiave(v.data), punti.get(chiave(v.data)) + imp); }
  return { mesi, punti: [...punti.entries()].map(([k, val]) => ({ k, val: r2(val) })) };
}
function colonneSVG({ mesi, punti }) {
  const W = 340, H = 170, L = 44, B = 22, T = 8, n = punti.length, max = Math.max(...punti.map(p => p.val), 0);
  if (!max) return '<div class="empty" style="padding:18px">Niente da mostrare in questo periodo.</div>';
  const mag = 10 ** Math.floor(Math.log10(max)), top = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map(x => x * mag).find(x => x >= max - 1e-9);
  const y = v => T + (H - T - B) * (1 - v / top);
  const larg = (W - L) / n, bw = Math.max(2, larg - 2);
  const etichetta = p => mesi ? MESI[+p.k.slice(5) - 1].slice(0, 3) : String(+p.k.slice(8));
  const ogni = mesi ? 1 : n > 20 ? 5 : n > 10 ? 2 : 1;
  let g = '';
  for (const v of [0, top / 2, top]) g += `<line x1="${L}" x2="${W}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" class="ch-grid"/><text x="${L - 6}" y="${(y(v) + 3.5).toFixed(1)}" class="ch-asse" text-anchor="end">${v >= 1000 ? fmtNum(Math.round(v / 100) / 10) + 'k' : Math.round(v)}</text>`;
  punti.forEach((p, i) => {
    const x = L + i * larg + 1, h = y(0) - y(p.val), r = Math.min(4, bw / 2, h);
    if (p.val > 0) g += `<path class="ch-bar" data-i="${i}" d="M${x.toFixed(1)},${y(0).toFixed(1)} v${(-h + r).toFixed(1)} q0,${(-r).toFixed(1)} ${r.toFixed(1)},${(-r).toFixed(1)} h${(bw - 2 * r).toFixed(1)} q${r.toFixed(1)},0 ${r.toFixed(1)},${r.toFixed(1)} v${(h - r).toFixed(1)} z"/>`;
    g += `<rect class="ch-hit" data-i="${i}" x="${(L + i * larg).toFixed(1)}" y="${T}" width="${larg.toFixed(1)}" height="${H - T}"><title>${esc(nomePunto(p, mesi))}: ${fmtEuro(p.val)}</title></rect>`;
    if (i % ogni === 0 || i === n - 1 && !mesi && (n - 1) % ogni > ogni / 2) g += `<text x="${(L + i * larg + larg / 2).toFixed(1)}" y="${H - 6}" class="ch-asse" text-anchor="middle">${etichetta(p)}</text>`;
  });
  return `<svg class="grafico" viewBox="0 0 ${W} ${H}" role="img" aria-label="Andamento">${g}</svg>`;
}
const nomePunto = (p, mesi) => mesi ? nomeMese(p.k) : nomeGiorno(p.k);
routes.categorie = () => {
  const d = venditeCategorie(VC.periodo), senza = [...S.prodotti.values()].filter(p => !catDi(p)).length;
  const and = puntiAndamento(VC.periodo, VC.serie), totA = r2(and.punti.reduce((t, p) => t + p.val, 0));
  const conV = and.punti.filter(p => p.val > 0), media = conV.length ? r2(totA / conV.length) : 0;
  const migliore = conV.reduce((m, p) => !m || p.val > m.val ? p : m, null);
  let html = `<div class="chips">${PERIODI_CRU.map(([k, l]) => `<button class="chip ${VC.periodo === k ? 'on' : ''}" type="button" data-act="vc-periodo" data-f="${k}">${l}</button>`).join('')}</div>`;
  html += `<div class="card"><div class="row"><h3 class="spacer" style="margin:0">Andamento</h3>
      <div class="segmented mini"><button type="button" class="${VC.serie === 'cassa' ? 'on' : ''}" data-act="vc-serie" data-s="cassa">Cassa</button><button type="button" class="${VC.serie === 'app' ? 'on' : ''}" data-act="vc-serie" data-s="app">Scansionato</button></div></div>
      <div class="faint small" id="vcInfo">${VC.serie === 'cassa' ? 'Incassi dalle chiusure di cassa' : 'Vendite scansionate nell\'app'}, ${and.mesi ? 'mese per mese' : 'giorno per giorno'}. Tocca una colonna.</div>
      ${colonneSVG(and)}
      <dl class="kv"><dt>Totale</dt><dd>${fmtEuro(totA)}</dd><dt>Media ${and.mesi ? 'al mese' : 'al giorno'}</dt><dd>${conV.length ? fmtEuro(media) : '–'}</dd>${migliore ? `<dt>${and.mesi ? 'Mese migliore' : 'Giorno migliore'}</dt><dd>${esc(nomePunto(migliore, and.mesi))}: ${fmtEuro(migliore.val)}</dd>` : ''}</dl></div>`;
  if (senza) html += `<div class="notice"><span class="spacer"><b>${senza}</b> ${senza === 1 ? 'prodotto è' : 'prodotti sono'} senza categoria.</span><button class="btn small" type="button" data-act="cat-proponi">Proponi dal nome</button></div>`;
  html += `<div class="section-title"><h2>Per categoria</h2><span class="count">${fmtEuro(d.totale)}</span></div>`;
  html += d.lista.length ? barreHTML(d.lista.map(e => ({
    nome: e.nome, valore: e.imp, href: '#categoria/' + encodeURIComponent(e.nome),
    sotto: e.imp ? [qtaCat(e), Math.round(e.quota) + '% del venduto', e.perc != null ? 'margine ' + fmtNum(e.perc) + '%' : ''].filter(Boolean).join(' · ') : `nessuna vendita · in negozio ${fmtEuro(r2(e.merce))} di merce`
  })), d.lista[0].imp) : '<div class="empty">Nessuna vendita scansionata in questo periodo.</div>';
  html += `<div class="faint small">Dalla più venduta alla meno venduta. Contano le vendite scansionate al banco (frutta e verdura no). Tocca una categoria per vedere i suoi prodotti.</div>`;
  return {
    title: 'Vendite e grafici', html, back: '#cruscotto', tab: 'home',
    mount: b => {
      const svg = b.querySelector('svg.grafico'), info = b.querySelector('#vcInfo'); if (!svg) return;
      svg.addEventListener('click', e => {
        const r = e.target.closest('[data-i]'); if (!r) return;
        const p = and.punti[+r.dataset.i];
        svg.querySelectorAll('.ch-bar.on').forEach(x => x.classList.remove('on'));
        const bar = svg.querySelector(`.ch-bar[data-i="${r.dataset.i}"]`); if (bar) bar.classList.add('on');
        info.innerHTML = `<b>${esc(nomePunto(p, and.mesi))}</b>: ${fmtEuro(p.val)}`;
      });
    }
  };
};
routes.categoria = arg => {
  const nome = arg || SENZA_CAT, d = venditeCategorie(VC.periodo), e = d.lista.find(x => x.nome === nome);
  if (nome === ELIMINATI) {
    const [da, a] = periodo(VC.periodo), voci = e ? [...e.prodotti.values()].filter(x => x.imp > 0).sort((x, y) => y.imp - x.imp) : [], tutte = venditeEliminati(da, a);
    let html = `<div class="chips">${PERIODI_CRU.map(([k, l]) => `<button class="chip ${VC.periodo === k ? 'on' : ''}" type="button" data-act="vc-periodo" data-f="${k}">${l}</button>`).join('')}</div>
      <div class="notice"><span>Vendite scansionate di prodotti che poi sono stati eliminati dal catalogo. Di solito sono prove: se è così, cancellale.</span></div>`;
    html += voci.length ? `<div class="list">${voci.map(x => `<div class="item"><div class="main"><div class="name">${esc(nomeVendita(x.v))}</div><div class="sub">${x.v.sfuso ? fmtKg(r3(x.qta)) : fmtNum(r3(x.qta)) + ' pz'}</div></div><span class="prezzo">${fmtEuro(r2(x.imp))}</span></div>`).join('')}</div>` : '<div class="empty">Nessuna vendita in questo periodo.</div>';
    if (tutte.length) html += `<button class="btn danger block" type="button" data-act="elim-prove" data-f="${VC.periodo}">Erano prove: cancellale (${tutte.length})</button>`;
    return { title: nome, html, back: '#categorie', tab: 'home' };
  }
  const prodotti = [...S.prodotti.values()].filter(p => (catDi(p) || SENZA_CAT) === nome);
  const venduti = e ? [...e.prodotti.entries()].map(([pid, x]) => ({ p: prodotto(pid), ...x })).filter(x => x.p && x.imp > 0).sort((a, b) => b.imp - a.imp) : [];
  const conVendite = new Set(venduti.map(x => x.p.id));
  const fermi = prodotti.filter(p => !conVendite.has(p.id) && giacenza(p.id) > 0).map(p => ({ p, g: giacenza(p.id), val: (p.prezzoAcquisto || 0) * giacenza(p.id) })).sort((a, b) => b.val - a.val);
  let html = `<div class="chips">${PERIODI_CRU.map(([k, l]) => `<button class="chip ${VC.periodo === k ? 'on' : ''}" type="button" data-act="vc-periodo" data-f="${k}">${l}</button>`).join('')}</div>
    <div class="stats" style="grid-template-columns:1fr 1fr"><div class="stat green"><b class="euro">${fmtEuro(e ? e.imp : 0)}</b><span>Venduto · ${e ? Math.round(e.quota) : 0}% del totale</span></div>
      <div class="stat"><b class="euro">${e && e.perc != null ? fmtNum(e.perc) + '%' : '–'}</b><span>Margine</span></div></div>`;
  html += `<div class="section-title"><h2>I più venduti</h2><span class="count">${venduti.length}</span></div>`;
  html += venduti.length ? barreHTML(venduti.slice(0, 15).map(x => ({ nome: x.p.nome, valore: r2(x.imp), href: '#prodotto/' + encodeURIComponent(x.p.id), sotto: fq(x.p, r3(x.qta)) })), venduti[0].imp) : '<div class="empty">Nessuna vendita in questo periodo.</div>';
  if (venduti.length > 15) html += `<div class="faint small">E altri ${venduti.length - 15} prodotti venduti meno.</div>`;
  if (venduti.length > 3) html += `<div class="section-title"><h2>I meno venduti</h2></div><div class="list">${venduti.slice(-3).reverse().map(x => `<a class="item" href="#prodotto/${encodeURIComponent(x.p.id)}"><div class="main"><div class="name">${esc(x.p.nome)}</div><div class="sub">${fq(x.p, r3(x.qta))}</div></div><span class="prezzo">${fmtEuro(r2(x.imp))}</span></a>`).join('')}</div>`;
  if (fermi.length) html += `<div class="section-title"><h2>In negozio ma non venduti</h2><span class="count">${fermi.length}</span></div><div class="list">${fermi.slice(0, 10).map(x => `<a class="item" href="#prodotto/${encodeURIComponent(x.p.id)}"><div class="main"><div class="name">${esc(x.p.nome)}</div><div class="sub">in negozio ${fq(x.p, x.g)}</div></div><span class="prezzo">${x.val ? fmtEuro(r2(x.val)) : ''}</span></a>`).join('')}</div>
    <div class="faint small">Nessuna vendita nel periodo scelto. Valore al prezzo d'acquisto.</div>`;
  html += `<button class="btn block" type="button" data-act="cat-vedi" data-c="${esc(nome)}">Vedi i ${prodotti.length} prodotti nel Catalogo</button>`;
  return { title: nome, html, back: '#categorie', tab: 'home' };
};

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
const SYNC_CONF = { apiKey: 'AIzaSyBj_vigsG7m3jQg3MaRSBTwoKkXcPB3HKk', projectId: 'magazzino-spesa-sfusa-69c90', email: 'laspesasfusa@gmail.com' };   // dati pubblici del progetto Firebase: a proteggere i dati sono password e regole
const SYNC_STORES = ['fornitori', 'prodotti', 'lotti', 'ordini', 'sprechi', 'vendite', 'chiusure', 'fatture', 'spese'];
const SYNC_META = ['settings', 'etiPosizione', 'riordinoTolti'];
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
  // un dispositivo con la versione vecchia salta gli archivi che non conosce: con quelli nuovi si riscarica tutto, una volta
  const archivi = SYNC_STORES.join(','), tutto = S.meta.syncArchivi !== archivi;
  const da = S.meta.syncDa && !tutto ? new Date(tsMs(S.meta.syncDa) - 15000).toISOString() : '1970-01-01T00:00:00Z';
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
  if (tutto) await setMeta('syncArchivi', archivi);
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
const classeStato = () => 'sync-stato ' + (SYNC.stato === 'ok' ? 'ok' : SYNC.stato === 'errore' || SYNC.stato === 'accesso' ? 'err' : '');
function mostraStato() {
  const el = document.getElementById('syncStato'); if (!el) return;
  el.textContent = testoStato();
  el.className = classeStato();
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
    <div id="syncStato" class="${classeStato()}">${esc(testoStato())}</div>
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
    <div class="card" data-auto><h2>Avvisi di scadenza</h2>
      <p class="muted small">Giorni prima della scadenza in cui il prodotto diventa rosso, arancione e giallo.</p>
      ${['preferibilmente', 'entro'].map(t => `<div class="field" style="font-weight:600">${t === 'entro' ? 'Freschi (da consumarsi entro)' : 'Secchi e conserve (preferibilmente entro)'}
        <div class="btn-grid" style="grid-template-columns:repeat(3,1fr)">${s.soglie[t].map((v, i) => `<label class="field"><span class="hint">${['rosso', 'arancione', 'giallo'][i]}</span><input type="number" inputmode="numeric" min="0" data-soglia="${t}|${i}" value="${v}"></label>`).join('')}</div></div>`).join('')}
      <label class="field">Nome del negozio nei messaggi<input type="text" id="sNeg" value="${esc(s.negozio)}"></label>
      <label class="field">Va da solo in «Da ordinare» quando ne restano (pezzi)<input type="number" inputmode="numeric" min="0" id="sScorta" value="${s.scortaMin}"></label>
      <div class="faint small">Vale per tutti i prodotti a pezzi; nella scheda di un prodotto si può scrivere un numero diverso. 0 = mai da solo.</div>
      <div class="faint small salva-stato" aria-live="polite">Ogni modifica si salva da sola.</div></div>
    <div class="card" data-auto><h2>Sfuso</h2>
      <p class="muted small">Quando al sacco più vecchio resta meno di questa parte (polvere, pesate), l'app lo considera finito e passa al sacco dopo.</p>
      <label class="field">Avanzo del sacco, in %<input type="number" inputmode="numeric" min="0" max="30" id="sAvanzo" value="${s.avanzoSfuso}"></label>
      <div class="faint small salva-stato" aria-live="polite">Ogni modifica si salva da sola.</div>
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
    mount: b => {
      autoSalva(b, () => leggiImpostazioni(b));
      if (navigator.storage && navigator.storage.persisted) navigator.storage.persisted().then(v => { persistito = v; const el = $('#persist'); if (el) el.textContent = v ? 'sì' : 'no'; });
    }
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
  const files = [...(e.target.files || [])]; e.target.value = '';
  e.target.multiple = false; e.target.accept = '.txt,.json,text/plain,application/json';
  if (!files.length) return;
  if (fileMode === 'fatture') { await importaFatture(files); return; }
  const f = files[0];
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
   Annulla l'ultima modifica / Rifai
   ========================================================= */
const valoreAttuale = x => x.store === 'meta' ? { id: x.id, value: S.meta[x.id] } : S[x.store].get(x.id);
async function applicaVersioni(v, quale) {
  ANN.applico = true;
  try {
    const per = new Map();
    for (const x of v.voci.values()) { if (!per.has(x.store)) per.set(x.store, { su: [], via: [] }); const g = per.get(x.store), o = x[quale];
      if (x.store === 'meta') await setMeta(x.id, o ? copia(o.value) : undefined);
      else if (o) g.su.push(copia(o)); else if (S[x.store].has(x.id)) g.via.push(x.id); }
    for (const [st, g] of per) { if (st === 'meta') continue; if (g.su.length) await saveMany(st, g.su); if (g.via.length) await removeMany(st, g.via); }
  } finally { ANN.applico = false; }
}
function descriviVoce(v) {
  const voci = [...v.voci.values()], di = st => voci.find(x => x.store === st), nome = x => {
    const o = x.dopo || x.prima || {}; if (x.store === 'prodotti' || x.store === 'fornitori') return o.nome || '';
    const p = o.prodottoId && prodotto(o.prodottoId); return p ? p.nome : ''; };
  const con = (t, x) => t + (x && nome(x) ? ' · ' + nome(x) : '');
  if (di('vendite')) { const x = di('vendite'); return con(x.prima && !x.dopo ? 'vendita tolta' : x.prima ? 'vendita cambiata' : x.dopo && x.dopo.tipo === 'reso' ? 'reso' : 'vendita', x); }
  if (di('sprechi')) return con('spreco', di('sprechi'));
  if (di('lotti')) { const x = di('lotti'); return con(!x.prima ? 'confezione aggiunta' : !x.dopo ? 'confezione tolta' : 'confezione cambiata', x); }
  if (di('ordini')) return 'ordine cambiato';
  if (di('chiusure')) return 'incasso del giorno';
  if (di('prodotti')) { const n = voci.filter(x => x.store === 'prodotti').length, x = di('prodotti'); return n > 1 ? `${n} prodotti` : con(!x.prima ? 'prodotto nuovo' : !x.dopo ? 'prodotto eliminato' : 'scheda', x); }
  if (di('fornitori')) return con('fornitore', di('fornitori'));
  if (di('meta')) return 'impostazioni';
  return 'ultima modifica';
}
async function annullaUltimo() {
  if (paginaSalva) await paginaSalva();     // quello che si sta scrivendo entra prima nella lista
  const v = ANN.pila.pop(); aggiornaUndo();
  if (!v) { toast('Niente da annullare'); return; }
  const dopoAncora = [...v.voci.values()].some(x => JSON.stringify(valoreAttuale(x) ?? null) !== JSON.stringify(x.dopo ?? null));
  if (dopoAncora && !(await confirmBox('Dopo questa modifica è cambiato ancora qualcosa (forse dall\'altro dispositivo). Rimetto lo stesso com\'era prima?', { ok: 'Rimetti com\'era', title: 'Annulla' }))) { ANN.pila.push(v); aggiornaUndo(); return; }
  await applicaVersioni(v, 'prima');
  ANN.rifare = v;
  render(); aggiornaUndo();
  setTimeout(() => toast(`Annullato: ${descriviVoce(v)}`, { action: { label: 'Rifai', run: rifaiUltimo } }), 60);
}
async function rifaiUltimo() {
  const v = ANN.rifare; if (!v) return;
  ANN.rifare = null;
  await applicaVersioni(v, 'dopo');
  ANN.pila.push(v);
  render(); aggiornaUndo();
  setTimeout(() => toast(`Rifatto: ${descriviVoce(v)}`), 60);
}

/* =========================================================
   Azioni (pulsanti)
   ========================================================= */
const A = {};
A['annulla-ultimo'] = () => annullaUltimo().catch(e => toast('Non riesco ad annullare: ' + e.message, { err: true }));
/* fatture */
A['fatture-carica'] = () => { const i = $('#fileInput'); i.accept = '.xml,.p7m,.zip,application/xml,text/xml,application/zip,application/pkcs7-mime'; i.multiple = true; fileMode = 'fatture'; i.click(); };
A['fatture-tutte'] = () => { FAT.tutte = true; render(); };
A['spesa-nuova'] = () => spesaModal(null);
A['spesa-mod'] = el => spesaModal(el.dataset.id);
A['fa-pag-scad'] = el => { const fa = S.fatture.get(el.dataset.id); if (fa) scadenzaFatturaModal(fa); };
A['fa-pag-fatto'] = async el => {
  const fa = S.fatture.get(el.dataset.id); if (!fa) return;
  await save('fatture', { ...fa, pagamenti: [{ modalita: '', scadenza: fa.data, importo: fa.totale, pagata: todayISO() }] });
  render();
};
A['cru-periodo'] = el => { CRU = VC.periodo = el.dataset.f; render(); };
A['cru-prove'] = () => { const n = numeriPeriodo(CRU); cancellaVendite(n.vendite, n.da === n.a ? `del ${fmtDate(n.da)}` : `dal ${fmtDate(n.da)} al ${fmtDate(n.a)}`); };
A['elim-prove'] = el => { const [da, a] = periodo(el.dataset.f); cancellaVendite(venditeEliminati(da, a), 'dei prodotti eliminati'); };
A['cassa-nuova'] = el => cassaModal(null, el.dataset.m);
A['vc-periodo'] = el => { VC.periodo = CRU = el.dataset.f; render(); };
A['vc-serie'] = el => { VC.serie = el.dataset.s; render(); };
A['cat-proponi'] = () => proponiCategorie();
A['cat-vedi'] = el => { CAT = { ...CAT, q: '', forn: '', cat: el.dataset.c, senzaCodice: false, sfuso: false, limite: 60, sel: null }; location.hash = '#catalogo'; };
A['cat-categoria'] = () => { const ids = [...(CAT.sel || [])].filter(id => S.prodotti.has(id)); if (!ids.length) { toast('Scegli prima i prodotti', { err: true }); return; } categoriaModal(ids); };
A['cassa-mod'] = el => cassaModal(el.dataset.d);
A['vendite-prova'] = el => cancellaVendite([...S.vendite.values()].filter(v => (v.data || '').slice(0, 7) === el.dataset.m), `di ${nomeMese(el.dataset.m).toLowerCase()}`);
A['riep-excel'] = el => riepilogoExcel(el.dataset.m).catch(e => toast('Non riesco a preparare il file: ' + e.message, { err: true }));
A['pag-segna'] = async el => {
  if (el.dataset.s) { await segnaSpesa(el.dataset.s); return; }
  const fa = S.fatture.get(el.dataset.f); if (!fa) return;
  const i = +el.dataset.i;
  await save('fatture', { ...fa, pagamenti: fa.pagamenti.map((p, k) => k === i ? { ...p, pagata: p.pagata ? null : todayISO() } : p) });
  render();
};
A['fa-stato'] = async el => {
  const fa = S.fatture.get(el.dataset.id); if (!fa) return;
  const ok = fa.stato !== 'controllata';
  await save('fatture', { ...fa, stato: ok ? 'controllata' : 'nuova', controllata: ok ? todayISO() : null });
  if (ok) { location.hash = '#fatture'; setTimeout(() => toast('Fattura controllata'), 150); } else render();
};
A['fa-elimina'] = async el => {
  const fa = S.fatture.get(el.dataset.id); if (!fa) return;
  if (!(await confirmBox(`Elimino la fattura n. ${fa.numero} di ${nomeFornFattura(fa)}? Se serve, si ricarica dal file.`, { ok: 'Elimina', danger: true }))) return;
  await remove('fatture', fa.id); location.hash = '#fatture';
};
A['fa-forn'] = async el => {
  const fa = S.fatture.get(el.dataset.id), fid = $('#faForn').value; if (!fa) return;
  if (!fid) { toast('Scegli il fornitore', { err: true }); return; }
  await collegaFornitoreFattura(fa, fid); render();
};
A['fa-forn-nuovo'] = async el => {
  const fa = S.fatture.get(el.dataset.id); if (!fa) return;
  const f = { id: uid('f'), nome: fa.fornitore.nome, daNominare: false, metodo: '', telefono: '', email: '', sito: '', note: '', piva: fa.fornitore.piva };
  await save('fornitori', f); await collegaFornitoreFattura(fa, f.id); toast('Fornitore creato: ' + f.nome); render();
};
const rigaDa = el => { const fa = S.fatture.get(el.dataset.f); return fa ? { fa, r: fa.righe[+el.dataset.i] } : {}; };
const serveFornitore = fa => { if (fa.fornitoreId) return true; toast('Prima scegli di quale fornitore è la fattura (in alto)', { err: true }); return false; };
A['fr-si'] = async el => { const { fa, r } = rigaDa(el); if (!r || !serveFornitore(fa)) return; await ricordaRiga(fa, r, el.dataset.p); render(); };
A['fr-no'] = async el => { const { fa, r } = rigaDa(el); if (!r || !serveFornitore(fa)) return; await ricordaRiga(fa, r, '-'); render(); };
A['fr-collega'] = el => {
  const { fa, r } = rigaDa(el); if (!r || !serveFornitore(fa)) return;
  const q0 = norm(r.descrizione).split(' ').filter(w => w.length > 2).slice(0, 2).join(' ');
  pickerModal({
    title: 'Quale prodotto è?', q0, fornitoreId: fa.fornitoreId, nomeNuovo: r.descrizione,
    intro: `<div class="faint">Riga della fattura: <b>${esc(r.descrizione)}</b>. Lo ricordo per le prossime fatture di questo fornitore.</div>`,
    onPick: async p => { await ricordaRiga(fa, r, p.id); render(); }
  });
};
A['fr-prezzo'] = async el => {
  const { fa, r } = rigaDa(el); if (!r) return;
  const e = esameRiga(fa, r); if (!e.p || e.prezzo == null) return;
  if (e.strano && !(await confirmBox(`Il nuovo prezzo (${fmtEuro(e.prezzo)}) è molto diverso da quello di prima (${fmtEuro(e.prima)}): forse in fattura c'è il prezzo di una confezione da più pezzi. Lo aggiorno lo stesso?`, { ok: 'Aggiorna' }))) return;
  const c = await aggiornaPrezzoRiga(fa, e); render(); avvisoCassa([c]);
};
A['fa-prezzi'] = async el => {
  const fa = S.fatture.get(el.dataset.id); if (!fa) return;
  const cambi = [];
  for (const e of statoFattura(fa).es) if (e.cambia && !e.strano) cambi.push(await aggiornaPrezzoRiga(fa, e));
  render(); avvisoCassa(cambi);
};
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
A['sr-inventario'] = el => { closeModal(); const p = prodotto(el.dataset.id); if (!p) return; CS = caricoPer(p, 'inventario'); location.hash = '#carico/inventario'; if (current.name === 'carico') render(); };
A['sr-ordina'] = async el => { closeModal(); await aggiungiOrdine(el.dataset.id); render(); };
/* arrivo merce */
A.modo = el => { const m = el.dataset.m; if (CS.modo === m) return; CS = cambiaModo(m); location.hash = m === 'inventario' ? '#carico/inventario' : '#carico'; render(); };
/* da Arrivo a Inventario (e ritorno) senza perdere il prodotto aperto né la scadenza già scritta */
function cambiaModo(m) {
  const p = CS.pid ? prodotto(CS.pid) : null;
  if (!p) return nuovoCarico(m);
  const c = caricoPer(p, m);
  c.scad = CS.scad; c.senza = CS.senza; c.field = CS.senza ? 'qta' : CS.field;
  return c;
}
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
A['riga-del'] = async el => { await segnaTolto(el.dataset.p, true); return cambiaRiga(el, () => null); };
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
let PSTATO = null;
/* scheda prodotto: legge i campi adesso; il salvataggio vero (con le domande quando diventa sfuso) viene dopo */
function leggiScheda(id, b, stato) {
  const p = prodotto(id), q = sel => b.querySelector(sel);
  if (!p || !q('#pNome') || current.name !== 'prodotto' || current.arg !== id) return null;
  const v = sel => (q(sel) ? q(sel).value : '');
  const nome = v('#pNome').replace(/\s+/g, ' ').trim(); if (!nome) return { errore: 'Il nome non può essere vuoto: non salvato' };
  const sfuso = q('#pSfuso').checked, saccoTxt = v('#pSacco').trim(), sacco = parseNum(saccoTxt);
  const unita = sfuso ? v('#pUnita') : p.unita, fp = { sfuso, unita }, f = sfuso ? UNITA[unitaDi(fp)].f : 1;
  const manTxt = v('#pMan').trim(), manRaw = manTxt ? parseNum(manTxt) : null;
  if (manTxt && manRaw == null) return { errore: 'Il prezzo a mano non è un numero: non salvato' };
  const acqTxt = v('#pAcq').trim(), acq = acqTxt ? parseNum(acqTxt) : null;
  if (acqTxt && acq == null) return { errore: 'Il prezzo d\'acquisto non è un numero: non salvato' };
  const scTxt = v('#pScorta').trim(), sc = scTxt ? parseNum(scTxt) : null;
  if (scTxt && !(sc >= 0)) return { errore: 'La scorta minima non è un numero valido: non salvato' };
  if (sfuso && saccoTxt && !(sacco > 0)) return { errore: `${inLitri(fp) ? 'I litri della tanica non sono' : 'Il peso del sacco non è'} un numero valido: non salvato` };
  const cat = categoriaScelta(b, 'pCat');
  const dati = {
    nome, fornitoreId: v('#pForn'), formato: v('#pFormato').trim(), categoria: cat == null ? p.categoria : cat, tipoScadenza: v('#pTipo'),
    prezzoAcquisto: acq, iva: parseNum(v('#pIva')), ricarico: +v('#pRic'),
    prezzoManuale: manRaw != null ? Math.round(manRaw / f * 10000) / 10000 : null, note: v('#pNote').trim(),
    scortaMin: sc == null ? null : (sfuso ? r3(sc) : Math.round(sc)),
    sfuso, unita, pesoSacco: sfuso && sacco > 0 ? sacco : (sfuso ? null : p.pesoSacco ?? null)
  };
  return { salva: () => salvaScheda(id, dati, { sacco, manRaw, fp, f, stato }) };
}
async function salvaScheda(id, dati, { sacco, manRaw, fp, f, stato }) {
  const p = prodotto(id); if (!p) return false;
  const quiDentro = () => current.name === 'prodotto' && current.arg === id && $('#pNome');
  let confezioni = [];
  if (dati.sfuso && !stato.eraSfuso && !stato.chiesto && sacco > 0) {
    // diventa sfuso: i prezzi del listino possono essere per il sacco intero, le confezioni contate a pezzi
    const intero = inLitri(fp) ? 'la tanica intera' : 'il sacco intero';
    if (dati.prezzoAcquisto != null || manRaw != null) {
      const quali = [dati.prezzoAcquisto != null ? 'acquisto ' + fmtEuro(dati.prezzoAcquisto) : '', manRaw != null ? 'a mano ' + fmtEuro(manRaw) : ''].filter(Boolean).join(', ');
      const perSacco = await sceltaBox(`I prezzi scritti (${quali}) sono per ${intero} da ${fmtSf(fp, sacco)}?`, { si: `Sì: li divido per ${fmtNum(sacco)}`, no: 'No, sono già giusti', title: 'Prezzi' });
      if (perSacco === null) return false;
      if (perSacco) {
        if (dati.prezzoAcquisto != null) dati.prezzoAcquisto = Math.round(dati.prezzoAcquisto / sacco * 10000) / 10000;
        if (manRaw != null) dati.prezzoManuale = Math.round(manRaw / sacco * 100) / 100;
        if (quiDentro()) {
          if (dati.prezzoAcquisto != null) $('#pAcq').value = fmtNum(dati.prezzoAcquisto);
          if (dati.prezzoManuale != null) $('#pMan').value = fmtNum(Math.round(dati.prezzoManuale * f * 100) / 100);
          $('#pAcq').dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
    }
    const att = lottiAttivi().filter(l => l.prodottoId === id);
    if (att.length) {
      const n = att.reduce((t, l) => t + (+l.quantita || 0), 0);
      const sacchi = await sceltaBox(`In negozio risultano ${fmtNum(n)} confezioni di questo prodotto. Sono ${nomeSacco(fp, 2)} da ${fmtSf(fp, sacco)}?`, { si: `Sì: diventano ${fmtSf(fp, n * sacco)}`, no: `No, sono già ${nomeBase(fp)}`, title: `Quantità in ${nomeBase(fp)}` });
      if (sacchi === null) return false;
      if (sacchi) confezioni = att.map(l => ({ ...l, quantita: r3(l.quantita * sacco), sacchi: l.quantita }));
    }
    stato.chiesto = true;
  }
  const cur = prodotto(id); if (!cur) return false;
  const cambiato = Object.keys(dati).some(k => JSON.stringify(cur[k] ?? null) !== JSON.stringify(dati[k] ?? null));
  if (!cambiato && !confezioni.length) return true;
  await save('prodotti', { ...cur, ...dati });
  if (confezioni.length) await saveMany('lotti', confezioni);
  if (!dati.sfuso && cur.sfuso && lottiAttivi().some(l => l.prodottoId === id)) toast(`Le quantità erano in ${nomeBase(cur)}: controllale nelle confezioni`, { ms: 5000 });
  if (quiDentro()) {
    // si aggiorna solo quello che dipende dai dati salvati: i campi restano come li si sta scrivendo
    const np = prodotto(id), t = $('#pTitolo'), so = $('#pSotto'), g = $('#pGiac'), l = $('#pLotti');
    if (t) t.textContent = dati.nome;
    if (so) so.textContent = nomeForn(dati.fornitoreId) + (dati.formato ? ' · ' + dati.formato : '');
    if (cur.sfuso !== dati.sfuso || cur.unita !== dati.unita || confezioni.length) {
      if (g) g.textContent = fq(np, giacenza(id));
      if (l) l.innerHTML = lottiScheda(np);
      aggiornaCodici();
    }
  }
  return true;
}
/* sfuso senza codice: lo crea l'app e apre subito l'etichetta */
A['p-crea-codice'] = async el => {
  if (paginaSalva) await paginaSalva();
  const p = prodotto(el.dataset.id); if (!p) return;
  if ((p.codici || []).length) { aggiornaCodici(); return; }
  await save('prodotti', { ...p, codici: [...(p.codici || []), await codiceInterno()] });
  aggiornaCodici(); toast('Codice creato');
  etichettaPronta(p.id);
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
  const g = giacenza(p.id);
  if (!(await confirmBox(`Elimino "${p.nome}" dal catalogo?${g ? ` In negozio risultano ancora ${fq(p, g)}: escono dal magazzino.` : ''}`, { ok: 'Elimina', danger: true }))) return;
  const prima = await eliminaProdotti([p.id]);
  location.hash = '#catalogo';
  setTimeout(() => toastAnnulla(`Eliminato: ${p.nome}`, prima), 120);   // dopo il cambio pagina, che chiude gli avvisi
};
/* eliminare in blocco: prodotti, le loro confezioni in negozio e le righe negli ordini da fare.
   Si tiene la versione di prima di tutto, così «Annulla» rimette ogni cosa com'era. */
async function eliminaProdotti(ids) {
  const set = new Set(ids.filter(id => S.prodotti.has(id)));
  const prima = {
    prodotti: [...set].map(id => S.prodotti.get(id)),
    lotti: lottiAttivi().filter(l => set.has(l.prodottoId)),
    ordini: [...S.ordini.values()].filter(o => o.stato === 'aperto' && o.righe.some(r => set.has(r.prodottoId))),
    fornitori: []
  };
  await removeMany('prodotti', [...set]);
  if (prima.lotti.length) await saveMany('lotti', prima.lotti.map(l => ({ ...l, stato: 'eliminato', chiuso: todayISO() })));
  if (prima.ordini.length) await saveMany('ordini', prima.ordini.map(o => ({ ...o, righe: o.righe.filter(r => !set.has(r.prodottoId)) })));
  return prima;
}
async function eliminaFornitori(ids, conProdotti) {
  const set = new Set(ids.filter(id => S.fornitori.has(id)));
  const prodIds = [...S.prodotti.values()].filter(p => set.has(p.fornitoreId)).map(p => p.id);
  const forn = [...set].map(id => S.fornitori.get(id));
  let prima = { prodotti: [], lotti: [], ordini: [], fornitori: forn };
  if (prodIds.length && conProdotti) prima = { ...(await eliminaProdotti(prodIds)), fornitori: forn };
  else if (prodIds.length) { prima.prodotti = prodIds.map(id => S.prodotti.get(id)); await saveMany('prodotti', prima.prodotti.map(p => ({ ...p, fornitoreId: '' }))); }
  const bozze = [...S.ordini.values()].filter(o => o.stato === 'aperto' && set.has(o.fornitoreId));
  for (const o of bozze) if (!prima.ordini.some(x => x.id === o.id)) prima.ordini.push(o);
  if (bozze.length) await removeMany('ordini', bozze.map(o => o.id));
  await removeMany('fornitori', [...set]);
  return prima;
}
async function rimetti(prima) { for (const st of ['fornitori', 'prodotti', 'lotti', 'ordini']) if (prima[st] && prima[st].length) await saveMany(st, prima[st]); }
function toastAnnulla(msg, prima) {
  toast(msg, { action: { label: 'Annulla', run: async () => { await rimetti(prima); toast('Rimesso tutto com\'era'); render(); } } });
}
/* chiede cosa fare dei prodotti dei fornitori da eliminare; null = annullato */
async function chiediFornitori(ids) {
  const n = ids.length, k = [...S.prodotti.values()].filter(p => ids.includes(p.fornitoreId)).length;
  const chi = n === 1 ? `il fornitore "${fornitore(ids[0]).nome}"` : `${n} fornitori`;
  if (!k) return (await confirmBox(`Elimino ${chi}?`, { ok: 'Elimina', danger: true })) ? false : null;
  return sceltaBox(`Elimino ${chi}. ${n === 1 ? 'Ha' : 'Hanno'} ${k === 1 ? '1 prodotto' : k + ' prodotti'} nel catalogo: cosa ne faccio?`,
    { si: `Elimina anche ${k === 1 ? 'il prodotto' : 'i ' + k + ' prodotti'}`, no: 'Tieni i prodotti, senza fornitore', title: 'Elimina fornitori' });
}
A['cat-sel'] = () => { CAT.sel = new Set(); render(); };
A['cat-sel-fine'] = () => { CAT.sel = null; render(); };
A['cat-sel-tutti'] = () => { CAT.sel = new Set(filtroCat(Infinity).items.map(p => p.id)); render(); };
A['cat-sel-nessuno'] = () => { CAT.sel = new Set(); render(); };
A['cat-elimina'] = async () => {
  const ids = [...(CAT.sel || [])].filter(id => S.prodotti.has(id)); if (!ids.length) return;
  const conMerce = ids.filter(id => giacenza(id) > 0).length;
  if (!(await confirmBox(`Elimino ${ids.length === 1 ? '1 prodotto' : ids.length + ' prodotti'} dal catalogo?${conMerce ? ` ${conMerce === 1 ? '1 ha' : conMerce + ' hanno'} ancora merce in negozio: esce dal magazzino.` : ''}`, { ok: 'Elimina', danger: true }))) return;
  const prima = await eliminaProdotti(ids);
  CAT.sel = null; render();
  toastAnnulla(`Eliminati ${ids.length === 1 ? '1 prodotto' : ids.length + ' prodotti'}`, prima);
};
A['for-sel'] = () => { FSEL = new Set(); render(); };
A['for-sel-fine'] = () => { FSEL = null; render(); };
A['for-sel-tutti'] = () => { FSEL = new Set(S.fornitori.keys()); render(); };
A['for-sel-nessuno'] = () => { FSEL = new Set(); render(); };
A['for-elimina'] = async () => {
  const ids = [...(FSEL || [])].filter(id => S.fornitori.has(id)); if (!ids.length) return;
  const con = await chiediFornitori(ids); if (con === null) return;
  const prima = await eliminaFornitori(ids, con);
  FSEL = null; render();
  toastAnnulla(`Eliminati ${ids.length === 1 ? '1 fornitore' : ids.length + ' fornitori'}${con && prima.prodotti.length ? ` e ${prima.prodotti.length} prodotti` : ''}`, prima);
};
A['nuovo-fornitore'] = async () => {
  const f = { id: uid('f'), nome: 'Nuovo fornitore', daNominare: false, metodo: '', telefono: '', email: '', sito: '', note: '' };
  await save('fornitori', f); location.hash = '#fornitore/' + encodeURIComponent(f.id);
};
function leggiFornitore(id, b) {
  const q = sel => b.querySelector(sel); if (!q('#fNome') || current.name !== 'fornitore' || current.arg !== id) return null;
  const nome = q('#fNome').value.trim(); if (!nome) return { errore: 'Il nome non può essere vuoto: non salvato' };
  let piva = q('#fPiva').value.replace(/\s/g, '').toUpperCase(); if (/^\d{11}$/.test(piva)) piva = 'IT' + piva;
  const dati = { nome, piva, metodo: q('#fMet').value, telefono: q('#fTel').value.trim(), email: q('#fMail').value.trim(), sito: q('#fSito').value.trim(), note: q('#fNote').value.trim() };
  return { salva: async () => {
    const f = fornitore(id); if (!f) return false;
    const nuovo = { ...f, ...dati, daNominare: f.daNominare && /^da nominare/i.test(nome) };
    if (JSON.stringify(nuovo) === JSON.stringify(f)) return true;
    await save('fornitori', nuovo); return true;
  } };
}
A['f-elimina'] = async el => {
  const f = fornitore(el.dataset.id); if (!f) return;
  const con = await chiediFornitori([f.id]); if (con === null) return;
  const prima = await eliminaFornitori([f.id], con);
  location.hash = '#fornitori';
  setTimeout(() => toastAnnulla(`Eliminato: ${f.nome}`, prima), 120);
};
/* impostazioni */
function leggiImpostazioni(b) {
  if (!b.querySelector('#sNeg') || current.name !== 'impostazioni') return null;
  const s0 = settings(), soglie = JSON.parse(JSON.stringify(s0.soglie));
  b.querySelectorAll('[data-soglia]').forEach(i => { const [t, k] = i.dataset.soglia.split('|'); soglie[t][+k] = Math.max(0, parseInt(i.value, 10) || 0); });
  for (const t in soglie) soglie[t].sort((x, y) => x - y);
  const av = parseInt(b.querySelector('#sAvanzo').value, 10), sc = parseInt(b.querySelector('#sScorta').value, 10);
  const nuovo = { ...(S.meta.settings || {}), soglie, negozio: b.querySelector('#sNeg').value.trim() || DEFAULT_SETTINGS.negozio, avanzoSfuso: isNaN(av) ? DEFAULT_SETTINGS.avanzoSfuso : Math.min(30, Math.max(0, av)), scortaMin: isNaN(sc) ? s0.scortaMin : Math.max(0, sc) };
  return { salva: async () => { if (JSON.stringify(nuovo) === JSON.stringify(S.meta.settings || {})) return true; await setMeta('settings', nuovo); aggiornaBadge(); return true; } };
}
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
    <div><b>${esc(nomeVendita(v))}</b><div class="faint">${fmtDate(v.data)} alle ${fmtOra(v.creato)} · ${v.sfuso ? fmtKg(v.qta) : fmtNum(v.qta) + ' pz'}${imp != null ? ' · ' + fmtEuro(imp) : ''}</div></div>
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
  setTimeout(function primoControllo() {
    if (syncAttiva() && !SYNC.ultimo && SYNC.stato !== 'offline' && SYNC.stato !== 'errore' && SYNC.stato !== 'accesso' && (primoControllo.n = (primoControllo.n || 0) + 1) < 30) { setTimeout(primoControllo, 1000); return; }
    categorieDalCatalogo().then(n => { if (n) { if (['categorie', 'categoria', 'catalogo', 'cruscotto'].includes(current.name)) render(); } }).catch(e => console.error(e))
      .finally(() => controlloScorte().catch(e => console.error(e)));
  }, 1200);
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
  window.__app = { S, onScan, parseScadenza, save, VERSIONE, giro, SYNC: () => SYNC, setMeta, categorieDalCatalogo, ANN, salvaOra: () => paginaSalva ? paginaSalva() : Promise.resolve() };
}
init();
})();
