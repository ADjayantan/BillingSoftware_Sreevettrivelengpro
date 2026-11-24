import { createServerClient } from '@supabase/ssr';
import { isAuthRetryableFetchError } from '@supabase/supabase-js';
import { NextResponse, type NextRequest } from 'next/server';
import { publicEnv } from '@/lib/schemas/public-env';

const UNAVAILABLE = 'The cloud is not answering. Nothing is lost: try again in a minute.';

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
    const { data, error } = await supabase.auth.getClaims();
    signedIn = data !== null;
    // The cloud being down is not a sign-out: keep the session and say so.
    unreachable = isAuthRetryableFetchError(error);
  } catch {
    return new NextResponse('StudFlow is not configured yet. See .env.example.', { status: 503 });
  }

  const { pathname, search } = request.nextUrl;
  if (pathname.startsWith('/api/')) {
    if (signedIn) return response;
    if (unreachable) return NextResponse.json({ error: { code: 'UNAVAILABLE', message: UNAVAILABLE } }, { status: 503 });
    return carryCookies(response, NextResponse.json({ error: { code: 'UNAUTHENTICATED', message: 'Sign in again' } }, { status: 401 }));
  }
  if (unreachable && pathname !== '/login') return new NextResponse(UNAVAILABLE, { status: 503 });
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
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|ico|webmanifest)$).*)'],
};
