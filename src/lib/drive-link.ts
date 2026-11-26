import 'server-only';
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { z } from 'zod';

/**
 * The Google Drive sign-in made with the Company page's button (specs/drive-button.md): the
 * sealing of the permission, and the steps with Google. Nothing here reads the database.
 */

export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const VAULT_NAME = 'Company_Billing_Vault';
export const CONNECT_COOKIE = 'studflow_drive_oauth';
export const CONNECT_PATH = '/api/drive';
export const CONNECT_MAX_AGE_S = 600;

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const ABOUT_URL = 'https://www.googleapis.com/drive/v3/about';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const PATIENCE_MS = 10_000;
const folderId = /^[A-Za-z0-9_-]{8,128}$/;

/** What the owner is told, in one word; never Google's own text, which may carry a secret. */
export type DriveLinkCode = 'denied' | 'failed' | 'expired' | 'forbidden' | 'not-ready';

export class DriveLinkError extends Error {
  constructor(readonly code: DriveLinkCode) {
    super(`Google Drive could not be connected (${code})`);
    this.name = 'DriveLinkError';
  }
}

/**
 * The key that seals the permission. It comes from CRON_SECRET, a server setting the database
 * never sees, so the stored row alone opens nothing. Changing CRON_SECRET means connecting again.
 */
export function driveLinkKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const secret = env.CRON_SECRET?.trim() ?? '';
  if (secret.length < 32) return null;
  return Buffer.from(hkdfSync('sha256', secret, 'StudFlow', 'google-drive-link/v1', 32));
}

/** The Google client of the server settings: the one that made the permission must renew it. */
export function driveOAuthClient(env: NodeJS.ProcessEnv = process.env): { clientId: string; clientSecret: string } | null {
  const clientId = env.GOOGLE_DRIVE_OAUTH_CLIENT_ID?.trim() ?? '';
  const clientSecret = env.GOOGLE_DRIVE_OAUTH_CLIENT_SECRET?.trim() ?? '';
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

// What each sealed text is for: a cookie can never be passed off as the stored permission.
const PURPOSE = { token: Buffer.from('studflow:drive-link:token:v1'), cookie: Buffer.from('studflow:drive-link:cookie:v1') } as const;
export type SealPurpose = keyof typeof PURPOSE;

/** AES-256-GCM: `v1.<12-byte iv>.<ciphertext and tag>`, base64url. */
export function seal(plain: string, key: Buffer, purpose: SealPurpose): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(PURPOSE[purpose]);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return `v1.${iv.toString('base64url')}.${body.toString('base64url')}`;
}

/** Null for anything not sealed with this key for this purpose, or changed since. */
export function unseal(sealed: string, key: Buffer, purpose: SealPurpose): string | null {
  const parts = /^v1\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{23,})$/.exec(sealed);
  if (!parts?.[1] || !parts[2]) return null;
  try {
    const iv = Buffer.from(parts[1], 'base64url');
    const body = Buffer.from(parts[2], 'base64url');
    if (iv.length !== 12 || body.length <= 16) return null;
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(PURPOSE[purpose]);
    decipher.setAuthTag(body.subarray(body.length - 16));
    return Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/**
 * Where to send the owner, and the cookie that must come back with Google's answer: a fresh
 * state against forged answers, and a PKCE verifier so a stolen code is worth nothing.
 */
export function connectStart(input: { clientId: string; redirectUri: string; key: Buffer; now: number }): { url: string; cookie: string } {
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  const url = `${AUTH_URL}?${new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: 'code',
    scope: DRIVE_FILE_SCOPE,
    access_type: 'offline', // without these two Google gives no lasting permission
    prompt: 'consent',
    state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
  }).toString()}`;
  return { url, cookie: seal(JSON.stringify({ s: state, v: verifier, t: input.now }), input.key, 'cookie') };
}

/** One cookie from a Cookie header: the callback reads it this way and needs no request scope. */
export function readCookie(header: string | null, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim() || undefined;
  }
  return undefined;
}

/** Back to the Company page's Drive section with one word, and the connect cookie gone. */
export function driveLanding(requestUrl: string, word: DriveLinkCode | 'connected'): NextResponse {
  const response = NextResponse.redirect(new URL(`/company?drive=${word}#drive`, requestUrl), 303);
  response.headers.set('cache-control', 'no-store');
  response.cookies.set(CONNECT_COOKIE, '', { httpOnly: true, sameSite: 'lax', path: CONNECT_PATH, maxAge: 0 });
  return response;
}

const cookieBody = z.object({ s: z.string().min(1).max(100), v: z.string().min(1).max(200), t: z.number().int() });

/** The verifier, when Google's state is the one this cookie sent, within ten minutes; else null. */
export function connectCheck(input: { cookie: string | undefined; state: string | null; key: Buffer; now: number }): { verifier: string } | null {
  if (!input.cookie || !input.state) return null;
  const opened = unseal(input.cookie, input.key, 'cookie');
  if (opened === null) return null;
  let parsed: z.infer<typeof cookieBody>;
  try {
    const result = cookieBody.safeParse(JSON.parse(opened));
    if (!result.success) return null;
    parsed = result.data;
  } catch {
    return null;
  }
  const age = input.now - parsed.t;
  if (age < -60_000 || age > CONNECT_MAX_AGE_S * 1000) return null;
  const expected = Buffer.from(parsed.s);
  const given = Buffer.from(input.state);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return { verifier: parsed.v };
}

const tokenReply = z.object({
  access_token: z.string().min(1).max(4096),
  refresh_token: z.string().min(1).max(2048),
  scope: z.string().max(4096).optional(),
});

/** The code, once, for a lasting permission to the app's own files. */
export async function exchangeCode(
  input: { code: string; verifier: string; clientId: string; clientSecret: string; redirectUri: string },
  fetchImpl: typeof fetch = fetch,
): Promise<{ accessToken: string; refreshToken: string }> {
  const response = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      code_verifier: input.verifier,
      client_id: input.clientId,
      client_secret: input.clientSecret,
      redirect_uri: input.redirectUri,
    }).toString(),
    signal: AbortSignal.timeout(PATIENCE_MS),
  }).catch(() => null);
  if (!response?.ok) throw new DriveLinkError('failed');
  const reply = tokenReply.safeParse(await response.json().catch(() => null));
  if (!reply.success) throw new DriveLinkError('failed');
  if (reply.data.scope !== undefined && !reply.data.scope.split(' ').includes(DRIVE_FILE_SCOPE)) throw new DriveLinkError('denied');
  return { accessToken: reply.data.access_token, refreshToken: reply.data.refresh_token };
}

const fileList = z.object({ files: z.array(z.object({ id: z.string() })) });
const madeFile = z.object({ id: z.string() });

/** The Company_Billing_Vault folder at the top of that Drive: the one there, else a new one. */
export async function findOrMakeVault(accessToken: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const headers = { authorization: `Bearer ${accessToken}` };
  const q = `name = '${VAULT_NAME}' and mimeType = '${FOLDER_MIME}' and 'root' in parents and trashed = false`;
  const found = await fetchImpl(`${FILES_URL}?${new URLSearchParams({ q, fields: 'files(id)', pageSize: '1' }).toString()}`, {
    headers,
    signal: AbortSignal.timeout(PATIENCE_MS),
  }).catch(() => null);
  if (!found?.ok) throw new DriveLinkError('failed');
  const list = fileList.safeParse(await found.json().catch(() => null));
  if (!list.success) throw new DriveLinkError('failed');
  let id = list.data.files[0]?.id;
  if (id === undefined) {
    const made = await fetchImpl(`${FILES_URL}?fields=id`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ name: VAULT_NAME, mimeType: FOLDER_MIME }),
      signal: AbortSignal.timeout(PATIENCE_MS),
    }).catch(() => null);
    if (!made?.ok) throw new DriveLinkError('failed');
    const file = madeFile.safeParse(await made.json().catch(() => null));
    if (!file.success) throw new DriveLinkError('failed');
    id = file.data.id;
  }
  if (!folderId.test(id)) throw new DriveLinkError('failed');
  return id;
}

const about = z.object({ user: z.object({ emailAddress: z.email().max(254) }) });

/** The Google account the permission belongs to, for the owner to see; null when Google does not say. */
export async function accountEmail(accessToken: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const response = await fetchImpl(`${ABOUT_URL}?fields=user(emailAddress)`, {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(PATIENCE_MS),
  }).catch(() => null);
  if (!response?.ok) return null;
  const reply = about.safeParse(await response.json().catch(() => null));
  return reply.success ? reply.data.user.emailAddress : null;
}

/** Ends a permission at Google. A failure here stops nothing: the permission is gone from StudFlow anyway. */
export async function revokeToken(token: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  await fetchImpl(REVOKE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }).toString(),
    signal: AbortSignal.timeout(PATIENCE_MS),
  }).catch(() => undefined);
}
