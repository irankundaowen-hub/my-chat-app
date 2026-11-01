// Twik Chat: opens instantly by keeping the app page, the logo and the fonts on the phone.
// The page is shown from memory first and refreshed in the background (like the big apps do).
const STATIC = "twik-static-v2";
const SHELL = "twik-shell-v10";
const HOSTS = ["cdn.jsdelivr.net", "fonts.googleapis.com", "fonts.gstatic.com"];
const FILES = ["/logo.svg", "/manifest.json", "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png"];

self.addEventListener("install", () => { self.skipWaiting(); });
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== STATIC && k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function tellClients(msg) {
  const cs = await self.clients.matchAll({ type: "window" });
  cs.forEach((c) => c.postMessage(msg));
}

self.addEventListener("fetch", (e) => {
  const r = e.request;
  if (r.method !== "GET") return;
  const u = new URL(r.url);

  // the app page
  if (u.origin === self.location.origin && (r.mode === "navigate" || u.pathname === "/" || u.pathname === "/index.html")) {
    e.respondWith(
      caches.open(SHELL).then(async (c) => {
        const hit = await c.match("/");
        const net = fetch(r).then((res) => {
          if (res && res.ok) {
            const old = hit && hit.headers.get("etag");
            const now = res.headers.get("etag");
            c.put("/", res.clone());
            if (hit && old && now && old !== now) tellClients({ type: "update" });
          }
          return res;
        }).catch(() => hit);
        return hit || net;
      })
    );
    return;
  }

  // fixed files: logo, icons, login library, fonts
  if (HOSTS.includes(u.hostname) || (u.origin === self.location.origin && FILES.includes(u.pathname))) {
    e.respondWith(
      caches.open(STATIC).then((c) =>
        c.match(r).then((hit) => {
          const net = fetch(r).then((res) => { if (res && (res.ok || res.type === "opaque")) c.put(r, res.clone()); return res; }).catch(() => hit);
          return hit || net;
        })
      )
    );
  }
});
