/* ============================================================
   Tracker service worker — caches the app shell so the PWA
   loads instantly and works offline. Data comes from Firestore
   (which has its own offline cache); this covers static assets
   AND the Firebase SDK modules tracker.js imports from Google's
   CDN — without those cached, the app's JS can't even start
   offline and the page stays blank.
   ============================================================ */
const CACHE_VERSION = "tracker-shell-v2";

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

const CDN_ASSETS = [
  "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js",
  "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js",
  "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js",
  "https://www.gstatic.com/firebasejs/10.12.5/firebase-functions.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(async (cache) => {
      await cache.addAll(SHELL_ASSETS);
      await Promise.all(
        CDN_ASSETS.map((url) =>
          fetch(url, { mode: "cors" })
            .then((res) => res.ok && cache.put(url, res))
            .catch(() => {})
        )
      );
    })
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

/* Cache-first for the app shell and the Firebase SDK CDN files (so the
   app can boot offline). Firestore/Auth/Functions calls themselves go
   straight to the network — the SDK handles those, including offline
   queuing of writes via persistentLocalCache. */
self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  const isFirebaseApi =
    url.hostname.endsWith("googleapis.com") || url.hostname.endsWith("firebaseio.com");
  if (isFirebaseApi) return;

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
