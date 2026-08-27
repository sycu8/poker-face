/* Richer PWA shell — cache app shell assets; never cache live game/API traffic. */
const CACHE = "poker-faces-shell-v3";
const PRECACHE = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/logo/poker-faces-mark.svg",
];

/** Live routes and backends must always hit the network. */
function isLivePath(pathname) {
  return (
    pathname.startsWith("/api/") ||
    pathname.startsWith("/ws/") ||
    pathname.startsWith("/table/")
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (isLivePath(url.pathname)) return;

  // Navigations: network-first so deploys show up; do not offline-cache table views.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (!isLivePath(url.pathname) && url.pathname === "/") {
            const copy = res.clone();
            void caches.open(CACHE).then((cache) => cache.put("/", copy));
          }
          return res;
        })
        .catch(() => caches.match("/") || caches.match("/index.html")),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const fetched = fetch(request)
        .then((res) => {
          if (
            res.ok &&
            url.origin === self.location.origin &&
            !isLivePath(url.pathname)
          ) {
            const copy = res.clone();
            void caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || fetched;
    }),
  );
});
