/* Service worker: rende l'app disponibile anche senza internet */
const CACHE = 'magazzino-1.22.0';
const FILES = ['./', './index.html', './categorie_catalogo.js', './app.js', './styles.css', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png', './icons/badge-96.png'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES.map(f => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: true }) || (req.mode === 'navigate' ? await cache.match('./index.html') : null);
    const net = fetch(req).then(r => { if (r && r.ok) cache.put(req, r.clone()); return r; }).catch(() => null);
    if (hit) { e.waitUntil(net); return hit; }
    const r = await net;
    return r || new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  })());
});

/* notifiche (dalla 1.19.0): le scadenze del mattino, mandate dal programma su GitHub */
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Magazzino', {
    body: d.body || '', icon: 'icons/icon-192.png', badge: 'icons/badge-96.png', lang: 'it', timestamp: Date.now(),
    tag: String(d.tag || 'magazzino').replace(/^scadenze-.*/, 'scadenze'), renotify: true, data: { url: d.url || '#scadenze' }
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const vai = (e.notification.data && e.notification.data.url) || '#home';
  e.waitUntil((async () => {
    const aperte = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const c = aperte.find(x => x.url.startsWith(self.registration.scope));
    if (c) { await c.focus(); c.postMessage({ vai }); return; }
    await self.clients.openWindow(new URL('./' + vai, self.registration.scope).href);
  })());
});
