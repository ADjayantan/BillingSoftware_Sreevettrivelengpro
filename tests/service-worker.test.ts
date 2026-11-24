// public/sw.js, run as the browser runs it: what it answers, and what it must never store.
import { existsSync, readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { beforeEach, describe, expect, it } from 'vitest';

const ORIGIN = 'https://shop.example';
const SHELL_HTML = '<script src="/_next/static/chunks/a.js"></script><link href="/_next/static/chunks/b.css"><script>self.__next_f.push([1,"\\"/_next/static/chunks/c.js\\""])</script>';

class FakeCache {
  readonly entries = new Map<string, Response>();
  constructor(private readonly wire: (url: string) => Promise<Response>) {}
  private key = (request: string | { url: string }): string => new URL(typeof request === 'string' ? request : request.url, ORIGIN).href;
  async match(request: string | { url: string }) { return this.entries.get(this.key(request))?.clone(); }
  async put(request: string | { url: string }, response: Response) { this.entries.set(this.key(request), response); }
  async add(path: string) {
    const response = await this.wire(new URL(path, ORIGIN).href);
    if (!response.ok) throw new TypeError('bad response');
    await this.put(path, response);
  }
  async addAll(paths: string[]) { for (const path of paths) await this.add(path); }
  async keys() { return [...this.entries.keys()].map((url) => ({ url })); }
  async delete(request: string | { url: string }) { return this.entries.delete(this.key(request)); }
}

let net: 'up' | 'down' | '503' | 'slow' | 'signed-out';
let stores: Map<string, FakeCache>;
let listeners: Record<string, (event: Record<string, unknown>) => void>;
let html: string;

function boot(): void {
  stores = new Map();
  listeners = {};
  const wire = async (input: string | { url: string }): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input.url, ORIGIN);
    if (net === 'down') throw new TypeError('Failed to fetch');
    if (net === 'slow') return new Promise(() => undefined);
    if (url.pathname.startsWith('/_next/static/') || url.pathname.endsWith('.png')) return typed(new Response(`asset ${url.pathname}`));
    if (url.pathname === '/offline.html') return typed(new Response('OFFLINE PAGE', { headers: { 'content-type': 'text/html' } }));
    if (net === '503') return typed(new Response('outage', { status: 503 }));
    if (net === 'signed-out') return typed(new Response('<form>login</form>', { headers: { 'content-type': 'text/html' } }), true);
    return typed(new Response(url.pathname === '/billing' ? html : `live ${url.pathname}`, { headers: { 'content-type': 'text/html; charset=utf-8' } }));
  };
  const self = {
    addEventListener: (type: string, listener: (event: Record<string, unknown>) => void) => { listeners[type] = listener; },
    skipWaiting: async () => undefined, clients: { claim: async () => undefined }, location: { origin: ORIGIN },
  };
  const caches = {
    open: async (name: string) => stores.get(name) ?? stores.set(name, new FakeCache(wire)).get(name),
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
  };
  const FastResponse = Object.assign(Response, {});
  runInNewContext(readFileSync('public/sw.js', 'utf8'), {
    self, caches, fetch: wire, URL, Response: FastResponse, Map, Set, Promise, Array, Error,
    // Patience is 5 s on the shop floor; tests have none.
    setTimeout: (run: () => void) => setTimeout(run, 5), clearTimeout,
  });
}
function typed(response: Response, redirected = false): Response {
  Object.defineProperties(response, { type: { value: 'basic' }, redirected: { value: redirected } });
  return response;
}

async function emit(type: string, data?: unknown): Promise<void> {
  const waiting: Promise<unknown>[] = [];
  listeners[type]?.({ data, waitUntil: (promise: Promise<unknown>) => waiting.push(promise) });
  await Promise.all(waiting);
}

/** The worker's answer, or null when it leaves the request to the browser. */
async function ask(path: string, options: { mode?: string; method?: string; origin?: string } = {}): Promise<Response | null> {
  let answer: Promise<Response> | null = null;
  listeners.fetch?.({
    request: { url: (options.origin ?? ORIGIN) + path, method: options.method ?? 'GET', mode: options.mode ?? 'cors' },
    respondWith: (response: Promise<Response>) => { answer = Promise.resolve(response); },
  });
  return answer;
}
const visit = (path: string) => ask(path, { mode: 'navigate' });
const text = async (response: Response | null) => response?.text();
const stored = () => [...stores.values()].flatMap((cache) => [...cache.entries.keys()].map((url) => url.replace(ORIGIN, ''))).sort();

beforeEach(async () => {
  net = 'up';
  html = SHELL_HTML;
  boot();
  await emit('install');
  await emit('activate');
  await emit('message', { type: 'CACHE_SHELL', assets: ['/_next/static/chunks/dexie.js', 'https://evil.example/x.js', '/api/customers'] });
});

describe('service worker', () => {
  it('stores the billing page, its files and the offline page, and nothing else', async () => {
    const files = ['/_next/static/chunks/a.js', '/_next/static/chunks/b.css', '/_next/static/chunks/c.js', '/_next/static/chunks/dexie.js', '/billing', '/icon-192.png', '/offline.html'];
    expect(stored()).toEqual(files);
    await visit('/customers');
    await visit('/invoices/1/print');
    await ask('/api/customers?q=m');
    await ask('/customers?_rsc=abc');
    expect(stored()).toEqual(files);
  });

  it.each(['down', '503', 'slow'] as const)('opens /billing and / when the network is %s', async (state) => {
    net = state;
    expect(await text(await visit('/billing'))).toBe(SHELL_HTML);
    expect(await text(await visit('/billing?bill=OFFLINE-1'))).toBe(SHELL_HTML);
    const root = await visit('/');
    expect(root?.status).toBe(302);
    expect(root?.headers.get('location')).toMatch(/\/billing$/);
    expect(await text(await ask('/_next/static/chunks/dexie.js'))).toContain('asset');
  });

  it('asks the network first, so signing out and new versions are noticed', async () => {
    html = 'new version';
    expect(await text(await visit('/billing'))).toBe('new version');
    net = 'signed-out';
    expect(await text(await visit('/billing'))).toBe('<form>login</form>');
  });

  it('never replaces the page with a sign-in form, an outage, or a half-downloaded version', async () => {
    for (const state of ['signed-out', '503', 'down'] as const) {
      net = state;
      await emit('message', { type: 'CACHE_SHELL', assets: [] });
    }
    net = 'down';
    expect(await text(await visit('/billing'))).toBe(SHELL_HTML);
  });

  it('swaps to a new version and drops the old files', async () => {
    html = '<script src="/_next/static/chunks/new.js"></script>';
    await emit('message', { type: 'CACHE_SHELL', assets: [] });
    expect(stored()).toEqual(['/_next/static/chunks/new.js', '/billing', '/icon-192.png', '/offline.html']);
  });

  it('explains other pages when there is no network, and leaves their errors alone', async () => {
    net = 'down';
    expect(await text(await visit('/customers'))).toBe('OFFLINE PAGE');
    net = '503';
    expect((await visit('/customers'))?.status).toBe(503);
  });

  it('keeps out of API calls, page data, posts and other sites', async () => {
    expect(await ask('/api/customers')).toBeNull();
    expect(await visit('/api/customers')).toBeNull();
    expect(await ask('/billing?_rsc=1')).toBeNull();
    expect(await ask('/billing', { method: 'POST', mode: 'navigate' })).toBeNull();
    expect(await ask('/_next/static/chunks/a.js', { origin: 'https://evil.example' })).toBeNull();
  });

  it('removes only its own older caches', async () => {
    stores.set('studflow-shell-v0', new FakeCache(async () => new Response()));
    stores.set('someone-else', new FakeCache(async () => new Response()));
    await emit('activate');
    expect([...stores.keys()].sort()).toEqual(['someone-else', 'studflow-shell-v1', 'studflow-static-v1']);
  });
});

describe('manifest', () => {
  it('is installable: names, start page, and icons that exist at their size', () => {
    const manifest = JSON.parse(readFileSync('public/manifest.json', 'utf8')) as { start_url: string; display: string; icons: { src: string; sizes: string; purpose: string }[] };
    expect(manifest).toMatchObject({ start_url: '/billing', display: 'standalone' });
    expect(manifest.icons.map((icon) => icon.sizes)).toEqual(expect.arrayContaining(['192x192', '512x512']));
    expect(manifest.icons.some((icon) => icon.purpose === 'maskable')).toBe(true);
    for (const icon of manifest.icons) {
      expect(existsSync(`public${icon.src}`)).toBe(true);
      const png = readFileSync(`public${icon.src}`);
      expect(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`).toBe(icon.sizes);
      expect(png.length).toBeLessThan(10_000);
    }
  });
});
