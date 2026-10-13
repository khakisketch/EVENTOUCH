'use strict';

// EVENTOUCH offline shell.
//
// A venue with poor Wi-Fi is the normal case, not the exception, and a staff
// member whose phone drops the network must still be able to open the
// check-in screen and queue a scan. Without this the page itself failed to
// load (ERR_INTERNET_DISCONNECTED), so the existing check-in outbox — which
// already queues work for later replay — could never even be reached.
//
// Strategy:
//   app shell (HTML/CSS/JS)  cached, served cache-first — it is versioned by
//                            the ?v= query the server already sets, so a new
//                            deploy naturally produces new cache keys
//   /api/*                   never cached; when offline the request falls
//                            through and the client keeps its queued state

const CACHE = 'eventouch-shell-v13';
const SHELL = ['/', '/index.html'];

async function shellAssets() {
  // Derive the asset list from the entry document so the cache can never
  // drift from what index.html actually loads.
  const response = await fetch('/index.html', { cache: 'no-cache' });
  const html = await response.text();
  const urls = new Set(SHELL);
  // index.html references assets relatively ("assets/css/tokens.css?v=16"), so
  // the pattern must not assume a leading slash. An earlier version anchored on
  // "/assets/" and silently cached nothing but the HTML itself, which left the
  // app unusable offline despite reporting success.
  for (const match of html.matchAll(/(?:href|src)="(assets\/[^"?]+)(?:\?[^"]*)?"/g)) {
    urls.add('/' + match[1]);
  }
  return [...urls];
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const urls = await shellAssets();
    // addAll is atomic: one failure would leave the worker uninstalled, so
    // each asset is added independently and a miss is simply not cached.
    await Promise.allSettled(urls.map((url) => cache.add(new Request(url, { cache: 'reload' }))));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

// The document loads /assets/css/tokens.css?v=16 but anything else may ask
// for /assets/css/tokens.css. Those are different cache keys, so a
// versionless offline request would miss and the screen would render
// unstyled. Matching the versionless form to the cached versioned entry
// keeps both working without storing the bytes twice.
function stripVersion(request){
  const url = new URL(request.url);
  url.search = '';
  return new Request(url.toString(), { method: 'GET' });
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // API traffic is authoritative and must never be answered from cache.
  if (url.pathname.startsWith('/api/')) return;

  const isShell = url.pathname === '/' || url.pathname === '/index.html'
    || url.pathname.startsWith('/assets/');
  if (!isShell) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = (await cache.match(request)) || (await cache.match(stripVersion(request)));
    if (cached) {
      // Refresh in the background so the next load is current.
      event.waitUntil(fetch(request).then((response) => {
        if (response && response.ok) return cache.put(request, response.clone());
        return undefined;
      }).catch(() => undefined));
      return cached;
    }
    try {
      const response = await fetch(request);
      if (response && response.ok) {
        await cache.put(request, response.clone());
        await cache.put(stripVersion(request), response.clone()).catch(() => undefined);
      }
      return response;
    } catch (error) {
      // Offline with nothing cached: a navigable shell is still better than
      // the browser's own error page, and the app reports its own state.
      if (request.mode === 'navigate') {
        const fallback = await cache.match('/index.html');
        if (fallback) return fallback;
      }
      throw error;
    }
  })());
});
