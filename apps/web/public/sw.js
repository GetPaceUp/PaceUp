// PaceUp service worker. Kept deliberately small:
// - /api and /health always go to the network (never cached), so going lists are never stale.
// - Pages are network-first; the last copy is only used when the phone is offline.
// - Built files under /assets have unique names, so caching them is safe.
const CACHE = "paceup-v1";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname === "/health") return;

  if (req.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok) { const cache = await caches.open(CACHE); cache.put("/", res.clone()); }
        return res;
      } catch {
        return (await caches.match("/")) || new Response("You're offline. PaceUp will be back when you're connected.", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
      }
    })());
    return;
  }

  if (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/icons/")) {
    event.respondWith((async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      const res = await fetch(req);
      if (res.ok) { const cache = await caches.open(CACHE); cache.put(req, res.clone()); }
      return res;
    })());
  }
});

// Phone alerts for owners and admins (sent by the PaceUp server). Tapping one opens the right page.
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data?.text() }; }
  event.waitUntil(self.registration.showNotification(data.title || "PaceUp", {
    body: data.body || "",
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    data: { url: data.url || "/" }
  }));
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of open) if (c.url === url && "focus" in c) return c.focus();
    return self.clients.openWindow(url);
  })());
});
