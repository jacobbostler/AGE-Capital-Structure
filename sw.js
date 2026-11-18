/* sw.js — the service worker. It makes the app open without a network
 * connection, by keeping a copy of each file it has already served.
 *
 * The strategy is NETWORK FIRST: always try the network, and use the saved
 * copy only when the network fails. That order matters for this lab. With
 * cache-first, a change you merged could keep showing the old page for days,
 * because the service worker would never look at the network again.
 *
 * Every path is relative, because the app lives at
 * https://<username>.github.io/<repository>/ and not at the root of a domain.
 */

/* Bump this when the file list changes; the old cache is then deleted. */
const CACHE = "age-capstruct-v1";

/* The files the app needs to start. */
const SHELL = [
  "./",
  "index.html",
  "styles.css",
  "capstruct.js",
  "app.js",
  "manifest.webmanifest",
  "data/assumptions.csv",
  "data/cdss.csv",
  "data/banker_schedule.csv",
  "data/example_firms.csv",
  "data/ebit_scenarios.csv",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/apple-touch-icon.png",
];

/* On install, fetch the shell once and save it. */
self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    /* One missing file must not stop the whole install, so each is added
       on its own and a failure is skipped. */
    await Promise.all(SHELL.map((path) =>
      cache.add(new Request(path, { cache: "reload" })).catch(() => null)));
    await self.skipWaiting();
  })());
});

/* On activate, throw away caches from older versions. */
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.map((name) => name === CACHE ? null : caches.delete(name)));
    await self.clients.claim();
  })());
});

/* On every request: network first, saved copy as the fallback. */
self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  /* Only handle this app's own files. */
  if (new URL(request.url).origin !== self.location.origin) return;

  event.respondWith((async () => {
    try {
      const response = await fetch(request);
      /* Save a copy for next time, when the response is a real one. */
      if (response && response.ok && response.type === "basic") {
        const cache = await caches.open(CACHE);
        cache.put(request, response.clone());
      }
      return response;
    } catch (err) {
      const cached = await caches.match(request, { ignoreSearch: true });
      if (cached) return cached;
      /* A page that was never visited falls back to the app's own page. */
      if (request.mode === "navigate") {
        const shell = await caches.match("index.html")
          || await caches.match("./");
        if (shell) return shell;
      }
      throw err;
    }
  })());
});
