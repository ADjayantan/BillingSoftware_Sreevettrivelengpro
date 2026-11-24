/** Registers the service worker and tells it which files make up the offline page. */

const supported = (): boolean => process.env.NODE_ENV === 'production' && typeof navigator !== 'undefined' && 'serviceWorker' in navigator;

export async function startServiceWorker(): Promise<void> {
  if (!supported()) return;
  try {
    await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
    const { active } = await navigator.serviceWorker.ready;
    // Lazy chunks (the offline engine) are not in the page's HTML; by now they have loaded.
    const assets = performance
      .getEntriesByType('resource')
      .map((entry) => new URL(entry.name))
      .filter((url) => url.origin === window.location.origin && url.pathname.startsWith('/_next/static/'))
      .map((url) => url.pathname + url.search);
    active?.postMessage({ type: 'CACHE_SHELL', assets });
  } catch {
    // Blocked or private window: the app still works, only without the offline page.
  }
}

export async function forgetShell(): Promise<void> {
  if (!supported()) return;
  const names = await caches.keys().catch(() => []);
  await Promise.all(names.filter((name) => name.startsWith('studflow-shell')).map(async (name) => (await caches.open(name)).delete('/billing')));
}
