import { NextResponse } from 'next/server';
import { route } from '@/lib/api/http';
import { driveInfo } from '@/lib/drive-backup';
import { CONNECT_COOKIE, CONNECT_MAX_AGE_S, CONNECT_PATH, connectStart, driveLanding, driveLinkKey, driveOAuthClient } from '@/lib/drive-link';

/**
 * The owner's "Connect Google Drive" (specs/drive-button.md): off to Google's own page, with a
 * fresh state and a PKCE verifier sealed in a cookie that only comes back to /api/drive.
 */
export const GET = route(async ({ request, supabase }) => {
  const info = await driveInfo(supabase);
  if (!info.ready) return driveLanding(request.url, 'not-ready'); // a database from before 009
  if (!info.owner) return driveLanding(request.url, 'forbidden');
  const key = driveLinkKey();
  const client = driveOAuthClient();
  if (!key || !client) return driveLanding(request.url, 'not-ready');
  const origin = new URL(request.url).origin;
  const { url, cookie } = connectStart({ clientId: client.clientId, redirectUri: `${origin}/api/drive/callback`, key, now: Date.now() });
  const response = NextResponse.redirect(url, 303);
  response.headers.set('cache-control', 'no-store');
  response.cookies.set(CONNECT_COOKIE, cookie, { httpOnly: true, secure: origin.startsWith('https:'), sameSite: 'lax', path: CONNECT_PATH, maxAge: CONNECT_MAX_AGE_S });
  return response;
});
