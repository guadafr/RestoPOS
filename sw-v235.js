// sw-v235.js
const CACHE_NAME = 'restopos-v235';
const CORE_ASSETS = [
  './',
  './index.html',
  './mozo.html',
  './admin.html',
  './cocina.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
  // agrega aquí css/js si los tenés separados, ej: './styles.css', './app.js'
];

// Instalar: precache de core
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(CORE_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// Activar: limpiar caches viejos
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.map(k => (k !== CACHE_NAME) ? caches.delete(k) : null))
    ).then(() => self.clients.claim())
  );
});

// Estrategia: cache-first con fallback a red, y si falla, a cache (si existe)
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // No cachear llamadas POST/PUT/DELETE (no las usamos; IndexedDB ya guarda datos)
  if (req.method !== 'GET') return;

  event.respondWith(
    caches.match(req).then(cached => {
      if (cached) {
        // Devuelvo cache y actualizo en segundo plano (stale-while-revalidate simple)
        fetch(req).then(res => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(req, copy)).catch(()=>{});
        }).catch(()=>{});
        return cached;
      }
      // No estaba en cache: voy a red, y guardo
      return fetch(req).then(res => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then(c => c.put(req, copy)).catch(()=>{});
        return res;
      }).catch(() => {
        // Fallback básico: si pidió una página, doy index (útil para volver a cargar UI)
        if (req.headers.get('accept')?.includes('text/html')) {
          return caches.match('./index.html');
        }
        return new Response('Offline', { status: 503, statusText: 'Offline' });
      });
    })
  );
});
