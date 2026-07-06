// Service worker de la app del técnico: recibe las notificaciones push de
// revisiones pendientes aunque la app esté cerrada (Android). Registrado con
// scope /tecnico.html para no pisar el service worker de Estelita.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (err) { /* texto plano */ }
  e.waitUntil(self.registration.showNotification(data.title || 'Estelita Técnico', {
    body: data.body || 'Tenés una revisión pendiente.',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: 'estelita-revision',
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(ventanas => {
    const abierta = ventanas.find(w => w.url.includes('/tecnico.html'));
    if (abierta) return abierta.focus();
    return self.clients.openWindow('/tecnico.html');
  }));
});
