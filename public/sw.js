// Offline shell for the installed app (Android/iOS home screen and the
// Capacitor wrapper). Only same-origin static files are cached: live feeds,
// /api proxies and third-party map tiles always go to the network so the
// console never shows stale positions.
const CACHE = 'gev-shell-v1';
// Paths are relative to the worker's scope so a non-root Vite base still works.
const BASE = new URL('./', self.location).pathname;
const SHELL = [
  '',
  'manifest.webmanifest',
  'logo.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
].map((path) => BASE + path);

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (
    !url.pathname.startsWith(BASE) ||
    url.pathname.startsWith(`${BASE}api/`) ||
    url.pathname.startsWith('/.netlify/')
  )
    return;

  // Pages: network first so a new deploy shows up immediately; cached shell offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(BASE, copy));
          return response;
        })
        .catch(() => caches.match(BASE)),
    );
    return;
  }

  // Hashed build assets, Cesium runtime, models and icons: cache first.
  const rest = url.pathname.slice(BASE.length);
  if (/^(assets|cesium|models|icons)\//.test(rest)) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ||
          fetch(request).then((response) => {
            if (response.ok) {
              const copy = response.clone();
              caches.open(CACHE).then((cache) => cache.put(request, copy));
            }
            return response;
          }),
      ),
    );
  }
});
