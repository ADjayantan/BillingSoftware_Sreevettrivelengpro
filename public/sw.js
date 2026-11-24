/*
 * Keeps the billing page openable with no cloud and no internet. It stores the page's own
 * files and nothing else: no API reply, no page with data, no print view ever enters a cache.
 * Bills and masters live in IndexedDB (src/lib/offline-db.ts), not here.
 */
const SHELL = 'studflow-shell-v1';
const STATIC = 'studflow-static-v1';
const SHELL_URL = '/billing'; // static: the same bytes for everyone, no data inside
const OFFLINE_URL = '/offline.html';
const PATIENCE = 5000;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll([OFFLINE_URL, '/icon-192.png'])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => name.startsWith('studflow-') && name !== SHELL && name !== STATIC).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'CACHE_SHELL') event.waitUntil(cacheShell(event.data.assets).catch(() => undefined));
});

const isAsset = (path) => typeof path === 'string' && path.startsWith('/_next/static/');

/** All or nothing: the page is swapped only once every file it needs is here. */
async function cacheShell(loaded) {
  const page = await fetch(SHELL_URL, { credentials: 'same-origin', cache: 'no-store' });
  // Signed out (redirected to the sign-in page) or the cloud is ill: keep what we have.
  if (!page.ok || page.redirected || !(page.headers.get('content-type') || '').includes('text/html')) return;
  const html = await page.clone().text();
  const needed = new Set([...(html.match(/\/_next\/static\/[^"'\\\s)<>]+/g) || []), ...(Array.isArray(loaded) ? loaded.filter(isAsset) : [])]);
  const store = await caches.open(STATIC);
  const have = new Map((await store.keys()).map((request) => [new URL(request.url).pathname + new URL(request.url).search, request]));
  await Promise.all([...needed].filter((path) => !have.has(path)).map((path) => store.add(path)));
  await (await caches.open(SHELL)).put(SHELL_URL, page);
  // Files of older deployments.
  await Promise.all([...have].filter(([path]) => !needed.has(path)).map(([, request]) => store.delete(request)));
}

const within = (promise, ms) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });

const fromShell = async (path) => (await caches.open(SHELL)).match(path);
const offlinePage = async () => (await fromShell(OFFLINE_URL)) || Response.error();

/** The network first (it knows if you are signed out); this PC's copy when it is down or slow. */
async function openBilling(request, isRoot) {
  const shell = await fromShell(SHELL_URL);
  try {
    const answer = fetch(request);
    const response = await (shell ? within(answer, PATIENCE) : answer);
    if (response.status < 500 || !shell) return response;
  } catch {
    if (!shell) return offlinePage();
  }
  return isRoot ? Response.redirect(new URL(SHELL_URL, self.location.origin).href, 302) : shell;
}

async function immutable(request) {
  const store = await caches.open(STATIC);
  const hit = await store.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok && response.type === 'basic') await store.put(request, response.clone()).catch(() => undefined);
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (request.mode === 'navigate') {
    if (url.pathname === '/' || url.pathname === SHELL_URL) event.respondWith(openBilling(request, url.pathname === '/'));
    else event.respondWith(fetch(request).catch(offlinePage));
    return;
  }
  if (isAsset(url.pathname)) event.respondWith(immutable(request));
  // Everything else (page data, print views, files) goes to the network as if we were not here.
});
