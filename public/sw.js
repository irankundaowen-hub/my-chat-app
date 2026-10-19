// Twik Chat: keeps only the fixed files (login library, fonts, logo) so the app opens faster.
const NAME = "twik-static-v1";
const HOSTS = ["cdn.jsdelivr.net", "fonts.googleapis.com", "fonts.gstatic.com"];
self.addEventListener("install", (e) => { self.skipWaiting(); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== NAME).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const r = e.request;
  if (r.method !== "GET") return;
  const u = new URL(r.url);
  if (!(HOSTS.includes(u.hostname) || u.pathname === "/logo.svg")) return;
  e.respondWith(
    caches.open(NAME).then((c) =>
      c.match(r).then((hit) => {
        const net = fetch(r).then((res) => { if (res && (res.ok || res.type === "opaque")) c.put(r, res.clone()); return res; }).catch(() => hit);
        return hit || net;
      })
    )
  );
});
