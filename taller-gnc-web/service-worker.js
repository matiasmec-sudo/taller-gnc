// Service worker de Estelita.
//
// Objetivo: que la app ABRA y se pueda trabajar aunque no haya internet en el
// taller o el hosting esté caído. Los datos de los clientes ya viven en el
// dispositivo (localStorage + IndexedDB); lo único que faltaba era guardar
// la app en sí.
//
// Estrategia:
//  - La app (HTML): RED PRIMERO. Si hay internet, siempre trae la última
//    versión recién desplegada (no se "congela" una vieja); si no hay, sale
//    de la caché.
//  - Íconos, manifest y las librerías del CDN (jsPDF): CACHÉ PRIMERO — no
//    cambian, y así los PDF se generan aunque estés sin señal.
//  - /api/ NUNCA se cachea: son la IA, la licencia, el respaldo y los pagos.
//    Esos sí necesitan servidor, y tienen que fallar de verdad si no está.

const CACHE = 'estelita-v2';
const CDN_PERMITIDO = 'cdnjs.cloudflare.com';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(APP_SHELL))
      .catch(() => { /* si alguno no está, igual instalamos: mejor algo que nada */ })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function esHTML(req) {
  return req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html');
}

function guardarEnCache(req, res) {
  // res.ok es false en las respuestas "opacas" del CDN (script sin CORS),
  // pero igual sirven y se pueden guardar.
  if (!res || !(res.ok || res.type === 'opaque')) return;
  const copia = res.clone();
  caches.open(CACHE).then((c) => c.put(req, copia)).catch(() => { /* sin espacio: seguimos */ });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;               // los POST a /api pasan derecho
  const url = new URL(req.url);
  if (url.pathname.startsWith('/api/')) return;   // la API nunca se cachea

  // Solo nos metemos con lo nuestro y con el CDN de las librerías.
  const propio = url.origin === self.location.origin;
  if (!propio && url.hostname !== CDN_PERMITIDO) return;

  // La app: red primero, caché de respaldo.
  if (esHTML(req)) {
    event.respondWith(
      fetch(req)
        .then((res) => { guardarEnCache(req, res); return res; })
        .catch(() => caches.match(req).then((r) => r || caches.match('./index.html')))
    );
    return;
  }

  // Íconos, manifest y librerías del CDN: caché primero, y si no está, red.
  event.respondWith(
    caches.match(req).then((cacheado) => {
      if (cacheado) return cacheado;
      return fetch(req).then((res) => { guardarEnCache(req, res); return res; });
    })
  );
});
