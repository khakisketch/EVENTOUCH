'use strict';

// EVENTOUCH service-worker retirement.
//
// The old offline shell is retired: the product UI is the Next app and the
// API serves no repository files. Browsers that installed the old worker
// (which cached `/`, `/index.html` and `/assets/*` under `eventouch-shell-*`
// keys) keep running it until they receive a byte-different worker at this
// same URL — this file. So this worker must stay at the old origin's /sw.js
// and must never grow a fetch/cache handler again.
//
// On activation it deletes ONLY the `eventouch-shell-*` caches, tells
// controlled pages to reload once, and unregisters itself. Cookies,
// localStorage, sessionStorage, IndexedDB and every unrelated cache are left
// untouched. There is intentionally no `fetch` listener: all traffic goes to
// the network while retirement completes.

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((name) => name.indexOf('eventouch-shell-') === 0)
        .map((name) => caches.delete(name))
    );
    try {
      await self.clients.claim();
    } catch (error) {
      // Claiming is best-effort; cache deletion above already retired the shell.
    }
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    await self.registration.unregister();
    clients.forEach((client) => {
      try {
        client.postMessage({ type: 'EVENTOUCH_SW_RETIRED' });
      } catch (error) {
        // A client that cannot receive messages still gets a fresh page below.
      }
      try {
        if ('navigate' in client && new URL(client.url).origin === self.location.origin) {
          // Do not await navigation inside activation: the new document may
          // itself wait for this activate event, deadlocking both operations.
          void client.navigate(client.url).catch(() => {});
        }
      } catch (error) {
        // Uncontrolled clients reject navigate(); their next load is clean.
      }
    });
  })());
});
