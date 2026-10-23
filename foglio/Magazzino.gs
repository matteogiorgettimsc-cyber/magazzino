/**
 * @OnlyCurrentDoc
 * Magazzino – La Spesa Sfusa: foglio Google collegato all'app, nei due sensi.
 *
 * - Listini (un foglio per fornitore, diviso per categoria): si possono cambiare nome, formato,
 *   codice a barre, prezzo d'acquisto, IVA, ricarico, prezzo di vendita e note, e aggiungere prodotti
 *   (nella riga vuota sotto la categoria). Le modifiche arrivano nell'app entro pochi secondi.
 * - Magazzino, Scadenze e Riepilogo del mese: si aggiornano da soli con i dati dell'app.
 * - Il foglio si aggiorna ogni 10 minuti, o subito dal menu «Magazzino → Aggiorna adesso».
 *
 * Come si collega: Estensioni → Apps Script, incolla questo codice, salva, torna al foglio,
 * ricarica la pagina, menu «Magazzino → Collega il foglio» e scrivi la password del negozio.
 * La password non resta da nessuna parte: si tiene solo il «biglietto» di accesso di Firebase.
 */
var CONF_BASE = {
  apiKey: 'AIzaSyBj_vigsG7m3jQg3MaRSBTwoKkXcPB3HKk', projectId: 'magazzino-spesa-sfusa-69c90', email: 'laspesasfusa@gmail.com',
  authUrl: 'https://identitytoolkit.googleapis.com/v1', tokenUrl: 'https://securetoken.googleapis.com/v1', fsUrl: 'https://firestore.googleapis.com/v1'
};
var SERVONO = ['prodotti', 'fornitori', 'lotti', 'vendite', 'chiusure', 'sprechi', 'meta'];   // le chiavi delle notifiche e le iscrizioni restano fuori dal foglio
var FISSI = ['Leggimi', 'Fornitori', 'Magazzino', 'Scadenze', 'Riepilogo', '_dati', '_coda'];
var FV_UNITA = { kg: { nome: 'kg', f: 1 }, etto: { nome: 'etto', f: 0.1 }, l: { nome: 'litro', f: 1 } };
var COL = { id: 1, nome: 2, formato: 3, codici: 4, unita: 5, acq: 6, iva: 7, ric: 8, vendita: 9, tipo: 10, note: 11 };
var TESTA = ['ID', 'Prodotto', 'Formato', 'Codice a barre', 'Unità', 'Acquisto € (senza IVA)', 'IVA %', 'Ricarico %', 'Vendita € (con IVA)', 'Prezzo di vendita', 'Note'];
var PRIMA = 5;   // prima riga dei prodotti
var EURO = '#,##0.00 "€"';
var GRIGIO = '#EEF0E8', VERDE = '#DEE8D8';
var INIZIO = Date.now(), LAVORO = 0;   // Google ferma uno script dopo 6 minuti: oltre i 4 e mezzo si salva il punto e si continua al giro dopo
function limite_() { var l = conf_().limiteMs; return l != null ? l : 270000; }
function basta_() { return LAVORO > 0 && Date.now() - INIZIO > limite_(); }

/* ---------------- menu ---------------- */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Magazzino')
    .addItem('Aggiorna adesso', 'aggiornaAdesso')
    .addItem('Rifai tutti i fogli', 'ricostruisci')
    .addSeparator()
    .addItem('Collega il foglio', 'collega')
    .addItem('Scollega', 'scollega')
    .addToUi();
}
function collega() {
  var ui = SpreadsheetApp.getUi();
  var r = ui.prompt('Collega il foglio all\'app', 'Password dell\'account del negozio (' + conf_().email + '):', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK || !r.getResponseText()) return;
  var esito;
  try { esito = collegaConPassword(r.getResponseText()); }
  catch (e) { ui.alert('Non collegato', e.message + '\n\nRiprova dal menu Magazzino → Collega il foglio.', ui.ButtonSet.OK); return; }
  ui.alert('Collegato!', esito === 'fatto' ? 'Il foglio si aggiorna da solo ogni 10 minuti.'
    : 'I dati sono tanti: finisco di preparare i fogli da solo nei prossimi minuti, non serve fare niente. Nel foglio «Leggimi» vedi a che punto sono.', ui.ButtonSet.OK);
}
function collegaConPassword(password) {
  var a;
  try { a = accedi_(password); } catch (e) { if (String(password).trim() === password) throw e; a = accedi_(String(password).trim()); }   // spazio finale messo dalla tastiera
  var P = props_();
  P.setProperty('refresh', a.refreshToken);
  CacheService.getScriptCache().put('token', a.idToken, 3000);
  ['syncDa', 'firme', 'sospeso'].forEach(function (k) { P.deleteProperty(k); });
  installaTrigger_();
  return aggiorna({ tutto: true });
}
function scollega() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ['refresh', 'seguito', 'sospeso'].forEach(function (k) { props_().deleteProperty(k); }); CacheService.getScriptCache().remove('token');
  SpreadsheetApp.getActive().toast('Scollegato: il foglio non si aggiorna più con l\'app.', 'Magazzino', 6);
}
function aggiornaAdesso() { var e = aggiorna({}); SpreadsheetApp.getActive().toast(e === 'sospeso' ? 'Tante novità: continuo da solo tra un minuto.' : e === 'occupato' ? 'Un aggiornamento è già in corso: tra poco è tutto pronto.' : 'Aggiornato con l\'app.', 'Magazzino', 5); }
function ricostruisci() { props_().deleteProperty('firme'); props_().deleteProperty('sospeso'); var e = aggiorna({ tutto: true }); SpreadsheetApp.getActive().toast(e === 'sospeso' ? 'Sto rifacendo i fogli: finisco da solo nei prossimi minuti.' : 'Fogli rifatti.', 'Magazzino', 6); }
function installaTrigger_() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  props_().deleteProperty('seguito');
  ScriptApp.newTrigger('aggiorna').timeBased().everyMinutes(10).create();
  ScriptApp.newTrigger('quandoModifichi').forSpreadsheet(SpreadsheetApp.getActive()).onEdit().create();
}

function continua_() {   // lavoro a metà: un giro in più tra un minuto, senza aspettare i 10
  var P = props_(); if (P.getProperty('seguito')) return;
  P.setProperty('seguito', ScriptApp.newTrigger('aggiorna').timeBased().after(60000).create().getUniqueId());
}
function pulisciSeguito_() {
  var P = props_(), id = P.getProperty('seguito'); if (!id) return;
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getUniqueId() === id) ScriptApp.deleteTrigger(t); });
  P.deleteProperty('seguito');
}

/* ---------------- Firebase ---------------- */
function props_() { return PropertiesService.getScriptProperties(); }
function conf_() { var o = props_().getProperty('conf'); var c = JSON.parse(JSON.stringify(CONF_BASE)); if (o) { var x = JSON.parse(o); for (var k in x) c[k] = x[k]; } return c; }
function nb_() { return 'projects/' + conf_().projectId + '/databases/(default)/documents'; }
function docId_(st, id) { return encodeURIComponent(st + '~' + id); }
function chiama_(url, opz) {
  opz.muteHttpExceptions = true;
  var r = UrlFetchApp.fetch(url, opz), testo = r.getContentText(), j = null;
  try { j = testo ? JSON.parse(testo) : null; } catch (e) { }
  return { code: r.getResponseCode(), j: j };
}
function accedi_(password) {
  var c = conf_();
  var r = chiama_(c.authUrl + '/accounts:signInWithPassword?key=' + encodeURIComponent(c.apiKey), { method: 'post', contentType: 'application/json', payload: JSON.stringify({ email: c.email, password: password, returnSecureToken: true }) });
  if (r.code !== 200) throw new Error(/INVALID|PASSWORD|EMAIL/.test(JSON.stringify(r.j)) ? 'password sbagliata' : 'accesso non riuscito (' + r.code + ')');
  return { idToken: r.j.idToken, refreshToken: r.j.refreshToken };
}
function token_() {
  var cache = CacheService.getScriptCache(), t = cache.get('token');
  if (t) return t;
  var c = conf_(), rt = props_().getProperty('refresh');
  if (!rt) throw new Error('Foglio non collegato: menu Magazzino → Collega all\'app');
  var r = chiama_(c.tokenUrl + '/token?key=' + encodeURIComponent(c.apiKey), { method: 'post', contentType: 'application/x-www-form-urlencoded', payload: 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(rt) });
  if (r.code !== 200) throw new Error('Accesso scaduto: menu Magazzino → Collega all\'app');
  if (r.j.refresh_token && r.j.refresh_token !== rt) props_().setProperty('refresh', r.j.refresh_token);
  cache.put('token', r.j.id_token, 3000);
  return r.j.id_token;
}
function fs_(path, body, method) {
  var c = conf_(), opz = { method: method || 'post', headers: { Authorization: 'Bearer ' + token_() } };
  if (body) { opz.contentType = 'application/json'; opz.payload = JSON.stringify(body); }
  var r = chiama_(c.fsUrl + '/' + nb_() + path, opz);
  if (r.code === 401) { CacheService.getScriptCache().remove('token'); opz.headers.Authorization = 'Bearer ' + token_(); r = chiama_(c.fsUrl + '/' + nb_() + path, opz); }
  if (r.code < 200 || r.code >= 300) throw new Error('Firebase: ' + ((r.j && r.j.error && r.j.error.message) || r.code));
  return r.j;
}
/* un documento dell'app: campi f_<nome> in JSON; per le confezioni la quantità è la somma dei q_<dispositivo> */
function leggiDoc_(d) {
  var f = d.fields || {}, rec = {}, k;
  var st = f.st && f.st.stringValue, rid = f.rid && f.rid.stringValue;
  if (!st || rid == null) return null;
  for (k in f) if (k.indexOf('f_') === 0 && f[k].stringValue != null) { try { rec[k.slice(2)] = JSON.parse(f[k].stringValue); } catch (e) { } }
  if (st === 'lotti') { var q = 0; for (k in f) if (/^q_\d+$/.test(k)) q += +(f[k].doubleValue != null ? f[k].doubleValue : f[k].integerValue || 0); rec.quantita = Math.round(q * 1000) / 1000; }
  if (rec.id === undefined) rec.id = rid;
  return { st: st, id: String(rec.id), del: !!(f.del && f.del.booleanValue), rec: rec, srv: f.srv && f.srv.timestampValue };
}
function scrittura_(st, id, set) {
  var fields = { st: { stringValue: st }, rid: { stringValue: String(id) }, del: { booleanValue: false } }, mask = ['st', 'rid', 'del'];
  for (var k in set) { fields['f_' + k] = { stringValue: JSON.stringify(set[k] === undefined ? null : set[k]) }; mask.push('f_' + k); }
  return { update: { name: nb_() + '/dati/' + docId_(st, id), fields: fields }, updateMask: { fieldPaths: mask }, updateTransforms: [{ fieldPath: 'srv', setToServerValue: 'REQUEST_TIME' }] };
}

/* ---------------- copia dei dati nel foglio nascosto «_dati» ---------------- */
function foglio_(nome, crea) {
  var ss = SpreadsheetApp.getActive(), sh = ss.getSheetByName(nome);
  if (!sh && crea) { sh = ss.insertSheet(nome); if (nome.charAt(0) === '_') sh.hideSheet(); }
  return sh;
}
function leggiCopia_() {
  var sh = foglio_('_dati', true), n = sh.getLastRow(), m = {}, righe = {};
  if (n > 0) sh.getRange(1, 1, n, 2).getValues().forEach(function (r, i) { if (r[0]) { try { m[r[0]] = JSON.parse(r[1]); righe[r[0]] = i + 1; } catch (e) { } } });
  Object.defineProperty(m, '_righe', { value: righe, enumerable: false });
  return m;
}
function scriviRighe_(m, chiavi) {
  var sh = foglio_('_dati', true), ultima = sh.getLastRow(), righe = m._righe || {};
  chiavi.forEach(function (k) {
    if (!righe[k]) { ultima++; righe[k] = ultima; }
    sh.getRange(righe[k], 1, 1, 2).setValues([[k, JSON.stringify(m[k])]]);
  });
}
function scriviCopia_(m) {
  var sh = foglio_('_dati', true), righe = Object.keys(m).sort().map(function (k) { return [k, JSON.stringify(m[k])]; });
  sh.clearContents();
  if (righe.length) sh.getRange(1, 1, righe.length, 2).setValues(righe);
}
function novita_() {   // una lettura sola: c'è qualcosa di più recente dell'ultima volta?
  var da = props_().getProperty('syncDa'); if (!da) return true;
  var u = (fs_(':runQuery', { structuredQuery: { from: [{ collectionId: 'dati' }], orderBy: [{ field: { fieldPath: 'srv' }, direction: 'DESCENDING' }], limit: 1 } }) || []).filter(function (x) { return x.document; });
  return u.length > 0 && Date.parse(u[0].document.fields.srv.timestampValue) > Date.parse(da);
}
function scarica_(copia) {
  var P = props_(), da = P.getProperty('syncDa'), cursore = null, max = da, cambiati = {}, LIM = 300, docs = [];
  var dal = da ? new Date(Date.parse(da) - 15000).toISOString() : '1970-01-01T00:00:00Z';
  for (;;) {
    var q = { from: [{ collectionId: 'dati' }], where: { fieldFilter: { field: { fieldPath: 'srv' }, op: 'GREATER_THAN_OR_EQUAL', value: { timestampValue: dal } } },
      orderBy: [{ field: { fieldPath: 'srv' }, direction: 'ASCENDING' }, { field: { fieldPath: '__name__' }, direction: 'ASCENDING' }], limit: LIM };
    if (cursore) q.startAt = { values: [{ timestampValue: cursore.srv }, { referenceValue: cursore.name }], before: false };
    var pag = (fs_(':runQuery', { structuredQuery: q }) || []).filter(function (x) { return x.document; }).map(function (x) { return x.document; });
    docs = docs.concat(pag);
    if (pag.length < LIM) break;
    if (Date.now() - INIZIO > limite_() * 0.6) { cambiati._incompleto = true; break; }   // il resto al giro dopo (si riparte dall'ultimo documento letto)
    var ul = pag[pag.length - 1]; cursore = { srv: ul.fields.srv.timestampValue, name: ul.name };
  }
  docs.forEach(function (d) {
    var r = leggiDoc_(d); if (!r || SERVONO.indexOf(r.st) < 0 || (r.st === 'meta' && r.id !== 'settings')) return;
    var k = r.st + '~' + r.id;
    if (r.del) { if (copia[k]) { delete copia[k]; cambiati[r.st] = true; } }
    else if (JSON.stringify(copia[k]) !== JSON.stringify(r.rec)) { copia[k] = r.rec; cambiati[r.st] = true; }
    if (r.srv && (!max || Date.parse(r.srv) > Date.parse(max))) max = r.srv;
  });
  if (max && max !== da) P.setProperty('syncDa', max);
  // vendite, sprechi e chiusure servono solo per il riepilogo: si tengono gli ultimi due mesi
  var limite = primoDelMeseScorso_();
  Object.keys(copia).forEach(function (k) { var st = k.split('~')[0]; if ((st === 'vendite' || st === 'sprechi' || st === 'chiusure') && copia[k].data && copia[k].data < limite) delete copia[k]; });
  return cambiati;
}
function oggi_() { return Utilities.formatDate(new Date(), 'Europe/Rome', 'yyyy-MM-dd'); }
function primoDelMeseScorso_() { var o = oggi_(), y = +o.slice(0, 4), m = +o.slice(5, 7) - 1; if (m < 1) { m = 12; y--; } return y + '-' + ('0' + m).slice(-2) + '-01'; }

/* ---------------- il giro: prima le modifiche del foglio in attesa, poi quelle dell'app ---------------- */
function aggiorna(opz) {
  opz = opz && opz.tutto !== undefined ? opz : {};
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) return 'occupato';
  var P = props_(), ora = function () { return Utilities.formatDate(new Date(), 'Europe/Rome', 'dd/MM/yyyy HH:mm'); };
  try {
    pulisciSeguito_();
    if (!P.getProperty('refresh')) return 'scollegato';
    var sospeso = P.getProperty('sospeso'), fatti = sospeso && !opz.tutto ? JSON.parse(sospeso) : [];
    var tutto = !!opz.tutto || !!sospeso || !P.getProperty('firme'), coda = foglio_('_coda', false), inCoda = !!(coda && coda.getLastRow());
    if (!tutto && !inCoda && !novita_()) { leggimi_('Ultimo aggiornamento: ' + ora() + ' (nessuna novità)'); return 'niente'; }
    var copia = leggiCopia_();
    mandaCoda_(copia);
    var cambiati = scarica_(copia);
    if (!tutto && !Object.keys(cambiati).length) { leggimi_('Ultimo aggiornamento: ' + ora() + ' (nessuna novità)'); return 'niente'; }
    scriviCopia_(copia);
    var sospendi = function (cosa) {
      P.setProperty('sospeso', JSON.stringify(fatti)); continua_();
      leggimi_('Sto ancora ' + cosa + ' (' + ora() + '): continuo da solo tra un minuto, non serve fare niente.');
      return 'sospeso';
    };
    if (cambiati._incompleto) return sospendi('scaricando i dati dall\'app');
    var s = stato_(copia), firme = JSON.parse(P.getProperty('firme') || '{}');
    var passi = [
      ['listini', tutto || cambiati.prodotti || cambiati.fornitori || !firme._listini, function () { return listini_(s, firme); }],
      ['magazzino', tutto || cambiati.prodotti || cambiati.fornitori || cambiati.lotti, function () { magazzino_(s); }],
      ['scadenze', tutto || cambiati.prodotti || cambiati.fornitori || cambiati.lotti, function () { scadenze_(s); }],
      ['riepilogo', tutto || cambiati.vendite || cambiati.chiusure || cambiati.sprechi || cambiati.prodotti, function () { riepilogo_(s); }]
    ];
    for (var i = 0; i < passi.length; i++) {
      var p = passi[i];
      if (!p[1] || fatti.indexOf(p[0]) >= 0) continue;
      if (basta_()) return sospendi('preparando i fogli');
      var finito = p[2]() !== false;
      P.setProperty('firme', JSON.stringify(firme));
      if (!finito) return sospendi('preparando i fogli dei fornitori');
      fatti.push(p[0]); LAVORO++;
    }
    P.deleteProperty('sospeso');
    leggimi_('Ultimo aggiornamento: ' + ora());
    return 'fatto';
  } catch (e) {
    leggimi_('Ultimo tentativo non riuscito (' + ora() + '): ' + e.message);
    throw e;
  } finally { lock.releaseLock(); }
}
function stato_(copia) {
  var s = { prodotti: {}, fornitori: {}, lotti: [], vendite: [], chiusure: [], sprechi: [], settings: null };
  Object.keys(copia).forEach(function (k) {
    var st = k.split('~')[0], r = copia[k];
    if (st === 'prodotti') s.prodotti[r.id] = r; else if (st === 'fornitori') s.fornitori[r.id] = r;
    else if (st === 'lotti') s.lotti.push(r); else if (st === 'vendite') s.vendite.push(r);
    else if (st === 'chiusure') s.chiusure.push(r); else if (st === 'sprechi') s.sprechi.push(r);
    else if (k === 'meta~settings') s.settings = r.value;
  });
  return s;
}

/* ---------------- prezzi, come nell'app ---------------- */
function unita_(p) { return !p.sfuso ? { nome: 'pezzo', f: 1 } : (FV_UNITA[p.unita] || FV_UNITA.kg); }
function calcolato_(p) { if (p.prezzoAcquisto == null || p.iva == null) return null; var ric = p.ricarico || 50; return Math.ceil(p.prezzoAcquisto * (1 + ric / 100) * (1 + p.iva / 100) * 10 - 1e-9) / 10; }
function vendita_(p) { return p.prezzoManuale != null ? p.prezzoManuale : calcolato_(p); }
function per_(p, x) { return x == null ? '' : Math.round(x * unita_(p).f * 100) / 100; }
function per3_(p, x) { return x == null ? '' : Math.round(x * unita_(p).f * 1000) / 1000; }
function nomeForn_(s, fid) { return fid && s.fornitori[fid] ? s.fornitori[fid].nome : 'Senza fornitore'; }
function catDi_(p) { return (p.categoria || '').trim(); }
var CATEGORIE_BASE = ['Frutta e verdura', 'Pasta', 'Riso e cereali', 'Farine, lieviti e preparati', 'Legumi', 'Frutta secca e semi', 'Pane, crackers e snack salati', 'Biscotti e dolci', 'Cioccolato e caramelle', 'Miele, confetture e creme', 'Latte, formaggi e uova', 'Salumi e carne', 'Pesce', 'Gastronomia e pasta fresca', 'Sughi, conserve e sottoli', 'Olio, aceto e condimenti', 'Spezie, sale e brodi', 'Caffè, tè e tisane', 'Bevande e succhi', 'Vino, birra e liquori', 'Zucchero e dolcificanti', 'Detersivi e casa', 'Cura della persona', 'Altro'];
function ordineCat_(c) { return c === 'Senza categoria' ? 999 : CATEGORIE_BASE.indexOf(c) >= 0 ? CATEGORIE_BASE.indexOf(c) : 100; }
function rigaProdotto_(p) {
  var v = vendita_(p);
  return [p.id, p.nome || '', p.formato || '', (p.codici || []).join(', '), unita_(p).nome, per3_(p, p.prezzoAcquisto), p.iva != null ? p.iva : '', p.prezzoAcquisto != null && p.prezzoManuale == null ? (p.ricarico || 50) : (p.ricarico && p.ricarico !== 50 ? p.ricarico : ''),
    per_(p, v), p.prezzoManuale != null ? 'scritto a mano' : v != null ? 'calcolato' : 'manca', p.note || ''];
}

/* ---------------- listini: un foglio per fornitore ---------------- */
function nomeFoglio_(nome, usati) {
  var base = String(nome || '').replace(/[\\\/?*\[\]:]/g, ' ').replace(/\s+/g, ' ').replace(/^'+|'+$/g, '').trim().slice(0, 31).trim() || 'Fornitore', n = base, k = 2;
  while (usati[n.toLowerCase()] || n.toLowerCase() === 'history') { var suf = ' (' + (k++) + ')'; n = base.slice(0, 31 - suf.length).trim() + suf; }
  usati[n.toLowerCase()] = 1; return n;
}
function gruppi_(s) {
  var per = {};
  Object.keys(s.prodotti).forEach(function (id) { var p = s.prodotti[id], fid = p.fornitoreId && s.fornitori[p.fornitoreId] ? p.fornitoreId : '-'; (per[fid] = per[fid] || []).push(p); });
  Object.keys(s.fornitori).forEach(function (fid) { if (!per[fid]) per[fid] = []; });
  return per;
}
function righeListino_(s, fid, prodotti) {
  var cats = {};
  prodotti.forEach(function (p) { var c = catDi_(p) || 'Senza categoria'; (cats[c] = cats[c] || []).push(p); });
  var nomi = Object.keys(cats).sort(function (a, b) { return ordineCat_(a) - ordineCat_(b) || a.localeCompare(b, 'it'); });
  var righe = [['fornitore', 'Listino ' + nomeForn_(s, fid === '-' ? '' : fid)], [fid, prodotti.length + ' prodotti · le celle bianche si cambiano qui e arrivano nell\'app; quelle grigie le decide l\'app'],
    ['', 'Prodotto nuovo: scrivilo nella riga vuota sotto la sua categoria. Prezzi per unità: a pezzo, o al kg / all\'etto / al litro per lo sfuso. Vendita: scrivi il prezzo per fissarlo a mano; cancellalo per tornare al prezzo calcolato da acquisto, ricarico e IVA.'], TESTA.slice()];
  var tipi = [];
  nomi.forEach(function (c) {
    righe.push(['CAT:' + c, c + ' · ' + cats[c].length]); tipi.push('cat');
    cats[c].sort(function (a, b) { return (a.nome || '').localeCompare(b.nome || '', 'it'); }).forEach(function (p) { righe.push(rigaProdotto_(p)); tipi.push('p'); });
    righe.push(['']); tipi.push('vuota');
  });
  if (!nomi.length) { righe.push(['CAT:Senza categoria', 'Senza categoria · 0']); tipi.push('cat'); righe.push(['']); tipi.push('vuota'); }
  return { righe: righe.map(function (r) { while (r.length < TESTA.length) r.push(''); return r; }), tipi: tipi };
}
function firma_(x) { return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, JSON.stringify(x), Utilities.Charset.UTF_8)); }
function listini_(s, firme) {   // false = fermato a metà per il tempo: si riprende dal fornitore dopo
  var ss = SpreadsheetApp.getActive(), per = gruppi_(s), usati = {};
  FISSI.forEach(function (n) { usati[n.toLowerCase()] = 1; });
  var esistenti = {};
  ss.getSheets().forEach(function (sh) { if (FISSI.indexOf(sh.getName()) < 0 && sh.getRange(1, 1).getValue() === 'fornitore') esistenti[String(sh.getRange(2, 1).getValue())] = sh; });
  var fids = Object.keys(per).filter(function (fid) { return per[fid].length; })
    .sort(function (a, b) { return (a === '-') - (b === '-') || nomeForn_(s, a === '-' ? '' : a).localeCompare(nomeForn_(s, b === '-' ? '' : b), 'it'); });
  var indice = [];
  for (var i = 0; i < fids.length; i++) {
    var fid = fids[i], nome = nomeFoglio_(nomeForn_(s, fid === '-' ? '' : fid), usati), r = righeListino_(s, fid, per[fid]), f = firma_([nome, r.righe]);
    var sh = esistenti[fid];
    if (!sh || firme[fid] !== f) {
      if (basta_()) return false;
      if (sh && sh.getName() !== nome) sh.setName(nome);
      if (!sh) sh = ss.insertSheet(nome);
      scriviListino_(sh, r); firme[fid] = f; LAVORO++;
      props_().setProperty('firme', JSON.stringify(firme));
    }
    delete esistenti[fid];
    var fo = s.fornitori[fid];
    indice.push([nomeForn_(s, fid === '-' ? '' : fid), nome, per[fid].length, r.tipi.filter(function (t) { return t === 'cat'; }).length, fo ? fo.telefono || '' : '', fo ? fo.email || '' : '', fo ? fo.sito || '' : '']);
  }
  Object.keys(esistenti).forEach(function (fid) { ss.deleteSheet(esistenti[fid]); delete firme[fid]; });   // fornitore tolto nell'app
  var ix = foglio_('Fornitori', true);
  scriviTabella_(ix, 'Listini dei fornitori', 'Un foglio per fornitore, dentro divisi per categoria. Aggiornato dall\'app.', ['Fornitore', 'Foglio', 'Prodotti', 'Categorie', 'Telefono', 'Email', 'Sito'], indice, { larghezze: [220, 200, 80, 80, 120, 200, 200] });
  firme._listini = 1;
}
function scriviListino_(sh, r) {
  var n = r.righe.length;
  sh.clear();
  sh.getRange(1, 1, n, TESTA.length).setValues(r.righe);
  sh.getRange(1, 2).setFontSize(14).setFontWeight('bold');
  sh.getRange(2, 2, 2, 1).setFontColor('#56604F');
  sh.getRange(4, 1, 1, TESTA.length).setFontWeight('bold');
  sh.setFrozenRows(4);
  sh.hideColumns(1);
  if (n >= PRIMA) {
    sh.getRange(PRIMA, COL.acq, n - PRIMA + 1, 1).setNumberFormat('#,##0.00##" €"');
    sh.getRange(PRIMA, COL.vendita, n - PRIMA + 1, 1).setNumberFormat(EURO);
    sh.getRange(PRIMA, COL.unita, n - PRIMA + 1, 1).setBackground(GRIGIO);
    sh.getRange(PRIMA, COL.tipo, n - PRIMA + 1, 1).setBackground(GRIGIO);
    sh.getRange(PRIMA, COL.codici, n - PRIMA + 1, 1).setNumberFormat('@');
    r.tipi.forEach(function (t, i) { if (t === 'cat') sh.getRange(PRIMA + i, 1, 1, TESTA.length).setBackground(VERDE).setFontWeight('bold'); });
  }
  [1, 260, 110, 130, 60, 110, 60, 80, 110, 110, 260].forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
}

/* ---------------- fogli che arrivano solo dall'app ---------------- */
function scriviTabella_(sh, titolo, sotto, testa, righe, opz) {
  opz = opz || {};
  sh.clear();
  var tutte = [[titolo], [sotto], [], testa].concat(righe), w = testa.length;
  tutte = tutte.map(function (r) { r = r.slice(); while (r.length < w) r.push(''); return r; });
  sh.getRange(1, 1, tutte.length, w).setValues(tutte);
  sh.getRange(1, 1).setFontSize(14).setFontWeight('bold'); sh.getRange(2, 1).setFontColor('#56604F');
  sh.getRange(4, 1, 1, w).setFontWeight('bold').setBackground(VERDE);
  sh.setFrozenRows(4);
  if (righe.length && opz.formati) opz.formati.forEach(function (f, i) { if (f) sh.getRange(5, i + 1, righe.length, 1).setNumberFormat(f); });
  if (opz.larghezze) opz.larghezze.forEach(function (x, i) { sh.setColumnWidth(i + 1, x); });
}
function attivi_(s) { return s.lotti.filter(function (l) { return l.stato === 'attivo' && l.quantita > 0; }); }
function data_(iso) { return iso ? new Date(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10), 12) : ''; }
function magazzino_(s) {
  var per = {};
  attivi_(s).forEach(function (l) { var p = s.prodotti[l.prodottoId]; if (!p) return; var e = per[p.id] = per[p.id] || { p: p, q: 0, n: 0, scad: null }; e.q += l.quantita; e.n++; if (l.scadenza && (!e.scad || l.scadenza < e.scad)) e.scad = l.scadenza; });
  var righe = Object.keys(per).map(function (k) { return per[k]; })
    .sort(function (a, b) { return ordineCat_(catDi_(a.p) || 'Senza categoria') - ordineCat_(catDi_(b.p) || 'Senza categoria') || (catDi_(a.p)).localeCompare(catDi_(b.p), 'it') || a.p.nome.localeCompare(b.p.nome, 'it'); })
    .map(function (e) { var u = e.p.sfuso ? (e.p.unita === 'l' ? 'litri' : 'kg') : 'pz'; return [e.p.nome, catDi_(e.p) || 'Senza categoria', nomeForn_(s, e.p.fornitoreId), Math.round(e.q * 1000) / 1000, u, e.n, data_(e.scad), e.p.prezzoAcquisto != null ? Math.round(e.p.prezzoAcquisto * e.q * 100) / 100 : '']; });
  var tot = righe.reduce(function (t, r) { return t + (+r[7] || 0); }, 0);
  scriviTabella_(foglio_('Magazzino', true), 'Magazzino', 'Quello che c\'è in negozio adesso, dall\'app · valore al prezzo d\'acquisto: ' + tot.toFixed(2).replace('.', ',') + ' €',
    ['Prodotto', 'Categoria', 'Fornitore', 'In negozio', 'Unità', 'Confezioni', 'Prossima scadenza', 'Valore al costo €'], righe, { formati: ['', '', '', '0.###', '', '0', 'dd/mm/yyyy', EURO], larghezze: [260, 180, 180, 90, 60, 90, 120, 120] });
}
function scadenze_(s) {
  var oggi = oggi_(), t0 = data_(oggi).getTime();
  var righe = attivi_(s).filter(function (l) { return l.scadenza; }).sort(function (a, b) { return a.scadenza.localeCompare(b.scadenza); }).map(function (l) {
    var p = s.prodotti[l.prodottoId] || { nome: '?', sfuso: false }, g = Math.round((data_(l.scadenza).getTime() - t0) / 86400000);
    return [data_(l.scadenza), g, p.nome, Math.round(l.quantita * 1000) / 1000, p.sfuso ? (p.unita === 'l' ? 'litri' : 'kg') : 'pz', nomeForn_(s, p.fornitoreId), g < 0 ? 'scaduto' : g === 0 ? 'scade oggi' : g === 1 ? 'domani' : 'tra ' + g + ' giorni', l.gestito ? (l.nota || 'gestito') : ''];
  });
  scriviTabella_(foglio_('Scadenze', true), 'Scadenze', 'Le confezioni in negozio, dalla scadenza più vicina · dall\'app', ['Scadenza', 'Giorni', 'Prodotto', 'Quantità', 'Unità', 'Fornitore', 'Quando', 'Gestito'], righe,
    { formati: ['dd/mm/yyyy', '0', '', '0.###', '', '', '', ''], larghezze: [100, 60, 260, 80, 60, 180, 110, 160] });
}
function riepilogo_(s) {
  var oggi = oggi_(), mese = oggi.slice(0, 7), MESI = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
  var dentro = function (d) { return d && d.slice(0, 7) === mese; };
  var incassi = s.chiusure.filter(function (c) { return dentro(c.data); }).sort(function (a, b) { return a.data.localeCompare(b.data); });
  var cat = {}, totV = 0;
  s.vendite.filter(function (v) { return dentro(v.data) && v.prodottoId; }).forEach(function (v) {
    var p = s.prodotti[v.prodottoId], pr = v.prezzo != null ? v.prezzo : p ? vendita_(p) : null; if (pr == null) return;
    var imp = Math.round(pr * v.qta * (v.tipo === 'reso' ? -1 : 1) * 100) / 100, c = p ? catDi_(p) || 'Senza categoria' : 'Prodotti eliminati';
    cat[c] = (cat[c] || 0) + imp; totV += imp;
  });
  var buttato = 0, cucina = 0;
  s.sprechi.filter(function (r) { return dentro(r.data) && r.prezzoAcquisto != null; }).forEach(function (r) { if (r.tipo === 'cucina') cucina += r.prezzoAcquisto * r.qta; else if (r.motivo !== 'Reso al fornitore') buttato += r.prezzoAcquisto * r.qta; });
  var totInc = incassi.reduce(function (t, c) { return t + (+c.incasso || 0); }, 0);
  var righe = [['Incassi del mese (dalla cassa)', Math.round(totInc * 100) / 100, ''], ['Venduto nell\'app (scansionato)', Math.round(totV * 100) / 100, ''], ['Merce buttata (al costo)', Math.round(buttato * 100) / 100, ''], ['Merce usata in cucina (al costo)', Math.round(cucina * 100) / 100, ''], ['', '', ''], ['Incassi giorno per giorno', '', '']];
  incassi.forEach(function (c) { righe.push([data_(c.data), +c.incasso || 0, c.frutta != null ? c.frutta : '']); });
  righe.push(['', '', ''], ['Venduto per categoria', '', '']);
  Object.keys(cat).sort(function (a, b) { return cat[b] - cat[a]; }).forEach(function (c) { righe.push([c, Math.round(cat[c] * 100) / 100, totV ? Math.round(cat[c] / totV * 1000) / 10 + '%' : '']); });
  var sh = foglio_('Riepilogo', true);
  scriviTabella_(sh, 'Riepilogo di ' + MESI[+mese.slice(5) - 1] + ' ' + mese.slice(0, 4), 'Dall\'app: incassi delle chiusure, vendite scansionate, sprechi e cucina del mese', ['Voce', 'Euro', 'Frutta e verdura / quota'], righe, { formati: ['', EURO, ''], larghezze: [280, 120, 170] });
  incassi.forEach(function (c, i) { sh.getRange(5 + 6 + i, 1).setNumberFormat('dd/mm/yyyy'); sh.getRange(5 + 6 + i, 3).setNumberFormat(EURO); });
}
function leggimi_(stato) {
  var sh = foglio_('Leggimi', true);
  sh.getRange(1, 1, 8, 1).setValues([['Magazzino – La Spesa Sfusa: foglio collegato all\'app'], [stato],
    ['I fogli dei fornitori (listini) si cambiano anche da qui: nome, formato, codice a barre, acquisto, IVA, ricarico, prezzo di vendita, note. Le modifiche arrivano nell\'app in pochi secondi.'],
    ['Prodotto nuovo: nel foglio del suo fornitore, scrivilo nella riga vuota sotto la sua categoria.'],
    ['Magazzino, Scadenze e Riepilogo arrivano solo dall\'app: qui non si cambiano.'],
    ['Il foglio si aggiorna da solo ogni 10 minuti. Subito: menu Magazzino → Aggiorna adesso.'],
    ['Eliminare prodotti, cambiare categoria o fornitore: dall\'app.'],
    ['Se qualcosa non torna: menu Magazzino → Rifai tutti i fogli.']]);
  sh.getRange(1, 1).setFontSize(14).setFontWeight('bold'); sh.setColumnWidth(1, 900);
}

/* ---------------- modifiche fatte nel foglio → app ---------------- */
function numero_(v) {
  if (v === '' || v == null) return { vuoto: true };
  if (typeof v === 'number') return { n: v };
  var t = String(v).replace(/€/g, '').replace(/\s/g, '');
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(t)) t = t.replace(/\./g, '');
  t = t.replace(',', '.');
  var n = Number(t); return isFinite(n) && t !== '' ? { n: n } : { errore: true };
}
var CAMPI = {};
CAMPI[COL.nome] = 'nome'; CAMPI[COL.formato] = 'formato'; CAMPI[COL.codici] = 'codici'; CAMPI[COL.acq] = 'prezzoAcquisto'; CAMPI[COL.iva] = 'iva'; CAMPI[COL.ric] = 'ricarico'; CAMPI[COL.vendita] = 'prezzoManuale'; CAMPI[COL.note] = 'note';
function valoreCampo_(p, campo, v, s) {
  var f = unita_(p).f, x;
  if (campo === 'nome') { x = String(v).replace(/\s+/g, ' ').trim(); if (!x) throw new Error('Il nome non può essere vuoto'); return x; }
  if (campo === 'formato' || campo === 'note') return String(v == null ? '' : v).trim();
  if (campo === 'codici') {
    var cs = String(v == null ? '' : v).split(/[,;\s]+/).map(function (c) { return c.trim(); }).filter(Boolean);
    cs.forEach(function (c) { for (var id in s.prodotti) if (id !== p.id && (s.prodotti[id].codici || []).indexOf(c) >= 0) throw new Error('Il codice ' + c + ' è già di «' + s.prodotti[id].nome + '»'); });
    return cs;
  }
  x = numero_(v);
  if (x.errore) throw new Error('«' + v + '» non è un numero');
  if (campo === 'iva') { if (x.vuoto) return null; if (x.n < 0 || x.n > 30) throw new Error('IVA da 0 a 30'); return x.n; }
  if (campo === 'ricarico') { if (x.vuoto) return 50; if (x.n < 0 || x.n > 500) throw new Error('Ricarico non valido'); return x.n; }
  if (x.vuoto) return null;
  if (x.n < 0) throw new Error('Il prezzo non può essere negativo');
  return Math.round(x.n / f * 1000) / 1000;   // nel foglio per unità di vendita (etto…), nell'app al kg
}
function mostrato_(p, campo) {
  var r = rigaProdotto_(p), c = { nome: COL.nome, formato: COL.formato, codici: COL.codici, prezzoAcquisto: COL.acq, iva: COL.iva, ricarico: COL.ric, prezzoManuale: COL.vendita, note: COL.note }[campo];
  return r[c - 1];
}
function uguale_(a, b) {
  if (a === undefined || a === null) a = ''; if (b === undefined || b === null) b = '';
  var na = numero_(a), nb = numero_(b);
  if (na.n != null && nb.n != null) return Math.abs(na.n - nb.n) < 0.0005;
  return String(a).trim() === String(b).trim();
}
function nuovoId_() { return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function quandoModifichi(e) {
  var r = e.range, sh = r.getSheet();
  var ss = SpreadsheetApp.getActive();
  if (FISSI.indexOf(sh.getName()) >= 0) { if (sh.getName().charAt(0) !== '_' && sh.getName() !== 'Leggimi') ss.toast('Questo foglio arriva dall\'app: qui le modifiche non si salvano e al prossimo aggiornamento tornano com\'erano.', 'Magazzino', 8); return; }
  if (sh.getRange(1, 1).getValue() !== 'fornitore' || r.getLastRow() < PRIMA) return;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) { ss.toast('Un momento: il foglio si sta aggiornando. Riscrivi tra poco.', 'Magazzino', 6); return; }
  try {
    var copia = leggiCopia_(), s = stato_(copia), fid = String(sh.getRange(2, 1).getValue());
    var r0 = Math.max(r.getRow(), PRIMA), r1 = r.getLastRow(), c0 = r.getColumn(), c1 = r.getLastColumn();
    var valori = sh.getRange(r0, 1, r1 - r0 + 1, TESTA.length).getValues();
    var scritture = [], errori = [], salvati = 0, toccati = [], singola = r.getNumRows() === 1 && r.getNumColumns() === 1;
    for (var i = 0; i < valori.length; i++) {
      var riga = r0 + i, v = valori[i], id = String(v[0] || '');
      if (id.indexOf('CAT:') === 0) { errori.push('Le categorie si cambiano dall\'app'); rimetti_(sh, riga, null, s); continue; }
      var p = id ? s.prodotti[id] : null, nuovo = false;
      if (id && !p) { errori.push('Riga ' + riga + ': prodotto non più nell\'app'); continue; }
      if (!id) {
        if (!String(v[COL.nome - 1] || '').trim()) continue;
        var cat = ''; for (var k = riga - 1; k >= PRIMA; k--) { var a = String(sh.getRange(k, 1).getValue() || ''); if (a.indexOf('CAT:') === 0) { cat = a.slice(4); break; } }
        if (cat === 'Senza categoria') cat = '';
        p = { id: nuovoId_(), nome: '', fornitoreId: fid === '-' ? '' : fid, categoria: cat, formato: '', prezzoAcquisto: null, iva: null, prezzoVendita: null, prezzoManuale: null, ricarico: 50, codici: [], tipoScadenza: 'preferibilmente', note: '', origine: 'Creato nel foglio' };
        nuovo = true;
      }
      // in una sola cella: se prima c'era un valore diverso da quello dell'app, il foglio si era spostato → non si salva
      if (singola && !nuovo && CAMPI[c0] && e.oldValue !== undefined && !uguale_(e.oldValue, mostrato_(p, CAMPI[c0]))) {
        errori.push('Il foglio si era appena aggiornato: riscrivi il valore'); rimetti_(sh, riga, p, s); continue;
      }
      var set = {}, cambia = false;
      try {
        for (var c = Math.max(c0, 2); c <= c1; c++) {
          if (c === COL.unita || c === COL.tipo) continue;
          var campo = CAMPI[c]; if (!campo) continue;
          var val = valoreCampo_(p, campo, v[c - 1], s);
          // la vendita mostrata è quella calcolata: se non cambia, il prezzo resta calcolato
          if (campo === 'prezzoManuale' && p.prezzoManuale == null && val != null && uguale_(v[c - 1], per_(p, calcolato_(p)))) continue;
          if (JSON.stringify(val) !== JSON.stringify(p[campo] === undefined ? null : p[campo])) { set[campo] = val; cambia = true; }
        }
        if (nuovo) { var tuttoP = JSON.parse(JSON.stringify(p)); for (var x in set) tuttoP[x] = set[x]; for (var c2 = 2; c2 <= TESTA.length; c2++) { var cp = CAMPI[c2]; if (cp && c2 !== c0 && v[c2 - 1] !== '') tuttoP[cp] = valoreCampo_(p, cp, v[c2 - 1], s); } set = tuttoP; cambia = true; }
      } catch (err) { errori.push(err.message); rimetti_(sh, riga, nuovo ? null : p, s); continue; }
      if (!nuovo && !cambia && ((c0 <= COL.unita && c1 >= COL.unita) || (c0 <= COL.tipo && c1 >= COL.tipo))) { rimetti_(sh, riga, p, s); continue; }   // celle grigie: si rimettono
      if (!cambia) continue;
      scritture.push(scrittura_('prodotti', p.id, set));
      var np = JSON.parse(JSON.stringify(p)); for (var y in set) np[y] = set[y];
      copia['prodotti~' + p.id] = np; s.prodotti[p.id] = np; salvati++; toccati.push('prodotti~' + p.id);
      sh.getRange(riga, 1, 1, TESTA.length).setValues([rigaProdotto_(np)]);
    }
    if (scritture.length) {
      try { fs_(':commit', { writes: scritture }); }
      catch (err) { accoda_(scritture); errori.push('Salvato nel foglio: arriverà nell\'app appena possibile (' + err.message + ')'); }
      scriviRighe_(copia, toccati);
    }
    if (errori.length) ss.toast(errori.slice(0, 3).join('\n'), 'Magazzino', 8);
    else if (salvati) ss.toast(salvati === 1 ? 'Salvato nell\'app' : salvati + ' prodotti salvati nell\'app', 'Magazzino', 3);
  } finally { lock.releaseLock(); }
}
function rimetti_(sh, riga, p, s) {
  if (p) sh.getRange(riga, 1, 1, TESTA.length).setValues([rigaProdotto_(p)]);
  else { var a = String(sh.getRange(riga, 1).getValue() || ''); if (a.indexOf('CAT:') === 0) { var c = a.slice(4), n = Object.keys(s.prodotti).filter(function (id) { return (catDi_(s.prodotti[id]) || 'Senza categoria') === c && (s.prodotti[id].fornitoreId || '-') === String(sh.getRange(2, 1).getValue()); }).length; sh.getRange(riga, 2).setValue(c + ' · ' + n); } else sh.getRange(riga, 2, 1, TESTA.length - 1).clearContent(); }
}
function accoda_(scritture) {
  var sh = foglio_('_coda', true);
  sh.getRange(sh.getLastRow() + 1, 1, scritture.length, 1).setValues(scritture.map(function (w) { return [JSON.stringify(w)]; }));
}
function mandaCoda_(copia) {
  var sh = foglio_('_coda', false); if (!sh || !sh.getLastRow()) return;
  var w = sh.getRange(1, 1, sh.getLastRow(), 1).getValues().map(function (r) { return JSON.parse(r[0]); });
  fs_(':commit', { writes: w });
  sh.clearContents();
}
