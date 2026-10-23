/* Notifiche delle scadenze (Magazzino – La Spesa Sfusa)
   Ogni mattina (GitHub Actions) legge da Firebase le confezioni in negozio e manda una notifica
   ai telefoni che l'hanno attivata in Impostazioni. Se non scade niente, non manda niente.
   Serve il segreto FIREBASE_PASSWORD (password dell'account del negozio) nelle impostazioni del repository.
   Le chiavi per firmare le notifiche le crea il primo telefono e stanno su Firebase (documento sys~vapid). */
import { manda } from './webpush.mjs';

const CONF = {
  apiKey: process.env.API_KEY || 'AIzaSyBj_vigsG7m3jQg3MaRSBTwoKkXcPB3HKk',
  projectId: process.env.PROJECT_ID || 'magazzino-spesa-sfusa-69c90',
  email: process.env.FIREBASE_EMAIL || 'laspesasfusa@gmail.com',
  authUrl: process.env.AUTH_URL || 'https://identitytoolkit.googleapis.com/v1',
  fsUrl: process.env.FS_URL || 'https://firestore.googleapis.com/v1'
};
const PASSWORD = process.env.FIREBASE_PASSWORD;
const FORZA = !!process.env.FORZA;
const nb = `projects/${CONF.projectId}/databases/(default)/documents`;
const docId = (st, id) => encodeURIComponent(st + '~' + id);
let token = null;

/* ora e data in Italia (l'orario del server è UTC) */
function oraRoma(d = process.env.ORA ? new Date(process.env.ORA) : new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false }).formatToParts(d).map(x => [x.type, x.value]));
  return { data: `${p.year}-${p.month}-${p.day}`, ora: +p.hour % 24 };
}
async function accedi() {
  const r = await fetch(`${CONF.authUrl}/accounts:signInWithPassword?key=${encodeURIComponent(CONF.apiKey)}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: CONF.email, password: PASSWORD, returnSecureToken: true }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Accesso a Firebase non riuscito: ' + ((j.error && j.error.message) || r.status) + ' (controlla il segreto FIREBASE_PASSWORD)');
  token = j.idToken;
}
async function fs(path, body, method = 'POST') {
  const r = await fetch(`${CONF.fsUrl}/${nb}${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 404 && method === 'GET') return null;
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error('Firestore: ' + ((j && j.error && j.error.message) || r.status));
  return j;
}
/* un documento dell'app: campi f_<nome> in JSON; le confezioni hanno la quantità divisa per dispositivo (q_<n>) */
function leggi(d) {
  const f = d.fields || {}, rec = {};
  for (const [k, v] of Object.entries(f)) if (k.startsWith('f_') && v.stringValue != null) { try { rec[k.slice(2)] = JSON.parse(v.stringValue); } catch (e) { } }
  if (f.st && f.st.stringValue === 'lotti') {
    let q = 0; for (const [k, v] of Object.entries(f)) if (/^q_\d+$/.test(k)) q += +(v.doubleValue ?? v.integerValue ?? 0);
    rec.quantita = Math.round(q * 1000) / 1000;
  }
  return { name: d.name, st: f.st && f.st.stringValue, id: f.rid && f.rid.stringValue, del: !!(f.del && f.del.booleanValue), rec };
}
async function tutti(st) {
  const out = []; let dopo = null;
  for (;;) {
    const q = { from: [{ collectionId: 'dati' }], where: { fieldFilter: { field: { fieldPath: 'st' }, op: 'EQUAL', value: { stringValue: st } } },
      orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }], limit: 300 };
    if (dopo) q.startAt = { values: [{ referenceValue: dopo }], before: false };
    const docs = ((await fs(':runQuery', { structuredQuery: q })) || []).filter(x => x.document).map(x => x.document);
    out.push(...docs.map(leggi).filter(x => !x.del));
    if (docs.length < 300) break;
    dopo = docs[docs.length - 1].name;
  }
  return out;
}
const scrivi = (st, id, set, del = false) => ({
  update: { name: `${nb}/dati/${docId(st, id)}`, fields: { st: { stringValue: st }, rid: { stringValue: String(id) }, del: { booleanValue: del }, ...Object.fromEntries(Object.entries(set).map(([k, v]) => ['f_' + k, { stringValue: JSON.stringify(v) }])) } },
  updateMask: { fieldPaths: ['st', 'rid', 'del', ...Object.keys(set).map(k => 'f_' + k)] },
  updateTransforms: [{ fieldPath: 'srv', setToServerValue: 'REQUEST_TIME' }]
});
const giorni = (da, a) => Math.round((Date.parse(a + 'T12:00:00Z') - Date.parse(da + 'T12:00:00Z')) / 86400000);

/* il testo della notifica: scaduti, oggi, e i «rossi» dei prossimi giorni (come nella pagina Scadenze) */
export function componi(lotti, prodotti, settings, oggi) {
  const soglie = { preferibilmente: [7, 15, 30], entro: [2, 5, 10], ...((settings && settings.soglie) || {}) };
  const voci = [];
  for (const l of lotti) {
    if (l.stato !== 'attivo' || !l.scadenza || l.gestito || !(l.quantita > 0)) continue;
    const p = prodotti.get(l.prodottoId); if (!p) continue;
    const d = giorni(oggi, l.scadenza), s = soglie[p.tipoScadenza === 'entro' ? 'entro' : 'preferibilmente'];
    if (d <= s[0]) voci.push({ nome: p.nome, d });
  }
  if (!voci.length) return null;
  voci.sort((a, b) => a.d - b.d || a.nome.localeCompare(b.nome, 'it'));
  const scad = voci.filter(v => v.d < 0).length, oggiN = voci.filter(v => v.d === 0).length, presto = voci.length - scad - oggiN;
  const quando = d => d < 0 ? 'scaduto' : d === 0 ? 'oggi' : d === 1 ? 'domani' : `tra ${d} giorni`;
  const conta = [scad ? `${scad} scadut${scad === 1 ? 'o' : 'i'}` : '', oggiN ? `${oggiN} scad${oggiN === 1 ? 'e' : 'ono'} oggi` : '', presto ? `${presto} nei prossimi giorni` : ''].filter(Boolean).join(' · ');
  const nomi = voci.slice(0, 5).map(v => `${v.nome} (${quando(v.d)})`).join(', ') + (voci.length > 5 ? ` e altri ${voci.length - 5}` : '');
  const neg = (settings && settings.negozio) || 'La Spesa Sfusa';
  return { title: `${neg}: scadenze`, body: `${conta}\n${nomi}`, url: '#scadenze/urgenti', tag: 'scadenze-' + oggi, n: voci.length };
}

async function main() {
  const { data: oggi, ora } = oraRoma();
  if (!FORZA && (ora < 8 || ora >= 12)) { console.log(`In Italia sono le ${ora}: le notifiche partono dalle 8.`); return; }
  if (!PASSWORD) throw new Error('Manca il segreto FIREBASE_PASSWORD nelle impostazioni del repository (Settings → Secrets and variables → Actions)');
  await accedi();
  const sys = async id => { const d = await fs('/dati/' + docId('sys', id), null, 'GET'); return d ? leggi(d).rec : null; };
  const giro = await sys('notifiche');
  if (!FORZA && giro && giro.ultimo === oggi) { console.log('Notifiche di oggi già mandate.'); return; }
  const chiavi = await sys('vapid');
  const iscritti = await tutti('push');
  if (!chiavi || !chiavi.pub || !iscritti.length) { console.log('Nessun telefono ha attivato le notifiche.'); return; }
  const meta = await fs('/dati/' + docId('meta', 'settings'), null, 'GET');
  const settings = meta ? leggi(meta).rec.value : null;
  const prodotti = new Map((await tutti('prodotti')).map(x => [x.id, x.rec]));
  const lotti = (await tutti('lotti')).map(x => x.rec);
  const msg = componi(lotti, prodotti, settings, oggi);
  const scritture = [scrivi('sys', 'notifiche', { ultimo: oggi, quanti: msg ? msg.n : 0 })];
  if (!msg) console.log('Niente in scadenza: nessuna notifica.');
  else {
    console.log(`Notifica: ${msg.body.replace(/\n/g, ' | ')}`);
    const payload = JSON.stringify({ title: msg.title, body: msg.body, url: msg.url, tag: msg.tag });
    const opz = { pub: chiavi.pub, priv: chiavi.priv, soggetto: 'mailto:' + CONF.email };
    for (const x of iscritti) {
      const sub = x.rec.sub; if (!sub || !sub.endpoint) continue;
      try { await manda(sub, payload, opz); console.log(`  mandata a ${x.rec.nome || x.id}`); }
      catch (e) {
        console.log(`  non arrivata a ${x.rec.nome || x.id}: ${e.message}`);
        if (e.statusCode === 404 || e.statusCode === 410) scritture.push(scrivi('push', x.id, {}, true));   // iscrizione scaduta: si toglie
      }
    }
  }
  await fs(':commit', { writes: scritture });
}
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) main().catch(e => { console.error(e.message); process.exit(1); });
