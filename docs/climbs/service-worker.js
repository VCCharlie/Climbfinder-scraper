/* FietsKlim climbs PWA — installable on Android Chrome (GitHub Pages / docs/climbs/).
 * Geolocation is not intercepted here (only same-origin GET for static assets). */
/** Bump on every HTML/JS/CSS change — see docs/climbs/PWA_UPDATES.md */
const CACHE_VERSION = "20261013logbook1";
const CACHE_NAME = `fietsklim-climbs-${CACHE_VERSION}`;

const PRECACHE_URLS = [
  "./",
  "./index.html",
  "./import.html",
  "./settings.html",
  "./assets/settings.css",
  "./assets/settings-page.js",
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

function isFirebaseConfigRequest(requestUrl) {
  try {
    return new URL(requestUrl).pathname.endsWith("/auth/firebase-config.js");
  } catch {
    return false;
  }
}

function isIndexHtmlRequest(requestUrl) {
  try {
    const url = new URL(requestUrl);
    const path = url.pathname;
    if (path.endsWith("/index.html")) return true;
    if (path.endsWith("/climbs") || path.endsWith("/climbs/")) return true;
    const parts = path.split("/").filter(Boolean);
    const last = parts[parts.length - 1];
    return last === "climbs";
  } catch {
    return false;
  }
}

async function networkFirstNoStore(request, cacheWrites) {
  try {
    const response = await fetch(request, { cache: "no-store" });
    if (cacheWrites && response.ok && response.type === "basic") {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, response.clone());
    }
    return response;
  } catch {
    return caches.match(request, { ignoreSearch: true });
  }
}

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
      .catch((err) => {
        console.warn("[fietsklim-sw] precache partial/failed", err);
        return self.skipWaiting();
      })
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const { request } = event;
  if (!isSameOriginClimbs(request.url)) return;

  if (isIndexHtmlRequest(request.url)) {
    event.respondWith(networkFirstNoStore(request, true));
    return;
  }

  if (isFirebaseConfigRequest(request.url)) {
    event.respondWith(networkFirstNoStore(request, true));
    return;
  }

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
