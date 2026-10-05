/* Magazzino – La Spesa Sfusa
   App offline: scadenze e ordini. Dati salvati sul telefono (IndexedDB), backup su Drive. */
(function () {
'use strict';

const VERSIONE = '1.0.1';

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
const STORES = ['fornitori', 'prodotti', 'lotti', 'ordini', 'meta'];
let db;
const S = { fornitori: new Map(), prodotti: new Map(), lotti: new Map(), ordini: new Map(), meta: {} };

function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      for (const s of STORES) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: s === 'meta' ? 'key' : 'id' });
    };
    r.onsuccess = () => res(r.result);
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
  for (const s of ['fornitori', 'prodotti', 'lotti', 'ordini']) S[s] = new Map((await getAll(s)).map(o => [o.id, o]));
  S.meta = {}; (await getAll('meta')).forEach(m => { S.meta[m.key] = m.value; });
}
async function save(store, obj) { S[store].set(obj.id, obj); await tx(store, s => s.put(obj)); if (store === 'prodotti') rebuildCodeIndex(); }
async function saveMany(store, arr) { arr.forEach(o => S[store].set(o.id, o)); await tx(store, s => arr.forEach(o => s.put(o))); if (store === 'prodotti') rebuildCodeIndex(); }
async function remove(store, id) { S[store].delete(id); await tx(store, s => s.delete(id)); if (store === 'prodotti') rebuildCodeIndex(); }
async function setMeta(key, value) { S.meta[key] = value; await tx('meta', s => s.put({ key, value })); }

const DEFAULT_SETTINGS = { soglie: { preferibilmente: [7, 15, 30], entro: [2, 5, 10] }, negozio: 'La Spesa Sfusa' };
function settings() {
  const s = S.meta.settings || {};
  return { negozio: s.negozio || DEFAULT_SETTINGS.negozio, soglie: Object.assign({}, DEFAULT_SETTINGS.soglie, s.soglie || {}) };
}

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
const giacenza = pid => lottiAttivi().filter(l => l.prodottoId === pid).reduce((s, l) => s + (+l.quantita || 0), 0);
const nameNorm = new WeakMap();
function cerca(q, { fornitoreId = '', limit = 60, soloSenzaCodice = false } = {}) {
  const nq = norm(q), words = nq ? nq.split(' ') : [], code = String(q || '').trim();
  const out = [];
  for (const p of S.prodotti.values()) {
    if (fornitoreId && p.fornitoreId !== fornitoreId) continue;
    if (soloSenzaCodice && (p.codici || []).length) continue;
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
  if (mount) mount($('#modalBody'));
}
/* la pulizia è immediata: l'evento "close" del browser arriva dopo e non deve
   cancellare una finestra aperta subito dopo (es. collega codice → scheda rapida) */
function pulisciModal() {
  stopCamera(); $('#modalBody').innerHTML = ''; modalScan = null;
  const cb = modalOnClose; modalOnClose = null; if (cb) cb();
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

/* =========================================================
   Lettore di codici a barre
   - lettore Bluetooth: si comporta come una tastiera e manda "Invio"
   - fotocamera: BarcodeDetector di Chrome per Android
   ========================================================= */
const SC = { chars: '', times: [], field: null, before: null };
function resetSC() { SC.chars = ''; SC.times = []; SC.field = null; SC.before = null; }
const isTextField = t => t && (t.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit', 'file'].includes(t.type) || t.tagName === 'TEXTAREA' || t.isContentEditable);
document.addEventListener('keydown', e => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const now = performance.now();
  const field = isTextField(e.target) ? e.target : null;
  if (SC.times.length && now - SC.times[SC.times.length - 1] > 120) resetSC();
  if (e.key === 'Enter' || e.key === 'Tab') {
    const n = SC.chars.length;
    const avg = n > 1 ? (SC.times[n - 1] - SC.times[0]) / (n - 1) : 999;
    const isScan = n >= 4 && (field ? avg < 35 : true);
    if (isScan) {
      e.preventDefault(); e.stopPropagation();
      const code = SC.chars;
      if (field && SC.before !== null) { field.value = SC.before; field.dispatchEvent(new Event('input', { bubbles: true })); }
      resetSC(); onScan(code); return;
    }
    resetSC(); return;
  }
  if (e.key && e.key.length === 1) {
    if (!SC.chars) { SC.field = field; SC.before = field ? field.value : null; }
    SC.chars += e.key; SC.times.push(now);
    if (!field) e.preventDefault();
  }
}, true);

let camStream = null, camTimer = null;
async function openCamera() {
  if (!('BarcodeDetector' in window)) { toast('Su questo dispositivo la fotocamera non legge i codici: usa il lettore o scrivi il codice', { err: true }); return; }
  let formats = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'qr_code'];
  try { const sup = await BarcodeDetector.getSupportedFormats(); formats = formats.filter(f => sup.includes(f)); } catch (e) { }
  const det = new BarcodeDetector({ formats });
  openModal(`${mhead('Inquadra il codice a barre')}<div class="video-wrap"><video id="camVideo" playsinline muted></video></div>
    <div class="row"><p class="faint spacer" style="margin:0">Tieni il codice dentro il riquadro, ben fermo e con buona luce.</p><button class="btn small" type="button" id="camTorch" hidden>Luce</button></div>`, async b => {
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
    const tick = async () => {
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

function onScan(code) {
  code = String(code || '').trim();
  if (!code) return;
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
    <div class="sub">${esc(nomeForn(p.fornitoreId))}${p.formato ? ' · ' + esc(p.formato) : ''}${g ? ' · in negozio ' + fmtNum(g) : ''}</div></div>
    ${(p.codici || []).length ? '<span class="tag ok">codice</span>' : ''}</button>`;
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
    <button class="btn primary block" type="button" id="npSave">Crea prodotto</button>`, b => {
    b.querySelector('#npNome').focus();
    b.querySelector('#npSave').onclick = async () => {
      const n = b.querySelector('#npNome').value.trim();
      if (!n) { toast('Scrivi il nome del prodotto', { err: true }); return; }
      const fid = b.querySelector('#npForn').value;
      const p = { id: uid('p'), nome: n, fornitoreId: fid, categoria: '', formato: b.querySelector('#npFormato').value.trim(), prezzoAcquisto: null, iva: null, prezzoVendita: null, prezzoManuale: null, ricarico: 50, codici: code ? [code] : [], tipoScadenza: b.querySelector('#npTipo').value, note: '', origine: 'Creato nell\'app' };
      if (code) { const prima = byCode(code); if (prima) await save('prodotti', { ...prima, codici: prima.codici.filter(c => c !== code) }); }
      await save('prodotti', p); if (fid) await setMeta('ultimoFornitore', fid);
      closeModal(); toast(`Creato: ${p.nome}`); onDone && onDone(p);
    };
  });
}
function schedaRapida(p) {
  const lotti = lottiAttivi().filter(l => l.prodottoId === p.id).sort((a, b) => (a.scadenza || '9').localeCompare(b.scadenza || '9'));
  const u = ultimoOrdine(p.id);
  openModal(`${mhead(p.nome)}
    <div class="faint">${esc(nomeForn(p.fornitoreId))}${p.formato ? ' · ' + esc(p.formato) : ''}</div>
    ${lotti.length ? `<div class="list">${lotti.map(l => `<div class="item"><div class="main"><div class="name">${fmtNum(l.quantita)} pz</div><div class="sub">${l.scadenza ? 'scade ' + fmtDate(l.scadenza) + ' · ' + relDays(daysUntil(l.scadenza)) : 'senza scadenza'}</div></div></div>`).join('')}</div>` : '<div class="faint">Nessuna confezione registrata in negozio.</div>'}
    ${u ? `<div class="faint">Ultimo ordine: ${fmtNum(u.qta)} il ${fmtDate(u.data)}</div>` : ''}
    <div class="stack">
      <button class="btn primary block" type="button" data-act="sr-carico" data-id="${esc(p.id)}">Arrivo merce</button>
      <button class="btn block" type="button" data-act="sr-ordina" data-id="${esc(p.id)}">Aggiungi all'ordine</button>
      <a class="btn ghost block" href="#prodotto/${encodeURIComponent(p.id)}" data-act="close-modal-link">Apri la scheda</a>
    </div>`);
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
  current.fresh = !!scrollTop;
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
  html += `<div class="faint" style="text-align:center">Puoi anche scansionare un prodotto in qualsiasi momento per vedere cosa fare.</div>`;
  const warn = giorniBk == null || giorniBk >= 3;
  html += `<div class="notice ${warn ? 'red' : 'green'}"><div class="spacer">${giorniBk == null ? '<b>Nessun backup ancora.</b> Fallo ogni giorno a fine lavoro.' : giorniBk === 0 ? 'Backup fatto oggi.' : `Ultimo backup: <b>${giorniBk === 1 ? 'ieri' : giorniBk + ' giorni fa'}</b>.`}</div>
    <button class="btn small ${warn ? 'primary' : ''}" type="button" data-act="backup">Fai backup</button></div>`;
  if (installPrompt) html += `<button class="btn block" type="button" data-act="installa">Installa l'app sul telefono</button>`;
  return { title: settings().negozio, html, tab: 'home' };
};

/* =========================================================
   ARRIVO MERCE / INVENTARIO
   ========================================================= */
let CS = nuovoCarico('arrivo');
function nuovoCarico(modo) { return { pid: null, qta: '1', scad: '', senza: false, field: 'scad', qtaFresh: true, modo }; }
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
  if (d.length === 4) { const r = parseScadenza(d); return r ? { t: `Solo mese e anno: fine ${fmtDateLong(r.iso).split(' ').slice(1).join(' ')} · oppure continua con il giorno`, err: false } : { t: 'Mese non valido', err: true }; }
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
    html += `<div class="card">
      <div class="row"><div class="spacer"><h2>${esc(p.nome)}</h2><div class="faint">${esc(nomeForn(p.fornitoreId))}${p.formato ? ' · ' + esc(p.formato) : ''}</div></div>${tagTipo(p)}</div>
      ${info ? `<div class="notice green"><span>In ordine: <b>${fmtNum(info.qta)}</b> · già arrivati <b>${fmtNum(info.ric)}</b></span></div>` : ''}
      <div class="kp-fields">
        <button type="button" class="kp-field ${CS.field === 'scad' ? 'on' : ''}" data-act="kp-field" data-f="scad" ${CS.senza ? 'disabled' : ''}><small>Scadenza</small><b>${CS.senza ? '—' : fmtScadDigits(CS.scad)}</b></button>
        <div class="kp-qta">
          <button type="button" class="kp-pm" data-act="qta-" aria-label="Meno uno">−</button>
          <button type="button" class="kp-field ${CS.field === 'qta' ? 'on' : ''}" data-act="kp-field" data-f="qta"><small>${inv ? 'Quanti ce ne sono' : 'Quantità'}</small><b>${esc(CS.qta || '0')}</b></button>
          <button type="button" class="kp-pm" data-act="qta+" aria-label="Più uno">+</button>
        </div>
      </div>
      <div class="date-preview ${pr.err ? 'err' : ''} ${pr.faint ? 'faint' : ''}">${esc(pr.t)}</div>
      <div class="keypad">${['1', '2', '3', '4', '5', '6', '7', '8', '9'].map(k => `<button type="button" data-act="kp" data-k="${k}">${k}</button>`).join('')}
        <button type="button" data-act="kp" data-k="back" aria-label="Cancella">⌫</button><button type="button" data-act="kp" data-k="0">0</button>
        <button type="button" class="ok" data-act="carico-salva">Salva</button></div>
      <div class="row wrap"><label class="check spacer"><input type="checkbox" data-act="senza" ${CS.senza ? 'checked' : ''}> Senza scadenza</label>
        <button class="btn small ghost" type="button" data-act="carico-annulla">Annulla</button></div>
    </div>`;
  }
  const oggi = [...S.lotti.values()].filter(l => l.arrivo === todayISO() && (l.origine || 'arrivo') === CS.modo).sort((a, b) => b.creato - a.creato);
  html += `<div class="section-title"><h2>${inv ? 'Contati oggi' : 'Arrivati oggi'}</h2><span class="count">${oggi.length}</span></div>`;
  html += oggi.length ? `<div class="list">${oggi.map(l => {
    const pp = prodotto(l.prodottoId);
    return `<div class="item"><div class="main"><div class="name">${esc(pp ? pp.nome : '?')}</div><div class="sub">${fmtNum(l.quantita)} pz · ${l.scadenza ? 'scade ' + fmtDate(l.scadenza) : 'senza scadenza'}</div></div>
      <button class="btn small ghost" type="button" data-act="lotto-annulla" data-id="${esc(l.id)}">Togli</button></div>`;
  }).join('')}</div>` : `<div class="empty">Ancora niente oggi.</div>`;
  return { title: inv ? 'Inventario' : 'Arrivo merce', html, tab: 'carico', onScan: caricoScan };
};
async function caricoScan(code) {
  const p = byCode(code);
  const go = p2 => { const m = CS.modo; CS = nuovoCarico(m); CS.pid = p2.id; render(); };
  if (CS.pid) {
    if (p && p.id === CS.pid) { CS.qta = String((parseInt(CS.qta, 10) || 0) + 1); render(); toast(`Quantità: ${CS.qta}`); return; }
    const pronto = CS.senza || parseScadenza(CS.scad);
    if (!pronto) { toast(`Prima scrivi la scadenza di ${prodotto(CS.pid).nome}, oppure premi Annulla`, { err: true }); return; }
    const ok = await salvaCarico(); if (!ok) return;
  }
  if (p) go(p); else collegaCodice(code, go);
}
async function salvaCarico() {
  const p = prodotto(CS.pid); if (!p) return false;
  const qta = parseInt(CS.qta, 10) || 0;
  if (qta <= 0) { toast('La quantità deve essere almeno 1', { err: true }); return false; }
  let scad = null;
  if (!CS.senza) {
    const r = parseScadenza(CS.scad);
    if (!r) { toast('Scrivi la scadenza: 6 cifre, per esempio 280527', { err: true }); return false; }
    scad = r.iso;
    if (daysUntil(scad) < 0 && !(await confirmBox(`La data ${fmtDate(scad)} è già passata. Salvo lo stesso?`, { ok: 'Salva' }))) return false;
  }
  const l = { id: uid('l'), prodottoId: p.id, quantita: qta, scadenza: scad, arrivo: todayISO(), creato: Date.now(), stato: 'attivo', gestito: false, nota: '', ordineId: null, origine: CS.modo, sprechi: [] };
  if (CS.modo === 'arrivo') {
    const info = infoOrdine(p);
    if (info) {
      const righe = info.o.righe.map(r => r.prodottoId === p.id ? { ...r, ricevuto: (r.ricevuto || 0) + qta } : r);
      await save('ordini', { ...info.o, righe }); l.ordineId = info.o.id;
    }
  }
  await save('lotti', l);
  toast(`Salvato: ${qta} × ${p.nome}${scad ? ' · scade ' + fmtDate(scad) : ''}`, { action: { label: 'Annulla', run: () => annullaLotto(l.id) } });
  CS = nuovoCarico(CS.modo);
  render();
  return true;
}
async function annullaLotto(id) {
  const l = S.lotti.get(id); if (!l) return;
  if (l.ordineId) {
    const o = S.ordini.get(l.ordineId);
    if (o) await save('ordini', { ...o, righe: o.righe.map(r => r.prodottoId === l.prodottoId ? { ...r, ricevuto: Math.max(0, (r.ricevuto || 0) - l.quantita) } : r) });
  }
  await remove('lotti', id); toast('Tolto'); render();
}

/* =========================================================
   SCADENZE
   ========================================================= */
let SZ = { filtro: 'urgenti', q: '' };
const FILTRI = [['urgenti', 'Urgenti'], ['scaduti', 'Scaduti'], ['30', 'Prossimi 30 giorni'], ['tutti', 'Tutti'], ['gestiti', 'Gestiti']];
const FASCE = [['scaduto', 'Scaduti'], ['rosso', 'Scadono a brevissimo'], ['arancio', 'Scadono presto'], ['giallo', 'Entro il mese'], ['ok', 'Più avanti']];
function lottiFiltrati() {
  const q = norm(SZ.q);
  return lottiAttivi().filter(l => {
    if (!l.scadenza) return false;
    const f = fascia(l);
    if (SZ.filtro === 'gestiti') { if (!l.gestito) return false; }
    else if (SZ.filtro === 'urgenti') { if (l.gestito || !['scaduto', 'rosso', 'arancio'].includes(f)) return false; }
    else if (SZ.filtro === 'scaduti') { if (f !== 'scaduto') return false; }
    else if (SZ.filtro === '30') { if (f === 'ok') return false; }
    if (q) { const p = prodotto(l.prodottoId); if (!p || !q.split(' ').every(w => norm(p.nome).includes(w))) return false; }
    return true;
  }).sort((a, b) => a.scadenza.localeCompare(b.scadenza));
}
function rigaLotto(l) {
  const p = prodotto(l.prodottoId), f = fascia(l), d = daysUntil(l.scadenza);
  return `<div class="lot ${f} ${l.gestito ? 'gestito' : ''}">
    <div class="top"><div class="spacer"><div class="name" style="font-weight:650">${esc(p ? p.nome : '?')}</div>
      <div class="sub small muted">${esc(p ? nomeForn(p.fornitoreId) : '')} · ${fmtNum(l.quantita)} pz ${tagTipo(p)}${l.gestito ? ` · <b>${esc(l.nota || 'gestito')}</b>` : ''}</div></div>
      <div class="when">${fmtDate(l.scadenza)}<small>${relDays(d)}</small></div></div>
    <div class="acts">
      <button class="btn small" type="button" data-act="lot-gestito" data-id="${esc(l.id)}">${l.gestito ? 'Non gestito' : 'Gestito'}</button>
      <button class="btn small" type="button" data-act="lot-esaurito" data-id="${esc(l.id)}">Esaurito</button>
      <button class="btn small danger" type="button" data-act="lot-buttato" data-id="${esc(l.id)}">Buttato</button>
      <button class="btn small" type="button" data-act="lot-modifica" data-id="${esc(l.id)}" aria-label="Modifica"><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg></button></div></div>`;
}
function listaScadenzeHTML() {
  const ls = lottiFiltrati();
  if (!ls.length) return `<div class="empty">${SZ.q ? 'Nessuna scadenza per questa ricerca.' : SZ.filtro === 'urgenti' ? 'Niente di urgente. Ottimo!' : 'Niente da mostrare.'}</div>`;
  let html = '';
  for (const [k, label] of FASCE) {
    const g = ls.filter(l => fascia(l) === k);
    if (!g.length) continue;
    html += `<div class="section-title"><h2>${label}</h2><span class="count">${g.length}</span></div><div class="list">${g.map(rigaLotto).join('')}</div>`;
  }
  return html;
}
routes.scadenze = arg => {
  if (current.fresh && arg && FILTRI.some(f => f[0] === arg)) SZ.filtro = arg;
  const html = `<div class="chips">${FILTRI.map(([k, l]) => `<button class="chip ${SZ.filtro === k ? 'on' : ''}" type="button" data-act="sz-filtro" data-f="${k}">${l}</button>`).join('')}</div>
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
  return `Scadenze ${fmtDate(todayISO())}:\n` + ls.map(l => { const p = prodotto(l.prodottoId); return `- ${fmtDate(l.scadenza)} ${p ? p.nome : '?'} (${fmtNum(l.quantita)} pz)${l.gestito ? ' – ' + (l.nota || 'gestito') : ''}`; }).join('\n');
}

/* =========================================================
   ORDINI
   ========================================================= */
const METODI = { whatsapp: 'WhatsApp', email: 'Email', sito: 'Sito', telefono: 'Telefono', interno: 'Produzione interna', '': 'Da impostare' };
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
    toast(`Da ordinare: ${p.nome}${u ? ` · ultima volta ${fmtNum(u.qta)} il ${fmtDate(u.data)}` : ''}`);
  }
}
function normTel(t) {
  let d = String(t || '').replace(/[^\d+]/g, '');
  if (d.startsWith('+')) d = d.slice(1); else if (d.startsWith('00')) d = d.slice(2);
  else if (d.length >= 9 && d.length <= 10) d = '39' + d;
  return d;
}
function testoOrdine(o) {
  const righe = o.righe.filter(r => r.qta > 0).map(r => { const p = prodotto(r.prodottoId); return `- ${fmtNum(r.qta)} x ${p ? p.nome : '?'}`; });
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
      return `<div class="item ord-row"><div class="main"><div class="name">${esc(p ? p.nome : '?')}</div><div class="sub">${u ? `ultima volta ${fmtNum(u.qta)} il ${fmtDate(u.data)}` : 'mai ordinato nell\'app'}${p ? ' · in negozio ' + fmtNum(giacenza(p.id)) : ''}</div></div>
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
        ${o.righe.map(r => { const p = prodotto(r.prodottoId), ric = r.ricevuto || 0; const st = ric >= r.qta ? 'ok' : ric > 0 ? 'warn' : ''; return `<div class="item"><div class="main"><div class="name">${esc(p ? p.nome : '?')}</div></div><span class="progress tag ${st}">${fmtNum(ric)} / ${fmtNum(r.qta)}</span></div>`; }).join('')}
        <footer><button class="btn" type="button" data-act="ord-chiudi" data-o="${esc(o.id)}">Chiudi ordine</button></footer></section>`;
    }
  }
  if (chiusi.length) {
    html += `<div class="section-title"><h2>Ultimi ordini chiusi</h2></div><div class="list">${chiusi.map(o => `<div class="item"><div class="main"><div class="name">${esc(nomeForn(o.fornitoreId))}</div><div class="sub">inviato ${fmtDate(o.inviato)} · chiuso ${fmtDate(o.chiuso)} · ${o.righe.length} prodotti</div></div></div>`).join('')}</div>`;
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
let CAT = { q: '', forn: '', limite: 60, senzaCodice: false };
function catListHTML() {
  const res = cerca(CAT.q, { fornitoreId: CAT.forn, limit: CAT.limite, soloSenzaCodice: CAT.senzaCodice });
  if (!res.total) return `<div class="empty">Nessun prodotto.</div>`;
  return `<div class="faint">${res.total} prodotti</div><div class="list">${res.items.map(p => {
    const g = giacenza(p.id);
    return `<a class="item" href="#prodotto/${encodeURIComponent(p.id)}"><div class="main"><div class="name">${esc(p.nome)}</div>
      <div class="sub">${esc(nomeForn(p.fornitoreId))}${p.formato ? ' · ' + esc(p.formato) : ''}${g ? ' · in negozio ' + fmtNum(g) : ''}</div></div>
      ${(p.codici || []).length ? '<span class="tag ok">codice</span>' : ''}<span class="chev">›</span></a>`;
  }).join('')}</div>${res.total > res.items.length ? `<button class="btn block" type="button" data-act="cat-altri">Mostra altri (${res.total - res.items.length})</button>` : ''}`;
}
const segCat = on => `<div class="segmented"><a href="#catalogo" class="${on === 'p' ? 'on' : ''}">Prodotti</a><a href="#fornitori" class="${on === 'f' ? 'on' : ''}">Fornitori</a></div>`;
routes.catalogo = arg => {
  if (current.fresh && arg) { CAT.forn = arg; CAT.q = ''; CAT.limite = 60; }
  const forn = [...S.fornitori.values()].sort((a, b) => a.nome.localeCompare(b.nome, 'it'));
  const html = `${segCat('p')}
    <input type="search" id="catQ" placeholder="Cerca per nome o codice" value="${esc(CAT.q)}" autocomplete="off">
    <div class="row wrap"><select id="catF" style="flex:1;min-width:200px"><option value="">Tutti i fornitori</option>${forn.map(f => `<option value="${esc(f.id)}" ${CAT.forn === f.id ? 'selected' : ''}>${esc(f.nome)}</option>`).join('')}</select>
      <label class="check"><input type="checkbox" id="catSC" ${CAT.senzaCodice ? 'checked' : ''}> Senza codice</label></div>
    <div id="catList" class="stack">${catListHTML()}</div>
    <button class="btn block" type="button" data-act="nuovo-prodotto">+ Nuovo prodotto</button>`;
  return {
    title: 'Catalogo', html, tab: 'catalogo',
    mount: b => {
      const upd = () => { CAT.limite = 60; b.querySelector('#catList').innerHTML = catListHTML(); };
      b.querySelector('#catQ').addEventListener('input', e => { CAT.q = e.target.value; upd(); });
      b.querySelector('#catF').addEventListener('change', e => { CAT.forn = e.target.value; upd(); });
      b.querySelector('#catSC').addEventListener('change', e => { CAT.senzaCodice = e.target.checked; upd(); });
    },
    onScan: code => { const p = byCode(code); if (p) location.hash = '#prodotto/' + encodeURIComponent(p.id); else collegaCodice(code, p2 => { location.hash = '#prodotto/' + encodeURIComponent(p2.id); }); }
  };
};
routes.prodotto = id => {
  const p = prodotto(id);
  if (!p) return { title: 'Prodotto', html: '<div class="empty">Prodotto non trovato.</div>', back: '#catalogo', tab: 'catalogo' };
  const forn = [...S.fornitori.values()].sort((a, b) => a.nome.localeCompare(b.nome, 'it'));
  const lotti = lottiAttivi().filter(l => l.prodottoId === p.id).sort((a, b) => (a.scadenza || '9').localeCompare(b.scadenza || '9'));
  const calc = prezzoCalcolato(p);
  const html = `<div class="card">
      <label class="field">Nome<input type="text" id="pNome" value="${esc(p.nome)}"></label>
      <label class="field">Fornitore<select id="pForn"><option value="">— nessuno —</option>${forn.map(f => `<option value="${esc(f.id)}" ${p.fornitoreId === f.id ? 'selected' : ''}>${esc(f.nome)}</option>`).join('')}</select></label>
      <div class="btn-grid" style="grid-template-columns:1fr 1fr">
        <label class="field">Formato<input type="text" id="pFormato" value="${esc(p.formato)}"></label>
        <label class="field">Categoria<input type="text" id="pCat" value="${esc(p.categoria)}"></label></div>
      <label class="field">Tipo di scadenza<select id="pTipo"><option value="preferibilmente" ${p.tipoScadenza !== 'entro' ? 'selected' : ''}>Preferibilmente entro (secchi, conserve)</option><option value="entro" ${p.tipoScadenza === 'entro' ? 'selected' : ''}>Da consumarsi entro (freschi)</option></select></label>
      <div class="field" style="font-weight:600">Codici a barre
        <div class="row wrap">${(p.codici || []).map(c => `<span class="tag" style="font-size:.9rem;padding:6px 10px">${esc(c)} <button type="button" data-act="p-codice-del" data-c="${esc(c)}" style="border:0;background:none;font-size:1rem;cursor:pointer" aria-label="Togli codice">×</button></span>`).join('') || '<span class="faint">Nessun codice: scansiona ora il prodotto per collegarlo.</span>'}</div></div>
    </div>
    <div class="card"><h3>Prezzi</h3>
      <div class="btn-grid" style="grid-template-columns:1fr 1fr">
        <label class="field">Acquisto €<input type="text" inputmode="decimal" id="pAcq" value="${p.prezzoAcquisto != null ? fmtNum(p.prezzoAcquisto) : ''}"></label>
        <label class="field">IVA<select id="pIva"><option value="">—</option>${[4, 10, 22].map(v => `<option value="${v}" ${p.iva === v ? 'selected' : ''}>${v}%</option>`).join('')}</select></label>
        <label class="field">Ricarico<select id="pRic"><option value="50" ${p.ricarico !== 40 ? 'selected' : ''}>50%</option><option value="40" ${p.ricarico === 40 ? 'selected' : ''}>40% (eccezione)</option></select></label>
        <label class="field">Prezzo scelto a mano €<input type="text" inputmode="decimal" id="pMan" value="${p.prezzoManuale != null ? fmtNum(p.prezzoManuale) : ''}" placeholder="vuoto = calcolato"></label></div>
      <dl class="kv"><dt>Prezzo calcolato</dt><dd id="pCalc">${fmtEuro(calc)}</dd><dt>Prezzo nel listino</dt><dd>${fmtEuro(p.prezzoVendita)}</dd></dl>
      <div class="faint small">Calcolato: acquisto + ricarico + IVA, arrotondato ai 10 centesimi superiori.</div></div>
    <div class="card"><label class="field">Note<textarea id="pNote" style="min-height:80px">${esc(p.note)}</textarea></label>
      ${p.origine ? `<div class="faint small">Origine: ${esc(p.origine)}</div>` : ''}</div>
    <button class="btn primary block" type="button" data-act="p-salva" data-id="${esc(p.id)}">Salva modifiche</button>
    <div class="btn-grid" style="grid-template-columns:1fr 1fr"><button class="btn" type="button" data-act="sr-carico" data-id="${esc(p.id)}">Arrivo merce</button><button class="btn" type="button" data-act="sr-ordina" data-id="${esc(p.id)}">Aggiungi all'ordine</button></div>
    <div class="section-title"><h2>In negozio</h2><span class="count">${fmtNum(giacenza(p.id))} pz</span></div>
    ${lotti.length ? `<div class="list">${lotti.map(l => `<div class="item"><div class="main"><div class="name">${fmtNum(l.quantita)} pz</div><div class="sub">${l.scadenza ? 'scade ' + fmtDate(l.scadenza) + ' · ' + relDays(daysUntil(l.scadenza)) : 'senza scadenza'} · arrivato ${fmtDate(l.arrivo)}</div></div></div>`).join('')}</div>` : '<div class="empty">Nessuna confezione registrata.</div>'}
    <button class="btn danger block" type="button" data-act="p-elimina" data-id="${esc(p.id)}">Elimina prodotto</button>`;
  return {
    title: 'Scheda prodotto', html, back: '#catalogo', tab: 'catalogo',
    mount: b => {
      const upd = () => {
        const tmp = { prezzoAcquisto: parseNum(b.querySelector('#pAcq').value), iva: parseNum(b.querySelector('#pIva').value), ricarico: +b.querySelector('#pRic').value };
        b.querySelector('#pCalc').textContent = fmtEuro(prezzoCalcolato(tmp));
      };
      ['#pAcq', '#pIva', '#pRic'].forEach(s => b.querySelector(s).addEventListener('input', upd));
    },
    onScan: async code => {
      const prima = byCode(code);
      if (prima && prima.id === p.id) { toast('Questo codice è già collegato'); return; }
      if (prima && !(await confirmBox(`Il codice è collegato a "${prima.nome}". Lo sposto su questo prodotto?`, { ok: 'Sposta' }))) return;
      if (prima) await save('prodotti', { ...prima, codici: prima.codici.filter(c => c !== code) });
      const cur = prodotto(p.id);
      await save('prodotti', { ...cur, codici: [...new Set([...(cur.codici || []), code])] });
      toast('Codice collegato'); render();
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
   IMPOSTAZIONI, BACKUP
   ========================================================= */
let persistito = null;
routes.impostazioni = () => {
  const s = settings();
  const lb = S.meta.lastBackup;
  const html = `<div class="card"><h2>Backup su Drive</h2>
      <p class="muted small">I dati stanno solo su questo telefono. Il backup crea un file: nel menu che si apre scegli <b>Drive</b>. Fallo ogni giorno a fine lavoro.</p>
      <div class="faint">Ultimo backup: ${lb ? fmtDate(lb.slice(0, 10)) : 'mai'}</div>
      <button class="btn primary block" type="button" data-act="backup">Fai backup ora</button>
      <button class="btn block" type="button" data-act="ripristina">Ripristina da un backup</button></div>
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
    <div class="card"><h2>Informazioni</h2>
      <dl class="kv"><dt>Versione</dt><dd>${VERSIONE}</dd><dt>Dati protetti dalla pulizia del browser</dt><dd id="persist">${persistito == null ? '…' : persistito ? 'sì' : 'no'}</dd></dl>
      ${installPrompt ? `<button class="btn block" type="button" data-act="installa">Installa l'app sul telefono</button>` : ''}</div>`;
  return {
    title: 'Impostazioni', html, back: '#home',
    mount: () => { if (navigator.storage && navigator.storage.persisted) navigator.storage.persisted().then(v => { persistito = v; const el = $('#persist'); if (el) el.textContent = v ? 'sì' : 'no'; }); }
  };
};
async function faiBackup() {
  const data = { app: 'spesasfusa-magazzino', versione: 1, esportato: new Date().toISOString(), fornitori: [...S.fornitori.values()], prodotti: [...S.prodotti.values()], lotti: [...S.lotti.values()], ordini: [...S.ordini.values()], impostazioni: S.meta.settings || {} };
  const nome = `magazzino-backup-${todayISO()}.json`;
  const json = JSON.stringify(data);
  const file = new File([json], nome, { type: 'application/json' });
  let fatto = false;
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Backup magazzino' }); fatto = true; }
    catch (e) { if (e.name === 'AbortError') { toast('Backup annullato', { err: true }); return; } }
  }
  if (!fatto) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' })); a.download = nome;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000); fatto = true;
  }
  await setMeta('lastBackup', todayISO());
  toast('Backup pronto: salvalo su Drive'); render();
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
      if (!(await confirmBox(`Il backup è del ${fmtDate((data.esportato || '').slice(0, 10))}. Sostituisco tutti i dati di questo telefono?`, { ok: 'Ripristina', danger: true }))) return;
      for (const s of ['fornitori', 'prodotti', 'lotti', 'ordini']) { await tx(s, st => st.clear()); await tx(s, st => (data[s] || []).forEach(o => st.put(o))); }
      await setMeta('settings', data.impostazioni || {});
      await loadAll(); rebuildCodeIndex();
      toast('Dati ripristinati');
    }
    render();
  } catch (err) { toast(err.message, { err: true }); }
});

/* =========================================================
   Azioni (pulsanti)
   ========================================================= */
const A = {};
A['close-modal'] = () => closeModal();
A['close-modal-link'] = el => { closeModal(); location.hash = el.getAttribute('href'); };
A.back = () => { if (current.back) location.hash = current.back; else history.back(); };
A.camera = () => openCamera();
A['scrivi-codice'] = () => scriviCodice();
A.backup = () => faiBackup();
A.ripristina = () => { fileMode = 'ripristina'; $('#fileInput').click(); };
A['import-catalogo'] = () => { fileMode = 'catalogo'; $('#fileInput').click(); };
A.installa = async () => { if (!installPrompt) return; installPrompt.prompt(); try { await installPrompt.userChoice; } catch (e) { } installPrompt = null; render(); };
A['sr-carico'] = el => { closeModal(); CS = nuovoCarico('arrivo'); CS.pid = el.dataset.id; location.hash = '#carico/keep'; if (current.name === 'carico') render(); };
A['sr-ordina'] = async el => { closeModal(); await aggiungiOrdine(el.dataset.id); render(); };
/* arrivo merce */
A.modo = el => { const m = el.dataset.m; if (CS.pid && CS.modo !== m) { toast('Prima salva o annulla il prodotto aperto', { err: true }); return; } CS = nuovoCarico(m); location.hash = m === 'inventario' ? '#carico/inventario' : '#carico'; render(); };
A['carico-cerca'] = () => pickerModal({ title: 'Cerca il prodotto', onPick: p => { const m = CS.modo; CS = nuovoCarico(m); CS.pid = p.id; render(); } });
A['carico-annulla'] = () => { CS = nuovoCarico(CS.modo); render(); };
A['carico-salva'] = () => salvaCarico();
A['kp-field'] = el => { CS.field = el.dataset.f; if (CS.field === 'qta') CS.qtaFresh = true; render(); };
A.kp = el => {
  const k = el.dataset.k;
  if (CS.field === 'qta') {
    if (k === 'back') CS.qta = CS.qta.slice(0, -1);
    else { CS.qta = (CS.qtaFresh ? '' : CS.qta) + k; CS.qta = CS.qta.replace(/^0+(?=\d)/, '').slice(0, 4); }
    CS.qtaFresh = false;
  } else {
    if (CS.senza) return;
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
A['lot-buttato'] = async el => {
  const l = S.lotti.get(el.dataset.id); if (!l) return;
  const p = prodotto(l.prodottoId);
  let q = l.quantita;
  openModal(`${mhead('Quanti ne buttate?')}<div class="faint">${esc(p ? p.nome : '')} · scade ${fmtDate(l.scadenza)}</div>
    <div class="stepper"><button type="button" data-x="-">−</button><input type="number" inputmode="numeric" id="bQ" value="${q}" min="1" max="${l.quantita}"><button type="button" data-x="+">+</button></div>
    <button class="btn danger block" type="button" data-x="ok">Segna come buttati</button>`, b => {
    const i = b.querySelector('#bQ');
    b.querySelector('[data-x="-"]').onclick = () => { i.value = Math.max(1, (+i.value || 1) - 1); };
    b.querySelector('[data-x="+"]').onclick = () => { i.value = Math.min(l.quantita, (+i.value || 0) + 1); };
    b.querySelector('[data-x=ok]').onclick = async () => {
      const n = Math.min(l.quantita, Math.max(1, parseInt(i.value, 10) || 1));
      const sprechi = [...(l.sprechi || []), { data: todayISO(), qta: n }];
      const nl = n >= l.quantita ? { ...l, stato: 'buttato', chiuso: todayISO(), sprechi } : { ...l, quantita: l.quantita - n, sprechi };
      await save('lotti', nl); closeModal(); toast(`Buttati: ${n}`); render();
    };
  });
};
A['lot-modifica'] = el => {
  const l = S.lotti.get(el.dataset.id); if (!l) return;
  const [y, m, d] = (l.scadenza || '').split('-');
  openModal(`${mhead('Modifica')}
    <label class="field">Quantità<input type="number" inputmode="numeric" id="mQ" value="${l.quantita}" min="1"></label>
    <label class="field">Scadenza <span class="hint">6 cifre, es. 280527</span><input type="text" inputmode="numeric" id="mS" value="${l.scadenza ? d + m + y.slice(2) : ''}"></label>
    <button class="btn primary block" type="button" id="mOk">Salva</button>
    <button class="btn danger block" type="button" id="mDel">Elimina questa riga</button>`, b => {
    b.querySelector('#mOk').onclick = async () => {
      const q = parseInt(b.querySelector('#mQ').value, 10);
      const r = parseScadenza(b.querySelector('#mS').value);
      if (!q || q < 1) { toast('Quantità non valida', { err: true }); return; }
      if (!r) { toast('Data non valida', { err: true }); return; }
      await save('lotti', { ...l, quantita: q, scadenza: r.iso }); closeModal(); render();
    };
    b.querySelector('#mDel').onclick = async () => { closeModal(); if (await confirmBox('Elimino questa riga? Non conta come spreco.', { ok: 'Elimina', danger: true })) { await remove('lotti', l.id); render(); } };
  });
};
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
  const nome = $('#pNome').value.trim(); if (!nome) { toast('Il nome non può essere vuoto', { err: true }); return; }
  const man = $('#pMan').value.trim();
  await save('prodotti', {
    ...p, nome, fornitoreId: $('#pForn').value, formato: $('#pFormato').value.trim(), categoria: $('#pCat').value.trim(), tipoScadenza: $('#pTipo').value,
    prezzoAcquisto: parseNum($('#pAcq').value), iva: parseNum($('#pIva').value), ricarico: +$('#pRic').value, prezzoManuale: man ? parseNum(man) : null, note: $('#pNote').value.trim()
  });
  toast('Salvato'); render();
};
A['p-codice-del'] = async el => { const p = prodotto(current.arg); if (!p) return; await save('prodotti', { ...p, codici: (p.codici || []).filter(c => c !== el.dataset.c) }); render(); };
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
  await setMeta('settings', { soglie, negozio: $('#sNeg').value.trim() || DEFAULT_SETTINGS.negozio });
  toast('Impostazioni salvate'); render();
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
  route();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persisted().then(p => { persistito = p; if (!p) navigator.storage.persist().then(v => { persistito = v; }); });
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').then(reg => {
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        if (w) w.addEventListener('statechange', () => { if (w.state === 'activated' && navigator.serviceWorker.controller) toast('È pronta una nuova versione dell\'app', { action: { label: 'Aggiorna', run: () => location.reload() } }); });
      });
    }).catch(() => { });
  }
  window.__app = { S, onScan, parseScadenza, save, VERSIONE };
}
init();
})();
