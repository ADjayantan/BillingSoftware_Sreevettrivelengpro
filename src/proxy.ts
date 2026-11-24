import { createServerClient } from '@supabase/ssr';
import { isAuthRetryableFetchError } from '@supabase/supabase-js';
import { NextResponse, type NextRequest } from 'next/server';
import { publicEnv } from '@/lib/schemas/public-env';

const UNAVAILABLE = 'The cloud is not answering. Nothing is lost: try again in a minute.';

/** Longer than a healthy refresh takes; the client would otherwise keep retrying for 30 s. */
const AUTH_PATIENCE = 6000;

/** The one page that works without the cloud: static, so letting it through shows no data. */
const SHELL = '/billing';

const OUTAGE_PAGE = `<!doctype html><html lang="en-IN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>StudFlow · Cloud not answering</title>
<style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-content:center;gap:16px;padding:16px;text-align:center;font:18px/1.5 system-ui,sans-serif}h1,p{margin:0}a{display:inline-block;padding:12px 20px;border:1px solid;border-radius:8px;font-weight:600;color:inherit;text-decoration:none}</style>
<h1>The cloud is not answering</h1><p>Nothing is lost. Billing works meanwhile.</p><p><a href="${SHELL}">Open billing</a> <a href="">Try again</a></p></html>`;

const hasSession = (request: NextRequest): boolean => request.cookies.getAll().some(({ name }) => /^sb-.+-auth-token(\.\d+)?$/.test(name));

async function withPatience<T>(work: Promise<T>): Promise<T | 'late'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => resolve('late'), AUTH_PATIENCE);
  });
  work.catch(() => undefined); // if it fails after we stopped waiting, nobody else is listening
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/**
 * Keeps the Supabase session alive. Access tokens last an hour and Server Components cannot
 * write cookies, so the refresh has to happen here, before rendering: the new tokens go to
 * both this request (for the page) and the response (for the browser).
 *
 * This is also where signed-out visitors are turned away. It is a convenience, not the
 * security boundary: every row is still guarded by RLS and the access list.
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  let response = NextResponse.next({ request });
  let signedIn = false;
  let unreachable = false;
  try {
    const env = publicEnv();
    const supabase = createServerClient(env.supabaseUrl, env.supabasePublishableKey, {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (cookiesToSet, headers) => {
          for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options);
          // Cache-Control: no-store and friends, so a CDN never shares a refreshed session.
          for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
        },
      },
    });
    // Verifies the token, and refreshes it when it has expired. Nothing may run in between.
    const claims = await withPatience(supabase.auth.getClaims());
    signedIn = claims !== 'late' && claims.data !== null;
    // The cloud being down is not a sign-out: keep the session and say so.
    unreachable = claims === 'late' || isAuthRetryableFetchError(claims.error);
  } catch {
    return new NextResponse('StudFlow is not configured yet. See .env.example.', { status: 503 });
  }

  const { pathname, search } = request.nextUrl;
  if (pathname.startsWith('/api/')) {
    if (signedIn) return response;
    if (unreachable) return NextResponse.json({ error: { code: 'UNAVAILABLE', message: UNAVAILABLE } }, { status: 503, headers: { 'retry-after': '30' } });
    return carryCookies(response, NextResponse.json({ error: { code: 'UNAUTHENTICATED', message: 'Sign in again' } }, { status: 401 }));
  }
  if (unreachable && hasSession(request)) {
    // A signed-in shop PC keeps billing. Every row it could see still needs the API and RLS.
    if (pathname === SHELL) return NextResponse.next({ request });
    if (pathname === '/') return NextResponse.redirect(new URL(SHELL, request.url));
    if (pathname === '/login') return response;
    return new NextResponse(OUTAGE_PAGE, {
      status: 503,
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '30' },
    });
  }
  if (!signedIn && pathname !== '/login') {
    const login = new URL('/login', request.url);
    if (pathname !== '/') login.searchParams.set('next', `${pathname}${search}`);
    return carryCookies(response, NextResponse.redirect(login));
  }
  if (signedIn && (pathname === '/login' || pathname === '/')) {
    return carryCookies(response, NextResponse.redirect(new URL('/billing', request.url)));
  }
  return response;
}

/** A replacement response must keep refreshed (or cleared) session cookies. */
function carryCookies(from: NextResponse, to: NextResponse): NextResponse {
  for (const cookie of from.cookies.getAll()) to.cookies.set(cookie);
  return to;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|sw\\.js$|manifest\\.json$|offline\\.html$|.*\\.(?:svg|png|ico|webmanifest)$).*)'],
};
