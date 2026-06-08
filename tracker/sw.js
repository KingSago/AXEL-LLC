/* ============================================================
   Tracker service worker — caches the app shell so the PWA
   loads instantly and works offline. Data comes from Firestore
   (which has its own offline cache); this covers static assets
   AND the Firebase SDK modules tracker.js imports from Google's
   CDN — without those cached, the app's JS can't even start
   offline and the page stays blank.
   ============================================================ */
const CACHE_VERSION = "tracker-shell-v3";

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

/* Strategy:
   - Our own app shell (HTML/JS/CSS/manifest) is NETWORK-FIRST: always try the
     network so a fresh deploy loads immediately, falling back to cache when
     offline. (Cache-first here meant deploys never showed up until the cache
     version was bumped.)
   - The versioned Firebase SDK CDN files + icons are CACHE-FIRST (immutable, and
     needed for an offline boot).
   - Firestore/Auth/Functions API calls bypass the worker entirely — the SDK
     handles those, including offline write queuing via persistentLocalCache. */
self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  const isFirebaseApi =
    url.hostname.endsWith("googleapis.com") || url.hostname.endsWith("firebaseio.com");
  if (isFirebaseApi) return;

  const sameOrigin = url.origin === self.location.origin;
  const isShell =
    sameOrigin &&
    (request.mode === "navigate" ||
      url.pathname === "/" ||
      /\.(html|js|css|webmanifest)$/.test(url.pathname));

  if (isShell) {
    // Network-first: latest code when online, cached shell when offline.
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match(request).then((c) => c || caches.match("/index.html")))
    );
    return;
  }

  // Cache-first for CDN SDK modules + icons.
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
