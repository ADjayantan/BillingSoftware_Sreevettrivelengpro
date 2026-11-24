// Session refresh: an expired access token is renewed before the page renders.
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const URL_ = 'http://localhost:54321';
const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
const USER = { id: '00000000-0000-4000-8000-000000000001', aud: 'authenticated', role: 'authenticated', email: 'x@test.local', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' };

function session(secondsLeft: number, refreshToken: string): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  const claims = { sub: USER.id, role: 'authenticated', aud: 'authenticated', iat: now - 3600, exp: now + secondsLeft };
  return {
    access_token: `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(claims)}.${Buffer.from('sig').toString('base64url')}`,
    token_type: 'bearer', expires_in: secondsLeft, expires_at: now + secondsLeft, refresh_token: refreshToken, user: USER,
  };
}
const cookieFor = (value: Record<string, unknown>): string => `sb-localhost-auth-token=base64-${b64(value)}`;

let refreshes: string[];
let cloud: 'up' | 'down' | 'revoked';

beforeEach(() => {
  refreshes = [];
  cloud = 'up';
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', URL_);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_test');
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    if (cloud === 'down') throw new TypeError('fetch failed');
    const url = String(input);
    if (url.includes('grant_type=refresh_token')) {
      refreshes.push(String((JSON.parse(String(init?.body)) as { refresh_token: string }).refresh_token));
      return cloud === 'revoked'
        ? Response.json({ code: 'refresh_token_not_found', error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' }, { status: 400 })
        : Response.json(session(3600, 'r2'));
    }
    if (url.endsWith('/auth/v1/user')) return Response.json(USER);
    throw new Error(`unexpected ${url}`);
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function visit(path: string, cookie?: string) {
  const { proxy } = await import('@/proxy');
  return proxy(new NextRequest(`http://localhost:3000${path}`, cookie ? { headers: { cookie } } : {}));
}

describe('proxy', () => {
  it('leaves a live session alone', async () => {
    const response = await visit('/billing', cookieFor(session(3000, 'r1')));
    expect(response.status).toBe(200);
    expect(refreshes).toEqual([]);
    expect(response.cookies.getAll()).toEqual([]);
  });

  it('renews an expired session for this request and for the browser, uncached', async () => {
    const response = await visit('/billing', cookieFor(session(-5, 'r1')));
    expect(response.status).toBe(200);
    expect(refreshes).toEqual(['r1']);
    expect(response.cookies.getAll().some((cookie) => cookie.name.startsWith('sb-localhost-auth-token') && cookie.value !== '')).toBe(true);
    // The page rendered by this same request sees the new token, not the expired one.
    expect(response.headers.get('x-middleware-request-cookie')).not.toBe(cookieFor(session(-5, 'r1')));
    expect(response.headers.get('cache-control')).toMatch(/no-store/);
  });

  it('sends the signed-out to sign in, and comes back', async () => {
    const page = await visit('/invoices?page=2');
    expect(page.status).toBe(307);
    expect(page.headers.get('location')).toBe('http://localhost:3000/login?next=%2Finvoices%3Fpage%3D2');
    expect((await visit('/login')).status).toBe(200);
    const api = await visit('/api/customers');
    expect(api.status).toBe(401);
    expect(await api.json()).toEqual({ error: { code: 'UNAUTHENTICATED', message: 'Sign in again' } });
  });

  it('clears a revoked session while redirecting', async () => {
    cloud = 'revoked';
    const response = await visit('/billing', cookieFor(session(-5, 'r1')));
    expect(response.status).toBe(307);
    expect(response.cookies.get('sb-localhost-auth-token')?.value).toBe('');
  });

  it('does not call an unreachable cloud a sign-out', async () => {
    cloud = 'down';
    const live = cookieFor(session(3000, 'r1'));
    const api = await visit('/api/customers', live);
    expect(api.status).toBe(503);
    expect(((await api.json()) as { error: { code: string } }).error.code).toBe('UNAVAILABLE');
    // Other pages say so in words, with a way on; nothing is a dead end.
    const page = await visit('/customers', live);
    expect(page.status).toBe(503);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(await page.text()).toContain('href="/billing"');
    expect(page.cookies.getAll()).toEqual([]);
  });

  it('lets a signed-in PC open the (static) billing page during an outage, and nobody else', async () => {
    cloud = 'down';
    const live = cookieFor(session(3000, 'r1'));
    const billing = await visit('/billing?bill=OFFLINE-1', live);
    expect(billing.status).toBe(200);
    expect(billing.headers.get('x-middleware-next')).toBe('1');
    expect((await visit('/', live)).headers.get('location')).toBe('http://localhost:3000/billing');
    expect((await visit('/login', live)).status).toBe(200);
    expect((await visit('/billing')).headers.get('location')).toBe('http://localhost:3000/login?next=%2Fbilling');
    expect((await visit('/billing', 'sb-localhost-auth-token-code-verifier=x')).status).toBe(307);
  });

  it('does not hang on an expired session while the cloud is down', async () => {
    cloud = 'down';
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const pending = visit('/billing', cookieFor(session(-5, 'r1')));
      await vi.advanceTimersByTimeAsync(7000);
      const response = await pending;
      expect(response.status).toBe(200);
      expect(response.cookies.getAll()).toEqual([]); // the session survives the outage
      await vi.advanceTimersByTimeAsync(60_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('serves the install files without a session', async () => {
    const { config } = await import('@/proxy');
    const matcher = new RegExp(`^${config.matcher[0]}$`);
    for (const path of ['/sw.js', '/manifest.json', '/offline.html', '/icon-192.png']) expect(matcher.test(path)).toBe(false);
    for (const path of ['/billing', '/api/customers', '/sw.js/../customers', '/offline.html/x', '/api/sw.js/x']) expect(matcher.test(path)).toBe(true);
  });

  it('skips the sign-in page for the signed-in', async () => {
    expect((await visit('/login', cookieFor(session(3000, 'r1')))).headers.get('location')).toBe('http://localhost:3000/billing');
  });
});

describe('sign-in return path', () => {
  it('stays on this site', async () => {
    const { safeNext } = await import('@/lib/safe-next');
    expect(safeNext('/invoices?page=2')).toBe('/invoices?page=2');
    for (const bad of ['', '//evil.example', '/\\evil.example', 'https://evil.example', 'javascript:alert(1)', '/\t/evil.example', '/\n/evil.example']) {
      expect(safeNext(bad)).toBe('/billing');
    }
  });
});
