self.addEventListener('push', event => {
  let payload = {};
  try {
    const value = event.data ? event.data.json() : {};
    payload = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { payload = {}; }
  const safeUrl = (() => {
    try {
      const candidate = new URL(typeof payload.url === 'string' ? payload.url : '/prototype', self.location.origin);
      return candidate.origin === self.location.origin && (candidate.pathname === '/prototype' || candidate.pathname.startsWith('/prototype/')) ? candidate.pathname + candidate.search + candidate.hash : '/prototype';
    } catch { return '/prototype'; }
  })();
  event.waitUntil(self.registration.showNotification('Koema', {
    body: 'Você tem um lembrete.',
    icon: '/icons/koema-192.png',
    badge: '/icons/koema-192.png',
    tag: typeof payload.tag === 'string' ? payload.tag.slice(0, 100) : 'koema-reminder',
    data: { url: safeUrl },
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const requested = event.notification.data && typeof event.notification.data.url === 'string' ? event.notification.data.url : '/prototype';
  let target = '/prototype';
  try {
    const url = new URL(requested, self.location.origin);
    if (url.origin === self.location.origin && (url.pathname === '/prototype' || url.pathname.startsWith('/prototype/'))) target = url.pathname + url.search + url.hash;
  } catch { /* Keep the safe default route. */ }
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      const url = new URL(client.url);
      if (url.origin === self.location.origin) {
        await client.navigate(target);
        return client.focus();
      }
    }
    return self.clients.openWindow(target);
  })());
});
