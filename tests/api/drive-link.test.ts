// Connect Google Drive from the Company page, end to end (specs/drive-button.md): real routes,
// real supabase-js, real SQL and the 009 functions; only Google is played by a fake.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createClient as createSupabase, type SupabaseClient } from '@supabase/supabase-js';
import { GET as callback } from '@/app/api/drive/callback/route';
import { GET as connect } from '@/app/api/drive/connect/route';
import { POST as disconnect } from '@/app/api/drive/disconnect/route';
import { driveLinkKey, unseal } from '@/lib/drive-link';
import { ACTORS, createTestDb, queryAs, type Actor } from '../db/harness';
import { pgliteFetch } from '../support/postgrest';

let db: PGlite;
let actor: Actor = ACTORS.owner;

const client = (): SupabaseClient => {
  const supabase = createSupabase('http://localhost', 'sb_publishable_test', {
    global: { fetch: pgliteFetch(db, () => actor) },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  supabase.auth.getClaims = (async () => ({ data: { claims: {} }, error: null })) as unknown as typeof supabase.auth.getClaims;
  return supabase;
};
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => client() }));

const SECRET = 's'.repeat(48);
const KEY = driveLinkKey({ CRON_SECRET: SECRET } as unknown as NodeJS.ProcessEnv)!;
const FIRST = `1//0first${'f'.repeat(90)}`;
const SECOND = `1//0second${'g'.repeat(90)}`;

/** Google, played: answers in order, and remembers what it was asked. */
let asked: { url: string; body: string }[] = [];
let answers: { status?: number; body: unknown }[] = [];
const google = (async (input: RequestInfo | URL, init?: RequestInit) => {
  asked.push({ url: String(input), body: String(init?.body ?? '') });
  const next = answers.shift() ?? { status: 500, body: {} };
  return Response.json(next.body, { status: next.status ?? 200 });
}) as typeof fetch;
const grant = (refreshToken: string, folders: { id: string }[] = []) => [
  { body: { access_token: 'access-1', refresh_token: refreshToken, expires_in: 3599, scope: 'https://www.googleapis.com/auth/drive.file' } },
  { body: { files: folders } },
  ...(folders.length ? [] : [{ body: { id: 'vault-folder-0001' } }]),
  { body: { user: { emailAddress: 'owner@example.com' } } },
];

type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;
async function call(handler: unknown, url: string, as: Actor, init: RequestInit = {}): Promise<Response> {
  actor = as;
  try {
    return await (handler as Handler)(new Request(url, init), { params: Promise.resolve({}) });
  } finally {
    actor = ACTORS.owner;
  }
}
const landing = (response: Response): string => {
  const where = new URL(response.headers.get('location') ?? '', 'http://localhost');
  return `${where.pathname}?${where.searchParams.toString()}`;
};
/** Starts as the owner: Google's address, and the cookie the browser would keep. */
async function start(): Promise<{ state: string; cookie: string }> {
  const response = await call(connect, 'http://localhost/api/drive/connect', ACTORS.owner);
  const state = new URL(response.headers.get('location') ?? '').searchParams.get('state') ?? '';
  const cookie = /studflow_drive_oauth=([^;]+)/.exec(response.headers.get('set-cookie') ?? '')?.[1] ?? '';
  return { state, cookie };
}
const back = (query: string, cookie: string, as: Actor = ACTORS.owner) =>
  call(callback, `http://localhost/api/drive/callback?${query}`, as, { headers: { cookie: `other=1; studflow_drive_oauth=${cookie}` } });
const stored = async (): Promise<{ sealed: string; folder_id: string } | null> =>
  (await queryAs<{ r: { sealed: string; folder_id: string } | null }>(db, ACTORS.service, 'select public.drive_link_secret() as r'))[0]!.r;

beforeAll(async () => {
  db = await createTestDb();
});
beforeEach(() => {
  vi.stubEnv('CRON_SECRET', SECRET);
  vi.stubEnv('GOOGLE_DRIVE_OAUTH_CLIENT_ID', 'web-client');
  vi.stubEnv('GOOGLE_DRIVE_OAUTH_CLIENT_SECRET', 'web-secret');
  vi.stubEnv('GOOGLE_DRIVE_ROOT_FOLDER_ID', '');
  vi.stubGlobal('fetch', google);
  asked = [];
  answers = [];
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
afterAll(async () => {
  await db.close();
});

describe('Connect Google Drive', () => {
  it("sends the owner to Google's page, with a ten-minute cookie only the server can read", async () => {
    const response = await call(connect, 'http://localhost/api/drive/connect', ACTORS.owner);
    expect(response.status).toBe(303);
    const google = new URL(response.headers.get('location') ?? '');
    expect(google.origin).toBe('https://accounts.google.com');
    expect(google.searchParams.get('client_id')).toBe('web-client');
    expect(google.searchParams.get('redirect_uri')).toBe('http://localhost/api/drive/callback');
    expect(google.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/drive.file');
    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/^studflow_drive_oauth=v1\./);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\/api\/drive/);
    expect(cookie).toMatch(/Max-Age=600/);
    expect(response.headers.get('cache-control')).toContain('no-store');
  });

  it('is the owner\'s only', async () => {
    expect(landing(await call(connect, 'http://localhost/api/drive/connect', ACTORS.staff))).toBe('/company?drive=forbidden');
  });

  it('says it cannot yet when the server lacks its key or Google client', async () => {
    vi.stubEnv('CRON_SECRET', 'short');
    expect(landing(await call(connect, 'http://localhost/api/drive/connect', ACTORS.owner))).toBe('/company?drive=not-ready');
    vi.stubEnv('CRON_SECRET', SECRET);
    vi.stubEnv('GOOGLE_DRIVE_OAUTH_CLIENT_SECRET', '');
    expect(landing(await call(connect, 'http://localhost/api/drive/connect', ACTORS.owner))).toBe('/company?drive=not-ready');
  });

  it("keeps Google's permission sealed, with the vault folder and the account, and forgets the cookie", async () => {
    const { state, cookie } = await start();
    answers = grant(FIRST);
    const response = await back(`code=code-1&state=${state}`, cookie);
    expect(landing(response)).toBe('/company?drive=connected');
    expect(response.headers.get('set-cookie')).toMatch(/studflow_drive_oauth=;.*Max-Age=0/i);
    const link = await stored();
    expect(link?.folder_id).toBe('vault-folder-0001');
    expect(link?.sealed).not.toContain(FIRST);
    expect(unseal(link!.sealed, KEY, 'token')).toBe(FIRST);
    const exchange = new URLSearchParams(asked[0]?.body);
    expect(exchange.get('code')).toBe('code-1');
    expect(exchange.get('redirect_uri')).toBe('http://localhost/api/drive/callback');
    expect(exchange.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [status] = await queryAs<{ r: { account_email: string } }>(db, ACTORS.staff, 'select public.drive_link_status() as r');
    expect(status?.r.account_email).toBe('owner@example.com');
  });

  it('ends the old permission at Google when connected again, and uses the folder already there', async () => {
    const { state, cookie } = await start();
    answers = [...grant(SECOND, [{ id: 'vault-folder-0001' }]), { body: {} }];
    expect(landing(await back(`code=code-2&state=${state}`, cookie))).toBe('/company?drive=connected');
    expect(unseal((await stored())!.sealed, KEY, 'token')).toBe(SECOND);
    const revoke = asked.find((one) => one.url === 'https://oauth2.googleapis.com/revoke');
    expect(new URLSearchParams(revoke?.body).get('token')).toBe(FIRST);
    expect(asked.some((one) => one.body.includes('vault-folder'))).toBe(false); // nothing new was made
  });

  it.each([
    ['another state', (state: string, cookie: string) => [`code=c&state=${state}x`, cookie]],
    ['no cookie', (state: string) => [`code=c&state=${state}`, '']],
    ['a cookie of another start', (state: string, _cookie: string, other: string) => [`code=c&state=${state}`, other]],
  ])('takes no answer with %s', async (_name, make) => {
    const first = await start();
    const second = await start();
    const [query, cookie] = make(first.state, first.cookie, second.cookie);
    expect(landing(await back(query!, cookie!))).toBe('/company?drive=expired');
    expect(asked).toEqual([]);
  });

  it('says so when the owner says no at Google, and asks Google nothing', async () => {
    const { state, cookie } = await start();
    expect(landing(await back(`error=access_denied&state=${state}`, cookie))).toBe('/company?drive=denied');
    expect(asked).toEqual([]);
  });

  it('lets nobody but the owner finish it', async () => {
    const { state, cookie } = await start();
    expect(landing(await back(`code=c&state=${state}`, cookie, ACTORS.staff))).toBe('/company?drive=forbidden');
    expect(asked).toEqual([]);
  });

  it('keeps the old link when Google refuses the code', async () => {
    const before = await stored();
    const { state, cookie } = await start();
    answers = [{ status: 400, body: { error: 'invalid_grant', error_description: 'web-secret was wrong' } }];
    expect(landing(await back(`code=c&state=${state}`, cookie))).toBe('/company?drive=failed');
    expect(await stored()).toEqual(before);
  });
});

describe('Disconnect', () => {
  it('is refused to staff', async () => {
    const response = await call(disconnect, 'http://localhost/api/drive/disconnect', ACTORS.staff, { method: 'POST' });
    expect(response.status).toBe(403);
    expect(await stored()).not.toBeNull();
  });

  it('forgets the link, ends the permission at Google, and says what is left', async () => {
    answers = [{ body: {} }];
    const response = await call(disconnect, 'http://localhost/api/drive/disconnect', ACTORS.owner, { method: 'POST' });
    expect(response.status).toBe(201);
    expect(((await response.json()) as { data: { state: string } }).data.state).toBe('off');
    expect(await stored()).toBeNull();
    expect(new URLSearchParams(asked.find((one) => one.url === 'https://oauth2.googleapis.com/revoke')?.body).get('token')).toBe(SECOND);
  });
});
