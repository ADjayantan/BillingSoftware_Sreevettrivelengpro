import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { DRIVE_RELINK, driveCredentials, driveInfo, driveState } from '@/lib/drive-backup';
import { driveLinkKey, seal } from '@/lib/drive-link';

// specs/drive-button.md, "Which sign-in wins": the button's link, else the server settings.
// A link that cannot be opened stops the copying; it never falls back to another account's Drive.

const KEY_SECRET = 'k'.repeat(40);
const KEY = driveLinkKey({ CRON_SECRET: KEY_SECRET } as unknown as NodeJS.ProcessEnv)!;
const TOKEN = `1//0g${'t'.repeat(98)}`;
const LINK = { sealed: seal(TOKEN, KEY, 'token'), folder_id: 'button-folder-0001' };
const CLIENT = { GOOGLE_DRIVE_OAUTH_CLIENT_ID: 'web-client', GOOGLE_DRIVE_OAUTH_CLIENT_SECRET: 'web-secret' };
const SETTINGS = {
  GOOGLE_DRIVE_ROOT_FOLDER_ID: 'settings-folder-01',
  ...CLIENT,
  GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN: 'settings-token',
};
const env = (values: Record<string, string>): NodeJS.ProcessEnv => values as unknown as NodeJS.ProcessEnv;

/** Answers each rpc with what it is given; records what was asked. */
function fakeDb(answers: Record<string, { data: unknown; error: { code?: string; message: string } | null }>): SupabaseClient {
  return { rpc: async (name: string) => answers[name] ?? { data: null, error: { code: 'PGRST202', message: 'not found' } } } as unknown as SupabaseClient;
}
const linked = fakeDb({ drive_link_secret: { data: LINK, error: null }, drive_link_status: { data: { linked: true }, error: null } });
const empty = fakeDb({ drive_link_secret: { data: null, error: null }, drive_link_status: { data: { linked: false }, error: null } });
const before009 = fakeDb({});
const down = fakeDb({ drive_link_secret: { data: null, error: { code: '08006', message: 'connection failure' } } });

describe('the Drive sign-in in force', () => {
  it("is the button's link when there is one, ahead of the server settings", async () => {
    expect(await driveCredentials(env({ CRON_SECRET: KEY_SECRET, ...SETTINGS }), linked)).toEqual({
      rootFolderId: 'button-folder-0001',
      clientId: 'web-client',
      clientSecret: 'web-secret',
      refreshToken: TOKEN,
    });
  });

  it('is the server settings when there is no link, or the database is from before 009', async () => {
    for (const db of [empty, before009]) {
      expect(await driveCredentials(env(SETTINGS), db)).toEqual({ rootFolderId: 'settings-folder-01', clientId: 'web-client', clientSecret: 'web-secret', refreshToken: 'settings-token' });
    }
  });

  it('is nothing when neither is there', async () => {
    expect(await driveCredentials(env({}), empty)).toBeNull();
    expect(await driveCredentials(env({}), before009)).toBeNull();
  });

  it.each([
    ['the key is gone', { ...SETTINGS }],
    ['the key changed', { CRON_SECRET: 'z'.repeat(40), ...SETTINGS }],
    ['the Google client is gone', { CRON_SECRET: KEY_SECRET, GOOGLE_DRIVE_ROOT_FOLDER_ID: 'settings-folder-01' }],
  ])('asks to connect again, never the settings, when %s', async (_name, values) => {
    await expect(driveCredentials(env(values), linked)).rejects.toThrow(DRIVE_RELINK);
  });

  it('does not guess when the database cannot say', async () => {
    await expect(driveCredentials(env(SETTINGS), down)).rejects.toThrow('Google Drive link could not be read');
  });
});

describe('what the pages say about Drive', () => {
  it("names the button's link, the settings, or nothing", async () => {
    expect(await driveState(linked, env({}))).toBe('button');
    expect(await driveState(empty, env(SETTINGS))).toBe('settings');
    expect(await driveState(empty, env({}))).toBe('off');
    expect(await driveState(before009, env(SETTINGS))).toBe('settings');
  });

  it('says to whom, since when, and whether the reader may change it', async () => {
    const owner = fakeDb({ drive_link_status: { data: { linked: true, owner: true, account_email: 'owner@example.com', connected_at: '2026-11-26T10:00:00+00:00' }, error: null } });
    expect(await driveInfo(owner, env({}))).toEqual({ state: 'button', owner: true, accountEmail: 'owner@example.com', connectedAt: '2026-11-26T10:00:00+00:00', ready: true });
    const staff = fakeDb({ drive_link_status: { data: { linked: false, owner: false, account_email: null, connected_at: null }, error: null } });
    expect(await driveInfo(staff, env(SETTINGS))).toEqual({ state: 'settings', owner: false, accountEmail: null, connectedAt: null, ready: true });
  });

  it('says the button is not ready on a database from before 009, instead of "only the owner"', async () => {
    expect(await driveInfo(before009, env({}))).toEqual({ state: 'off', owner: false, accountEmail: null, connectedAt: null, ready: false });
    expect(await driveInfo(before009, env(SETTINGS))).toMatchObject({ state: 'settings', ready: false });
  });
});
