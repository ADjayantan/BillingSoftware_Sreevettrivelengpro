// What Home and the lists read, end to end: real Zod, real supabase-js, real SQL and RLS.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createClient as createSupabase, type SupabaseClient } from '@supabase/supabase-js';
import { ACTORS, createTestDb, goodsLine, intraStatePayload, queryAs, recordPayment, seedMasterData, syncInvoice, type Actor, type MasterData, type Payload } from '../db/harness';
import { pgliteFetch } from '../support/postgrest';

let db: PGlite;
let md: MasterData;
let actor: Actor = ACTORS.staff;

const client = (): SupabaseClient => {
  const supabase = createSupabase('http://localhost', 'sb_publishable_test', {
    global: { fetch: pgliteFetch(db, () => actor) },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  supabase.auth.getClaims = (async () => ({ data: { claims: {} }, error: null })) as unknown as typeof supabase.auth.getClaims;
  return supabase;
};
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => client() }));

interface Reply { status: number; data: Record<string, unknown>; error: { code: string; message: string } }
type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;
async function get(handler: unknown, search = '', params: Record<string, string> = {}, as: Actor = ACTORS.staff): Promise<Reply> {
  actor = as;
  try {
    const response = await (handler as Handler)(new Request(`http://localhost/api/x${search}`), { params: Promise.resolve(params) });
    return { status: response.status, ...((await response.json()) as Omit<Reply, 'status'>) };
  } finally {
    actor = ACTORS.staff;
  }
}
const issue = (over: Payload = {}) => syncInvoice(db, ACTORS.staff, intraStatePayload(md, over));
/** Sums over a frozen day; the harness' today. */
const TODAY = '2026-11-23';

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-23T06:00:00Z') });
  db = await createTestDb();
  md = await seedMasterData(db);
  const first = await issue({ invoice_date: '2026-11-01', due_date: '2026-11-02', po_no: 'A-17' });
  await issue({ invoice_date: TODAY, due_date: '2026-12-23' });
  await recordPayment(db, ACTORS.staff, first.invoice_id, '770.00');
});
afterAll(async () => {
  vi.useRealTimers();
  await db.close();
});

describe('GET /api/invoices', () => {
  it('finds bills, with the counts of every tab', async () => {
    const { GET } = await import('@/app/api/invoices/route');
    const all = await get(GET);
    expect(all.data).toMatchObject({ page: 1, hasMore: false, counts: { all: 2, open: 2, overdue: 1, paid: 0, cancelled: 0 }, shown: { bills: 2, total: '3540.00', balance: '2770.00' } });
    expect((await get(GET, '?show=overdue')).data.rows).toMatchObject([{ po_no: 'A-17', customer: 'Murugan Engineering Works', amount_paid: '770.00' }]);
    expect((await get(GET, '?q=a-17')).data.rows).toHaveLength(1);
    expect((await get(GET, `?show=open&customer=${md.kaCustomerId}`)).data.rows).toEqual([]);
    expect((await get(GET, '?month=2026-10')).data.rows).toEqual([]);
    expect((await get(GET, '?month=2026-11&q=&customer=&show=all&page=1')).data.rows).toHaveLength(2);
  });

  it('refuses a list that does not exist', async () => {
    const { GET } = await import('@/app/api/invoices/route');
    for (const bad of ['?show=everything', '?month=2026-13', '?month=2026', '?customer=1', '?page=0']) expect((await get(GET, bad)).status, bad).toBe(400);
    expect(await get(GET, '', {}, ACTORS.stranger)).toMatchObject({ status: 403, error: { code: 'FORBIDDEN' } });
  });

  it('says when there are more pages', async () => {
    const { findBills } = await import('@/lib/data');
    for (let i = 0; i < 50; i += 1) await issue();
    expect(await findBills(client(), {}, TODAY)).toMatchObject({ page: 1, hasMore: true, counts: { all: 52 } });
    const second = await findBills(client(), { page: 2 }, TODAY);
    expect(second).toMatchObject({ page: 2, hasMore: false });
    expect(second.rows).toHaveLength(2);
  });
});

describe('the reads of Home', () => {
  it('come in their shapes', async () => {
    const { findReceipts, goodsToSend, homeFigures } = await import('@/lib/data');
    expect(await homeFigures(client(), TODAY)).toMatchObject({ today: { bills: 1, total: '1770.00' }, overdue: { bills: 1, total: '1000.00', oldest: '2026-11-02' }, to_send: 52 });
    expect(await findReceipts(client(), {})).toMatchObject({ receipts: 1, total: '770.00', page: 1, hasMore: false, rows: [{ amount: '770.00', customer: 'Murugan Engineering Works' }] });
    expect(await goodsToSend(client())).toHaveLength(52);
    actor = ACTORS.stranger;
    await expect(homeFigures(client(), TODAY)).rejects.toMatchObject({ code: '42501' });
    actor = ACTORS.staff;
  });
});

describe('what each customer owes, end to end', () => {
  it('comes in its shape, a page at a time, and nobody else may look', async () => {
    const { customerBalances } = await import('@/lib/data');
    const found = await customerBalances(client(), { sort: 'owes' }, TODAY);
    // 51 × 1770 + (1770 − 770); only the first bill is past its due date.
    expect(found).toMatchObject({ page: 1, hasMore: false, customers: 2, owing: 1, balance: '91270.00', overdue: '1000.00' });
    expect(found.rows.map((row) => row.name)).toEqual(['Murugan Engineering Works', 'Bharat Fasteners Pvt Ltd']);
    expect(found.rows[0]).toMatchObject({ id: md.tnCustomerId, bills: 52, on_bills: '91270.00', overdue: '1000.00', oldest: '2026-11-02', balance: '91270.00', credit_days: 30, is_active: true });
    expect(found.rows[1]).toMatchObject({ bills: 0, on_bills: '0.00', oldest: null, balance: '0.00' });
    expect((await customerBalances(client(), { page: 2 }, TODAY)).rows).toEqual([]);
    expect(await customerBalances(client(), { q: 'bharat' }, TODAY)).toMatchObject({ customers: 1, owing: 0, rows: [{ name: 'Bharat Fasteners Pvt Ltd' }] });
    actor = ACTORS.stranger;
    await expect(customerBalances(client(), {}, TODAY)).rejects.toMatchObject({ code: '42501' });
    actor = ACTORS.staff;
  });

  it('takes its question from the address bar, and only what makes sense', async () => {
    const { customersQuery } = await import('@/lib/schemas/home');
    expect(customersQuery.parse({})).toEqual({ q: '', sort: 'name', page: 1 });
    expect(customersQuery.parse({ q: ' murugan ', sort: 'owes', page: '2', new: '' })).toEqual({ q: 'murugan', sort: 'owes', page: 2 });
    for (const bad of [{ sort: 'richest' }, { page: '0' }, { q: 'x'.repeat(61) }]) expect(customersQuery.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });
});

describe('GET /api/customers/[id]/glance', () => {
  const glance = async (id: string, search = '', as: Actor = ACTORS.staff): Promise<Reply> =>
    get((await import('@/app/api/customers/[id]/glance/route')).GET, search, { id }, as);

  it('gives what is owed and the goods of the last bill of that kind, newest bill first', async () => {
    await issue({
      invoice_date: TODAY, due_date: '2026-12-23', subtotal: '1550.00', cgst: '139.50', sgst: '139.50', grand_total: '1829.00',
      items: [
        goodsLine(md),
        { line_no: 2, stud_item_id: null, description: 'Packing charges', hsn_sac: '7318', qty_pieces: 1, total_weight_kg: null, billing_unit: 'pcs', unit_rate: '50.0000', tax_rate_percent: '18.00', line_total: '50.00' },
      ],
    });
    const { data } = await glance(md.tnCustomerId);
    expect(data).toMatchObject({ bills: 53, last: { invoice_no: 'INV/26-27/0053', invoice_date: TODAY, grand_total: '1829.00' } });
    const last = data.last as { lines: Record<string, unknown>[] };
    expect(last.lines).toHaveLength(1); // packing is not goods
    expect(last.lines[0]).toMatchObject({ description: 'M12 x 150 EN8 Stud', hsn_sac: '7318', billing_unit: 'pcs', quantity: '1000', rate: '1.5' });
    expect(last.lines[0]!.stud).toMatchObject({ id: md.studItemId, gst_rate_percent: '18.00' });
  });

  it('never offers a product that is not in use any more', async () => {
    await queryAs(db, ACTORS.owner, 'update public.stud_items set is_active = false where id = $1', [md.studItemId]);
    const last = (await glance(md.tnCustomerId)).data.last as { lines: Record<string, unknown>[] };
    expect(last.lines[0]).toMatchObject({ stud: null, description: 'M12 x 150 EN8 Stud' });
    await queryAs(db, ACTORS.owner, 'update public.stud_items set is_active = true where id = $1', [md.studItemId]);
  });

  it('a customer without bills has nothing to show, and nobody else may look', async () => {
    expect((await glance(md.kaCustomerId)).data).toEqual({ bills: 0, balance: '0.00', last: null });
    expect((await glance(md.tnCustomerId, '?type=job_work')).data).toMatchObject({ bills: 53, last: null });
    expect((await glance(md.tnCustomerId, '?type=other')).status).toBe(400);
    expect((await glance('nope')).status).toBe(400);
    expect((await glance(md.tnCustomerId, '', ACTORS.stranger)).status).toBe(403);
  });
});

describe('GET /api/metal-rates', () => {
  it('gives the latest rate of every grade, as text, and the alert limits', async () => {
    const { GET } = await import('@/app/api/metal-rates/route');
    await db.exec(`insert into public.metal_rates (material_grade, rate_per_kg, source, recorded_at) values
      ('SS 304', 210.55, 'test', '2026-11-21T04:00:00Z'), ('SS 304', 211.75, 'test', '2026-11-22T04:00:00Z'), ('MS', 58.25, 'test', '2026-11-22T04:00:00Z');
      insert into public.alert_rules (material_grade, threshold_rs_per_kg, telegram_chat_id, is_active) values ('MS', 1.5, '-1', true)`);
    const reply = await get(GET);
    expect(reply.status).toBe(200);
    expect(reply.data).toMatchObject({
      rates: [
        { material_grade: 'MS', rate_per_kg: '58.2500', previous_rate_per_kg: null, change_delta: null },
        { material_grade: 'SS 304', rate_per_kg: '211.7500', previous_rate_per_kg: '210.5500', change_delta: '1.2000', recorded_at: expect.stringContaining('2026-11-22') as string },
      ],
      rules: [{ material_grade: 'MS', threshold_rs_per_kg: '1.5000', is_active: true }],
    });
  });
});
