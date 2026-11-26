// 009: the Google Drive sign-in made with the Company page's button (specs/drive-button.md).
// Kept sealed; only the server (service_role) reads it, only the owner changes it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { ACTORS, createTestDb, pgError, queryAs, type Actor } from './harness';

const SEALED = `v1.AAAAAAAAAAAAAAAA.${'B'.repeat(60)}`;
const OTHER = `v1.CCCCCCCCCCCCCCCC.${'D'.repeat(60)}`;
const FOLDER = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345';

interface Status { linked: boolean; account_email: string | null; connected_at: string | null; owner: boolean }

let db: PGlite;
async function one<T>(actor: Actor, sql: string, params: unknown[] = []): Promise<T> {
  const [row] = await queryAs<{ r: T }>(db, actor, sql, params);
  return row!.r;
}
const status = (actor: Actor = ACTORS.staff): Promise<Status> => one(actor, 'select public.drive_link_status() as r');
const save = (actor: Actor, sealed = SEALED, folder = FOLDER, email: string | null = 'owner@example.com'): Promise<string | null> =>
  one(actor, 'select public.drive_link_save($1, $2, $3) as r', [sealed, folder, email]);
const secret = (actor: Actor = ACTORS.service): Promise<{ sealed: string; folder_id: string } | null> => one(actor, 'select public.drive_link_secret() as r');
const clear = (actor: Actor = ACTORS.owner): Promise<string | null> => one(actor, 'select public.drive_link_clear() as r');

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

describe('the Drive link of the Company page', () => {
  it('starts empty, and tells the owner apart', async () => {
    expect(await status()).toEqual({ linked: false, account_email: null, connected_at: null, owner: false });
    expect((await status(ACTORS.owner)).owner).toBe(true);
    expect(await secret()).toBeNull();
  });

  it('is kept by the owner and read back sealed by the server only', async () => {
    expect(await save(ACTORS.owner)).toBeNull();
    const now = await status();
    expect(now).toMatchObject({ linked: true, account_email: 'owner@example.com', owner: false });
    expect(typeof now.connected_at).toBe('string');
    expect(await secret()).toEqual({ sealed: SEALED, folder_id: FOLDER });
  });

  it('replaces the old link and hands back its token, to be revoked at Google', async () => {
    expect(await save(ACTORS.owner, OTHER, FOLDER, null)).toBe(SEALED);
    expect(await secret()).toEqual({ sealed: OTHER, folder_id: FOLDER });
    expect((await status()).account_email).toBeNull();
  });

  it.each([
    ['staff', ACTORS.staff],
    ['a stranger', ACTORS.stranger],
    ['a former user', ACTORS.former],
    ['the server', ACTORS.service],
  ])('refuses %s changing it', async (_name, actor) => {
    expect((await pgError(save(actor))).code).toBe('42501');
    expect((await pgError(clear(actor))).code).toBe('42501');
  });

  it('never hands the sealed token to a signed-in person, not even the owner', async () => {
    for (const actor of [ACTORS.owner, ACTORS.staff, ACTORS.anon]) expect((await pgError(secret(actor))).code).toBe('42501');
  });

  it('keeps the table itself out of every API role', async () => {
    for (const actor of [ACTORS.owner, ACTORS.staff, ACTORS.anon, ACTORS.service]) {
      expect((await pgError(queryAs(db, actor, 'select * from private.drive_link'))).code).toBe('42501');
    }
  });

  it('tells its state only to people of the firm', async () => {
    for (const actor of [ACTORS.stranger, ACTORS.former, ACTORS.anon]) expect((await pgError(status(actor))).code).toBe('42501');
  });

  it.each([
    ['an unsealed token', 'an unsealed token, as Google gave it', FOLDER, null],
    ['a short seal', 'v1.AAAAAAAAAAAAAAAA.short', FOLDER, null],
    ['a path for a folder', SEALED, '../../etc/passwd', null],
    ['an address that is not one', SEALED, FOLDER, 'not an email'],
    ['a very long address', SEALED, FOLDER, `${'x'.repeat(320)}@a.b`],
  ])('takes no %s', async (_name, sealed, folder, email) => {
    expect((await pgError(save(ACTORS.owner, sealed, folder, email))).code).toBe('23514');
  });

  it('is cleared by the owner, handing back the token to revoke', async () => {
    expect(await clear()).toBe(OTHER);
    expect(await status()).toMatchObject({ linked: false, account_email: null });
    expect(await secret()).toBeNull();
    expect(await clear()).toBeNull();
  });
});
