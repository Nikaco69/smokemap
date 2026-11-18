// 煙位地圖 service worker：App 殼離線可開；API 同地圖圖磚一律走網絡
const VERSION = 'v1';
const SHELL = [
  '/', '/app.js', '/nsa.geojson', '/manifest.webmanifest',
  '/icons/icon-192.png', '/icons/apple-touch-icon.png',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/photos/') || url.hostname.includes('tile.openstreetmap')) return;
  const isShell = url.origin === location.origin || url.hostname === 'unpkg.com';
  if (!isShell) return;
  // 網絡優先，失敗先用 cache（確保新版即時生效）
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request).then(r => r || caches.match('/')))
  );
});
