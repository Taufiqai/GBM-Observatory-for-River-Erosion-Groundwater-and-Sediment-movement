// GBM Observatory service worker — caches the app shell for offline launch.
// Live data (Open-Meteo, NASA GIBS, Esri) is always fetched from the network.
const CACHE = "gbm-observatory-v11";
const SHELL = ["./", "./index.html", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png", "./agro-pollution.html", "./install.html"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (url.origin === location.origin) {
    // app shell: network-first with cache fallback (so updates land, offline still works)
    e.respondWith(
      fetch(e.request).then(r => {
        const copy = r.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return r;
      }).catch(() => caches.match(e.request))
    );
  }
  // cross-origin (tiles, APIs, fonts, CDNs): default browser behaviour — always live
});
