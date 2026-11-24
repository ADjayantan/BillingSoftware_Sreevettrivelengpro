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
  seedMasterData,
  syncInvoice,
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
    await syncInvoice(ctx.db, ACTORS.staff, intraStatePayload(ctx.md));
    await queryAs(
      ctx.db,
      ACTORS.staff,
      `insert into public.job_work_ledger (customer_id, party_dc_no, party_dc_date, material_grade, inward_weight_kg)
       values ($1, 'PDC-1', '2026-11-02', 'EN8', 100)`,
      [ctx.md.tnCustomerId],
    );
    await queryAs(ctx.db, ACTORS.staff, `insert into public.metal_rates (material_grade, rate_per_kg) values ('EN8', 85)`);
    await queryAs(
      ctx.db,
      ACTORS.owner,
      `insert into public.alert_rules (material_grade, threshold_rs_per_kg, telegram_chat_id) values ('EN8', 5, '1')`,
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
      'truncate public.deliveries',
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
    const pay = (amount: string) =>
      queryAs(ctx.db, ACTORS.staff, `update public.invoices set amount_paid = $2, payment_status = 'partial' where id = $1`, [
        bill.invoice_id,
        amount,
      ]);
    await pay('1234.56');
    await pay('1000.00'); // correcting a typo must not erase the first entry
    await pay('1000.00'); // no change: nothing to log

    const log = await queryAs(
      ctx.db,
      ACTORS.sqlEditor,
      `select actor_id::text, actor_role, action, old_row ->> 'amount_paid' as was, new_row ->> 'amount_paid' as now
         from private.audit_log where table_name = 'public.invoices' and row_id = $1 order by id`,
      [bill.invoice_id],
    );
    expect(log).toEqual([
      { actor_id: USERS.staff.id, actor_role: 'authenticated', action: 'UPDATE', was: '0.00', now: '1234.56' },
      { actor_id: USERS.staff.id, actor_role: 'authenticated', action: 'UPDATE', was: '1234.56', now: '1000.00' },
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
      'public.customers',
      'public.deliveries',
      'public.invoice_items',
      'public.invoices',
      'public.job_work_ledger',
      'public.metal_rates',
      'public.stud_items',
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
      outcome(queryAs(ctx.db, ACTORS.staff, `update public.invoices set amount_paid = $2, payment_status = $3 where id = $1`, [bill.invoice_id, amount, status]));
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

    for (const table of ['customers', 'stud_items', 'metal_rates', 'invoices', 'invoice_items', 'deliveries', 'job_work_ledger', 'alert_rules', 'latest_metal_rates']) {
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

describe('known gaps, scheduled for Sprint 2 with the owner', () => {
  it.todo('SEZ / export supplies: IGST for a Tamil Nadu SEZ unit (IGST Act s.7(5)(b))');
  it.todo('packing charged outside the taxable value (CGST s.15(2)(c) vs the brief)');
  it.todo('supplier name, GSTIN and address frozen on each invoice (Rule 46(a))');
  it.todo('GST stored per line, for rate-wise printing and GSTR-1');
  it.todo('job-work bills linked to the party-DC lots they return (ITC-04), with a closing rule');
  it.todo('receipts through an atomic RPC, so two devices cannot overwrite each other');
});
