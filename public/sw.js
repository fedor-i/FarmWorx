// Keeps the app shell on the phone so it opens with no signal. Live data goes through the outbox in core.js.
const CACHE = 'farmworx-v2';
const SHELL = [
  './', 'worker.html', 'gate.html', 'boss.html', 'manifest.webmanifest', 'icon.svg', 'css/app.css',
  'js/core.js', 'js/catalog.js', 'js/geo.js', 'js/worker.js', 'js/gate.js', 'js/boss.js',
  'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css',
  'vendor/fonts/atkinson-hyperlegible-latin-400-normal.woff2', 'vendor/fonts/atkinson-hyperlegible-latin-700-normal.woff2',
  'vendor/fonts/barlow-condensed-latin-600-normal.woff2', 'vendor/fonts/barlow-condensed-latin-700-normal.woff2',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const path = url.pathname.slice(new URL(self.registration.scope).pathname.length);
  if (event.request.method !== 'GET' || url.origin !== location.origin || path.startsWith('api/') || path.startsWith('media/')) return;

  // A tag tap with no signal must still open the app and queue the scan.
  if (path.startsWith('t/')) {
    const tag = encodeURIComponent(decodeURIComponent(path.slice(2)));
    event.respondWith(Response.redirect(new URL(`worker.html?tag=${tag}`, self.registration.scope).href, 302));
    return;
  }

  // Network first, so updates land as soon as there is signal; the cache covers the rest.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(url.pathname, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request, { ignoreSearch: true }).then((hit) => hit ?? Response.error())),
  );
});
