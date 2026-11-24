// Test harness: boots an in-memory Postgres (PGlite, real Postgres compiled to WASM),
// applies the Supabase shim + every migration, and lets tests act as a specific user
// exactly like PostgREST does (SET ROLE + request.jwt.claims). No Docker required.
import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite, type Transaction } from '@electric-sql/pglite';

const MIGRATIONS_DIR = new URL('../../supabase/migrations/', import.meta.url);
const SHIM_SQL = readFileSync(new URL('./supabase-shim.sql', import.meta.url), 'utf8');

/** Stand-in for Supabase's `postgres`: the non-superuser that runs migrations and the SQL editor. */
const MIGRATOR = 'supabase_postgres';

/** Business "today" (IST) used by sync_invoice in tests, so date rules are deterministic. */
export const TEST_TODAY = '2026-11-23';

export const USERS = {
  owner: { id: '00000000-0000-4000-8000-000000000001', email: 'owner@studflow.test' },
  staff: { id: '00000000-0000-4000-8000-000000000002', email: 'staff@studflow.test' },
  /** Signed up with the public key but never allowlisted: must see nothing. */
  stranger: { id: '00000000-0000-4000-8000-000000000003', email: 'stranger@studflow.test' },
  /** Allowlisted once, then deactivated. */
  former: { id: '00000000-0000-4000-8000-000000000004', email: 'former@studflow.test' },
} as const;

export type Actor =
  | { role: 'anon' }
  | { role: 'service_role' }
  | { role: 'authenticated'; sub: string }
  /** The SQL editor / a migration: table owner, no JWT. */
  | { role: typeof MIGRATOR };

export const ACTORS = {
  anon: { role: 'anon' },
  service: { role: 'service_role' },
  sqlEditor: { role: MIGRATOR },
  owner: { role: 'authenticated', sub: USERS.owner.id },
  staff: { role: 'authenticated', sub: USERS.staff.id },
  stranger: { role: 'authenticated', sub: USERS.stranger.id },
  former: { role: 'authenticated', sub: USERS.former.id },
} as const satisfies Record<string, Actor>;

export function migrationFiles(): { name: string; sql: string }[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: readFileSync(new URL(name, MIGRATIONS_DIR), 'utf8') }));
}

export interface TestDbOptions {
  /** Freeze private.today_ist() to this IST date. `null` keeps the real clock. */
  today?: string | null;
  /** Insert auth users + the access allowlist. */
  seedUsers?: boolean;
  /** Open the INV and DC series of today's financial year at 0 (the go-live step). */
  openSeries?: boolean;
  /** Supabase's default grants on new public tables: none (today) or everything (older projects). */
  platformGrants?: 'none' | 'legacy-grant-all';
}

/** Freeze the business date. CREATE OR REPLACE keeps the function's owner and grants. */
export async function setToday(db: PGlite, day: string): Promise<void> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`Bad test date: ${day}`);
  await db.exec(`
    create or replace function private.today_ist() returns date
    language sql stable set search_path = ''
    as $$ select date '${day}' $$;
  `);
}

export async function openSeries(db: PGlite, fiscalYear: string, lastInv = 0, lastDc = 0): Promise<void> {
  await db.query(
    `insert into private.document_sequences (series, fiscal_year, last_value) values ('INV', $1, $2), ('DC', $1, $3)`,
    [fiscalYear, lastInv, lastDc],
  );
}

export async function createTestDb(options: TestDbOptions = {}): Promise<PGlite> {
  const { today = TEST_TODAY, seedUsers = true, openSeries: open = true, platformGrants = 'none' } = options;
  const db = await PGlite.create();
  await db.exec(`set timezone = 'UTC'`); // Supabase databases run in UTC
  await db.exec(SHIM_SQL);
  if (platformGrants === 'legacy-grant-all') {
    await db.exec(`
      alter default privileges for role ${MIGRATOR} in schema public
        grant all on tables to anon, authenticated, service_role;
      alter default privileges for role ${MIGRATOR} in schema public
        grant all on sequences to anon, authenticated, service_role;
    `);
  }

  await db.exec(`set role ${MIGRATOR}`);
  for (const migration of migrationFiles()) {
    try {
      await db.exec(migration.sql);
    } catch (error) {
      throw new Error(`Migration ${migration.name} failed: ${(error as Error).message}`, { cause: error });
    }
  }
  await db.exec('reset role');

  if (today !== null) await setToday(db, today);
  if (open) {
    const { rows } = await db.query<{ fy: string }>('select private.fiscal_year_of(private.today_ist()) as fy');
    await openSeries(db, rows[0]!.fy);
  }
  if (seedUsers) {
    await db.exec(`
      insert into auth.users (id, email) values
        ('${USERS.owner.id}', '${USERS.owner.email}'),
        ('${USERS.staff.id}', '${USERS.staff.email}'),
        ('${USERS.stranger.id}', '${USERS.stranger.email}'),
        ('${USERS.former.id}', '${USERS.former.email}');
      insert into private.app_users (user_id, display_name, role, is_active) values
        ('${USERS.owner.id}', 'Owner', 'owner', true),
        ('${USERS.staff.id}', 'Office Staff', 'staff', true),
        ('${USERS.former.id}', 'Former Staff', 'staff', false);
    `);
  }
  return db;
}

/** Run `fn` inside a transaction as `actor`, the way PostgREST executes an API request. */
export async function asActor<T>(db: PGlite, actor: Actor, fn: (tx: Transaction) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    if (actor.role !== MIGRATOR) {
      const claims = actor.role === 'authenticated' ? { role: actor.role, sub: actor.sub } : { role: actor.role };
      await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
    }
    await tx.exec(`set local role ${actor.role}`);
    return fn(tx);
  });
}

/** Convenience: run one query as `actor` and return its rows. */
export async function queryAs<R = Record<string, unknown>>(
  db: PGlite,
  actor: Actor,
  sql: string,
  params: unknown[] = [],
): Promise<R[]> {
  return asActor(db, actor, async (tx) => (await tx.query<R>(sql, params)).rows);
}

/**
 * What PostgREST answers for `Prefer: count=planned`: in the request's role it runs the
 * registered db-pre-request, then EXPLAIN, and returns the planner's row estimate.
 */
export async function plannedCount(db: PGlite, actor: Actor, countQuery: string): Promise<number | string> {
  const { rows } = await db.query<{ fn: string }>(`
    select split_part(c, '=', 2) as fn
      from pg_db_role_setting s join pg_roles r on r.oid = s.setrole cross join unnest(s.setconfig) as c
     where r.rolname = 'authenticator' and c like 'pgrst.db\\_pre\\_request=%'`);
  const preRequest = rows[0]?.fn;
  try {
    return await asActor(db, actor, async (tx) => {
      if (preRequest) await tx.query(`select ${preRequest}()`);
      const plan = await tx.query<{ 'QUERY PLAN': { Plan: { 'Plan Rows': number } }[] }>(
        `explain (format json) ${countQuery}`,
      );
      return plan.rows[0]!['QUERY PLAN'][0]!.Plan['Plan Rows'];
    });
  } catch (error) {
    return `refused ${(error as { code?: string }).code ?? '?'}`;
  }
}

export interface SyncResult {
  invoice_id: string;
  invoice_no: string;
  dc_no: string;
  replayed: boolean;
}

export async function syncInvoice(db: PGlite, actor: Actor, payload: unknown): Promise<SyncResult> {
  const rows = await queryAs<SyncResult>(db, actor, 'select * from public.sync_invoice($1::jsonb)', [
    JSON.stringify(payload),
  ]);
  const row = rows[0];
  if (!row) throw new Error('sync_invoice returned no row');
  return row;
}

/** Await a statement that must fail; returns its SQLSTATE and message for assertions. */
export async function pgError(promise: Promise<unknown>): Promise<{ code: string | undefined; message: string }> {
  try {
    await promise;
  } catch (error) {
    const err = error as { code?: string; message?: string };
    return { code: err.code, message: err.message ?? String(error) };
  }
  throw new Error('Expected the database to reject this, but it succeeded');
}

/** 'accepted <json>' or 'rejected <SQLSTATE>: <message>', so failures show what the DB did. */
export async function outcome(promise: Promise<unknown>): Promise<string> {
  try {
    return `accepted ${JSON.stringify(await promise)}`;
  } catch (error) {
    const err = error as { code?: string; message?: string };
    return `rejected ${err.code}: ${err.message}`;
  }
}

export const newTempId = (): string => `OFFLINE-${randomUUID()}`;

export interface MasterData {
  tnCustomerId: string; // Tamil Nadu (33) -> CGST + SGST
  kaCustomerId: string; // Karnataka (29) -> IGST
  studItemId: string;
}

/** Synthetic GSTINs with a valid check character. */
export const GSTIN = { tn: '33AABCM1234F1Z4', ka: '29AACCB5678G1ZD' } as const;

/** Master data inserted as the migration owner (bypasses RLS), like a seed script. */
export async function seedMasterData(db: PGlite): Promise<MasterData> {
  const one = async (sql: string): Promise<string> => {
    const row = (await db.query<{ id: string }>(sql)).rows[0];
    if (!row) throw new Error(`Seed returned no row: ${sql}`);
    return row.id;
  };
  return {
    tnCustomerId: await one(`
      insert into public.customers (name, gstin, phone, state_code, credit_days, address)
      values ('Murugan Engineering Works', '${GSTIN.tn}', '9876543210', '33', 30,
              '12 SIDCO Industrial Estate, Coimbatore 641021')
      returning id`),
    kaCustomerId: await one(`
      insert into public.customers (name, gstin, phone, state_code, credit_days, address)
      values ('Bharat Fasteners Pvt Ltd', '${GSTIN.ka}', '9845012345', '29', 45,
              'Peenya Industrial Area, Bengaluru 560058')
      returning id`),
    studItemId: await one(`
      insert into public.stud_items (sku_code, diameter_mm, length_mm, thread_type, material_grade,
                                     hsn_sac, gst_rate_percent, unit_weight_kg, default_rate_per_piece)
      values ('M12X150-EN8', 12, 150, 'Metric Coarse', 'EN8', '7318', 18, 0.133169, 1.5)
      returning id`),
  };
}

export type Payload = Record<string, unknown>;
export type Line = Record<string, unknown>;

/** 1000 pcs @ Rs 1.50 = 1500.00 at 18%. */
export function goodsLine(md: MasterData, overrides: Line = {}): Line {
  return {
    line_no: 1,
    stud_item_id: md.studItemId,
    description: 'M12 x 150 EN8 Stud',
    hsn_sac: '7318',
    qty_pieces: 1000,
    total_weight_kg: '133.169',
    billing_unit: 'pcs',
    unit_rate: '1.5000',
    tax_rate_percent: '18.00',
    line_total: '1500.00',
    ...overrides,
  };
}

/**
 * One goods line, 18% GST. Amounts are hand-computed fixtures: the DB only verifies
 * identities, it never computes them.
 */
export function intraStatePayload(md: MasterData, overrides: Payload = {}): Payload {
  return {
    client_temp_id: newTempId(),
    bill_type: 'supply',
    customer_id: md.tnCustomerId,
    invoice_date: '2026-11-20',
    due_date: '2026-12-20',
    subtotal: '1500.00',
    packing_charge: '0.00',
    delivery_charge: '0.00',
    delivery_taxable: true,
    cgst: '135.00',
    sgst: '135.00',
    igst: '0.00',
    round_off: '0.00',
    grand_total: '1770.00',
    items: [goodsLine(md)],
    delivery: {
      transport_mode: 'own_vehicle',
      vehicle_no: 'TN38AB1234',
      driver_name: 'Ravi',
      driver_phone: '9876500000',
      freight_paid_by: 'seller',
      freight_amount: '0.00',
    },
    ...overrides,
  };
}

export function interStatePayload(md: MasterData, overrides: Payload = {}): Payload {
  return intraStatePayload(md, {
    customer_id: md.kaCustomerId,
    due_date: '2027-01-04',
    cgst: '0.00',
    sgst: '0.00',
    igst: '270.00',
    ...overrides,
  });
}
