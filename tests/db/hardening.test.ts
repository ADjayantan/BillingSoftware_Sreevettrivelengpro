// Regression tests distilled from the adversarial review of 001: each one failed on the first
// draft of the migration.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import {
  ACTORS,
  USERS,
  createTestDb,
  goodsLine,
  interStatePayload,
  intraStatePayload,
  outcome,
  pgError,
  plannedCount,
  queryAs,
  recordPayment,
  seedMasterData,
  syncInvoice,
  type Line,
  type MasterData,
  type Payload,
} from './harness';

function useDb() {
  const ctx = {} as { db: PGlite; md: MasterData };
  beforeAll(async () => {
    ctx.db = await createTestDb();
    ctx.md = await seedMasterData(ctx.db);
  });
  afterAll(async () => {
    await ctx.db?.close();
  });
  return ctx;
}

const DRIVE_URL = 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456/view';

describe('NaN never enters a numeric column', () => {
  const ctx = useDb();

  // Catalog-driven on purpose: a numeric column added later without an upper bound fails here.
  it('is refused by every stored numeric column in public', async () => {
    const [lot] = await queryAs<{ id: string }>(
      ctx.db,
      ACTORS.staff,
      `insert into public.job_work_ledger (customer_id, party_dc_no, party_dc_date, material_grade, inward_weight_kg)
       values ($1, 'PDC-1', '2026-11-02', 'EN8', 100) returning id`,
      [ctx.md.tnCustomerId],
    );
    const bill = await syncInvoice(
      ctx.db,
      ACTORS.staff,
      intraStatePayload(ctx.md, {
        bill_type: 'job_work',
        job_work_returns: [{ lot_id: lot!.id, returned_weight_kg: '10', scrap_weight_kg: '1', declared_value: '500.00' }],
      }),
    );
    await recordPayment(ctx.db, ACTORS.staff, bill.invoice_id, '100.00');
    await queryAs(ctx.db, ACTORS.staff, `insert into public.metal_rates (material_grade, rate_per_kg) values ('EN8', 85)`);
    await queryAs(
      ctx.db,
      ACTORS.owner,
      `insert into public.alert_rules (material_grade, threshold_rs_per_kg, telegram_chat_id) values ('EN8', 5, '1')`,
    );
    await queryAs(
      ctx.db,
      ACTORS.staff,
      `insert into public.quotes (customer_id, quote_date, valid_until, place_of_supply, customer_snapshot, lines, charges_gst_rate, subtotal, cgst, sgst, grand_total)
       values ($1, '2026-11-20', '2026-11-30', '33', '{"name":"Murugan"}'::jsonb, '[{"description":"M16 Stud"}]'::jsonb, 18, 1000, 90, 90, 1180)`,
      [ctx.md.tnCustomerId],
    );
    await queryAs(
      ctx.db,
      ACTORS.staff,
      `insert into public.expenses (expense_date, category, description, weight_kg, taxable_amount, gst_amount, total_amount)
       values ('2026-11-20', 'raw_material', 'EN8 16mm rod', 100, 7500, 1350, 8850)`,
    );

    const { rows: columns } = await ctx.db.query<{ tbl: string; col: string }>(`
      select c.table_name as tbl, c.column_name as col
        from information_schema.columns c join information_schema.tables t using (table_schema, table_name)
       where c.table_schema = 'public' and t.table_type = 'BASE TABLE'
         and c.data_type = 'numeric' and c.is_generated = 'NEVER'
       order by 1, 2`);
    expect(columns.length).toBeGreaterThan(25);

    const accepted: string[] = [];
    for (const { tbl, col } of columns) {
      // Permanence and derived-value triggers would mask the CHECK under test, so switch
      // triggers off and write as the superuser: only the constraints are left to object.
      const result = await outcome(
        ctx.db.transaction(async (tx) => {
          await tx.exec(`set local session_replication_role = replica`);
          await tx.query(`update public.${tbl} set ${col} = 'NaN'`);
        }),
      );
      if (!result.startsWith('rejected 23514')) accepted.push(`${tbl}.${col}: ${result}`);
    }
    expect(accepted).toEqual([]);
  });

  it.each<[string, (md: MasterData) => Payload]>([
    ['an all-NaN bill', (md) => ({ subtotal: 'NaN', cgst: 'NaN', sgst: 'NaN', grand_total: 'NaN',
      items: [goodsLine(md, { unit_rate: 'NaN', line_total: 'NaN' })] })],
    ['NaN tax and total on a real line', () => ({ cgst: 'NaN', sgst: 'NaN', grand_total: 'NaN' })],
    ['NaN line total', (md) => ({ subtotal: 'NaN', grand_total: 'NaN', items: [goodsLine(md, { line_total: 'NaN' })] })],
    ['NaN freight', () => ({ delivery: { freight_amount: 'NaN' } })],
  ])('cannot get a GST number through sync_invoice: %s', async (_label, build) => {
    const { rows: before } = await ctx.db.query('select series, last_value from private.document_sequences order by 1');
    const err = await pgError(syncInvoice(ctx.db, ACTORS.staff, intraStatePayload(ctx.md, build(ctx.md))));
    expect(['22023', '23514']).toContain(err.code);
    const { rows: after } = await ctx.db.query('select series, last_value from private.document_sequences order by 1');
    expect(after).toEqual(before);
  });
});

describe('figures billing-math.ts could never produce are refused, even on a direct /rpc call', () => {
  const ctx = useDb();
  const reject = async (payload: Payload) => (await pgError(syncInvoice(ctx.db, ACTORS.staff, payload))).code;

  it.each<[string, (md: MasterData) => Payload]>([
    ['no GST on an 18% line', (md) => intraStatePayload(md, { cgst: '0.00', sgst: '0.00', grand_total: '1500.00' })],
    ['5% GST on an 18% line', (md) => intraStatePayload(md, { cgst: '37.50', sgst: '37.50', grand_total: '1575.00' })],
    ['GST on a nil-rated line', (md) => intraStatePayload(md, { items: [goodsLine(md, { tax_rate_percent: '0.00' })] })],
    ['no IGST on an inter-state 18% line', (md) => interStatePayload(md, { igst: '0.00', grand_total: '1500.00' })],
    ['taxable packing left out of the GST', (md) => intraStatePayload(md, { packing_charge: '100.00', grand_total: '1870.00' })],
    ['1000 x 1.50 billed as 1.00', (md) => intraStatePayload(md, { subtotal: '1.00', cgst: '0.09', sgst: '0.09',
      round_off: '-0.18', grand_total: '1.00', items: [goodsLine(md, { line_total: '1.00' })] })],
    ['1000 x 1.50 billed as 2000.00', (md) => intraStatePayload(md, { subtotal: '2000.00', cgst: '180.00', sgst: '180.00',
      grand_total: '2360.00', items: [goodsLine(md, { line_total: '2000.00' })] })],
    ['a line one paisa over qty x rate', (md) => intraStatePayload(md, { subtotal: '1500.01', cgst: '135.00', sgst: '135.00',
      grand_total: '1770.01', items: [goodsLine(md, { line_total: '1500.01' })] })],
  ])('%s', async (_label, build) => {
    expect(await reject(build(ctx.md))).toBe('23514');
  });

  it('needs an address to bill Rs 50,000 or more to an unregistered buyer (Rule 46(e))', async () => {
    const { rows } = await ctx.db.query<{ id: string }>(`insert into public.customers (name) values ('Walk-in') returning id`);
    const walkIn = rows[0]!.id;
    const big = intraStatePayload(ctx.md, {
      customer_id: walkIn, subtotal: '60000.00', cgst: '5400.00', sgst: '5400.00', grand_total: '70800.00',
      items: [goodsLine(ctx.md, { qty_pieces: 40000, total_weight_kg: '5326.760', line_total: '60000.00' })],
    });
    expect(await reject(big)).toBe('22023');
    expect(await outcome(syncInvoice(ctx.db, ACTORS.staff, intraStatePayload(ctx.md, { customer_id: walkIn })))).toMatch(/^accepted/);
  });
});

describe('an edited bill is never swallowed as a replay', () => {
  const ctx = useDb();

  it('refuses a re-send with different content and names the issued invoice', async () => {
    const draft = intraStatePayload(ctx.md);
    const issued = await syncInvoice(ctx.db, ACTORS.staff, draft);
    const edits: Payload[] = [
      { ...draft, notes: 'urgent' },
      { ...draft, invoice_date: '2026-11-19' },
      { ...draft, subtotal: '3000.00', cgst: '270.00', sgst: '270.00', grand_total: '3540.00',
        items: [goodsLine(ctx.md, { qty_pieces: 2000, total_weight_kg: '266.338', line_total: '3000.00' })] },
    ];
    for (const edited of edits) {
      const err = await pgError(syncInvoice(ctx.db, ACTORS.staff, edited));
      expect(err.code).toBe('23505'); // PostgREST: HTTP 409
      expect(err.message).toContain(issued.invoice_no);
    }
  });

  it('still replays the same bill when its JSON keys arrive in another order', async () => {
    const draft = intraStatePayload(ctx.md);
    const issued = await syncInvoice(ctx.db, ACTORS.staff, draft);
    const reordered = Object.fromEntries(Object.entries(draft).reverse());
    expect(await syncInvoice(ctx.db, ACTORS.owner, reordered)).toEqual({ ...issued, replayed: true });
  });

  it('runs only under READ COMMITTED, which the replay check depends on', async () => {
    const { rows } = await ctx.db.query<{ cfg: string[] }>(
      `select proconfig as cfg from pg_proc where oid = 'public.sync_invoice(jsonb)'::regprocedure`,
    );
    expect(rows[0]?.cfg).toContain('default_transaction_isolation=read committed');

    for (const level of ['repeatable read', 'serializable']) {
      await ctx.db.exec(`begin isolation level ${level}`);
      try {
        await ctx.db.query(`select set_config('request.jwt.claims', $1, true)`, [
          JSON.stringify({ role: 'authenticated', sub: USERS.staff.id }),
        ]);
        await ctx.db.exec('set local role authenticated');
        const call = ctx.db.query('select * from public.sync_invoice($1::jsonb)', [JSON.stringify(intraStatePayload(ctx.md))]);
        expect(await pgError(call)).toMatchObject({ code: '25001', message: expect.stringMatching(/read committed/) });
      } finally {
        await ctx.db.exec('rollback');
      }
    }
  });
});

describe('GST records are permanent', () => {
  const ctx = useDb();

  it('nobody can delete, truncate or rewrite an issued document — not even the SQL editor', async () => {
    const payload = intraStatePayload(ctx.md);
    const issued = await syncInvoice(ctx.db, ACTORS.staff, payload);
    const attempts = [
      'delete from public.invoices',
      'delete from public.deliveries',
      'delete from public.invoice_items',
      'update public.invoice_items set line_total = 1',
      'truncate public.invoices cascade',
      'truncate public.deliveries cascade',
      'truncate public.invoice_items',
    ];
    for (const actor of [ACTORS.staff, ACTORS.owner, ACTORS.service, ACTORS.sqlEditor]) {
      for (const sql of attempts) {
        expect((await pgError(queryAs(ctx.db, actor, sql))).code, `${actor.role}: ${sql}`).toBe('42501');
      }
    }
    expect(await syncInvoice(ctx.db, ACTORS.staff, payload)).toEqual({ ...issued, replayed: true });
  });

  it('logs every edit and deletion with who did it (CGST Rule 56(8)), append-only', async () => {
    const bill = await syncInvoice(ctx.db, ACTORS.staff, intraStatePayload(ctx.md));
    const wrong = await recordPayment(ctx.db, ACTORS.staff, bill.invoice_id, '1234.56');
    await queryAs(ctx.db, ACTORS.owner, `select public.void_payment($1, 'Typed the wrong amount')`, [wrong.payment_id]);
    await recordPayment(ctx.db, ACTORS.staff, bill.invoice_id, '1000.00'); // the first entry stays on record

    const log = await queryAs(
      ctx.db,
      ACTORS.sqlEditor,
      `select actor_id::text, actor_role, action, old_row ->> 'amount_paid' as was, new_row ->> 'amount_paid' as now
         from private.audit_log where table_name = 'public.invoices' and row_id = $1 order by id`,
      [bill.invoice_id],
    );
    expect(log).toEqual([
      { actor_id: USERS.staff.id, actor_role: 'authenticated', action: 'UPDATE', was: '0.00', now: '1234.56' },
      { actor_id: USERS.owner.id, actor_role: 'authenticated', action: 'UPDATE', was: '1234.56', now: '0.00' },
      { actor_id: USERS.staff.id, actor_role: 'authenticated', action: 'UPDATE', was: '0.00', now: '1000.00' },
    ]);
    const receipts = await queryAs(
      ctx.db,
      ACTORS.staff,
      'select amount::text, void_reason from public.payments where invoice_id = $1 order by created_at',
      [bill.invoice_id],
    );
    expect(receipts).toEqual([
      { amount: '1234.56', void_reason: 'Typed the wrong amount' },
      { amount: '1000.00', void_reason: null },
    ]);

    const { rows } = await ctx.db.query<{ id: string }>(`insert into public.customers (name) values ('Spare') returning id`);
    await queryAs(ctx.db, ACTORS.owner, 'delete from public.customers where id = $1', [rows[0]!.id]);
    const deleted = await queryAs(ctx.db, ACTORS.sqlEditor, `select action, old_row ->> 'name' as name from private.audit_log where row_id = $1`, [
      rows[0]!.id,
    ]);
    expect(deleted).toEqual([{ action: 'DELETE', name: 'Spare' }]);

    for (const sql of ['delete from private.audit_log', `update private.audit_log set actor_role = 'x'`, 'truncate private.audit_log']) {
      expect((await pgError(queryAs(ctx.db, ACTORS.sqlEditor, sql))).code).toBe('42501');
    }
  });

  it('covers every register and the access list with the edit log', async () => {
    const { rows } = await ctx.db.query<{ tbl: string }>(`
      select n.nspname || '.' || c.relname as tbl
        from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
       where t.tgfoid = 'private.log_change()'::regprocedure order by 1`);
    expect(rows.map((r) => r.tbl)).toEqual([
      'private.app_users',
      'public.company_profile',
      'public.customers',
      'public.deliveries',
      'public.expenses',
      'public.invoice_items',
      'public.invoices',
      'public.job_work_ledger',
      'public.job_work_returns',
      'public.metal_rates',
      'public.payments',
      'public.quotes',
      'public.stud_items',
      'public.suppliers',
    ]);
  });

  it('stamps who and when itself: clients cannot forge created_by or created_at', async () => {
    const [lot] = await queryAs<{ id: string; by: string; forged: boolean }>(
      ctx.db,
      ACTORS.staff,
      `insert into public.job_work_ledger (customer_id, party_dc_no, party_dc_date, material_grade, inward_weight_kg, created_by, created_at)
       values ($1, 'PDC-9', '2026-11-01', 'EN8', 250, $2, '2020-01-01')
       returning id, created_by::text as by, created_at < '2021-01-01' as forged`,
      [ctx.md.tnCustomerId, USERS.owner.id],
    );
    expect(lot).toMatchObject({ by: USERS.staff.id, forged: false });

    const [after] = await queryAs(
      ctx.db,
      ACTORS.staff,
      `update public.job_work_ledger set created_by = $2, created_at = '2019-01-01' where id = $1
       returning created_by::text as by, created_at < '2021-01-01' as forged`,
      [lot!.id, USERS.owner.id],
    );
    expect(after).toEqual({ by: USERS.staff.id, forged: false });
  });

  it('accepts only company Drive links as archive and proof-of-delivery URLs', async () => {
    const bill = await syncInvoice(ctx.db, ACTORS.staff, intraStatePayload(ctx.md));
    for (const [table, column, key] of [
      ['invoices', 'pdf_drive_url', 'id'],
      ['deliveries', 'proof_drive_url', 'invoice_id'],
    ]) {
      const set = (url: string) =>
        queryAs(ctx.db, ACTORS.staff, `update public.${table} set ${column} = $2 where ${key} = $1 returning id`, [bill.invoice_id, url]);
      for (const bad of ['https://evil.example/INV.pdf', 'https://drive.google.com.evil.example/x', `${DRIVE_URL}${'a'.repeat(500)}`]) {
        expect((await pgError(set(bad))).code).toBe('23514');
      }
      expect(await set(DRIVE_URL)).toHaveLength(1);
    }
  });

  it('keeps payment status consistent with what was received', async () => {
    const bill = await syncInvoice(ctx.db, ACTORS.staff, intraStatePayload(ctx.md));
    const set = (amount: string, status: string) =>
      outcome(queryAs(ctx.db, ACTORS.sqlEditor, `update public.invoices set amount_paid = $2, payment_status = $3 where id = $1`, [bill.invoice_id, amount, status]));
    expect(await set('5000.00', 'partial')).toMatch(/^rejected 23514/);
    expect(await set('100.00', 'unpaid')).toMatch(/^rejected 23514/);
    expect(await set('1740.00', 'paid')).toMatch(/^accepted/); // 2% TDS deducted by the buyer
  });
});

describe('the cron / admin key (service_role) works on every Supabase project, with least privilege', () => {
  const dbs = {} as Record<'none' | 'legacy-grant-all', PGlite>;
  beforeAll(async () => {
    for (const platformGrants of ['none', 'legacy-grant-all'] as const) {
      dbs[platformGrants] = await createTestDb({ platformGrants });
    }
  });
  afterAll(async () => {
    await Promise.all(Object.values(dbs).map((db) => db.close()));
  });

  const matrix = async (db: PGlite) =>
    (
      await db.query(`
        select r.role, c.relname, p.priv
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
         cross join unnest(array['anon', 'authenticated', 'service_role']) as r(role)
         cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) as p(priv)
         where n.nspname = 'public' and c.relkind in ('r', 'v') and has_table_privilege(r.role, c.oid, p.priv)
         order by 1, 2, 3`)
    ).rows;

  it('gets the same privileges whatever the platform default is (Supabase #45329)', async () => {
    expect(await matrix(dbs.none)).toEqual(await matrix(dbs['legacy-grant-all']));
  });

  it.each(['none', 'legacy-grant-all'] as const)('can do its jobs and nothing else (platform default: %s)', async (platformGrants) => {
    const db = dbs[platformGrants];
    const md = await seedMasterData(db);
    const bill = await syncInvoice(db, ACTORS.staff, intraStatePayload(md));
    const run = (sql: string, params: unknown[] = []) => outcome(queryAs(db, ACTORS.service, sql, params));

    for (const table of ['customers', 'stud_items', 'metal_rates', 'invoices', 'invoice_items', 'deliveries', 'job_work_ledger', 'job_work_returns', 'payments', 'company_profile', 'alert_rules', 'latest_metal_rates']) {
      expect(await run(`select * from public.${table}`), table).toMatch(/^accepted/);
    }
    expect(await run(`insert into public.metal_rates (material_grade, rate_per_kg, source) values ('EN8', 86.25, 'cron')`)).toMatch(/^accepted/);
    expect(await run('update public.invoices set pdf_drive_url = $2 where id = $1', [bill.invoice_id, DRIVE_URL])).toMatch(/^accepted/);
    expect(await run('update public.deliveries set proof_drive_url = $2 where invoice_id = $1', [bill.invoice_id, DRIVE_URL])).toMatch(/^accepted/);

    for (const sql of [
      `update public.invoices set grand_total = 1`,
      `update public.invoices set amount_paid = 1770, payment_status = 'paid'`,
      `update public.deliveries set status = 'delivered'`,
      `update public.customers set name = 'x'`,
      `update public.metal_rates set rate_per_kg = 1`,
      'delete from public.metal_rates',
      'delete from public.customers',
      'update private.document_sequences set last_value = 0',
    ]) {
      expect(await run(sql), sql).toMatch(/^rejected 42501/);
    }
  });
});

describe('outsiders learn nothing, not even row counts', () => {
  const ctx = useDb();

  it('refuses planner estimates (Prefer: count=planned) to anyone not on the access list', async () => {
    await ctx.db.exec(`insert into public.customers (name) select 'Party ' || g from generate_series(1, 40) as g; analyze`);
    const queries = [
      'select 1 from public.customers',
      `select 1 from public.customers where state_code <> '33'`,
      'select 1 from public.invoices where invoice_seq > 20',
      'select 1 from public.latest_metal_rates',
    ];
    for (const query of queries) {
      for (const actor of [ACTORS.stranger, ACTORS.former, ACTORS.anon]) {
        expect(await plannedCount(ctx.db, actor, query)).toBe('refused 42501');
      }
      for (const actor of [ACTORS.staff, ACTORS.owner, ACTORS.service]) {
        expect(await plannedCount(ctx.db, actor, query)).toBeTypeOf('number');
      }
    }
  });
});

describe('metal-rate history stays true, whoever writes it', () => {
  const ctx = useDb();
  const add = (grade: string, day: string, rate: string, actor: (typeof ACTORS)[keyof typeof ACTORS] = ACTORS.staff) =>
    queryAs<{ previous: string | null; delta: string | null }>(
      ctx.db,
      actor,
      `insert into public.metal_rates (material_grade, rate_per_kg, recorded_at) values ($1, $2, $3)
       returning previous_rate_per_kg::text as previous, change_delta::text as delta`,
      [grade, rate, `${day}T04:30:00Z`],
    );
  const history = async (grade: string) =>
    (
      await queryAs<{ day: string; rate: string; previous: string | null; delta: string | null }>(
        ctx.db,
        ACTORS.staff,
        `select to_char(recorded_at at time zone 'UTC', 'DD') as day, trim_scale(rate_per_kg)::text as rate,
                trim_scale(previous_rate_per_kg)::text as previous, trim_scale(change_delta)::text as delta
           from public.metal_rates where material_grade = $1 order by recorded_at`,
        [grade],
      )
    ).map((r) => [r.day, r.rate, r.previous, r.delta]);

  it('derives the previous rate and change per grade, also within one multi-row insert', async () => {
    await queryAs(
      ctx.db,
      ACTORS.owner,
      `insert into public.metal_rates (material_grade, rate_per_kg, recorded_at) values
         ('EN8', 88.50, '2026-11-21T04:30:00Z'), ('EN8', 85.00, '2026-11-20T04:30:00Z'), ('SS 304', 210.00, '2026-11-20T04:30:00Z')`,
    );
    expect(await history('EN8')).toEqual([
      ['20', '85', null, null],
      ['21', '88.5', '85', '3.5'],
    ]);
    expect(await history('SS 304')).toEqual([['20', '210', null, null]]);
  });

  it('re-links the neighbours after a back-fill, an owner correction and a deletion', async () => {
    await add('EN19', '2026-11-20', '85');
    await add('EN19', '2026-11-22', '90');
    await add('EN19', '2026-11-21', '88'); // staff back-fill: the cron was down that day
    expect(await history('EN19')).toEqual([['20', '85', null, null], ['21', '88', '85', '3'], ['22', '90', '88', '2']]);

    await queryAs(ctx.db, ACTORS.owner, `update public.metal_rates set rate_per_kg = 80 where material_grade = 'EN19' and rate_per_kg = 85`);
    expect(await history('EN19')).toEqual([['20', '80', null, null], ['21', '88', '80', '8'], ['22', '90', '88', '2']]);

    await queryAs(ctx.db, ACTORS.owner, `delete from public.metal_rates where material_grade = 'EN19' and rate_per_kg = 88`);
    expect(await history('EN19')).toEqual([['20', '80', null, null], ['22', '90', '80', '10']]);
  });

  it('ignores a typed previous rate (no fake spike alert) and refuses future readings', async () => {
    await add('BRASS', '2026-11-20', '610');
    const [row] = await queryAs(
      ctx.db,
      ACTORS.staff,
      `insert into public.metal_rates (material_grade, rate_per_kg, previous_rate_per_kg, recorded_at)
       values ('BRASS', 612, 1, '2026-11-21T04:30:00Z')
       returning trim_scale(previous_rate_per_kg)::text as previous, trim_scale(change_delta)::text as delta`,
    );
    expect(row).toEqual({ previous: '610', delta: '2' });
    const future = queryAs(ctx.db, ACTORS.staff, `insert into public.metal_rates (material_grade, rate_per_kg, recorded_at) values ('BRASS', 40, '2099-01-01')`);
    expect((await pgError(future)).code).toBe('22023');
  });

  it('stores a per-tonne quote exactly (Rs 52,355/t = Rs 52.355/kg)', async () => {
    await add('MS', '2026-11-20', '52.355');
    expect(await history('MS')).toEqual([['20', '52.355', null, null]]);
  });
});

describe('Sprint 2 decisions approved by the owner', () => {
  const ctx = useDb();
  const sync = (payload: Payload) => outcome(syncInvoice(ctx.db, ACTORS.staff, payload));

  const openLot = async (partyDcNo: string, kg = '500.000', customerId = ctx.md.tnCustomerId): Promise<string> =>
    (
      await queryAs<{ id: string }>(
        ctx.db,
        ACTORS.staff,
        `insert into public.job_work_ledger (customer_id, party_dc_no, party_dc_date, material_grade, inward_weight_kg)
         values ($1, $2, '2026-11-02', 'EN8', $3) returning id`,
        [customerId, partyDcNo, kg],
      )
    )[0]!.id;
  const lotState = async (id: string) =>
    (
      await queryAs<{ outward: string; scrap: string; balance: string; status: string }>(
        ctx.db,
        ACTORS.staff,
        `select outward_weight_kg::text as outward, scrap_weight_kg::text as scrap, balance_weight_kg::text as balance, status
           from public.job_work_ledger where id = $1`,
        [id],
      )
    )[0];
  const jobWork = (returns: Payload[], overrides: Payload = {}) =>
    intraStatePayload(ctx.md, { bill_type: 'job_work', job_work_returns: returns, ...overrides });

  it('SEZ / export supplies: IGST for a Tamil Nadu SEZ unit (IGST Act s.7(5)(b))', async () => {
    const { rows } = await ctx.db.query<{ id: string }>(`
      insert into public.customers (name, gstin, state_code, address, is_sez)
      values ('Precision Auto (SEZ Unit)', '33AAKCP4321K1ZF', '33', 'Mahindra World City SEZ, Chengalpattu', true) returning id`);
    const sez = { customer_id: rows[0]!.id, due_date: '2026-12-31' };
    expect(await sync(intraStatePayload(ctx.md, { ...sez, cgst: '0.00', sgst: '0.00', igst: '270.00' }))).toMatch(/^accepted/);
    expect(await sync(intraStatePayload(ctx.md, sez))).toMatch(/^rejected 23514/); // CGST + SGST
    expect(await sync(intraStatePayload(ctx.md, { cgst: '0.00', sgst: '0.00', igst: '270.00' }))).toMatch(/^rejected 23514/); // ordinary TN
    const [bill] = await queryAs(
      ctx.db,
      ACTORS.staff,
      'select place_of_supply, is_sez, igst::text from public.invoices where customer_id = $1',
      [sez.customer_id],
    );
    expect(bill).toEqual({ place_of_supply: '33', is_sez: true, igst: '270.00' });

    // A later change of status must not re-tax an issued bill.
    await queryAs(ctx.db, ACTORS.staff, 'update public.customers set is_sez = false where id = $1', [sez.customer_id]);
    const [same] = await queryAs(ctx.db, ACTORS.staff, 'select is_sez from public.invoices where customer_id = $1', [sez.customer_id]);
    expect(same).toEqual({ is_sez: true });
  });

  it('packing charged outside the taxable value (CGST s.15(2)(c) vs the brief)', async () => {
    const untaxedPacking = { packing_charge: '100.00', delivery_taxable: false, grand_total: '1870.00' };
    expect(await sync(intraStatePayload(ctx.md, untaxedPacking))).toMatch(/^rejected 23514/);
    const taxedPacking = { packing_charge: '100.00', delivery_taxable: false, cgst: '144.00', sgst: '144.00', grand_total: '1888.00' };
    expect(await sync(intraStatePayload(ctx.md, taxedPacking))).toMatch(/^accepted/);
    const untaxedDelivery = { delivery_charge: '200.00', delivery_taxable: false, grand_total: '1970.00' };
    expect(await sync(intraStatePayload(ctx.md, untaxedDelivery))).toMatch(/^accepted/);
  });

  it('supplier name, GSTIN and address frozen on each invoice (Rule 46(a))', async () => {
    const bill = await syncInvoice(ctx.db, ACTORS.staff, intraStatePayload(ctx.md));
    const change = `update public.company_profile set legal_name = 'Renamed Works', address = 'New address' returning id`;
    expect(await queryAs(ctx.db, ACTORS.staff, change)).toEqual([]); // owner only
    expect(await queryAs(ctx.db, ACTORS.owner, change)).toHaveLength(1);
    const snapshot = async (id: string) =>
      (await queryAs(ctx.db, ACTORS.staff, 'select supplier_snapshot as s from public.invoices where id = $1', [id]))[0]!.s;
    expect(await snapshot(bill.invoice_id)).toMatchObject({
      legal_name: 'Demo Stud Works', gstin: '33AAECS2468R1ZS', address: '1 Test Road, Coimbatore 641001', bank_ifsc: 'DEMO0000001',
    });
    const next = await syncInvoice(ctx.db, ACTORS.staff, intraStatePayload(ctx.md));
    expect(await snapshot(next.invoice_id)).toMatchObject({ legal_name: 'Renamed Works' });

    const second = `insert into public.company_profile (legal_name, gstin, address) values ('Two', '33ABCPV1357D1ZX', 'X')`;
    expect((await pgError(queryAs(ctx.db, ACTORS.owner, second))).code).toBe('23505');
    const fresh = await createTestDb();
    try {
      await fresh.exec(`insert into public.customers (id, name) values ('11111111-1111-4111-8111-111111111111', 'C')`);
      const payload = intraStatePayload(ctx.md, { customer_id: '11111111-1111-4111-8111-111111111111', items: [goodsLine(ctx.md, { stud_item_id: null })] });
      const err = await pgError(syncInvoice(fresh, ACTORS.staff, payload));
      expect(err).toMatchObject({ code: '55000', message: expect.stringMatching(/company profile/) });
    } finally {
      await fresh.close();
    }
  });

  it('GST stored per line, for rate-wise printing and GSTR-1', async () => {
    const items = [
      goodsLine(ctx.md),
      goodsLine(ctx.md, { line_no: 2, qty_pieces: 200, unit_rate: '5', line_total: '1000.00', tax_rate_percent: '5.00' }),
    ];
    const mixed = intraStatePayload(ctx.md, { subtotal: '2500.00', cgst: '160.00', sgst: '160.00', grand_total: '2820.00', items });
    const bill = await syncInvoice(ctx.db, ACTORS.staff, mixed);
    const byRate = await queryAs(
      ctx.db,
      ACTORS.staff,
      `select tax_rate_percent::text as rate, sum(line_total)::text as taxable, sum(cgst_amount)::text as cgst, sum(sgst_amount)::text as sgst
         from public.invoice_items where invoice_id = $1 group by tax_rate_percent order by tax_rate_percent`,
      [bill.invoice_id],
    );
    expect(byRate).toEqual([
      { rate: '5.00', taxable: '1000.00', cgst: '25.00', sgst: '25.00' },
      { rate: '18.00', taxable: '1500.00', cgst: '135.00', sgst: '135.00' },
    ]);

    const forge = (first: Line, second: Line) =>
      sync({ ...intraStatePayload(ctx.md, { subtotal: '2500.00', cgst: '160.00', sgst: '160.00', grand_total: '2820.00', items }),
        items: [{ ...items[0], igst_amount: '0.00', ...first }, { ...items[1], igst_amount: '0.00', ...second }] });
    const pair = (amount: string) => ({ cgst_amount: amount, sgst_amount: amount });
    expect(await forge(pair('135.00'), pair('25.00'))).toMatch(/^accepted/);
    expect(await forge(pair('135.00'), pair('24.00'))).toMatch(/^rejected 23514.*does not add up/); // lost a rupee
    expect(await forge(pair('25.00'), pair('135.00'))).toMatch(/^rejected 23514.*does not match its rate/); // swapped
    expect(await forge({ cgst_amount: '136.00', sgst_amount: '134.00' }, { cgst_amount: '24.00', sgst_amount: '26.00' })).toMatch(/^rejected 23514/);
    expect(await forge({}, pair('25.00'))).toMatch(/^rejected 22023/); // missing
  });

  it('job-work bills linked to the party-DC lots they return (ITC-04), with a closing rule', async () => {
    const lot = await openLot('PDC-2201');
    const part = jobWork([{ lot_id: lot, returned_weight_kg: '300.250', scrap_weight_kg: '12.500', pieces: 2400, goods_hsn: '731815' }]);
    const bill = await syncInvoice(ctx.db, ACTORS.staff, part);
    expect(await lotState(lot)).toEqual({ outward: '300.250', scrap: '12.500', balance: '187.250', status: 'open' });
    // Challan-wise trail: the DC, the lot and the balance as issued.
    const trail = await queryAs(
      ctx.db,
      ACTORS.staff,
      `select d.dc_no, r.party_dc_no, r.party_dc_date::text as dated, r.returned_weight_kg::text as kg, r.balance_after_kg::text as balance, r.pieces
         from public.job_work_returns r join public.deliveries d on d.id = r.delivery_id where r.ledger_id = $1`,
      [lot],
    );
    expect(trail).toEqual([{ dc_no: bill.dc_no, party_dc_no: 'PDC-2201', dated: '2026-11-02', kg: '300.250', balance: '187.250', pieces: 2400 }]);
    // A retry must not move the weight twice.
    expect((await syncInvoice(ctx.db, ACTORS.staff, part)).replayed).toBe(true);
    expect((await lotState(lot))?.outward).toBe('300.250');

    // Issued returns cannot be rewound, nor the lot re-labelled.
    for (const change of ['outward_weight_kg = 100', 'scrap_weight_kg = 0', `party_dc_no = 'X'`, `material_grade = 'EN19'`]) {
      expect((await pgError(queryAs(ctx.db, ACTORS.owner, `update public.job_work_ledger set ${change} where id = $1`, [lot]))).code).toBe('23514');
    }

    // Closing: within 1% of inward, or with a reason.
    const close = (reason: string | null) =>
      outcome(queryAs(ctx.db, ACTORS.staff, `update public.job_work_ledger set status = 'closed', close_reason = $2 where id = $1 returning status`, [lot, reason]));
    expect(await close(null)).toMatch(/^rejected 23514.*close_rule/);
    expect(await sync(jobWork([{ lot_id: lot, returned_weight_kg: '100', close: true }]))).toMatch(/^rejected 23514.*close_rule/);
    expect((await lotState(lot))?.outward).toBe('300.250');
    expect(await sync(jobWork([{ lot_id: lot, returned_weight_kg: '182.250', close: true }]))).toMatch(/^accepted/); // 5.000 kg left = exactly 1%
    expect(await lotState(lot)).toMatchObject({ balance: '5.000', status: 'closed' });
    expect(await sync(jobWork([{ lot_id: lot, returned_weight_kg: '1' }]))).toMatch(/^rejected 23514.*is closed/);

    const short = await openLot('PDC-2202');
    expect(await sync(jobWork([{ lot_id: short, returned_weight_kg: '100', close: true, close_reason: 'Party took back the rest' }]))).toMatch(/^accepted/);
    // Over-return beyond scale variance (a typed extra zero) is refused.
    const over = await openLot('PDC-2203');
    expect(await sync(jobWork([{ lot_id: over, returned_weight_kg: '505.001' }]))).toMatch(/^rejected 23514.*more than was received/);
    expect(await sync(jobWork([{ lot_id: over, returned_weight_kg: '505.000' }]))).toMatch(/^accepted/);
    // Wrong party, wrong bill type.
    const other = await openLot('PDC-2204', '500.000', ctx.md.kaCustomerId);
    expect(await sync(jobWork([{ lot_id: other, returned_weight_kg: '1' }]))).toMatch(/^rejected 23503/);
    expect(await sync(jobWork([{ lot_id: other, returned_weight_kg: '1' }], { bill_type: 'supply' }))).toMatch(/^rejected 23514/);
  });

  it('cancelling a job-work bill gives the weight back to its lot and reopens it', async () => {
    const lot = await openLot('PDC-2301', '100.000');
    const bill = await syncInvoice(ctx.db, ACTORS.staff, jobWork([{ lot_id: lot, returned_weight_kg: '98.000', scrap_weight_kg: '2.000', close: true }]));
    expect(await lotState(lot)).toMatchObject({ balance: '0.000', status: 'closed' });
    await queryAs(ctx.db, ACTORS.staff, `update public.invoices set cancelled_at = now(), cancellation_reason = 'Wrong weight typed' where id = $1`, [bill.invoice_id]);
    expect(await lotState(lot)).toEqual({ outward: '0.000', scrap: '0.000', balance: '100.000', status: 'open' });
    expect(await sync(jobWork([{ lot_id: lot, returned_weight_kg: '97.000', scrap_weight_kg: '3.000', close: true }]))).toMatch(/^accepted/);
    const rows = await queryAs(
      ctx.db,
      ACTORS.staff,
      'select returned_weight_kg::text as kg, reversed_at is not null as reversed from public.job_work_returns where ledger_id = $1 order by created_at',
      [lot],
    );
    expect(rows).toEqual([{ kg: '98.000', reversed: true }, { kg: '97.000', reversed: false }]);
  });

  it('receipts through an atomic RPC, so two devices cannot overwrite each other', async () => {
    const bill = (await syncInvoice(ctx.db, ACTORS.staff, intraStatePayload(ctx.md))).invoice_id; // Rs 1,770
    const direct = queryAs(ctx.db, ACTORS.staff, `update public.invoices set amount_paid = 500, payment_status = 'partial' where id = $1`, [bill]);
    expect((await pgError(direct)).message).toMatch(/record_payment/);

    await recordPayment(ctx.db, ACTORS.staff, bill, '1000.00');
    const id = '22222222-2222-4222-8222-222222222222';
    expect(await recordPayment(ctx.db, ACTORS.owner, bill, '500.00', { client_receipt_id: id })).toMatchObject({ amount_paid: '1500.00', replayed: false });
    // A retry after a lost response posts nothing new; a changed one is refused.
    expect(await recordPayment(ctx.db, ACTORS.owner, bill, '500.00', { client_receipt_id: id })).toMatchObject({ amount_paid: '1500.00', replayed: true });
    expect((await pgError(recordPayment(ctx.db, ACTORS.owner, bill, '600.00', { client_receipt_id: id }))).code).toBe('23505');

    for (const [amount, change, code] of [
      ['270.01', {}, '23514'], // more than is due
      ['0', {}, '23514'],
      ['-5', {}, '23514'],
      ['NaN', {}, '23514'],
      ['1.005', {}, '22023'],
      ['1.00', { received_on: '2026-11-24' }, '22023'], // future
      ['1.00', { mode: 'barter' }, '22P02'],
    ] as const) {
      expect((await pgError(recordPayment(ctx.db, ACTORS.staff, bill, amount, change))).code, amount).toBe(code);
    }
    for (const actor of [ACTORS.stranger, ACTORS.former, ACTORS.service, ACTORS.anon]) {
      expect((await pgError(recordPayment(ctx.db, actor, bill, '1.00'))).code).toBe('42501');
    }

    const last = await recordPayment(ctx.db, ACTORS.staff, bill, '270.00');
    expect(last).toMatchObject({ amount_paid: '1770.00', payment_status: 'paid' });
    expect((await pgError(queryAs(ctx.db, ACTORS.staff, `select public.void_payment($1, 'Cheque bounced')`, [last.payment_id]))).code).toBe('42501');
    const [voided] = await queryAs(ctx.db, ACTORS.owner, `select amount_paid, payment_status from public.void_payment($1, 'Cheque bounced')`, [last.payment_id]);
    expect(voided).toEqual({ amount_paid: '1500.00', payment_status: 'partial' });
    expect((await pgError(queryAs(ctx.db, ACTORS.owner, `select public.void_payment($1, 'Again')`, [last.payment_id]))).code).toBe('23514');

    // Receipts are the ledger: nobody writes or deletes them directly, and they always sum up.
    for (const sql of ['delete from public.payments', 'update public.payments set amount = 1', `insert into public.payments (amount) values (1)`]) {
      expect((await pgError(queryAs(ctx.db, ACTORS.owner, sql))).code).toBe('42501');
    }
    await syncInvoice(ctx.db, ACTORS.staff, intraStatePayload(ctx.md, { amount_paid: '1770.00', payment_status: 'paid', payment_mode: 'upi' }));
    const { rows } = await ctx.db.query(`
      select i.invoice_no from public.invoices i left join public.payments p on p.invoice_id = i.id and p.voided_at is null
       group by i.id having i.amount_paid <> coalesce(sum(p.amount), 0)`);
    expect(rows).toEqual([]);
  });
});
