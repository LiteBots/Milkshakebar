/* Service worker MilkMi: tylko powiadomienia push.
   Nie zapisuje stron w pamięci, więc nowa wersja aplikacji zawsze trafia do klientów od razu. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Sprzątanie po ewentualnych starych pamięciach podręcznych
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { body: event.data ? event.data.text() : '' }; }
  const title = data.title || 'MilkMi';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    icon: data.icon || '/icons/icon-192.png',
    badge: data.badge || '/icons/badge-96.png',
    data: { url: data.url || '/app' },
    tag: data.tag,
    renotify: Boolean(data.tag)
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || '/app', self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of windows) {
      if (w.url.startsWith(self.location.origin) && 'focus' in w) {
        await w.focus();
        if ('navigate' in w && w.url !== target) await w.navigate(target);
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});
