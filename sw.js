// 更新流程：改任何檔案都要把 VERSION 加一（與 js/version.js 相同，有測試把關）
const VERSION = '1.1.1';
const CACHE = 'izu-a-plan-' + VERSION;
const ASSETS = ['./', 'index.html', 'css/theme.css', 'css/app.css', 'js/app.js', 'js/engine.js', 'js/db.js', 'js/version.js',
  'manifest.webmanifest', 'setup.example.json', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS))));
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('message', e => { if (e.data === 'skip') self.skipWaiting(); });
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(r => r || fetch(e.request)));
});
