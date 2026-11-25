// The worker behind the monthly Excel books, and the routes around it: real SQL, a pretend Google
// Drive that can be slow, down, full, or lose its answers.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { createClient as createSupabase, type SupabaseClient } from '@supabase/supabase-js';
import { clearDriveCache, type OAuthCredentials } from '@/lib/drive-backup';
import { runBooks } from '@/lib/month-books';
import { ACTORS, createTestDb, intraStatePayload, openSeries, queryAs, recordPayment, seedMasterData, setToday, syncInvoice, type Actor, type MasterData, type Payload } from './db/harness';
import { FakeDrive, type DriveCall, type Fate } from './support/fake-drive';
import { pgliteFetch } from './support/postgrest';
import { readXlsx, table, type ReadSheet } from './support/xlsx-reader';

const ROOT = 'vault_root_folder_0001';
const CREDS: OAuthCredentials = { clientId: 'client', clientSecret: 'never-log-this-secret', refreshToken: 'never-log-this-token', rootFolderId: ROOT };
const drive = new FakeDrive(ROOT);
let db: PGlite;
let md: MasterData;
let server: SupabaseClient;
let actor: Actor = ACTORS.owner;
const client = (as: () => Actor): SupabaseClient =>
  createSupabase('http://localhost', 'sb_test', { global: { fetch: pgliteFetch(db, as) }, auth: { persistSession: false, autoRefreshToken: false } });

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => server }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => {
    const session = client(() => actor);
    session.auth.getClaims = (async () => (actor.role === 'anon' ? { data: null, error: null } : { data: { claims: {} }, error: null })) as unknown as typeof session.auth.getClaims;
    return session;
  },
}));

beforeAll(async () => {
  db = await createTestDb();
  md = await seedMasterData(db);
  server = client(() => ACTORS.service);
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  drive.reset();
  clearDriveCache();
  actor = ACTORS.owner;
  await db.exec('delete from private.book_changes; delete from private.month_books');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const issue = async (over: Payload = {}) => syncInvoice(db, ACTORS.staff, intraStatePayload(md, over));
const run = (over: Partial<Parameters<typeof runBooks>[0]> = {}) => runBooks({ db: server, creds: CREDS, fetchImpl: drive.fetch, ...over });
const months = async () => (await db.query<{ m: string; f: string | null; r: number; e: string | null; a: number; leased: boolean; resting: boolean }>(`select month::text as m, drive_file_id as f, revision::int as r, last_error as e, attempts as a, lease_token is not null as leased, next_try_at > clock_timestamp() as resting from private.month_books order by 1`)).rows;
const waiting = async () => (await db.query<{ n: number }>('select count(*)::int as n from private.book_changes')).rows[0]!.n;
const endLease = () => db.exec(`update private.month_books set lease_until = clock_timestamp() - interval '1 second', next_try_at = null where lease_token is not null`);
const endRest = () => db.exec('update private.month_books set next_try_at = null');
/** The bills in the one workbook on Drive. */
function inDrive(name = 'Billing_2026-11.xlsx'): string[] {
  const found = drive.files().filter((file) => file.name === name);
  expect(found, 'exactly one workbook').toHaveLength(1);
  const { sheets } = readXlsx(found[0]!.bytes);
  return table(sheets[0] as ReadSheet).map((row) => row['Invoice no']!);
}
const receiptsIn = (name: string) => table(readXlsx(drive.files().find((file) => file.name === name)!.bytes).sheets[3] as ReadSheet);
const allBills = async (month = '2026-11') => (await db.query<{ n: string }>(`select invoice_no as n from public.invoices where to_char(invoice_date, 'YYYY-MM') = $1 order by invoice_seq`, [month])).rows.map((row) => row.n);
const once = (kind: string, fate: Fate): ((call: DriveCall) => Fate) => {
  let used = false;
  return (call) => {
    if (used || call.kind !== kind) return 'ok';
    used = true;
    return fate;
  };
};

describe('the workbook on Drive', () => {
  it('appears after a bill, in the year and month of the bill’s own date, and says what it is', async () => {
    await issue();
    expect(await run()).toEqual([{ month: '2026-11-01', outcome: 'written' }]);
    const [file] = drive.files();
    expect(drive.pathOf(file!)).toBe('Company_Billing_Vault/FY_2026-27/2026-11/Billing_2026-11.xlsx');
    expect(file!.appProperties).toMatchObject({ studflowBook: '2026-11', revision: '1', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(inDrive()).toEqual(await allBills());
    expect(await months()).toMatchObject([{ m: '2026-11-01', f: file!.id, r: 1, e: null, leased: false }]);
    expect(await waiting()).toBe(0);
  });

  it('stays the same file, bill after bill', async () => {
    await issue();
    await run();
    const [file] = drive.files();
    await issue();
    expect(await run()).toEqual([{ month: '2026-11-01', outcome: 'written' }]);
    expect(drive.files()).toHaveLength(1);
    expect(drive.files()[0]!.id).toBe(file!.id);
    expect(drive.files()[0]!.appProperties.revision).toBe('2');
    expect(inDrive()).toEqual(await allBills());
    expect(drive.kinds().filter((kind) => kind === 'create')).toHaveLength(1);
    expect(drive.kinds().filter((kind) => kind === 'ids')).toHaveLength(1);
  });

  it('asks Google nothing when nothing has changed', async () => {
    expect(await run()).toEqual([]);
    expect(drive.calls).toEqual([]);
  });

  it('31 March goes into the old year, 1 April into the new one', async () => {
    const year = await createTestDb({ today: '2027-04-01' });
    const before = db;
    try {
      const masters = await seedMasterData(year);
      await openSeries(year, '26-27');
      for (const date of ['2027-03-31', '2027-04-01']) await syncInvoice(year, ACTORS.staff, intraStatePayload(masters, { invoice_date: date, due_date: '2027-05-01' }));
      db = year;
      expect((await runBooks({ db: client(() => ACTORS.service), creds: CREDS, fetchImpl: drive.fetch })).map((one) => one.month)).toEqual(['2027-03-01', '2027-04-01']);
      expect(drive.files().map((file) => drive.pathOf(file)).sort()).toEqual([
        'Company_Billing_Vault/FY_2026-27/2027-03/Billing_2027-03.xlsx', 'Company_Billing_Vault/FY_2027-28/2027-04/Billing_2027-04.xlsx',
      ]);
      expect([inDrive('Billing_2027-03.xlsx'), inDrive('Billing_2027-04.xlsx')]).toEqual([['INV/26-27/0001'], ['INV/27-28/0001']]);
    } finally {
      db = before;
      await year.close();
    }
  });

  it('a receipt in December updates November’s balance and December’s receipts', async () => {
    const { invoice_id, invoice_no } = await issue();
    await run();
    await setToday(db, '2026-12-05');
    await recordPayment(db, ACTORS.staff, invoice_id, '500.00', { received_on: '2026-12-03' });
    expect((await run()).map((one) => [one.month, one.outcome])).toEqual([['2026-11-01', 'written'], ['2026-12-01', 'written']]);
    expect(receiptsIn('Billing_2026-12.xlsx')).toMatchObject([{ 'Invoice no': invoice_no, 'Amount ₹': '500' }]);
    expect(inDrive('Billing_2026-12.xlsx')).toEqual([]); // the sale is November's
    const november = table(readXlsx(drive.files().find((file) => file.name === 'Billing_2026-11.xlsx')!.bytes).sheets[0] as ReadSheet);
    expect(november.find((row) => row['Invoice no'] === invoice_no)).toMatchObject({ 'Received ₹': '500', Status: 'Part paid' });
    await setToday(db, '2026-11-23');
  });

  it('a cancelled bill stays in it, labelled', async () => {
    const { invoice_id, invoice_no } = await issue();
    await run();
    await queryAs(db, ACTORS.staff, `update public.invoices set cancelled_at = now(), cancellation_reason = 'wrong buyer' where id = $1`, [invoice_id]);
    await run();
    const rows = table(readXlsx(drive.files()[0]!.bytes).sheets[0] as ReadSheet);
    expect(rows.find((row) => row['Invoice no'] === invoice_no)).toMatchObject({ Status: 'CANCELLED', 'Why cancelled': 'wrong buyer' });
  });
});

describe('Drive in trouble', () => {
  it.each<[string, Fate]>([['token', 'down'], ['token', 503], ['list', 'down'], ['list', 500], ['folder', 403], ['ids', 'down'], ['ids', 429]])('%s %s: the bills are safe, it rests, and the next try makes one file', async (kind, fate) => {
    await issue();
    drive.fate = (call) => (call.kind === kind ? fate : 'ok');
    const [result] = await run();
    expect(result).toMatchObject({ month: '2026-11-01', outcome: 'failed', error: expect.stringMatching(/^Google Drive (did not answer|refused \(HTTP 403\))$/) });
    expect(await months()).toMatchObject([{ leased: false, resting: true, e: result!.error, a: 1 }]);
    expect(await waiting()).toBeGreaterThan(0);
    expect(await run()).toEqual([]); // resting
    drive.fate = () => 'ok';
    expect(await run({ month: '2026-11-01', force: true })).toEqual([{ month: '2026-11-01', outcome: 'written' }]);
    expect(inDrive()).toEqual(await allBills());
    expect(await months()).toMatchObject([{ e: null, a: 0, resting: null }]);
  });

  it.each<['create' | 'update', Fate]>([['create', 'lose-reply'], ['update', 'lose-reply'], ['create', 'down'], ['update', 'down'], ['create', 502], ['update', 504]])('%s %s: nobody knows whether it arrived, so the month stays taken until its time is over', async (kind, fate) => {
    await issue();
    if (kind === 'update') {
      await run();
      await issue();
    }
    drive.fate = once(kind, fate);
    expect(await run()).toMatchObject([{ outcome: 'failed', error: 'Google Drive did not say whether the workbook arrived' }]);
    expect(await months()).toMatchObject([{ leased: true }]);
    expect(await run({ month: '2026-11-01', force: true })).toEqual([]); // not even when asked
    await endLease();
    expect(await run()).toEqual([{ month: '2026-11-01', outcome: 'written' }]);
    expect(drive.files()).toHaveLength(1); // never a second one
    expect(inDrive()).toEqual(await allBills());
  });

  it.each([400, 403, 429])('an upload refused with %d was not done: it rests without keeping the month', async (status) => {
    await issue();
    drive.fate = once('create', status);
    expect(await run()).toMatchObject([{ outcome: 'failed', error: `Google Drive refused the workbook (HTTP ${status})` }]);
    expect(await months()).toMatchObject([{ leased: false, resting: true }]);
    await endRest();
    expect(await run()).toMatchObject([{ outcome: 'written' }]);
    expect(drive.files()).toHaveLength(1);
  });

  it('a crash between keeping the id and making the file ends with one file, under that id', async () => {
    await issue();
    drive.fate = (call) => (call.kind === 'create' ? 'down' : 'ok'); // the machine died
    await run();
    const [{ f: kept } = { f: null }] = await months();
    expect(kept).toMatch(/^generated_/);
    drive.fate = () => 'ok';
    await endLease();
    await run();
    expect(drive.files().map((file) => file.id)).toEqual([kept]);
    expect(drive.kinds().filter((kind) => kind === 'ids')).toHaveLength(1);
  });

  it('a workbook in the bin is taken out of it; one deleted for good is made again', async () => {
    await issue();
    await run();
    const [file] = drive.files();
    file!.trashed = true;
    await issue();
    await run();
    expect(drive.files()).toMatchObject([{ id: file!.id, trashed: false }]);
    drive.nodes.delete(file!.id);
    await issue();
    expect(await run()).toMatchObject([{ outcome: 'written' }]);
    expect(drive.files()).toHaveLength(1);
    expect(drive.files()[0]!.id).not.toBe(file!.id);
    expect(inDrive()).toEqual(await allBills());
    expect(await months()).toMatchObject([{ f: drive.files()[0]!.id }]);
  });

  it('finds its own workbook when the database has forgotten it, and leaves anybody else’s alone', async () => {
    await issue();
    await run();
    const [ours] = drive.files();
    await db.exec('delete from private.month_books'); // e.g. restored from a backup
    const theirs = drive.add({ name: 'Billing_2026-11.xlsx', parentId: ours!.parentId, bytes: Buffer.from('typed by hand') });
    await issue();
    expect(await run()).toMatchObject([{ outcome: 'written' }]);
    expect(await months()).toMatchObject([{ f: ours!.id }]);
    expect(theirs.bytes.toString()).toBe('typed by hand');
    expect(drive.files()).toHaveLength(2);
  });

  it('a renamed workbook gets its name back, and is still the same file', async () => {
    await issue();
    await run();
    const [file] = drive.files();
    file!.name = 'november sales.xlsx';
    await issue();
    await run();
    expect(drive.files()).toMatchObject([{ id: file!.id, name: 'Billing_2026-11.xlsx' }]);
  });

  it('every call to Google has a time limit, and the upload’s ends before the lease does', async () => {
    await issue();
    await run();
    expect(drive.calls.every((call) => call.signal !== null)).toBe(true);
  });

  it('says in our own words what went wrong, and never a secret', async () => {
    await issue();
    drive.fate = (call) => (call.kind === 'token' ? 400 : 'ok');
    const [refused] = await run();
    expect(refused?.error).toBe('Google Drive permission has expired: connect Google Drive again');
    await endRest();
    drive.fate = () => {
      throw new Error(`secret ${CREDS.clientSecret} in a library's message`);
    };
    const [odd] = await run();
    expect(odd?.error).toBe('Google Drive did not answer');
    for (const said of [refused?.error, odd?.error, ...(await months()).map((row) => row.e)]) expect(said).not.toMatch(/never-log|vault_root/);
  });

  it('a book that cannot be read is not written', async () => {
    await issue();
    const broken = client(() => ACTORS.service);
    const from = broken.from.bind(broken);
    broken.from = ((name: string) => (name === 'payments' ? from('no_such_table') : from(name))) as typeof broken.from;
    expect(await run({ db: broken })).toMatchObject([{ outcome: 'failed', error: 'The books could not be read' }]);
    expect(drive.files()).toEqual([]);
    expect(await waiting()).toBeGreaterThan(0);
  });

  it('one month in trouble does not hold up the others', async () => {
    await issue({ invoice_date: '2026-10-31', due_date: '2026-12-30' });
    await issue();
    drive.fate = (call) => (call.kind === 'create' && drive.files().length === 0 ? 403 : 'ok');
    const results = await run();
    expect(results.map((one) => [one.month, one.outcome])).toEqual([['2026-10-01', 'failed'], ['2026-11-01', 'failed']]);
    drive.fate = once('create', 403);
    await endRest();
    expect((await run()).map((one) => one.outcome)).toEqual(['failed', 'written']);
  });
});

describe('several workers', () => {
  it('two at once write it once', async () => {
    await issue();
    const results = await Promise.all([run(), run(), run()]);
    expect(results.flat()).toEqual([{ month: '2026-11-01', outcome: 'written' }]);
    expect(drive.kinds().filter((kind) => kind === 'create' || kind === 'update')).toHaveLength(1);
  });

  /** Holds the first worker at its first call of `kind` until `go()`. */
  function stall(kind: string): { reached: Promise<void>; go: () => void } {
    let reach = (): void => undefined;
    let go = (): void => undefined;
    const reached = new Promise<void>((resolve) => (reach = resolve));
    const gate = new Promise<void>((resolve) => (go = resolve));
    let used = false;
    drive.fate = async (call): Promise<Fate> => {
      if (used || call.kind !== kind) return 'ok';
      used = true;
      reach();
      await gate;
      return 'ok';
    };
    return { reached, go };
  }

  it.each(['token', 'get', 'list', 'ids'])('one that stood still at "%s" past its time writes nothing over the newer book', async (kind) => {
    await issue();
    if (kind === 'get') {
      await run();
      await issue();
    }
    if (kind === 'token') clearDriveCache();
    const held = stall(kind);
    const slow = run();
    await held.reached;
    await endLease();
    await issue(); // the slow one has not seen this bill
    expect(await run()).toMatchObject([{ outcome: 'written' }]);
    const newest = inDrive();
    expect(newest).toEqual(await allBills());
    const writes = drive.kinds().filter((each) => each === 'create' || each === 'update').length;
    held.go();
    expect(await slow).toEqual([{ month: '2026-11-01', outcome: 'lost' }]);
    expect(drive.kinds().filter((each) => each === 'create' || each === 'update')).toHaveLength(writes);
    expect(inDrive()).toEqual(newest);
    expect(drive.files()).toHaveLength(1);
    expect(await waiting()).toBe(0);
  });

  it('sees that the file has been written since it looked, even if the lease should fail', async () => {
    await issue();
    await run();
    await issue();
    let looks = 0;
    drive.fate = (call) => {
      if (call.kind === 'get' && ++looks === 2) drive.files()[0]!.appProperties.revision = '99';
      return 'ok';
    };
    expect(await run()).toMatchObject([{ outcome: 'lost' }]);
    expect(drive.kinds().filter((kind) => kind === 'update')).toHaveLength(0);
  });

  it('a bill that comes while a book is being written is in the next one', async () => {
    await issue();
    const held = stall('ids');
    const first = run();
    await held.reached;
    const late = await issue();
    held.go();
    expect((await first).map((one) => one.outcome)).toContain('written');
    await run();
    expect(inDrive()).toContain(late.invoice_no);
    expect(await waiting()).toBe(0);
  });

  it('stops taking months when its own time is over', async () => {
    await issue({ invoice_date: '2026-10-31', due_date: '2026-12-30' });
    await issue();
    expect(await run({ budgetMs: 0 })).toHaveLength(1);
    expect(await run({ budgetMs: 0 })).toHaveLength(1);
    expect(await run({ budgetMs: 0 })).toHaveLength(0);
  });
});

// ---- Routes --------------------------------------------------------------------
type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;
async function call(module: Promise<Record<string, unknown>>, method: string, params: Record<string, string> = {}, json?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  const handler = (await module)[method] as Handler;
  return handler(new Request('http://localhost/x', { method, headers: { ...(json === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, ...(json === undefined ? {} : { body: JSON.stringify(json) }) }), { params: Promise.resolve(params) });
}
/** Drive as the deployed app finds it: by its settings, over the network. */
function connectDrive(): void {
  vi.stubEnv('GOOGLE_DRIVE_ROOT_FOLDER_ID', ROOT);
  vi.stubEnv('GOOGLE_DRIVE_OAUTH_CLIENT_ID', 'client');
  vi.stubEnv('GOOGLE_DRIVE_OAUTH_CLIENT_SECRET', 'never-log-this-secret');
  vi.stubEnv('GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN', 'never-log-this-token');
  vi.stubGlobal('fetch', drive.fetch);
}
const settled = async (): Promise<void> => {
  for (let i = 0; i < 200 && (await waiting()) > 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
};
const dataOf = async <T>(response: Response): Promise<T> => ((await response.json()) as { data: T }).data;

describe('Save once, and the book follows', () => {
  it.each([
    ['a bill', async () => {
      const { billDraft } = await import('@/lib/schemas/invoices');
      const { composeBill } = await import('@/lib/bill-draft');
      const draft = billDraft.parse({
        client_temp_id: `OFFLINE-${randomUUID()}`, bill_type: 'supply', customer_id: md.tnCustomerId, invoice_date: '2026-11-20', due_date: '2026-12-20', delivery: {},
        lines: [{ stud_item_id: null, description: 'Stud', hsn_sac: '7318', billing_unit: 'pcs', quantity: '50', rate: '12', gst_rate: '18' }], expected_total_paise: 70800,
      });
      expect(composeBill(draft, { state_code: '33', is_sez: false }).detail.amounts.grand_total_paise).toBe(70800);
      return call(import('@/app/api/invoices/sync/route'), 'POST', {}, draft);
    }],
    ['a receipt', async () => {
      const { invoice_id } = await issue();
      await run();
      return call(import('@/app/api/invoices/[id]/payments/route'), 'POST', { id: invoice_id }, { client_receipt_id: randomUUID(), amount: '10', received_on: '2026-11-21', mode: 'cash' });
    }],
    ['a voided receipt', async () => {
      const { invoice_id } = await issue();
      const { payment_id } = await recordPayment(db, ACTORS.staff, invoice_id, '10.00');
      await run();
      return call(import('@/app/api/payments/[id]/void/route'), 'POST', { id: payment_id }, { reason: 'wrong bill' });
    }],
    ['a cancellation', async () => {
      const { invoice_id } = await issue();
      await run();
      return call(import('@/app/api/invoices/[id]/cancel/route'), 'POST', { id: invoice_id }, { reason: 'wrong buyer' });
    }],
    ['a dispatch', async () => {
      const { invoice_id } = await issue();
      await run();
      const { rows } = await db.query<{ id: string }>('select id from public.deliveries where invoice_id = $1', [invoice_id]);
      return call(import('@/app/api/deliveries/[id]/route'), 'PATCH', { id: rows[0]!.id }, { status: 'dispatched' });
    }],
  ] as const)('%s', async (_, act) => {
    connectDrive();
    const response = await act();
    expect(response.status, await response.clone().text()).toBeLessThan(300);
    await settled();
    expect(await waiting()).toBe(0);
    expect(inDrive()).toEqual(await allBills());
  });

  it('billing does not notice that Drive is down', async () => {
    connectDrive();
    drive.fate = () => 'down';
    const { invoice_id } = await issue();
    const response = await call(import('@/app/api/invoices/[id]/payments/route'), 'POST', { id: invoice_id }, { client_receipt_id: randomUUID(), amount: '10', received_on: '2026-11-21', mode: 'cash' });
    expect(response.status).toBe(201);
    await new Promise((resolve) => setTimeout(resolve, 100));
    drive.fate = () => 'ok';
    await endRest();
    await run();
    expect(inDrive()).toEqual(await allBills());
  });

  it('without Google Drive nothing is tried, and everything stays in line', async () => {
    const { invoice_id } = await issue();
    const response = await call(import('@/app/api/invoices/[id]/cancel/route'), 'POST', { id: invoice_id }, { reason: 'wrong buyer' });
    expect(response.status).toBe(201);
    expect(await waiting()).toBeGreaterThan(0);
    expect(await months()).toEqual([]);
  });
});

describe('any open device asks from time to time', () => {
  const ask = () => call(import('@/app/api/books/run/route'), 'POST', {}, {});

  it('and the month that is due gets written', async () => {
    connectDrive();
    actor = ACTORS.staff;
    await issue();
    expect(await dataOf(await ask())).toEqual({ state: 'started' });
    await settled();
    expect(inDrive()).toEqual(await allBills());
    expect(await dataOf(await ask())).toEqual({ state: 'nothing' });
  });

  it('but not while it rests, nor without Drive, nor for a stranger', async () => {
    await issue();
    expect(await dataOf(await ask())).toEqual({ state: 'off' });
    connectDrive();
    drive.fate = () => 503;
    await run();
    const calls = drive.calls.length;
    expect(await dataOf(await ask())).toEqual({ state: 'nothing' });
    expect(drive.calls).toHaveLength(calls);
    actor = ACTORS.stranger;
    expect((await ask()).status).toBe(403);
    actor = ACTORS.anon;
    expect((await ask()).status).toBe(401);
  });
});

describe('the bill’s own state', () => {
  const state = async (id: string) => call(import('@/app/api/invoices/[id]/book/route'), 'GET', { id });

  it('is waiting, then updated', async () => {
    connectDrive();
    actor = ACTORS.staff;
    const { invoice_id } = await issue();
    expect(await dataOf(await state(invoice_id))).toEqual({ state: 'waiting' });
    await run();
    expect(await dataOf(await state(invoice_id))).toEqual({ state: 'updated' });
  });

  it('is off without Drive, and nobody else’s business', async () => {
    const { invoice_id } = await issue();
    expect(await dataOf(await state(invoice_id))).toEqual({ state: 'off' });
    connectDrive();
    actor = ACTORS.stranger;
    expect((await state(invoice_id)).status).toBe(403);
    expect((await state('nonsense')).status).toBe(400);
  });
});

describe('the owner’s page', () => {
  const list = () => call(import('@/app/api/books/route'), 'GET');
  const retry = (month = '2026-11') => call(import('@/app/api/books/[month]/retry/route'), 'POST', { month }, {});
  const download = (month = '2026-11') => call(import('@/app/api/books/[month]/route'), 'GET', { month });

  it('lists the months, with the last update and what went wrong', async () => {
    connectDrive();
    await issue();
    drive.fate = () => 503;
    await run();
    const failed = await dataOf<{ drive: boolean; months: Record<string, unknown>[] }>(await list());
    expect(failed).toMatchObject({ drive: true, months: [{ month: '2026-11-01', written_at: null, retry_at: expect.any(String), last_error: expect.stringMatching(/^Google/), drive_link: null, updating: false }] });
    drive.fate = () => 'ok';
    await endRest();
    await run();
    expect(await dataOf(await list())).toMatchObject({ months: [{ waiting: 0, written_at: expect.any(String), last_error: null, drive_link: expect.stringMatching(/^https:\/\/drive\.google\.com\//) }] });
  });

  it('Retry now writes it now, resting or not', async () => {
    connectDrive();
    await issue();
    drive.fate = () => 503;
    await run();
    drive.fate = () => 'ok';
    expect((await retry()).status).toBe(201);
    await settled();
    expect(inDrive()).toEqual(await allBills());
    drive.files()[0]!.bytes = Buffer.from('somebody typed in it');
    await retry();
    await settled();
    expect(inDrive()).toEqual(await allBills()); // made again although nothing had changed
  });

  it('opens the book of the moment, from the database, even when Drive is down', async () => {
    connectDrive();
    drive.fate = () => 'down';
    const { invoice_no } = await issue();
    const response = await download();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="Billing_2026-11.xlsx"');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const { sheets } = readXlsx(new Uint8Array(await response.arrayBuffer()));
    expect(table(sheets[0] as ReadSheet).map((row) => row['Invoice no'])).toEqual(await allBills());
    expect(await allBills()).toContain(invoice_no);
    expect(drive.calls).toEqual([]);
  });

  it('is the owner’s alone', async () => {
    connectDrive();
    await issue();
    for (const [who, status] of [[ACTORS.staff, 403], [ACTORS.stranger, 403], [ACTORS.anon, 401]] as const) {
      actor = who;
      for (const answer of [await list(), await retry(), await download()]) {
        expect(answer.status, who.role).toBe(status);
        expect(answer.headers.get('content-type')).toMatch(/^application\/json/);
      }
    }
    expect(await waiting()).toBeGreaterThan(0);
  });

  it('refuses what is not a month of these books', async () => {
    for (const month of ['2026-13', '2026-1', 'x', '2019-01', '../etc', '2026-11-01']) expect((await download(month)).status, month).toBe(400);
    expect((await retry('2027-01')).status).toBe(400);
    expect((await download('2027-01')).status).toBe(400); // not yet
  });
});

describe('the daily job', () => {
  const telegram: string[] = [];
  const cron = (secret = 'a-long-enough-cron-secret') => call(import('@/app/api/cron/books/route'), 'GET', {}, undefined, { authorization: `Bearer ${secret}` });
  beforeEach(() => {
    telegram.length = 0;
    vi.stubEnv('CRON_SECRET', 'a-long-enough-cron-secret');
    vi.stubEnv('TELEGRAM_BOT_TOKEN', '1:test');
    vi.stubEnv('TELEGRAM_OWNER_CHAT_ID', '42');
  });
  const online = (): void => {
    connectDrive();
    vi.stubGlobal('fetch', (async (input, init) => {
      if (String(input).startsWith('https://api.telegram.org/')) {
        telegram.push((JSON.parse(String(init?.body)) as { text: string }).text);
        return Response.json({ ok: true, result: {} });
      }
      return drive.fetch(input, init);
    }) as typeof fetch);
  };

  it('needs the secret', async () => {
    online();
    await issue();
    expect((await cron('wrong')).status).toBe(401);
    vi.stubEnv('CRON_SECRET', '');
    expect((await cron()).status).toBe(503);
    expect(drive.calls).toEqual([]);
  });

  it('writes what is waiting, quietly', async () => {
    online();
    await issue();
    const response = await cron();
    expect(response.status).toBe(200);
    expect(await dataOf(response)).toEqual({ written: ['2026-11'], failed: [] });
    expect(inDrive()).toEqual(await allBills());
    expect(telegram).toEqual([]);
  });

  it('tells the owner when a month could not be written, in our own words', async () => {
    online();
    await issue();
    drive.fate = (one) => (one.kind === 'token' ? 400 : 'ok');
    expect((await cron()).status).toBe(502);
    expect(telegram).toEqual([expect.stringMatching(/^StudFlow Excel: November 2026 could not be updated on Google Drive\. Google Drive permission has expired.*The bills are safe\.$/)]);
  });

  it('does nothing without Drive', async () => {
    await issue();
    expect(await dataOf(await cron())).toEqual({ written: [], failed: [], off: true });
  });
});
