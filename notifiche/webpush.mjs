/* Web Push senza librerie (solo il crypto di Node): cifratura del messaggio (RFC 8291, aes128gcm)
   e firma VAPID (RFC 8292) per il servizio di notifiche del browser (per Chrome: Firebase Cloud Messaging). */
import crypto from 'node:crypto';
const de = s => Buffer.from(s, 'base64url');
const hkdf = (salt, ikm, info, n) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, n));

/* opz.asPriv / opz.salt servono solo per le prove con i valori dell'RFC */
export function cifra(testo, sub, opz = {}) {
  const ecdh = crypto.createECDH('prime256v1');
  if (opz.asPriv) ecdh.setPrivateKey(de(opz.asPriv)); else ecdh.generateKeys();
  const asPub = ecdh.getPublicKey(), uaPub = de(sub.keys.p256dh), auth = de(sub.keys.auth);
  const segreto = ecdh.computeSecret(uaPub);
  const ikm = hkdf(auth, segreto, Buffer.concat([Buffer.from('WebPush: info\0'), uaPub, asPub]), 32);
  const salt = opz.salt ? de(opz.salt) : crypto.randomBytes(16);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const corpo = Buffer.concat([c.update(Buffer.concat([Buffer.from(testo), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPub.length]), asPub, corpo]);
}
/* firma VAPID: chiave privata «d» e pubblica (65 byte) in base64url, come le crea il telefono */
export function vapid(endpoint, pub, priv, soggetto, ora = Math.floor(Date.now() / 1000)) {
  const p = de(pub);
  const key = crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: priv, x: p.subarray(1, 33).toString('base64url'), y: p.subarray(33, 65).toString('base64url') }, format: 'jwk' });
  const b = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const dati = b({ typ: 'JWT', alg: 'ES256' }) + '.' + b({ aud: new URL(endpoint).origin, exp: ora + 12 * 3600, sub: soggetto });
  const firma = crypto.sign('sha256', Buffer.from(dati), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return `vapid t=${dati}.${firma}, k=${pub}`;
}
export async function manda(sub, testo, { pub, priv, soggetto, ttl = 8 * 3600 }) {
  const r = await fetch(sub.endpoint, {
    method: 'POST', body: cifra(testo, sub),
    headers: { Authorization: vapid(sub.endpoint, pub, priv, soggetto), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: String(ttl), Urgency: 'normal' }
  });
  if (!r.ok) { const e = new Error(`${r.status} ${await r.text().catch(() => '')}`.trim()); e.statusCode = r.status; throw e; }
  return r.status;
}
