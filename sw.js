/* DocScan service worker: app shell precache, network-first for app code (updates arrive at once),
   cache-first for CDN libraries and fonts (they are versioned URLs). */
const VERSION = 'docscan-v3.0.0';
const SHELL = [
  './', './index.html', './manifest.json',
  './css/theme.css', './css/app.css',
  './js/libs.js', './js/detect.js', './js/detect-worker.js', './js/warp.js', './js/filters.js', './js/cropper.js',
  './js/camera.js', './js/db.js', './js/convert.js', './js/ui.js', './js/pages.js', './js/annotate.js', './js/tools.js', './js/app.js',
  './assets/icons.svg', './assets/icons-extra.svg', './assets/emblem.svg', './assets/mascot.svg', './assets/shuriken.svg',
  './assets/shuriken-metal.svg', './assets/kunai.svg', './assets/speedlines.svg', './assets/halftone-fade.svg',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png',
];
const CDN_HOSTS = ['cdnjs.cloudflare.com', 'cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== 'docscan-cdn').map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (CDN_HOSTS.includes(url.hostname)) {
    e.respondWith(caches.open('docscan-cdn').then((c) => c.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res && (res.ok || res.type === 'opaque')) c.put(req, res.clone());
      return res;
    }))));
    return;
  }
  if (url.origin !== self.location.origin || url.pathname.includes('/dev/')) return;
  e.respondWith(fetch(req).then((res) => {
    if (res && res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match('./index.html'))));
});
