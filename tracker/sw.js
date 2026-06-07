/* ============================================================
   Tracker service worker — caches the app shell so the PWA
   loads instantly and works offline. Data comes from Firestore
   (which has its own offline cache); this only covers static
   assets.
   ============================================================ */
const CACHE_VERSION = "tracker-shell-v1";

const SHELL_ASSETS = [
  "/",
  "/index.html",
  "/tracker.css",
  "/tracker.js",
  "/firebase-config.js",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-512-maskable.png",
  "/icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(SHELL_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

/* Cache-first for the app shell, network passthrough for everything
   else (Firebase/Firestore/Functions calls must always hit the network
   directly so auth + live data work correctly). */
self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match("/index.html"));
    })
  );
});
