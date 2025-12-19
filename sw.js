/* sw.js — Milk PWA (cache-first dla assetów + network-first dla API) */

const VERSION = "milk-v1";
const STATIC_CACHE = `${VERSION}-static`;
const RUNTIME_CACHE = `${VERSION}-runtime`;

// Pliki, które chcemy mieć offline od razu
const PRECACHE_URLS = [
  "/app",
  "/app.html",
  "/index.html",
  "/",
  "/admin.html",
  "/manifest.webmanifest",
  "/favicon.png"
];

// Install: precache
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll(PRECACHE_URLS))
  );
  self.skipWaiting();
});

// Activate: cleanup starych cache
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => ![STATIC_CACHE, RUNTIME_CACHE].includes(k))
          .map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

// Helper
function isApiRequest(req) {
  try {
    const url = new URL(req.url);
    return url.pathname.startsWith("/api/") || url.pathname.startsWith("/socket.io/");
  } catch {
    return false;
  }
}

function isHtmlRequest(req) {
  return req.mode === "navigate" || (req.headers.get("accept") || "").includes("text/html");
}

// Fetch strategies:
// - HTML: network-first (żeby zawsze łapać nowe wersje), fallback cache, fallback /app.html
// - API: network-first, fallback cache (tylko gdy mamy coś w cache)
// - assets: cache-first, potem network i zapis do runtime cache
self.addEventListener("fetch", (event) => {
  const req = event.request;

  // tylko GET
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // ignoruj requesty do innych domen
  if (url.origin !== self.location.origin) return;

  // HTML (nawigacje)
  if (isHtmlRequest(req)) {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          const cache = await caches.open(RUNTIME_CACHE);
          cache.put(req, fresh.clone());
          return fresh;
        } catch (e) {
          const cached = await caches.match(req);
          if (cached) return cached;

          // fallback: app.html (dla /app), albo index.html
          const appFallback = await caches.match("/app.html");
          if (appFallback) return appFallback;

          const indexFallback = await caches.match("/index.html");
          if (indexFallback) return indexFallback;

          return new Response("Offline", { status: 503, headers: { "Content-Type": "text/plain" } });
        }
      })()
    );
    return;
  }

  // API: network-first
  if (isApiRequest(req)) {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          const cache = await caches.open(RUNTIME_CACHE);
          cache.put(req, fresh.clone());
          return fresh;
        } catch (e) {
          const cached = await caches.match(req);
          return (
            cached ||
            new Response(JSON.stringify({ ok: false, message: "Offline / brak odpowiedzi API" }), {
              status: 503,
              headers: { "Content-Type": "application/json" }
            })
          );
        }
      })()
    );
    return;
  }

  // Static assets: cache-first
  event.respondWith(
    (async () => {
      const cached = await caches.match(req);
      if (cached) return cached;

      try {
        const fresh = await fetch(req);
        const cache = await caches.open(RUNTIME_CACHE);
        cache.put(req, fresh.clone());
        return fresh;
      } catch (e) {
        // ostatnia deska ratunku: favicon
        const fallback = await caches.match("/favicon.png");
        return fallback || new Response("Offline", { status: 503 });
      }
    })()
  );
});
