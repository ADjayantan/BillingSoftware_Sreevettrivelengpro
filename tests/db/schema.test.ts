import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import {
  ACTORS,
  GSTIN,
  USERS,
  asActor,
  createTestDb,
  goodsLine,
  interStatePayload,
  intraStatePayload,
  openSeries,
  pgError,
  queryAs,
  recordPayment,
  seedMasterData,
  setToday,
  syncInvoice,
  type Actor,
  type MasterData,
  type SyncResult,
} from './harness';

/** The brief's 8 core tables plus the 3 that Sprint 2's approved decisions need. */
const PUBLIC_TABLES = [
  'alert_rules',
  'company_profile',
  'customers',
  'deliveries',
  'invoice_items',
  'invoices',
  'job_work_ledger',
  'job_work_returns',
  'metal_rates',
  'payments',
  'stud_items',
] as const;

const seqOf = (documentNo: string): number => Number(documentNo.split('/')[2]);

/** One fresh database per describe block; numbering assertions depend on isolation. */
function useDb(withMasterData = true) {
  const ctx = {} as { db: PGlite; md: MasterData };
  beforeAll(async () => {
    ctx.db = await createTestDb();
    if (withMasterData) ctx.md = await seedMasterData(ctx.db);
  });
  afterAll(async () => {
    await ctx.db?.close();
  });
  return ctx;
}

describe('migration', () => {
  const ctx = useDb(false);

  it('applies cleanly on Postgres 15+', async () => {
    const { rows } = await ctx.db.query<{ version: string }>('select version()');
    expect(rows[0]?.version).toMatch(/PostgreSQL (1[5-9]|[2-9]\d)\./);
  });

  it('creates exactly the 8 core and 3 Sprint 2 tables in public, all with RLS enabled', async () => {
    const { rows } = await ctx.db.query<{ relname: string; rls: boolean }>(`
      select c.relname, c.relrowsecurity as rls
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
      order by c.relname`);
    expect(rows.map((r) => r.relname)).toEqual([...PUBLIC_TABLES]);
    expect(rows.filter((r) => !r.rls)).toEqual([]);
  });

  it('enables RLS on the private tables as defence in depth', async () => {
    const { rows } = await ctx.db.query<{ relname: string; rls: boolean }>(`
      select c.relname, c.relrowsecurity as rls
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'private' and c.relkind = 'r'
      order by c.relname`);
    expect(rows).toEqual([
      { relname: 'app_users', rls: true },
      { relname: 'audit_log', rls: true },
      { relname: 'book_changes', rls: true },
      { relname: 'document_sequences', rls: true },
      { relname: 'month_books', rls: true },
    ]);
  });

  it('pins search_path on every function in public and private', async () => {
    const { rows } = await ctx.db.query<{ fn: string }>(`
      select n.nspname || '.' || p.proname as fn
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'private')
        and not exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) as cfg
                        where cfg like 'search_path=%')`);
    expect(rows).toEqual([]);
  });

  it('runs as a non-superuser, like Supabase’s postgres role', async () => {
    const { rows } = await ctx.db.query<{ fn: string }>(`
      select p.oid::regprocedure::text as fn
      from pg_proc p join pg_roles r on r.oid = p.proowner join pg_namespace n on n.oid = p.pronamespace
      where p.prosecdef and n.nspname in ('public', 'private') and r.rolsuper`);
    expect(rows).toEqual([]);
  });

  it('gives anon no privilege on any public table or view', async () => {
    const { rows } = await ctx.db.query<{ relname: string }>(`
      select c.relname
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'v', 'm')
        and has_table_privilege('anon', c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')`);
    expect(rows).toEqual([]);
  });

  it('lets API roles execute only the helpers that policies, CHECKs and the gate evaluate', async () => {
    const { rows } = await ctx.db.query<{ fn: string; role: string }>(`
      select n.nspname || '.' || p.proname as fn, r.role
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      cross join unnest(array['anon', 'authenticated', 'service_role']) as r(role)
      where n.nspname in ('public', 'private') and has_function_privilege(r.role, p.oid, 'EXECUTE')
      order by 1, 2`);
    const helpers = [
      'private.check_request',
      'private.fiscal_year_of',
      'private.fiscal_year_start',
      'private.format_document_no',
      'private.is_owner',
      'private.is_staff',
      'private.is_valid_gstin',
    ];
    expect(rows.filter((r) => r.role === 'anon')).toEqual([]);
    expect(rows.filter((r) => r.role === 'service_role').map((r) => r.fn)).toEqual([
      ...helpers,
      'public.book_claim',
      'public.book_done',
      'public.book_failed',
      'public.book_hold',
      'public.book_set_file',
    ]);
    expect(rows.filter((r) => r.role === 'authenticated').map((r) => r.fn)).toEqual([
      ...helpers,
      'private.product_code',
      'public.bill_in_book',
      'public.book_due',
      'public.book_months',
      'public.book_retry',
      'public.record_payment',
      'public.sync_invoice',
      'public.void_payment',
    ]);
  });

  it('keeps the allowlist, counters, edit log and allocator out of reach of signed-in users', async () => {
    const attempts = [
      'select * from private.app_users',
      'select * from private.document_sequences',
      'select * from private.audit_log',
      `select private.next_document_seq('INV', '26-27')`,
      `insert into private.app_users (user_id, display_name, role) values ('${USERS.stranger.id}', 'Me', 'owner')`,
      `update private.app_users set role = 'owner' where user_id = '${USERS.staff.id}'`,
      'update private.document_sequences set last_value = last_value + 5',
    ];
    for (const actor of [ACTORS.staff, ACTORS.owner]) {
      for (const sql of attempts) {
        expect((await pgError(queryAs(ctx.db, actor, sql))).code).toBe('42501');
      }
    }
  });

  it("computes the business date in IST, whatever the server's or session's time zone", async () => {
    const realClock = await createTestDb({ today: null, seedUsers: false });
    try {
      const istToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
      for (const tz of ['UTC', 'Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
        await realClock.exec(`set timezone = '${tz}'`);
        const { rows } = await realClock.query<{ today: string }>('select private.today_ist()::text as today');
        expect(rows[0]?.today).toBe(istToday);
      }
      // Most of the day other zones agree on the date, so also pin the zone itself.
      const { rows: def } = await realClock.query<{ src: string }>(
        `select prosrc as src from pg_proc where oid = 'private.today_ist()'::regprocedure`,
      );
      expect(def[0]?.src.trim()).toBe(`select (now() at time zone 'Asia/Kolkata')::date`);
    } finally {
      await realClock.close();
    }
  });
});

describe('fiscal year and document numbers', () => {
  const ctx = useDb(false);

  it.each([
    ['2026-03-31', '25-26'],
    ['2026-04-01', '26-27'],
    ['2026-11-23', '26-27'],
    ['2027-03-31', '26-27'],
    ['2027-04-01', '27-28'],
    ['2000-04-01', '00-01'],
    ['2099-04-01', '99-00'],
    ['2100-01-15', '99-00'],
  ])('FY of %s is %s', async (date, fy) => {
    const { rows } = await ctx.db.query<{ fy: string }>('select private.fiscal_year_of($1::date) as fy', [date]);
    expect(rows[0]?.fy).toBe(fy);
  });

  it.each([
    [1, 'INV/26-27/0001'],
    [42, 'INV/26-27/0042'],
    [9999, 'INV/26-27/9999'],
    [10000, 'INV/26-27/10000'], // lpad() alone would truncate this to 'INV/26-27/1000'
    [999999, 'INV/26-27/999999'], // 16 chars: the GST Rule 46 maximum
  ])('formats sequence %i as %s', async (seq, expected) => {
    const { rows } = await ctx.db.query<{ no: string }>(
      `select private.format_document_no('INV', '26-27', $1) as no`,
      [seq],
    );
    expect(rows[0]?.no).toBe(expected);
  });
});

describe('sync_invoice: crash-safe numbering', () => {
  const ctx = useDb();

  it('numbers invoices and challans from 0001 in each financial year', async () => {
    const first = await syncInvoice(ctx.db, ACTORS.staff, intraStatePayload(ctx.md));
    const second = await syncInvoice(ctx.db, ACTORS.owner, intraStatePayload(ctx.md));
    expect(first).toMatchObject({ invoice_no: 'INV/26-27/0001', dc_no: 'DC/26-27/0001', replayed: false });
    expect(second).toMatchObject({ invoice_no: 'INV/26-27/0002', dc_no: 'DC/26-27/0002', replayed: false });
  });

  it('replays an already-synced bill instead of minting a second number', async () => {
    const payload = intraStatePayload(ctx.md);
    const original = await syncInvoice(ctx.db, ACTORS.staff, payload);
    const replay = await syncInvoice(ctx.db, ACTORS.owner, payload);
    expect(replay).toEqual({ ...original, replayed: true });

    const next = await syncInvoice(ctx.db, ACTORS.staff, intraStatePayload(ctx.md));
    expect(seqOf(next.invoice_no)).toBe(seqOf(original.invoice_no) + 1);
  });

  it('does not burn a number when validation fails', async () => {
    const before = await syncInvoice(ctx.db, ACTORS.staff, intraStatePayload(ctx.md));
    const mismatched = intraStatePayload(ctx.md, { subtotal: '1499.00', grand_total: '1769.00' });
    expect((await pgError(syncInvoice(ctx.db, ACTORS.staff, mismatched))).code).toBe('23514');
    // This one fails on the DC insert, after BOTH counters have moved.
    const badPlate = intraStatePayload(ctx.md, { delivery: { vehicle_no: 'tn 38 ab 1234' } });
    expect((await pgError(syncInvoice(ctx.db, ACTORS.staff, badPlate))).code).toBe('23514');

    const after = await syncInvoice(ctx.db, ACTORS.staff, intraStatePayload(ctx.md));
    expect(seqOf(after.invoice_no)).toBe(seqOf(before.invoice_no) + 1);
    expect(seqOf(after.dc_no)).toBe(seqOf(before.dc_no) + 1);
  });

  it('hands the numbers back when the connection dies before COMMIT', async () => {
    const before = await syncInvoice(ctx.db, ACTORS.staff, intraStatePayload(ctx.md));
    const crashed = asActor(ctx.db, ACTORS.staff, async (tx) => {
      await tx.query('select * from public.sync_invoice($1::jsonb)', [JSON.stringify(intraStatePayload(ctx.md))]);
      throw new Error('power cut before COMMIT');
    });
    await expect(crashed).rejects.toThrow('power cut before COMMIT');

    const after = await syncInvoice(ctx.db, ACTORS.staff, intraStatePayload(ctx.md));
    expect(seqOf(after.invoice_no)).toBe(seqOf(before.invoice_no) + 1);
  });

  it('rejects future dates, dates over 31 days old (reset PC clock, wrong year) and non-ISO dates', async () => {
    const on = (invoiceDate: string) =>
      intraStatePayload(ctx.md, { invoice_date: invoiceDate, due_date: '2026-12-31' });
    for (const date of ['2026-11-24', '2026-10-22', '2025-11-20', '20/11/2026']) {
      expect((await pgError(syncInvoice(ctx.db, ACTORS.staff, on(date)))).code).toBe('22023');
    }
    for (const date of ['2026-11-23', '2026-10-23']) {
      expect((await syncInvoice(ctx.db, ACTORS.staff, on(date))).invoice_no).toMatch(/^INV\/26-27\//);
    }
  });
});

describe('sync_invoice: financial-year rollover and go-live', () => {
  const withDb = async (
    today: string,
    fn: (db: PGlite, md: MasterData) => Promise<void>,
    open = false,
  ): Promise<void> => {
    const db = await createTestDb({ today, openSeries: open });
    try {
      await fn(db, await seedMasterData(db));
    } finally {
      await db.close();
    }
  };
  const on = (md: MasterData, date: string) => intraStatePayload(md, { invoice_date: date, due_date: '2027-12-31' });

  it('rolls forward by itself on 1 April, while late March bills stay in their own series', async () => {
    await withDb('2027-03-31', async (db, md) => {
      await syncInvoice(db, ACTORS.staff, on(md, '2027-03-31'));
      await setToday(db, '2027-04-02');
      const numbers: string[] = [];
      for (const date of ['2027-04-01', '2027-03-31', '2027-04-02']) {
        numbers.push((await syncInvoice(db, ACTORS.staff, on(md, date))).invoice_no);
      }
      expect(numbers).toEqual(['INV/27-28/0001', 'INV/26-27/0002', 'INV/27-28/0002']);
    }, true);
  });

  it('refuses to bill before the series is opened, instead of starting at 0001', async () => {
    await withDb('2026-11-23', async (db, md) => {
      const err = await pgError(syncInvoice(db, ACTORS.staff, on(md, '2026-11-20')));
      expect(err).toMatchObject({ code: '55000', message: 'INV numbering for FY 26-27 is not open' });
    });
  });

  it('continues the old system’s series after a mid-year cut-over', async () => {
    await withDb('2026-11-23', async (db, md) => {
      await openSeries(db, '26-27', 412, 388);
      expect(await syncInvoice(db, ACTORS.staff, on(md, '2026-11-20'))).toMatchObject({
        invoice_no: 'INV/26-27/0413',
        dc_no: 'DC/26-27/0389',
      });
      await db.exec(`update private.document_sequences set last_value = 9999 where series = 'INV'`);
      expect((await syncInvoice(db, ACTORS.staff, on(md, '2026-11-20'))).invoice_no).toBe('INV/26-27/10000');
    });
  });

  it('never opens an FY before go-live: those numbers belong to the old system', async () => {
    await withDb('2026-04-10', async (db, md) => {
      await openSeries(db, '26-27', 12, 9);
      const err = await pgError(syncInvoice(db, ACTORS.staff, on(md, '2026-03-31')));
      expect(err).toMatchObject({ code: '55000', message: 'INV numbering for FY 25-26 is not open' });
    });
  });

  it('refuses a half-done cut-over that opened INV but not DC', async () => {
    await withDb('2026-11-23', async (db, md) => {
      await db.exec(`insert into private.document_sequences (series, fiscal_year, last_value) values ('INV', '26-27', 412)`);
      const err = await pgError(syncInvoice(db, ACTORS.staff, on(md, '2026-11-20')));
      expect(err).toMatchObject({ code: '55000', message: 'DC numbering for FY 26-27 is not open' });
    });
  });

  it('stops cleanly at the 16-character GST limit', async () => {
    await withDb('2026-11-23', async (db, md) => {
      await openSeries(db, '26-27', 999998, 999998);
      expect((await syncInvoice(db, ACTORS.staff, on(md, '2026-11-20'))).invoice_no).toBe('INV/26-27/999999');
      expect((await pgError(syncInvoice(db, ACTORS.staff, on(md, '2026-11-20')))).code).toBe('23514');
      const { rows } = await db.query(`select distinct last_value from private.document_sequences`);
      expect(rows).toEqual([{ last_value: 999999 }]);
    });
  });

  it('answers a replay even when the bill’s date has since become too old to issue', async () => {
    await withDb('2026-11-23', async (db, md) => {
      const payload = on(md, '2026-11-20');
      const issued = await syncInvoice(db, ACTORS.staff, payload);
      await setToday(db, '2027-06-01');
      expect(await syncInvoice(db, ACTORS.staff, payload)).toEqual({ ...issued, replayed: true });
    }, true);
  });

  it('replays the challan issued with the bill, not a later one with a lower number', async () => {
    await withDb('2027-03-31', async (db, md) => {
      await syncInvoice(db, ACTORS.staff, on(md, '2027-03-31'));
      const payload = on(md, '2027-03-31');
      const issued = await syncInvoice(db, ACTORS.staff, payload);
      expect(issued.dc_no).toBe('DC/26-27/0002');
      // A balance dispatch on 2 April gets DC/27-28/0001.
      await db.query(
        `with n as (select private.next_document_seq('DC', '27-28') as seq)
         insert into public.deliveries (invoice_id, dc_no, fiscal_year, dc_seq, dc_date)
         select $1, private.format_document_no('DC', '27-28', n.seq), '27-28', n.seq, date '2027-04-02' from n`,
        [issued.invoice_id],
      );
      expect(await syncInvoice(db, ACTORS.staff, payload)).toEqual({ ...issued, replayed: true });
    }, true);
  });
});

describe('sync_invoice: authorization and payload shape', () => {
  const ctx = useDb();

  it.each([
    ['a signed-up stranger', ACTORS.stranger],
    ['a deactivated employee', ACTORS.former],
    ['the service role (no user behind it)', ACTORS.service],
    ['anon', ACTORS.anon],
  ])('rejects %s', async (_label, actor) => {
    expect((await pgError(syncInvoice(ctx.db, actor, intraStatePayload(ctx.md)))).code).toBe('42501');
  });

  it('does not let a stranger replay an existing bill to learn its numbers', async () => {
    const payload = intraStatePayload(ctx.md);
    await syncInvoice(ctx.db, ACTORS.staff, payload);
    expect((await pgError(syncInvoice(ctx.db, ACTORS.stranger, payload))).code).toBe('42501');
  });

  it.each([
    ['a short id', 'OFFLINE-123'],
    ['an uppercase uuid', 'OFFLINE-6F1C0E2A-1B2C-4D3E-8F90-A1B2C3D4E5F6'],
    ['a missing prefix', '6f1c0e2a-1b2c-4d3e-8f90-a1b2c3d4e5f6'],
  ])('rejects a client_temp_id with %s', async (_label, clientTempId) => {
    const payload = intraStatePayload(ctx.md, { client_temp_id: clientTempId });
    expect((await pgError(syncInvoice(ctx.db, ACTORS.staff, payload))).code).toBe('22023');
  });

  it('rejects an unknown customer', async () => {
    const payload = intraStatePayload(ctx.md, { customer_id: '11111111-1111-4111-8111-111111111111' });
    expect((await pgError(syncInvoice(ctx.db, ACTORS.staff, payload))).code).toBe('23503');
  });

  it('requires 1 to 500 line items', async () => {
    const lines = Array.from({ length: 501 }, (_, i) => goodsLine(ctx.md, { line_no: i + 1 }));
    for (const items of [[], lines, 'nope']) {
      expect((await pgError(syncInvoice(ctx.db, ACTORS.staff, intraStatePayload(ctx.md, { items })))).code).toBe('22023');
    }
  });

  it('accepts the RPC the way PostgREST calls it: a named jsonb argument', async () => {
    const rows = await queryAs<{ replayed: boolean }>(
      ctx.db,
      ACTORS.staff,
      `select r.replayed
         from public.sync_invoice(p_payload := (select a.p_payload from json_to_record($1::json) as a(p_payload jsonb))) as r`,
      [JSON.stringify({ p_payload: intraStatePayload(ctx.md) })],
    );
    expect(rows).toEqual([{ replayed: false }]);
  });

  it('ignores everything the device must not decide', async () => {
    const result = await syncInvoice(
      ctx.db,
      ACTORS.staff,
      intraStatePayload(ctx.md, {
        id: '11111111-1111-4111-8111-111111111111',
        invoice_no: 'INV/26-27/0999',
        invoice_seq: 999,
        created_by: USERS.owner.id,
        cancelled_at: '2026-11-20T00:00:00Z',
        cancellation_reason: 'forged',
        pdf_drive_url: 'https://evil.example/x.pdf',
        place_of_supply: '29',
        customer_snapshot: { name: 'Someone Else' },
      }),
    );
    const [row] = await queryAs(
      ctx.db,
      ACTORS.staff,
      `select invoice_no, created_by::text, cancelled_at, pdf_drive_url, place_of_supply,
              customer_snapshot ->> 'name' as billed_name
         from public.invoices where id = $1`,
      [result.invoice_id],
    );
    expect(row).toEqual({
      invoice_no: result.invoice_no,
      created_by: USERS.staff.id,
      cancelled_at: null,
      pdf_drive_url: null,
      place_of_supply: '33',
      billed_name: 'Murugan Engineering Works',
    });
  });
});

describe('GST and accounting invariants', () => {
  const ctx = useDb();
  const reject = async (payload: unknown) => pgError(syncInvoice(ctx.db, ACTORS.staff, payload));

  it('bills a Tamil Nadu customer CGST + SGST with place of supply 33', async () => {
    const result = await syncInvoice(ctx.db, ACTORS.staff, intraStatePayload(ctx.md));
    const [invoice] = await queryAs(
      ctx.db,
      ACTORS.staff,
      `select place_of_supply, cgst::text, sgst::text, igst::text, grand_total::text,
              customer_snapshot ->> 'gstin' as billed_gstin
         from public.invoices where id = $1`,
      [result.invoice_id],
    );
    expect(invoice).toEqual({
      place_of_supply: '33',
      cgst: '135.00',
      sgst: '135.00',
      igst: '0.00',
      grand_total: '1770.00',
      billed_gstin: GSTIN.tn,
    });
  });

  it('bills an out-of-state customer IGST only', async () => {
    const result = await syncInvoice(ctx.db, ACTORS.staff, interStatePayload(ctx.md));
    const [invoice] = await queryAs(
      ctx.db,
      ACTORS.staff,
      'select place_of_supply, igst::text from public.invoices where id = $1',
      [result.invoice_id],
    );
    expect(invoice).toEqual({ place_of_supply: '29', igst: '270.00' });
  });

  it('rejects IGST on an intra-state bill', async () => {
    const payload = intraStatePayload(ctx.md, { cgst: '0.00', sgst: '0.00', igst: '270.00' });
    expect(await reject(payload)).toMatchObject({ code: '23514', message: expect.stringMatching(/gst_regime/) });
  });

  it('rejects CGST/SGST on an inter-state bill', async () => {
    const payload = interStatePayload(ctx.md, { cgst: '135.00', sgst: '135.00', igst: '0.00' });
    expect(await reject(payload)).toMatchObject({ code: '23514', message: expect.stringMatching(/gst_regime/) });
  });

  it('rejects unequal CGST and SGST halves', async () => {
    const payload = intraStatePayload(ctx.md, { cgst: '135.01', sgst: '134.99' });
    expect(await reject(payload)).toMatchObject({ code: '23514', message: expect.stringMatching(/cgst_equals_sgst/) });
  });

  it('rejects a grand total that does not add up', async () => {
    expect(await reject(intraStatePayload(ctx.md, { grand_total: '1771.00' }))).toMatchObject({
      code: '23514',
      message: expect.stringMatching(/total_identity/),
    });
  });

  it('rejects a round-off of a rupee or more, or one that does not land on a whole rupee', async () => {
    for (const [roundOff, grandTotal] of [
      ['1.00', '1771.00'],
      ['0.37', '1770.37'],
      ['-0.99', '1769.01'],
    ]) {
      const payload = intraStatePayload(ctx.md, { round_off: roundOff, grand_total: grandTotal });
      expect((await reject(payload)).code).toBe('23514');
    }
  });

  it('rejects amounts with more decimals than the column holds (no silent rounding)', async () => {
    const header = intraStatePayload(ctx.md, { cgst: '135.004', sgst: '135.004', grand_total: '1770.008' });
    expect((await reject(header)).code).toBe('22023');

    const line = intraStatePayload(ctx.md, { items: [goodsLine(ctx.md, { unit_rate: '1.5000001' })] });
    expect((await reject(line)).code).toBe('22023');
  });

  it('requires a weight on kg-billed lines', async () => {
    const payload = intraStatePayload(ctx.md, {
      items: [goodsLine(ctx.md, { billing_unit: 'kg', total_weight_kg: null })],
    });
    expect((await reject(payload)).code).toBe('23514');
  });

  it('keeps buyer-paid freight off the invoice but on the challan', async () => {
    const billed = intraStatePayload(ctx.md, {
      delivery_charge: '200.00',
      cgst: '153.00',
      sgst: '153.00',
      grand_total: '2006.00',
      delivery: { freight_paid_by: 'buyer_to_pay', freight_amount: '200.00' },
    });
    expect(await reject(billed)).toMatchObject({ code: '23514', message: expect.stringMatching(/Freight paid by the buyer/) });

    const result = await syncInvoice(
      ctx.db,
      ACTORS.staff,
      intraStatePayload(ctx.md, {
        delivery: {
          transport_mode: 'transporter',
          lr_number: 'LR-7781',
          freight_paid_by: 'buyer_to_pay',
          freight_amount: '200.00',
        },
      }),
    );
    const [challan] = await queryAs(
      ctx.db,
      ACTORS.staff,
      `select d.freight_paid_by, d.freight_amount::text, d.transport_mode, d.lr_number, i.grand_total::text
         from public.deliveries d join public.invoices i on i.id = d.invoice_id
        where d.invoice_id = $1`,
      [result.invoice_id],
    );
    expect(challan).toEqual({
      freight_paid_by: 'buyer_to_pay',
      freight_amount: '200.00',
      transport_mode: 'transporter',
      lr_number: 'LR-7781',
      grand_total: '1770.00',
    });
  });

  it('freezes the billed customer details when the master record changes', async () => {
    const { rows } = await ctx.db.query<{ id: string }>(`
      insert into public.customers (name, gstin, state_code, address)
      values ('Sri Velan Industries', '33AAFCS9988K1ZI', '33', 'Old address, Tiruppur')
      returning id`);
    const customerId = rows[0]!.id;
    const result = await syncInvoice(ctx.db, ACTORS.staff, intraStatePayload(ctx.md, { customer_id: customerId }));

    await queryAs(ctx.db, ACTORS.staff, `update public.customers set name = 'Renamed Co', address = 'New address' where id = $1`, [
      customerId,
    ]);
    const [invoice] = await queryAs(
      ctx.db,
      ACTORS.staff,
      `select customer_snapshot ->> 'name' as name, customer_snapshot ->> 'address' as address
         from public.invoices where id = $1`,
      [result.invoice_id],
    );
    expect(invoice).toEqual({ name: 'Sri Velan Industries', address: 'Old address, Tiruppur' });
  });
});

describe('master data constraints', () => {
  const ctx = useDb();
  const insertCustomer = (gstin: string, stateCode: string, address: string | null = 'Coimbatore') =>
    queryAs(ctx.db, ACTORS.staff, `insert into public.customers (name, gstin, state_code, address) values ('X', $1, $2, $3)`, [
      gstin,
      stateCode,
      address,
    ]);

  it.each([
    ['a state code that disagrees with the GSTIN', '33ABCPV1357D1ZX', '29', 'Coimbatore'],
    ['a truncated GSTIN', '33ABCPV1357D1Z', '33', 'Coimbatore'],
    ['a one-character GSTIN typo', '33ABCPV1357D1ZY', '33', 'Coimbatore'],
    ['a transposed digit pair in the GSTIN', '33ABCPV1375D1ZX', '33', 'Coimbatore'],
    ['a registered buyer without an address (Rule 46)', '33ABCPV1357D1ZX', '33', null],
  ])('rejects %s', async (_label, gstin, stateCode, address) => {
    expect((await pgError(insertCustomer(gstin, stateCode, address))).code).toBe('23514');
  });

  it('accepts published sample GSTINs and rejects a duplicate', async () => {
    expect(await insertCustomer('27AAPFU0939F1ZV', '27')).toEqual([]);
    expect(await insertCustomer('33ABCPV1357D1ZX', '33')).toEqual([]);
    expect((await pgError(insertCustomer('33ABCPV1357D1ZX', '33'))).code).toBe('23505');
  });

  const insertItem = (sku: string, d: number, l: number, grade: string, weight: string, manual = false) =>
    queryAs(
      ctx.db,
      ACTORS.staff,
      `insert into public.stud_items (sku_code, diameter_mm, length_mm, thread_type, material_grade, hsn_sac, gst_rate_percent, unit_weight_kg, unit_weight_is_manual)
       values ($1, $2, $3, 'Metric Coarse', $4, '731815', 18, $5, $6)`,
      [sku, d, l, grade, weight, manual],
    );

  it('rejects non-normalised grades and SKU codes', async () => {
    expect((await pgError(insertItem('M10X100-EN8', 10, 100, 'en8', '0.061652'))).code).toBe('23514');
    expect((await pgError(insertItem('m10x100 en8', 10, 100, 'EN8', '0.061652'))).code).toBe('23514');
    expect(await insertItem('M10X100-SS304', 10, 100, 'SS 304', '0.061652')).toEqual([]);
  });

  it('holds a formula weight to its dimensions, and lets a weighed one differ', async () => {
    expect((await pgError(insertItem('M16X200-EN8', 16, 200, 'EN8', '0.133169'))).code).toBe('23514');
    const lengthen = queryAs(ctx.db, ACTORS.staff, 'update public.stud_items set length_mm = 300 where id = $1', [ctx.md.studItemId]);
    expect((await pgError(lengthen)).code).toBe('23514');

    expect(await insertItem('M3X10-SS304', 3, 10, 'SS 304', '0.000555')).toEqual([]);
    expect(await insertItem('M64X2000-EN8', 64, 2000, 'EN8', '50.505549')).toEqual([]);
    expect(await insertItem('M10X100-BRASS', 10, 100, 'BRASS', '0.066900', true)).toEqual([]); // denser than steel
  });
});

describe('row level security', () => {
  const ctx = useDb();
  let invoice: SyncResult;
  beforeAll(async () => {
    invoice = await syncInvoice(ctx.db, ACTORS.staff, intraStatePayload(ctx.md));
  });

  it('shows business data to active staff only', async () => {
    expect(await queryAs(ctx.db, ACTORS.staff, 'select id from public.customers')).toHaveLength(2);
    expect(await queryAs(ctx.db, ACTORS.owner, 'select id from public.invoices')).toHaveLength(1);
    for (const actor of [ACTORS.stranger, ACTORS.former]) {
      for (const table of PUBLIC_TABLES) {
        expect(await queryAs(ctx.db, actor, `select 1 from public.${table}`)).toEqual([]);
      }
    }
  });

  it('denies anon outright', async () => {
    for (const table of PUBLIC_TABLES) {
      expect((await pgError(queryAs(ctx.db, ACTORS.anon, `select 1 from public.${table}`))).code).toBe('42501');
    }
  });

  it('blocks writes from signed-up strangers, without revealing which GSTINs or SKUs exist', async () => {
    const inserts = [
      `insert into public.customers (name) values ('Intruder')`,
      `insert into public.customers (name, gstin, state_code, address) values ('X', '${GSTIN.tn}', '33', 'A')`,
      `insert into public.customers (name, gstin, state_code, address) values ('X', '${GSTIN.tn}', '33', 'A')
         on conflict (gstin) where gstin is not null do nothing returning id`,
      `insert into public.stud_items (sku_code, diameter_mm, length_mm, thread_type, material_grade, unit_weight_kg)
         values ('M12X150-EN8', 12, 150, 'MC', 'EN8', 0.133169)`,
    ];
    for (const sql of inserts) {
      const err = await pgError(queryAs(ctx.db, ACTORS.stranger, sql));
      expect(err.code).toBe('42501');
      expect(err.message).toMatch(/row-level security/);
    }
    const updated = await queryAs(
      ctx.db,
      ACTORS.stranger,
      `update public.invoices set payment_status = 'paid', amount_paid = 1770 returning id`,
    );
    expect(updated).toEqual([]);
  });

  it('creates invoices, lines and challans only through sync_invoice', async () => {
    const attempts = [
      `insert into public.invoices (invoice_no) values ('INV/26-27/9999')`,
      `insert into public.invoice_items (invoice_id) values ('${invoice.invoice_id}')`,
      `insert into public.deliveries (invoice_id) values ('${invoice.invoice_id}')`,
    ];
    for (const actor of [ACTORS.owner, ACTORS.service]) {
      for (const sql of attempts) {
        expect((await pgError(queryAs(ctx.db, actor, sql))).code).toBe('42501');
      }
    }
  });

  it('lets staff record a part payment, but only through record_payment', async () => {
    const direct = queryAs(
      ctx.db,
      ACTORS.staff,
      `update public.invoices set amount_paid = 1000, payment_status = 'partial' where id = $1`,
      [invoice.invoice_id],
    );
    expect((await pgError(direct)).code).toBe('23514');
    expect(await recordPayment(ctx.db, ACTORS.staff, invoice.invoice_id, '1000.00')).toMatchObject({
      payment_status: 'partial',
      amount_paid: '1000.00',
    });
  });

  it('reserves master-data deletion for the owner, and never for billed customers', async () => {
    const { rows } = await ctx.db.query<{ id: string }>(`insert into public.customers (name) values ('Spare') returning id`);
    const spareId = rows[0]!.id;
    const deleteSql = 'delete from public.customers where id = $1 returning id';
    expect(await queryAs(ctx.db, ACTORS.staff, deleteSql, [spareId])).toEqual([]);
    expect(await queryAs(ctx.db, ACTORS.owner, deleteSql, [spareId])).toHaveLength(1);
    // NO ACTION: foreign_key_violation on every Postgres version (RESTRICT says 23001 on PG 18).
    expect((await pgError(queryAs(ctx.db, ACTORS.owner, deleteSql, [ctx.md.tnCustomerId]))).code).toBe('23503');
    const billedItem = queryAs(ctx.db, ACTORS.owner, 'delete from public.stud_items where id = $1', [ctx.md.studItemId]);
    expect((await pgError(billedItem)).code).toBe('23503');
  });

  it('reserves alert rules and rate corrections for the owner', async () => {
    const insertRule = `insert into public.alert_rules (material_grade, threshold_rs_per_kg, telegram_chat_id)
                        values ('EN8', 5, '-1001234567890') returning id`;
    expect((await pgError(queryAs(ctx.db, ACTORS.staff, insertRule))).code).toBe('42501');
    expect(await queryAs(ctx.db, ACTORS.owner, insertRule)).toHaveLength(1);

    const [rate] = await queryAs<{ id: string }>(
      ctx.db,
      ACTORS.staff,
      `insert into public.metal_rates (material_grade, rate_per_kg) values ('EN19', 92.50) returning id`,
    );
    const correct = 'update public.metal_rates set rate_per_kg = 93 where id = $1 returning id';
    expect(await queryAs(ctx.db, ACTORS.staff, correct, [rate!.id])).toEqual([]);
    expect(await queryAs(ctx.db, ACTORS.owner, correct, [rate!.id])).toHaveLength(1);
  });

  it('applies the caller’s RLS through the latest_metal_rates view', async () => {
    expect((await queryAs(ctx.db, ACTORS.staff, 'select * from public.latest_metal_rates')).length).toBeGreaterThan(0);
    expect(await queryAs(ctx.db, ACTORS.stranger, 'select * from public.latest_metal_rates')).toEqual([]);
    expect((await pgError(queryAs(ctx.db, ACTORS.anon, 'select * from public.latest_metal_rates'))).code).toBe('42501');
  });
});

describe('triggers and generated columns', () => {
  const ctx = useDb();

  it('bumps updated_at on update', async () => {
    const [row] = await queryAs<{ bumped: boolean }>(
      ctx.db,
      ACTORS.staff,
      `update public.customers set phone = '9000000001' where id = $1 returning updated_at > created_at as bumped`,
      [ctx.md.tnCustomerId],
    );
    expect(row?.bumped).toBe(true);
  });

  it('stamps dispatch and delivery times as the challan moves', async () => {
    const result = await syncInvoice(ctx.db, ACTORS.staff, intraStatePayload(ctx.md));
    const move = (status: string) =>
      queryAs<{ dispatched: boolean; delivered: boolean; ordered: boolean | null }>(
        ctx.db,
        ACTORS.staff,
        `update public.deliveries set status = $2 where invoice_id = $1
         returning dispatched_at is not null as dispatched, delivered_at is not null as delivered,
                   delivered_at >= dispatched_at as ordered`,
        [result.invoice_id, status],
      );
    expect((await move('dispatched'))[0]).toEqual({ dispatched: true, delivered: false, ordered: null });
    expect((await move('delivered'))[0]).toEqual({ dispatched: true, delivered: true, ordered: true });
  });

  it('keeps the challan number, date and invoice link immutable', async () => {
    const result = await syncInvoice(ctx.db, ACTORS.staff, intraStatePayload(ctx.md));
    for (const change of [`dc_no = 'DC/26-27/9999', dc_seq = 9999`, `dc_date = date '2026-11-21'`]) {
      const err = await pgError(
        queryAs(ctx.db, ACTORS.owner, `update public.deliveries set ${change} where invoice_id = $1`, [result.invoice_id]),
      );
      expect(err.code).toBe('23514');
      expect(err.message).toMatch(/immutable/); // raised by the trigger, not a CHECK side effect
    }
  });

  it('refuses to flip a challan to buyer-paid freight once the invoice has billed delivery', async () => {
    const flip = (invoiceId: string) =>
      queryAs(ctx.db, ACTORS.staff, `update public.deliveries set freight_paid_by = 'buyer_to_pay' where invoice_id = $1 returning id`, [
        invoiceId,
      ]);
    const billed = await syncInvoice(
      ctx.db,
      ACTORS.staff,
      intraStatePayload(ctx.md, { delivery_charge: '200.00', cgst: '153.00', sgst: '153.00', grand_total: '2006.00' }),
    );
    expect((await pgError(flip(billed.invoice_id))).code).toBe('23514');
    const free = await syncInvoice(ctx.db, ACTORS.staff, intraStatePayload(ctx.md));
    expect(await flip(free.invoice_id)).toHaveLength(1);
  });

  it('maintains the job-work balance', async () => {
    const [lot] = await queryAs<{ id: string; balance: string }>(
      ctx.db,
      ACTORS.staff,
      `insert into public.job_work_ledger (customer_id, party_dc_no, party_dc_date, material_grade, inward_weight_kg)
       values ($1, 'PDC-118', '2026-11-02', 'EN8', 500.000)
       returning id, balance_weight_kg::text as balance`,
      [ctx.md.tnCustomerId],
    );
    expect(lot?.balance).toBe('500.000');

    const [after] = await queryAs<{ balance: string }>(
      ctx.db,
      ACTORS.staff,
      `update public.job_work_ledger set outward_weight_kg = 300.250, scrap_weight_kg = 12.500
        where id = $1 returning balance_weight_kg::text as balance`,
      [lot!.id],
    );
    expect(after?.balance).toBe('187.250');
  });
});

describe('issued-invoice guard', () => {
  const ctx = useDb();
  let id: string;
  beforeEach(async () => {
    id = (await syncInvoice(ctx.db, ACTORS.staff, intraStatePayload(ctx.md))).invoice_id;
  });
  const set = (change: string, actor: Actor = ACTORS.staff) =>
    queryAs<Record<string, unknown>>(ctx.db, actor, `update public.invoices set ${change} where id = $1 returning *`, [id]);

  // Catalog-driven: a column added later must be frozen, or listed here on purpose.
  it('rejects changes to billed amounts, party and numbering after sync', async () => {
    const editable = [
      'amount_paid',
      'payment_status',
      'pdf_drive_url',
      'drive_sync_pending',
      'drive_file_id',
      'dc_drive_url',
      'dc_drive_file_id',
      'last_reminder_stage',
      'last_reminder_sent_on',
      'cancelled_at',
      'cancellation_reason',
      'updated_at',
    ];
    const { rows } = await ctx.db.query<{ col: string; type: string }>(`
      select column_name as col, data_type as type from information_schema.columns
       where table_schema = 'public' and table_name = 'invoices' order by ordinal_position`);
    const other: Record<string, string> = {
      uuid: `'11111111-1111-4111-8111-111111111111'`, text: `'changed'`, integer: '77', date: `date '2026-11-01'`,
      jsonb: `'{"name":"Forged"}'`, numeric: '0.01', 'USER-DEFINED': `'job_work'`,
      'timestamp with time zone': `'2020-01-01'`,
    };
    const frozen = rows.filter((r) => !editable.includes(r.col));
    expect(frozen.length).toBe(rows.length - editable.length);
    for (const { col, type } of frozen) {
      for (const actor of [ACTORS.staff, ACTORS.owner, ACTORS.sqlEditor]) {
        const err = await pgError(set(`${col} = ${type === 'boolean' ? `not ${col}` : other[type]}`, actor));
        expect(err, `${actor.role}: ${col}`).toMatchObject({ code: '23514', message: expect.stringMatching(/is issued and cannot be edited/) });
      }
    }
    // A consistent re-pricing satisfies every CHECK; only the guard stops it.
    const repriced = set(`subtotal = 100, cgst = 9, sgst = 9, grand_total = 118`, ACTORS.owner);
    expect((await pgError(repriced)).message).toMatch(/cannot be edited/);
  });

  it('still allows payment tracking, the archive URL and cancellation', async () => {
    const paid = await recordPayment(ctx.db, ACTORS.staff, id, '1000.00');
    const whilePaid = set(`cancelled_at = now(), cancellation_reason = 'Order cancelled'`);
    expect((await pgError(whilePaid)).message).toMatch(/void them before cancelling/);
    await queryAs(ctx.db, ACTORS.owner, `select public.void_payment($1, 'Bill cancelled')`, [paid.payment_id]);
    expect(await set(`pdf_drive_url = 'https://drive.google.com/file/d/1Abc/view'`)).toHaveLength(1);
    expect(await set(`cancelled_at = '2020-01-01', cancellation_reason = 'Order cancelled'`)).toHaveLength(1);
    const { rows } = await ctx.db.query(`select cancelled_at > now() - interval '1 hour' as server_dated from public.invoices where id = $1`, [id]);
    expect(rows).toEqual([{ server_dated: true }]);
  });

  it('makes cancellation one-way', async () => {
    await set(`cancelled_at = now(), cancellation_reason = 'Order cancelled'`);
    for (const change of [
      'cancelled_at = null, cancellation_reason = null',
      `cancellation_reason = 'Another reason'`,
      `cancelled_at = '2020-01-01'`,
    ]) {
      expect(await pgError(set(change, ACTORS.owner))).toMatchObject({ code: '23514', message: expect.stringMatching(/already cancelled/) });
    }
  });
});
