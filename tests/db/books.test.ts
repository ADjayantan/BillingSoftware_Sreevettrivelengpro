// 006: customers the device names itself, lines that remember grade and size, and the outbox that
// keeps one Excel book per month (specs/counter-and-books.md).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import {
  ACTORS,
  createTestDb,
  goodsLine,
  intraStatePayload,
  migrationFiles,
  openSeries,
  pgError,
  queryAs,
  recordPayment,
  seedMasterData,
  setToday,
  syncInvoice,
  type MasterData,
  type Payload,
} from './harness';

let db: PGlite;
let md: MasterData;
beforeAll(async () => {
  db = await createTestDb();
  md = await seedMasterData(db);
});
afterAll(async () => {
  await db.close();
});

interface Claim {
  month: string;
  token: string;
  change_ids: number[];
  drive_file_id: string | null;
  revision: number;
}
const claim = async (month: string | null = null, options: { seconds?: number; force?: boolean; on?: PGlite } = {}): Promise<Claim | undefined> =>
  (
    await queryAs<Claim>(
      options.on ?? db,
      ACTORS.service,
      'select month::text, token::text, change_ids, drive_file_id, revision::int from public.book_claim($1, $2, $3)',
      [month, options.seconds ?? 300, options.force ?? false],
    )
  )[0];
const yes = async (sql: string, params: unknown[], on = db): Promise<boolean> =>
  (await queryAs<{ ok: boolean }>(on, ACTORS.service, `select public.${sql} as ok`, params))[0]!.ok;
const done = (c: Claim, ids = c.change_ids) => yes('book_done($1, $2, $3, $4, $5)', [c.month, c.token, ids, 'https://drive.google.com/file/d/x/view', 'a'.repeat(64)]);
const hold = (c: Claim, seconds = 60) => yes('book_hold($1, $2, $3)', [c.month, c.token, seconds]);
const fail = (c: Claim, unknownOutcome = false) => yes('book_failed($1, $2, $3, $4)', [c.month, c.token, 'Google Drive did not answer', unknownOutcome]);
/** What is waiting, as [month, invoice]. */
const waiting = async (on = db): Promise<[string, string][]> =>
  (await on.query<{ m: string; i: string }>('select distinct month::text as m, invoice_id::text as i from private.book_changes order by 1, 2')).rows.map((r) => [r.m, r.i]);
const clear = async (): Promise<void> => {
  await db.exec('delete from private.book_changes; delete from private.month_books');
};
const issue = async (over: Payload = {}) => (await syncInvoice(db, ACTORS.staff, intraStatePayload(md, over))).invoice_id;

describe('a customer', () => {
  it('may be given its id by the device, once', async () => {
    const id = randomUUID();
    const add = (name: string) => queryAs<{ id: string }>(db, ACTORS.staff, `insert into public.customers (id, name) values ($1, $2) returning id`, [id, name]);
    expect(await add('Made offline')).toEqual([{ id }]);
    expect(await pgError(add('Another'))).toMatchObject({ code: '23505', message: expect.stringContaining('customers_pkey') });
  });

  it('is found by name, phone or GSTIN, whatever changes', async () => {
    const text = async (id: string) => (await db.query<{ t: string }>('select search_text as t from public.customers where id = $1', [id])).rows[0]?.t;
    expect(await text(md.tnCustomerId)).toBe('MURUGAN ENGINEERING WORKS 9876543210 33AABCM1234F1Z4');
    const [plain] = await queryAs<{ id: string }>(db, ACTORS.staff, `insert into public.customers (name) values ('Walk-in') returning id`);
    expect(await text(plain!.id)).toBe('WALK-IN');
    await queryAs(db, ACTORS.staff, `update public.customers set phone = '9000000001' where id = $1`, [plain!.id]);
    expect(await text(plain!.id)).toBe('WALK-IN 9000000001');
  });
});

describe('an invoice line', () => {
  const lineOf = async (id: string) =>
    (await db.query<{ g: string | null; s: string | null }>('select material_grade as g, size_text as s from public.invoice_items where invoice_id = $1 order by line_no', [id])).rows;

  it('remembers the grade and size it was billed with', async () => {
    const id = await issue();
    expect(await lineOf(id)).toEqual([{ g: 'EN8', s: 'M12 × 150 mm' }]);
    await db.query(`update public.stud_items set diameter_mm = 16, length_mm = 80.5, material_grade = 'MS', unit_weight_kg = 127.056720, unit_weight_is_manual = true where id = $1`, [md.studItemId]);
    expect(await lineOf(id)).toEqual([{ g: 'EN8', s: 'M12 × 150 mm' }]);
    expect(await lineOf(await issue())).toEqual([{ g: 'MS', s: 'M16 × 80.5 mm' }]);
    await db.query(`update public.stud_items set diameter_mm = 12, length_mm = 150, material_grade = 'EN8', unit_weight_kg = 0.133169, unit_weight_is_manual = false where id = $1`, [md.studItemId]);
  });

  it('has none when it was typed by hand or is not a stud, and cannot be given one', async () => {
    const [nut] = await queryAs<{ id: string }>(db, ACTORS.staff, `insert into public.stud_items (name, hsn_sac, gst_rate_percent) values ('Nut', '731816', 18) returning id`);
    const items = [
      goodsLine(md, { stud_item_id: null, total_weight_kg: null, qty_pieces: 500, line_total: '750.00', material_grade: 'EN8', size_text: 'M99' }),
      goodsLine(md, { line_no: 2, stud_item_id: nut!.id, total_weight_kg: null, qty_pieces: 500, line_total: '750.00' }),
    ];
    expect(await lineOf(await issue({ items }))).toEqual([{ g: null, s: null }, { g: null, s: null }]);
  });
});

describe('a month is marked as changed', () => {
  beforeEach(clear);

  it('by every issued bill, in its own transaction, by invoice date', async () => {
    const november = await issue({ invoice_date: '2026-11-20' });
    const october = await issue({ invoice_date: '2026-10-31' });
    expect(await waiting()).toEqual([['2026-10-01', october], ['2026-11-01', november]].sort());
  });

  it('never by a bill that was refused, nor by a replay', async () => {
    const payload = intraStatePayload(md);
    const { invoice_id } = await syncInvoice(db, ACTORS.staff, payload);
    await clear();
    await syncInvoice(db, ACTORS.staff, payload);
    expect((await pgError(syncInvoice(db, ACTORS.staff, intraStatePayload(md, { grand_total: '1.00' })))).code).toBe('23514');
    expect(await waiting()).toEqual([]);
    expect(invoice_id).toBeTruthy();
  });

  it('on both sides of 31 March: the sale belongs to the date on the bill', async () => {
    const year = await createTestDb({ today: '2027-04-01' });
    try {
      const masters = await seedMasterData(year);
      await openSeries(year, '26-27');
      const bill = async (date: string) => (await syncInvoice(year, ACTORS.staff, intraStatePayload(masters, { invoice_date: date, due_date: '2027-05-01' }))).invoice_no;
      expect([await bill('2027-03-31'), await bill('2027-04-01')]).toEqual(['INV/26-27/0001', 'INV/27-28/0001']);
      expect((await waiting(year)).map(([month]) => month)).toEqual(['2027-03-01', '2027-04-01']);
    } finally {
      await year.close();
    }
  });

  it('by a receipt: the month of the bill and the month of the money', async () => {
    const id = await issue({ invoice_date: '2026-11-20' });
    await clear();
    await setToday(db, '2026-12-05');
    const paid = await recordPayment(db, ACTORS.staff, id, '500.00', { received_on: '2026-12-03' });
    expect(await waiting()).toEqual([['2026-11-01', id], ['2026-12-01', id]]);
    await clear();
    await queryAs(db, ACTORS.owner, 'select * from public.void_payment($1, $2)', [paid.payment_id, 'wrong bill']);
    expect(await waiting()).toEqual([['2026-11-01', id], ['2026-12-01', id]]);
    await setToday(db, '2026-11-23');
  });

  it('by a cancellation', async () => {
    const id = await issue();
    await clear();
    await queryAs(db, ACTORS.staff, `update public.invoices set cancelled_at = now(), cancellation_reason = 'wrong buyer' where id = $1`, [id]);
    expect(await waiting()).toEqual([['2026-11-01', id]]);
  });

  it('by dispatch, but not by a Drive link, a proof photo or a reminder', async () => {
    const id = await issue();
    await clear();
    await queryAs(db, ACTORS.service, `update public.invoices set pdf_drive_url = 'https://drive.google.com/x', drive_sync_pending = false where id = $1`, [id]);
    await queryAs(db, ACTORS.service, `update public.invoices set last_reminder_stage = 'due', last_reminder_sent_on = '2026-11-23' where id = $1`, [id]);
    await queryAs(db, ACTORS.service, `update public.deliveries set proof_drive_url = 'https://drive.google.com/y' where invoice_id = $1`, [id]);
    expect(await waiting()).toEqual([]);
    await queryAs(db, ACTORS.staff, `update public.deliveries set status = 'dispatched' where invoice_id = $1`, [id]);
    expect(await waiting()).toEqual([['2026-11-01', id]]);
  });

  it('by material going back, and by taking it back', async () => {
    const [lot] = await queryAs<{ id: string }>(db, ACTORS.staff, `insert into public.job_work_ledger (customer_id, party_dc_no, party_dc_date, material_grade, inward_weight_kg) values ($1, 'B-1', '2026-11-01', 'EN8', 100) returning id`, [md.tnCustomerId]);
    const id = await issue({ bill_type: 'job_work', job_work_returns: [{ lot_id: lot!.id, returned_weight_kg: '40', scrap_weight_kg: '0' }] });
    expect(await waiting()).toEqual([['2026-11-01', id]]);
    await clear();
    await queryAs(db, ACTORS.staff, `update public.invoices set cancelled_at = now(), cancellation_reason = 'wrong lot' where id = $1`, [id]);
    expect(await waiting()).toEqual([['2026-11-01', id]]);
  });
});

describe('one worker at a time', () => {
  beforeEach(clear);

  it('takes the month that has waited longest, and nobody else can take it meanwhile', async () => {
    await issue({ invoice_date: '2026-11-20' });
    await issue({ invoice_date: '2026-10-31' });
    const first = await claim();
    const second = await claim();
    expect([first?.month, second?.month]).toEqual(['2026-11-01', '2026-10-01']);
    expect(await claim()).toBeUndefined();
    expect(await claim('2026-11-01', { force: true })).toBeUndefined();
    expect(await hold(first!)).toBe(true);
  });

  it('finishes exactly what it had seen; what came later makes the next round', async () => {
    const early = await issue();
    const first = (await claim())!;
    const late = await issue();
    expect(await done(first)).toBe(true);
    expect((await waiting()).map(([, invoice]) => invoice)).toEqual([late]);
    const next = (await claim())!;
    expect(next).toMatchObject({ month: '2026-11-01', revision: 1 });
    expect(await done(next)).toBe(true);
    expect(await waiting()).toEqual([]);
    expect(early).not.toBe(late);
    expect(await claim()).toBeUndefined();
  });

  it('does not lose a bill that was committed late, under a lower number', async () => {
    const slow = await issue();
    const { rows } = await db.query<{ id: number }>('select id::int from private.book_changes order by id');
    await db.exec('delete from private.book_changes'); // its transaction has not committed yet
    await issue();
    const first = (await claim())!;
    await db.query('insert into private.book_changes (id, month, invoice_id) overriding system value values ($1, $2, $3)', [rows[0]!.id, '2026-11-01', slow]);
    expect(await done(first)).toBe(true);
    expect((await waiting()).map(([, invoice]) => invoice)).toEqual([slow]);
  });

  it('loses the month when its time is over: it may not write, finish or fail any more', async () => {
    await issue();
    const stale = (await claim())!;
    await db.exec(`update private.month_books set lease_until = clock_timestamp() - interval '1 second'`);
    const fresh = (await claim())!;
    expect(fresh.month).toBe(stale.month);
    expect(await hold(stale)).toBe(false);
    expect(await yes('book_set_file($1, $2, $3)', [stale.month, stale.token, 'stale_file_id'])).toBe(false);
    expect(await done(stale)).toBe(false);
    expect(await fail(stale)).toBe(false);
    expect(await hold(fresh)).toBe(true);
    expect(await done(fresh)).toBe(true);
  });

  it('may not start writing when too little time is left', async () => {
    await issue();
    const short = (await claim(null, { seconds: 30 }))!;
    expect(await hold(short, 60)).toBe(false);
    expect(await hold(short, 5)).toBe(true);
  });

  it('keeps one file id for the month', async () => {
    await issue();
    const first = (await claim())!;
    expect(first.drive_file_id).toBeNull();
    expect(await yes('book_set_file($1, $2, $3)', [first.month, first.token, 'file_for_november'])).toBe(true);
    await done(first);
    await issue();
    expect((await claim())?.drive_file_id).toBe('file_for_november');
  });

  it('rests after a failure, longer each time, unless somebody asks', async () => {
    await issue();
    const rests: number[] = [];
    for (let i = 0; i < 3; i++) {
      const tried = (await claim('2026-11-01', { force: true }))!;
      expect(await fail(tried)).toBe(true);
      expect(await claim()).toBeUndefined();
      const { rows } = await db.query<{ s: number; e: string; a: number }>(`select extract(epoch from next_try_at - clock_timestamp())::int as s, last_error as e, attempts as a from private.month_books`);
      expect(rows[0]).toMatchObject({ e: 'Google Drive did not answer', a: i + 1 });
      rests.push(rows[0]!.s);
    }
    expect(rests[0]).toBeGreaterThan(30);
    expect(rests[1]).toBeGreaterThan(rests[0]!);
    expect(rests[2]).toBeGreaterThan(rests[1]!);
    await db.exec('update private.month_books set attempts = 60');
    await fail((await claim('2026-11-01', { force: true }))!);
    expect((await db.query<{ ok: boolean }>(`select next_try_at <= clock_timestamp() + interval '6 hours' as ok from private.month_books`)).rows[0]?.ok).toBe(true);
    await done((await claim('2026-11-01', { force: true }))!);
    expect((await db.query('select attempts, next_try_at, last_error, lease_token from private.month_books')).rows).toEqual([{ attempts: 0, next_try_at: null, last_error: null, lease_token: null }]);
  });

  it('keeps the month when nobody knows whether the upload arrived, so a late one cannot land on a newer one', async () => {
    await issue();
    const unsure = (await claim())!;
    expect(await fail(unsure, true)).toBe(true);
    expect(await claim('2026-11-01', { force: true })).toBeUndefined();
    await db.exec(`update private.month_books set lease_until = clock_timestamp() - interval '1 second'`);
    expect((await claim('2026-11-01', { force: true }))?.month).toBe('2026-11-01');
  });

  it('two claims at the same instant give one worker', async () => {
    await issue();
    const both = await Promise.all([claim(), claim()]);
    expect(both.filter(Boolean)).toHaveLength(1);
  });
});

describe('who may see and do what', () => {
  beforeEach(clear);

  it('the worker’s functions answer the server only', async () => {
    const calls = [
      'public.book_claim(null, 300, false)', `public.book_hold('2026-11-01', gen_random_uuid(), 5)`, `public.book_set_file('2026-11-01', gen_random_uuid(), 'file_12345')`,
      `public.book_done('2026-11-01', gen_random_uuid(), '{1}', 'https://drive.google.com/x', repeat('a', 64))`, `public.book_failed('2026-11-01', gen_random_uuid(), 'x', false)`,
    ];
    for (const actor of [ACTORS.anon, ACTORS.stranger, ACTORS.staff, ACTORS.owner]) {
      for (const call of calls) expect((await pgError(queryAs(db, actor, `select ${call}`))).code, `${actor.role} ${call}`).toBe('42501');
    }
  });

  it('nobody reads or writes the tables', async () => {
    for (const actor of [ACTORS.anon, ACTORS.staff, ACTORS.owner, ACTORS.service]) {
      for (const table of ['private.book_changes', 'private.month_books']) {
        expect((await pgError(queryAs(db, actor, `select * from ${table}`))).code).toBe('42501');
        expect((await pgError(queryAs(db, actor, `delete from ${table}`))).code).toBe('42501');
      }
    }
  });

  it('staff see whether a bill is in the book yet', async () => {
    const state = async (id: string, actor = ACTORS.staff as Parameters<typeof queryAs>[1]) => (await queryAs<{ s: string }>(db, actor, 'select public.bill_in_book($1) as s', [id]))[0]?.s;
    const id = await issue();
    expect(await state(id)).toBe('waiting');
    await done((await claim())!);
    expect(await state(id)).toBe('updated');
    await recordPayment(db, ACTORS.staff, id, '10.00', { received_on: '2026-11-21' });
    expect(await state(id)).toBe('waiting');
    expect((await pgError(state(id, ACTORS.stranger))).code).toBe('42501');
    expect((await pgError(state(randomUUID()))).code).toBe('22023');
  });

  it('staff learn only that something is due', async () => {
    const due = async (actor = ACTORS.staff as Parameters<typeof queryAs>[1]) => (await queryAs<{ d: boolean }>(db, actor, 'select public.book_due() as d'))[0]?.d;
    expect(await due()).toBe(false);
    await issue();
    expect(await due()).toBe(true);
    await fail((await claim())!);
    expect(await due()).toBe(false); // resting
    expect((await pgError(due(ACTORS.stranger))).code).toBe('42501');
  });

  it('the owner sees every month and may ask for it again; nobody else', async () => {
    await issue({ invoice_date: '2026-11-20' });
    await issue({ invoice_date: '2026-10-31' });
    await done((await claim('2026-10-01'))!);
    await fail((await claim('2026-11-01'))!);
    const months = async (actor = ACTORS.owner as Parameters<typeof queryAs>[1]) =>
      queryAs<{ month: string; waiting: number; bills: number; written: boolean; retry: boolean; last_error: string | null; link: string | null }>(
        db, actor, `select month::text, waiting::int, bills::int, written_at is not null as written, retry_at is not null as retry, last_error, drive_link as link from public.book_months()`,
      );
    expect(await months()).toEqual([
      { month: '2026-11-01', waiting: expect.any(Number), bills: expect.any(Number), written: false, retry: true, last_error: 'Google Drive did not answer', link: null },
      { month: '2026-10-01', waiting: 0, bills: expect.any(Number), written: true, retry: false, last_error: null, link: 'https://drive.google.com/file/d/x/view' },
    ]);
    const retry = (month: string, actor = ACTORS.owner as Parameters<typeof queryAs>[1]) => queryAs(db, actor, 'select public.book_retry($1)', [month]);
    await retry('2026-11-01');
    expect((await claim())?.month).toBe('2026-11-01');
    await retry('2026-10-01'); // up to date: made again all the same
    expect((await claim())?.month).toBe('2026-10-01');
    for (const actor of [ACTORS.staff, ACTORS.stranger, ACTORS.service]) {
      expect((await pgError(months(actor))).code).toBe('42501');
      expect((await pgError(retry('2026-11-01', actor))).code).toBe('42501');
    }
    expect((await pgError(retry('2026-11-15'))).code).toBe('22023');
  });
});

describe('the migration', () => {
  it('puts the bills and receipts that are already there in line', async () => {
    const live = await createTestDb({ upTo: '005', today: '2026-12-05' });
    try {
      const masters = await seedMasterData(live);
      const { invoice_id } = await syncInvoice(live, ACTORS.staff, intraStatePayload(masters, { invoice_date: '2026-11-20', due_date: '2026-12-20' }));
      await recordPayment(live, ACTORS.staff, invoice_id, '100.00', { received_on: '2026-12-03' });
      const before = (await live.query<Record<string, unknown>>('select * from public.invoice_items')).rows;
      await live.exec(`set role supabase_postgres; ${migrationFiles().find(({ name }) => name.startsWith('006'))?.sql ?? ''}; reset role;`);
      expect(await waiting(live)).toEqual([['2026-11-01', invoice_id], ['2026-12-01', invoice_id]]);
      expect((await live.query<Record<string, unknown>>('select * from public.invoice_items')).rows).toEqual(before.map((row) => ({ ...row, material_grade: null, size_text: null })));
      expect((await claim(null, { on: live }))?.month).toBe('2026-11-01');
    } finally {
      await live.close();
    }
  });
});
