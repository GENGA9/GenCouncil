// GenCouncil service worker: cache the app shell, never cache API/WS/MCP traffic.
// v2: media left alone (and the old cache, which could hold whole videos, dropped)
const VERSION = "gc-shell-v2";
const SHELL = ["/", "/index.html", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET") return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/mcp/") || url.pathname === "/ws") return;
  // video and sound go straight to the server: Safari plays them only from byte ranges (206), which a
  // cached whole file or a proxied answer breaks (the dances would not play on the iPhone)
  if (event.request.headers.has("range") || /\.(mp4|webm|mp3|wav|m4a)$/i.test(url.pathname)) return;
  // navigation: network first, fall back to cached shell
  if (event.request.mode === "navigate") {
    event.respondWith(fetch(event.request).catch(() => caches.match("/index.html")));
    return;
  }
  // hashed assets: cache first
  event.respondWith(
    caches.match(event.request).then(
      (hit) =>
        hit ||
        fetch(event.request).then((res) => {
          if (res.status === 200 && url.origin === self.location.origin) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(event.request, copy));
          }
          return res;
        }),
    ),
  );
});
