/* FietsKlim climbs PWA — installable on Android Chrome (GitHub Pages / docs/climbs/).
 * Geolocation is not intercepted here (only same-origin GET for static assets). */
const CACHE_VERSION = "20261011maptilesnokey";
const CACHE_NAME = `fietsklim-climbs-${CACHE_VERSION}`;

const PRECACHE_URLS = [
  "./",
  "./index.html",
  "./import.html",
  "./manifest.webmanifest",
  "./assets/styles.css",
  "./assets/app.js",
  "./assets/climb-metrics.js",
  "./assets/climb-log.js",
  "./assets/pwa-register.js",
  "./assets/region-picker.js",
  "./../auth/gate.css",
  "./../auth/gate.js",
  "./../auth/firebase-config.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
];

function isSameOriginClimbs(requestUrl) {
  try {
    const url = new URL(requestUrl);
    if (url.origin !== self.location.origin) return false;
    const path = url.pathname;
    return path.includes("/climbs/") || path.endsWith("/climbs");
  } catch {
    return false;
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
      .catch((err) => {
        console.warn("[fietsklim-sw] precache partial/failed", err);
      })
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k.startsWith("fietsklim-climbs-") && k !== CACHE_NAME).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const { request } = event;
  if (!isSameOriginClimbs(request.url)) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok && response.type === "basic") {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request, { ignoreSearch: true }))
  );
});
