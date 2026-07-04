// Service worker mínimo: alcanza con esto para que el navegador considere
// la app "instalable". No cachea nada todavía (se podría agregar después
// para que funcione offline).
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Por ahora, dejamos pasar todos los pedidos normalmente.
});
