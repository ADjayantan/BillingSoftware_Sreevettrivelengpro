import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CONNECT_MAX_AGE_S,
  DRIVE_FILE_SCOPE,
  DriveLinkError,
  accountEmail,
  connectCheck,
  connectStart,
  driveLinkKey,
  driveOAuthClient,
  exchangeCode,
  findOrMakeVault,
  revokeToken,
  seal,
  unseal,
} from '@/lib/drive-link';

// specs/drive-button.md: the Google permission is kept sealed, the connect flow checks its
// own state and PKCE verifier, and every answer from Google is read without trusting it.

const SECRET = 'c'.repeat(40);
const KEY = driveLinkKey({ CRON_SECRET: SECRET } as unknown as NodeJS.ProcessEnv)!;
const TOKEN = `1//0g${'x'.repeat(98)}`;
const NOW = 1_795_700_000_000;
const DB_CHECK = /^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{40,}$/;

type Call = { url: string; init: RequestInit | undefined };
function fakeFetch(answers: Array<{ status?: number; body: unknown }>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const queue = [...answers];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const next = queue.shift() ?? { status: 500, body: {} };
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetch: impl, calls };
}
const form = (call: Call | undefined): URLSearchParams => new URLSearchParams(String(call?.init?.body ?? ''));

describe('the key', () => {
  it('comes from CRON_SECRET only when it is long enough', () => {
    expect(driveLinkKey({} as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(driveLinkKey({ CRON_SECRET: 'short' } as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(KEY).toHaveLength(32);
    expect(driveLinkKey({ CRON_SECRET: SECRET } as unknown as NodeJS.ProcessEnv)!.equals(KEY)).toBe(true);
    expect(driveLinkKey({ CRON_SECRET: 'd'.repeat(40) } as unknown as NodeJS.ProcessEnv)!.equals(KEY)).toBe(false);
  });

  it('reads the Google client of the server settings, or says none', () => {
    expect(driveOAuthClient({} as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(driveOAuthClient({ GOOGLE_DRIVE_OAUTH_CLIENT_ID: 'id' } as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(driveOAuthClient({ GOOGLE_DRIVE_OAUTH_CLIENT_ID: ' id ', GOOGLE_DRIVE_OAUTH_CLIENT_SECRET: ' secret ' } as unknown as NodeJS.ProcessEnv)).toEqual({ clientId: 'id', clientSecret: 'secret' });
  });
});

describe('sealing', () => {
  it('opens what it sealed, in the shape the database takes', () => {
    const sealed = seal(TOKEN, KEY, 'token');
    expect(sealed).toMatch(DB_CHECK);
    expect(sealed).not.toContain(TOKEN);
    expect(unseal(sealed, KEY, 'token')).toBe(TOKEN);
    expect(seal(TOKEN, KEY, 'token')).not.toBe(sealed);
  });

  it('opens nothing sealed with another key, for another use, or changed', () => {
    const sealed = seal(TOKEN, KEY, 'token');
    const other = driveLinkKey({ CRON_SECRET: 'e'.repeat(40) } as unknown as NodeJS.ProcessEnv)!;
    expect(unseal(sealed, other, 'token')).toBeNull();
    expect(unseal(sealed, KEY, 'cookie')).toBeNull();
    const [v, iv, body] = sealed.split('.') as [string, string, string];
    const flip = (text: string): string => `${text.slice(0, -2)}${text.at(-2) === 'A' ? 'B' : 'A'}${text.at(-1)}`;
    expect(unseal(`${v}.${flip(iv)}.${body}`, KEY, 'token')).toBeNull();
    expect(unseal(`${v}.${iv}.${flip(body)}`, KEY, 'token')).toBeNull();
    expect(unseal(`v2.${iv}.${body}`, KEY, 'token')).toBeNull();
    for (const junk of ['', 'v1..', 'v1.short.short', TOKEN]) expect(unseal(junk, KEY, 'token')).toBeNull();
  });
});

describe('connecting', () => {
  const start = (now = NOW) => connectStart({ clientId: 'client-1', redirectUri: 'https://studflow.example/api/drive/callback', key: KEY, now });

  it("sends the owner to Google's page with the app's own files only, a state and a PKCE challenge", () => {
    const { url, cookie } = start();
    const asked = new URL(url);
    expect(`${asked.origin}${asked.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    const params = Object.fromEntries(asked.searchParams);
    expect(params).toMatchObject({
      client_id: 'client-1',
      redirect_uri: 'https://studflow.example/api/drive/callback',
      response_type: 'code',
      scope: DRIVE_FILE_SCOPE,
      access_type: 'offline',
      prompt: 'consent',
      code_challenge_method: 'S256',
    });
    expect(params.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const back = connectCheck({ cookie, state: params.state ?? null, key: KEY, now: NOW + 60_000 });
    expect(back).not.toBeNull();
    expect(createHash('sha256').update(back!.verifier).digest('base64url')).toBe(params.code_challenge);
    expect(cookie).not.toContain(back!.verifier);
  });

  it('accepts the answer only with its own state, from its own cookie, in time', () => {
    const { url, cookie } = start();
    const state = new URL(url).searchParams.get('state');
    const other = start(NOW + 1);
    expect(connectCheck({ cookie, state: new URL(other.url).searchParams.get('state'), key: KEY, now: NOW })).toBeNull();
    expect(connectCheck({ cookie: other.cookie, state, key: KEY, now: NOW })).toBeNull();
    expect(connectCheck({ cookie: undefined, state, key: KEY, now: NOW })).toBeNull();
    expect(connectCheck({ cookie, state: null, key: KEY, now: NOW })).toBeNull();
    expect(connectCheck({ cookie, state: `${state}x`, key: KEY, now: NOW })).toBeNull();
    expect(connectCheck({ cookie, state, key: driveLinkKey({ CRON_SECRET: 'f'.repeat(40) } as unknown as NodeJS.ProcessEnv)!, now: NOW })).toBeNull();
    expect(connectCheck({ cookie, state, key: KEY, now: NOW + CONNECT_MAX_AGE_S * 1000 + 1 })).toBeNull();
    expect(connectCheck({ cookie, state, key: KEY, now: NOW + CONNECT_MAX_AGE_S * 1000 })).not.toBeNull();
  });
});

describe("Google's answers", () => {
  const ask = { code: 'code-1', verifier: 'verifier-1', clientId: 'client-1', clientSecret: 'secret-1', redirectUri: 'https://studflow.example/api/drive/callback' };

  it('trades the code once, with the verifier, for a lasting permission', async () => {
    const google = fakeFetch([{ body: { access_token: 'access-1', refresh_token: TOKEN, expires_in: 3599, scope: DRIVE_FILE_SCOPE, token_type: 'Bearer' } }]);
    expect(await exchangeCode(ask, google.fetch)).toEqual({ accessToken: 'access-1', refreshToken: TOKEN });
    expect(google.calls[0]?.url).toBe('https://oauth2.googleapis.com/token');
    expect(Object.fromEntries(form(google.calls[0]))).toEqual({
      grant_type: 'authorization_code',
      code: 'code-1',
      code_verifier: 'verifier-1',
      client_id: 'client-1',
      client_secret: 'secret-1',
      redirect_uri: 'https://studflow.example/api/drive/callback',
    });
  });

  it.each([
    ['a refusal', { status: 400, body: { error: 'invalid_grant' } }, 'failed'],
    ['no lasting permission', { body: { access_token: 'access-1', expires_in: 3599 } }, 'failed'],
    ['an odd reply', { body: ['not', 'an', 'object'] }, 'failed'],
    ['another permission than its own files', { body: { access_token: 'a', refresh_token: TOKEN, scope: 'openid email' } }, 'denied'],
  ])('takes no %s', async (_name, answer, code) => {
    const google = fakeFetch([answer]);
    const error = await exchangeCode(ask, google.fetch).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DriveLinkError);
    expect((error as DriveLinkError).code).toBe(code);
    expect((error as Error).message).not.toContain('secret-1');
  });

  it('uses the vault folder when it is there, else makes it', async () => {
    const found = fakeFetch([{ body: { files: [{ id: 'folder-0001-aaaa' }] } }]);
    expect(await findOrMakeVault('access-1', found.fetch)).toBe('folder-0001-aaaa');
    const q = new URL(found.calls[0]!.url).searchParams.get('q') ?? '';
    expect(q).toContain("name = 'Company_Billing_Vault'");
    expect(q).toContain('trashed = false');
    expect(q).toContain("'root' in parents");
    expect((found.calls[0]?.init?.headers as Record<string, string>).authorization).toBe('Bearer access-1');

    const made = fakeFetch([{ body: { files: [] } }, { body: { id: 'folder-0002-bbbb' } }]);
    expect(await findOrMakeVault('access-1', made.fetch)).toBe('folder-0002-bbbb');
    expect(made.calls[1]?.init?.method).toBe('POST');
    expect(JSON.parse(String(made.calls[1]?.init?.body))).toEqual({ name: 'Company_Billing_Vault', mimeType: 'application/vnd.google-apps.folder' });

    await expect(findOrMakeVault('access-1', fakeFetch([{ body: { files: [{ id: '../x' }] } }]).fetch)).rejects.toBeInstanceOf(DriveLinkError);
    await expect(findOrMakeVault('access-1', fakeFetch([{ status: 403, body: {} }]).fetch)).rejects.toBeInstanceOf(DriveLinkError);
  });

  it('names the account when Google says it, else nothing', async () => {
    expect(await accountEmail('access-1', fakeFetch([{ body: { user: { emailAddress: 'owner@example.com' } } }]).fetch)).toBe('owner@example.com');
    expect(await accountEmail('access-1', fakeFetch([{ body: { user: {} } }]).fetch)).toBeNull();
    expect(await accountEmail('access-1', fakeFetch([{ status: 403, body: {} }]).fetch)).toBeNull();
  });

  it('revokes an old permission, and a failure there stops nothing', async () => {
    const google = fakeFetch([{ body: {} }]);
    await revokeToken(TOKEN, google.fetch);
    expect(google.calls[0]?.url).toBe('https://oauth2.googleapis.com/revoke');
    expect(form(google.calls[0]).get('token')).toBe(TOKEN);
    await expect(revokeToken(TOKEN, fakeFetch([{ status: 400, body: {} }]).fetch)).resolves.toBeUndefined();
    await expect(revokeToken(TOKEN, (async () => { throw new Error('offline'); }) as typeof fetch)).resolves.toBeUndefined();
  });
});
