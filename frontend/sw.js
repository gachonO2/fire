/**
 * 오프라인 대비 서비스워커 — 통신이 끊겨도 앱 셸과 지도로 최소경로 안내를 이어간다.
 * (위험 상태는 api.js가 localStorage에 캐시한 마지막 값을 쓴다)
 *
 * /api/* 는 절대 캐시하지 않는다 — 오래된 위험 정보로 안내하면 안 되기 때문.
 * 서버에 닿지 못하면 api.js가 오프라인 폴백으로 전환하고 사용자에게 그 사실을 알린다.
 */
const CACHE = 'fireguide-v5';
const SHELL = [
  './',
  './index.html',
  './admin.html',
  './guardian.html',
  './architect.html',
  './demo.html',
  './css/style.css',
  './js/api.js',
  './js/app.js',
  './js/admin.js',
  './js/architect.js',
  './js/demo.js',
  './js/guardian.js',
  './js/guidance.js',
  './js/minimap.js',
  './js/odometry.js',
  './shared/floor-plan.js',
  './shared/default-plan.js',
  './shared/hazard-rules.js',
  './shared/pathfinding.js',
  './manifest.json',
  './icon.svg',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/')) return; // 실시간 데이터는 캐시 금지

  // 앱 셸: 네트워크 우선, 실패 시 캐시
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
