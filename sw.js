'use strict';

/** Incrémenter quand index.html, style.css, app.js ou icônes shell changent. */
const CACHE = 'booklens-shell-v1';

function coreUrls() {
  const r = self.location;
  return [
    new URL('./index.html', r).href,
    new URL('./style.css', r).href,
    new URL('./app.js', r).href,
    new URL('./site.webmanifest', r).href,
    new URL('./icons/icon-192.png', r).href,
    new URL('./icons/icon-512.png', r).href,
  ];
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(coreUrls()))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.map((k) => {
            if (k !== CACHE && k.startsWith('booklens-shell-')) return caches.delete(k);
            return Promise.resolve();
          })
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  const path = url.pathname;
  const isShell =
    path.endsWith('/index.html') ||
    path.endsWith('/style.css') ||
    path.endsWith('/app.js') ||
    path.endsWith('/site.webmanifest') ||
    /\/icons\/icon-(192|512)\.png$/i.test(path);

  if (request.mode === 'navigate') {
    const navKey = () => {
      const u = new URL(request.url);
      u.search = '';
      return new Request(u.href, { method: 'GET' });
    };
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(navKey(), copy));
          }
          return res;
        })
        .catch(() =>
          caches
            .match(new URL('./index.html', self.location).href)
            .then((hit) => hit || caches.match(new URL('./', self.location).href))
        )
    );
    return;
  }

  if (!isShell) return;

  /** Aligné sur Pages (`app.js?v=hash`) : une seule entrée cache sans query. */
  function cacheKeyRequest(req) {
    const u = new URL(req.url);
    u.search = '';
    return new Request(u.href, { method: 'GET' });
  }

  event.respondWith(
    caches.match(cacheKeyRequest(request)).then((cached) => {
      const net = fetch(request).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(cacheKeyRequest(request), copy));
        }
        return res;
      });
      return cached || net;
    })
  );
});
