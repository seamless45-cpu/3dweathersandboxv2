/*
 * MeteoLab service worker.
 *
 * The app ships as one self-contained HTML file (every script and stylesheet is inlined by
 * vite-plugin-singlefile), so there is no bundle graph to precache and no build-time manifest to
 * generate: the entire application is a single document plus its icons, its web app manifest and
 * the worker itself. That makes a hand-written worker both simpler and more predictable than
 * Workbox for this project.
 *
 * Caching strategy:
 *
 *   • Navigations go to the network FIRST, falling back to the cached shell when offline. The
 *     app is a live simulation that changes with every deploy, so a returning visitor must never
 *     be handed a stale build while the network is available — but they should still be able to
 *     open it with no connection.
 *   • Everything else (icons, the manifest, the worker's own module imports) is cache-FIRST:
 *     these files are content-addressed by version in CACHE_NAME and change only on deploy.
 *   • Cross-origin requests are never intercepted. There are none today, but a worker that
 *     silently swallows requests to another origin is a debugging trap.
 *
 * Versioning: bumping CACHE_NAME is the only thing needed to ship a new build. `activate`
 * deletes every cache whose name it does not own, and `skipWaiting` + `clients.claim` make the
 * new worker take over immediately instead of waiting for every tab to close.
 */

const VERSION = 'v1';
const CACHE_NAME = `meteolab-shell-${VERSION}`;
const OFFLINE_URL = './';

/** Files the app cannot start without. Relative to the worker's own scope. */
const PRECACHE = [
  './',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
  './favicon.svg',
];

/** Resolve a relative URL against the worker's scope, which is the deployment base path. */
function scoped(rel) {
  return new URL(rel, self.registration.scope).href;
}

/**
 * Caches must be filled from a *response*, so warm the shell by fetching each file. A single
 * failure must not abort the install (an icon that failed to upload should not make the whole
 * app un-installable), so each entry is added independently and failures are logged.
 */
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await Promise.all(
        PRECACHE.map(async (rel) => {
          const url = scoped(rel);
          try {
            const response = await fetch(url, { cache: 'reload' });
            if (response.ok) await cache.put(url, response);
          } catch (err) {
            // Offline during install, or a 404 for an optional asset. Keep going.
            console.warn('[meteolab-sw] precache skipped', url, err);
          }
        })
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith('meteolab-shell-') && name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
      await self.clients.claim();
    })()
  );
});

/** Put a navigation response into the shell cache so the next offline open works. */
async function cacheNavigation(response) {
  if (!response || !response.ok || response.type !== 'basic') return;
  try {
    const cache = await caches.open(CACHE_NAME);
    // Always keyed to the scope root: `start_url` is ".", and every navigation to the app
    // (with or without a query string, e.g. a shortcut's ?preset=...) serves the same document.
    await cache.put(scoped('./'), response.clone());
  } catch (err) {
    console.warn('[meteolab-sw] could not refresh the shell cache', err);
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;

  // Only GETs are cacheable; a POST (there are none today) must go straight through.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // ---- Navigations: network first, cache fallback -------------------------------------------
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          await cacheNavigation(response);
          return response;
        } catch {
          const cache = await caches.open(CACHE_NAME);
          const cached = (await cache.match(scoped('./'))) || (await cache.match(OFFLINE_URL));
          if (cached) return cached;
          // Nothing cached yet and no network: let the browser show its own offline page rather
          // than synthesising a blank 200 response.
          throw new Error('[meteolab-sw] offline with an empty cache');
        }
      })()
    );
    return;
  }

  // ---- Everything else: cache first, revalidate in the background ----------------------------
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(request);
      if (cached) {
        // Refresh in the background, but never make the page wait for it.
        event.waitUntil(
          (async () => {
            try {
              const fresh = await fetch(request);
              if (fresh && fresh.ok) await cache.put(request, fresh);
            } catch {
              /* offline: the cached copy is the answer */
            }
          })()
        );
        return cached;
      }
      try {
        const response = await fetch(request);
        if (response && response.ok && response.type === 'basic') {
          await cache.put(request, response.clone());
        }
        return response;
      } catch (err) {
        // A missing icon must not surface as an unhandled rejection in the page.
        return new Response('', { status: 504, statusText: 'Offline' });
      }
    })()
  );
});

/**
 * Lets the page ask which build the worker is holding, so the "update available" prompt can show
 * something concrete instead of a generic message.
 */
self.addEventListener('message', (event) => {
  const data = event.data;
  if (data && data.type === 'GET_VERSION') {
    event.ports?.[0]?.postMessage({ type: 'VERSION', version: VERSION, cache: CACHE_NAME });
  }
  if (data && data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
