// Only shows notifications and routes a tap back to the app. No fetch handler: every request, /api and /ws
// included, goes straight to the server with its bearer token, and nothing is cached.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()))

self.addEventListener('notificationclick', event => {
  event.notification.close()
  const pane = typeof event.notification.data?.pane === 'string' ? event.notification.data.pane : ''
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      const client = windows.find(c => c.focused) ?? windows[0]
      if (client) {
        await client.focus()
        if (pane) client.postMessage({ type: 'open', pane })
        return
      }
      await self.clients.openWindow(pane ? `/?pane=${encodeURIComponent(pane)}` : '/')
    })(),
  )
})
