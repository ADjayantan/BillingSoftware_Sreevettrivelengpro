import { driveInfo } from '@/lib/drive-backup';
import {
  CONNECT_COOKIE,
  DriveLinkError,
  accountEmail,
  connectCheck,
  driveLanding,
  driveLinkKey,
  driveOAuthClient,
  exchangeCode,
  findOrMakeVault,
  readCookie,
  revokeToken,
  seal,
  unseal,
} from '@/lib/drive-link';
import { createClient } from '@/lib/supabase/server';

/**
 * Google sends the owner back here. That is a cross-site visit, so this route does not go
 * through route() (which refuses those): the state and the PKCE verifier sealed in the cookie
 * are the check instead. Only one of a few fixed words ever reaches the page.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  try {
    const key = driveLinkKey();
    const client = driveOAuthClient();
    if (!key || !client) return driveLanding(request.url, 'not-ready');
    const check = connectCheck({ cookie: readCookie(request.headers.get('cookie'), CONNECT_COOKIE), state: url.searchParams.get('state'), key, now: Date.now() });
    if (!check) return driveLanding(request.url, 'expired');
    if (url.searchParams.has('error')) return driveLanding(request.url, 'denied'); // "Cancel" on Google's page
    const code = url.searchParams.get('code') ?? '';
    if (!code || code.length > 2048) return driveLanding(request.url, 'failed');

    const supabase = await createClient();
    const { data: claims } = await supabase.auth.getClaims();
    if (!claims || !(await driveInfo(supabase)).owner) return driveLanding(request.url, 'forbidden');

    const tokens = await exchangeCode({ code, verifier: check.verifier, ...client, redirectUri: `${url.origin}/api/drive/callback` });
    const folder = await findOrMakeVault(tokens.accessToken);
    const email = await accountEmail(tokens.accessToken);
    const { data: replaced, error } = await supabase.rpc('drive_link_save', {
      p_sealed: seal(tokens.refreshToken, key, 'token'),
      p_folder_id: folder,
      p_account_email: email,
    });
    if (error) {
      await revokeToken(tokens.refreshToken); // not kept, so not left alive at Google either
      return driveLanding(request.url, 'failed');
    }
    // The permission it replaced ends at Google too.
    const before = typeof replaced === 'string' ? unseal(replaced, key, 'token') : null;
    if (before && before !== tokens.refreshToken) await revokeToken(before);
    return driveLanding(request.url, 'connected');
  } catch (error) {
    return driveLanding(request.url, error instanceof DriveLinkError ? error.code : 'failed');
  }
}
