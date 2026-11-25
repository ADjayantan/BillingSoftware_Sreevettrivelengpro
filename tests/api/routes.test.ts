// Route handlers end to end: real Zod, real supabase-js, real SQL and RLS (PGlite).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createClient as createSupabase } from '@supabase/supabase-js';
import { productCode } from '@/lib/products';
import { ACTORS, GSTIN, createTestDb, newTempId, seedMasterData, type Actor, type MasterData } from '../db/harness';
import { pgliteFetch } from '../support/postgrest';

let db: PGlite;
let md: MasterData;
let actor: Actor = ACTORS.staff;
let signedIn = true;

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => {
    const client = createSupabase('http://localhost', 'sb_publishable_test', {
      global: { fetch: pgliteFetch(db, () => actor) },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    client.auth.getClaims = (async () => ({ data: signedIn ? { claims: {} } : null, error: null })) as unknown as typeof client.auth.getClaims;
    return client;
  },
}));

type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;
interface Reply {
  status: number;
  data: Record<string, unknown>;
  error: { code: string; message: string };
}

async function call(handler: unknown, options: { method?: string; params?: Record<string, string>; search?: string; json?: unknown; headers?: Record<string, string>; as?: Actor } = {}): Promise<Reply> {
  const previous = actor;
  actor = options.as ?? ACTORS.staff;
  try {
    const request = new Request(`http://localhost/api/x${options.search ?? ''}`, {
      method: options.method ?? (options.json === undefined ? 'GET' : 'POST'),
      headers: { ...(options.json === undefined ? {} : { 'content-type': 'application/json' }), ...options.headers },
      ...(options.json === undefined ? {} : { body: typeof options.json === 'string' ? options.json : JSON.stringify(options.json) }),
    });
    const response = await (handler as Handler)(request, { params: Promise.resolve(options.params ?? {}) });
    return { status: response.status, ...((await response.json()) as Omit<Reply, 'status'>) };
  } finally {
    actor = previous;
  }
}

beforeAll(async () => {
  db = await createTestDb();
  md = await seedMasterData(db);
});
afterAll(async () => {
  await db.close();
});

const customer = { name: 'Vel Tools', gstin: '33ABCPV1357D1ZX', phone: '98765 43210', state_code: '33', credit_days: 30, address: 'Coimbatore', opening_balance: '-120.50' };

describe('every route', () => {
  it('needs a session, a same-site caller, JSON and a valid body, and answers in one error shape', async () => {
    const { GET, POST } = await import('@/app/api/customers/route');
    signedIn = false;
    expect(await call(GET)).toMatchObject({ status: 401, error: { code: 'UNAUTHENTICATED' } });
    signedIn = true;
    expect(await call(GET, { headers: { 'sec-fetch-site': 'cross-site' } })).toMatchObject({ status: 403 });
    expect(await call(POST, { json: '{' })).toMatchObject({ status: 400, error: { code: 'INVALID' } });
    expect(await call(POST, { json: {}, headers: { 'content-type': 'text/plain' } })).toMatchObject({ status: 415 });
    expect(await call(POST, { json: { ...customer, name: '' } })).toMatchObject({ status: 400, error: { message: 'name: Required' } });
    expect(await call(GET, { search: '?page=0' })).toMatchObject({ status: 400 });
  });

  it('shows nothing to a signed-in stranger and never leaks SQL', async () => {
    const { GET, POST } = await import('@/app/api/customers/route');
    expect((await call(GET, { as: ACTORS.stranger })).data).toMatchObject({ rows: [] });
    const refused = await call(POST, { json: customer, as: ACTORS.stranger });
    expect(refused).toMatchObject({ status: 403, error: { code: 'FORBIDDEN' } });
    expect(refused.error.message).not.toMatch(/row-level|relation|policy|customers/i);
  });
});

describe('customers', () => {
  it('creates, reads, searches, updates and deletes', async () => {
    const { GET, POST } = await import('@/app/api/customers/route');
    const one = await import('@/app/api/customers/[id]/route');
    const created = await call(POST, { json: customer });
    expect(created).toMatchObject({ status: 201, data: { gstin: customer.gstin, phone: '9876543210', opening_balance: '-120.50', is_sez: false } });
    const params = { id: created.data.id as string };
    expect((await call(GET, { search: '?q=vel t' })).data.rows).toHaveLength(1);
    expect((await call(GET, { search: '?q=%25' })).data.rows).toEqual([]); // a literal %, not a wildcard
    expect(await call(one.PUT, { method: 'PUT', params, json: { ...customer, is_sez: true, credit_days: 45 } })).toMatchObject({ status: 200, data: { is_sez: true, credit_days: 45 } });
    expect(await call(one.DELETE, { method: 'DELETE', params })).toMatchObject({ status: 404 }); // staff cannot
    expect(await call(one.DELETE, { method: 'DELETE', params, as: ACTORS.owner })).toMatchObject({ status: 200 });
    expect(await call(one.GET, { params })).toMatchObject({ status: 404 });
    expect(await call(one.GET, { params: { id: 'nope' } })).toMatchObject({ status: 400 });
  });

  it.each([
    ['a mistyped GSTIN', { gstin: '33ABCPV1357D1ZY' }, /not valid/],
    ['a state that disagrees with the GSTIN', { state_code: '29' }, /state/],
    ['a registered buyer without an address', { address: '' }, /address/],
    ['an SEZ unit without a GSTIN', { gstin: '', is_sez: true }, /SEZ/],
    ['a made-up state code', { gstin: '', state_code: '25' }, /state/],
    ['scientific notation money', { opening_balance: '1e5' }, /decimals/],
  ])('refuses %s', async (_label, change, message) => {
    const { POST } = await import('@/app/api/customers/route');
    const reply = await call(POST, { json: { ...customer, ...change } });
    expect(reply.status).toBe(400);
    expect(reply.error.message).toMatch(message);
  });

  it('explains a duplicate GSTIN in plain words', async () => {
    const { POST } = await import('@/app/api/customers/route');
    expect(await call(POST, { json: { ...customer, gstin: GSTIN.tn } })).toMatchObject({
      status: 409, error: { code: 'CONFLICT', message: 'Another customer already has this GSTIN' },
    });
  });
});

describe('a customer made at the counter', () => {
  const counter = (over: Record<string, unknown> = {}) => ({
    id: randomUUID(), different_from: [], name: 'Sri Balaji Fabricators', gstin: '', phone: '', state_code: '33', is_sez: false, credit_days: 30, address: '', opening_balance: '0', is_active: true, ...over,
  });
  const add = async (json: Record<string, unknown>, as: Actor = ACTORS.staff) => call((await import('@/app/api/customers/route')).POST, { json, as });
  const named = async (name: string) => (await db.query<{ id: string }>('select id from public.customers where name = $1', [name])).rows.map((row) => row.id);
  const details = (reply: Reply) => (reply.error as unknown as { details?: { existing?: { id: string }; candidates?: { id: string }[]; same_name?: boolean } }).details;

  it('keeps the id the device gave it, however often it is sent', async () => {
    const body = counter();
    const first = await add(body);
    expect(first).toMatchObject({ status: 201, data: { id: body.id, name: 'Sri Balaji Fabricators', gstin: null, state_code: '33', credit_days: 30, opening_balance: '0.00' } });
    expect((await add(body)).data).toEqual(first.data); // the reply was lost: sent again
    const both = await Promise.all([add(counter({ id: '00000000-0000-4000-8000-0000000000aa', name: 'Double Click Works' })), add(counter({ id: '00000000-0000-4000-8000-0000000000aa', name: 'Double Click Works' }))]);
    expect(both.map((reply) => reply.data.id)).toEqual(['00000000-0000-4000-8000-0000000000aa', '00000000-0000-4000-8000-0000000000aa']);
    expect([await named('Sri Balaji Fabricators'), await named('Double Click Works')].map((ids) => ids.length)).toEqual([1, 1]);
  });

  it('is never overwritten by sending other details under the same id', async () => {
    const body = counter({ name: 'Original Party' });
    await add(body);
    expect((await add({ ...body, name: 'Changed Party', phone: '9000000009' })).data).toMatchObject({ name: 'Original Party', phone: null });
  });

  it('is not made when its GSTIN is already in the books: that customer is offered', async () => {
    const reply = await add(counter({ name: 'Murugan Engg', gstin: GSTIN.tn, address: 'x' }));
    expect(reply).toMatchObject({ status: 409, error: { code: 'CUSTOMER_EXISTS', message: 'This GSTIN is already Murugan Engineering Works' } });
    expect(details(reply)).toMatchObject({ existing: { id: md.tnCustomerId, name: 'Murugan Engineering Works', is_active: true }, same_name: false });
    expect(details(await add(counter({ name: 'MURUGAN ENGINEERING WORKS', gstin: GSTIN.tn, address: 'x' })))).toMatchObject({ same_name: true });
    expect(await named('Murugan Engg')).toEqual([]);
  });

  it('is offered even when it is switched off, so there is a way out', async () => {
    const off = await add(counter({ name: 'Switched Off Ltd', gstin: '27AAPFU0939F1ZV', state_code: '27', address: 'Pune' }));
    await db.query('update public.customers set is_active = false where id = $1', [off.data.id]);
    expect(details(await add(counter({ name: 'Other name', gstin: '27AAPFU0939F1ZV', state_code: '27', address: 'Pune' })))).toMatchObject({ existing: { id: off.data.id, is_active: false } });
  });

  it('is not made beside a like-sounding one, or one with the same phone, until the owner says it is different', async () => {
    const known = await add(counter({ name: 'Anbu Tools', phone: '9443300001' }));
    const alike = counter({ name: 'Anbu Tool (P) Ltd' });
    const asked = await add(alike);
    expect(asked).toMatchObject({ status: 409, error: { code: 'CUSTOMER_SIMILAR' } });
    expect(details(asked)?.candidates?.map((one) => one.id)).toEqual([known.data.id]);
    const sharing = await add(counter({ name: 'Quite Another', phone: '+91 94433 00001' }));
    expect(details(sharing)?.candidates).toMatchObject([{ id: known.data.id, name: 'Anbu Tools', phone: '9443300001' }]);
    expect(await named('Anbu Tool (P) Ltd')).toEqual([]);

    expect(await add({ ...alike, different_from: [known.data.id] })).toMatchObject({ status: 201, data: { id: alike.id } });
    const third = await add(counter({ name: 'ANBU TOOLS' }));
    expect(details(third)?.candidates?.map((one) => one.id).sort()).toEqual([known.data.id, alike.id].sort());
    // Ruling out one of two does not rule out the other.
    expect(details(await add(counter({ name: 'ANBU TOOLS', different_from: [known.data.id] })))?.candidates?.map((one) => one.id)).toEqual([alike.id]);
  });

  it('is not confused with customers that are switched off', async () => {
    const old = await add(counter({ name: 'Retired Party' }));
    await db.query('update public.customers set is_active = false where id = $1', [old.data.id]);
    expect(await add(counter({ name: 'Retired Party' }))).toMatchObject({ status: 201 });
  });

  it('is compared with every customer, not the first thousand', async () => {
    await db.exec(`insert into public.customers (name, state_code, credit_days) select 'Crowd ' || lpad(i::text, 5, '0'), '33', 0 from generate_series(1, 1200) as i`);
    const { rows } = await db.query<{ id: string }>(`insert into public.customers (id, name, state_code, credit_days) values ('ffffffff-ffff-4fff-8fff-ffffffffffff', 'Zulu Precision', '33', 0) returning id`);
    expect(details(await add(counter({ name: 'Zulu Precision' })))?.candidates?.map((one) => one.id)).toEqual([rows[0]?.id]);
    await db.exec(`delete from public.customers where name like 'Crowd %' or name = 'Zulu Precision'`);
  });

  it('follows the same rules as any customer', async () => {
    expect(await add(counter({ name: '' }))).toMatchObject({ status: 400 });
    expect(await add(counter({ gstin: '33ABCPV1357D1ZY', address: 'x' }))).toMatchObject({ status: 400, error: { message: expect.stringContaining('not valid') } });
    expect(await add(counter({ id: 'nope' }))).toMatchObject({ status: 400 });
    expect(await add(counter({ name: 'Stranger Danger' }), ACTORS.stranger)).toMatchObject({ status: 403 });
  });

  it('leaves the Customers page as it was: no id, no questions', async () => {
    const plain = { ...counter({ name: 'Anbu Tools' }) } as Record<string, unknown>;
    delete plain.id;
    delete plain.different_from;
    expect(await add(plain)).toMatchObject({ status: 201 });
  });

  it('is found by phone and by GSTIN too', async () => {
    const { GET } = await import('@/app/api/customers/route');
    const find = async (q: string) => ((await call(GET, { search: `?${new URLSearchParams({ q }).toString()}` })).data.rows as { name: string }[]).map((row) => row.name);
    expect(await find('9443300001')).toEqual(['Anbu Tools']);
    expect(await find(GSTIN.tn.toLowerCase())).toEqual(['Murugan Engineering Works']);
    expect(await find('murugan eng')).toEqual(['Murugan Engineering Works']);
  });
});

describe('studs', () => {
  const stud = { sku_code: 'm10x100-en8', diameter_mm: '10', length_mm: '100', thread_type: 'ISO metric RH, 1.5 mm pitch, fully threaded', material_grade: 'en8', hsn_sac: '731815', gst_rate_percent: '18' };

  it('computes the formula weight, honours a measured one, and recomputes when dimensions change', async () => {
    const { POST } = await import('@/app/api/stud-items/route');
    const one = await import('@/app/api/stud-items/[id]/route');
    const created = await call(POST, { json: stud });
    expect(created).toMatchObject({ status: 201, data: { sku_code: 'M10X100-EN8', material_grade: 'EN8', unit_weight_kg: '0.061652', unit_weight_is_manual: false } });
    const params = { id: created.data.id as string };
    expect(await call(one.PUT, { method: 'PUT', params, json: { ...stud, length_mm: '200' } })).toMatchObject({ data: { unit_weight_kg: '0.123305' } });
    expect(await call(one.PUT, { method: 'PUT', params, json: { ...stud, manual_unit_weight_kg: '0.0669' } })).toMatchObject({ data: { unit_weight_kg: '0.066900', unit_weight_is_manual: true } });
    expect(await call(POST, { json: stud })).toMatchObject({ status: 409, error: { message: 'Another product already has this code' } });
    expect(await call(POST, { json: { ...stud, sku_code: 'X', default_rate_per_piece: '0.04375' } })).toMatchObject({ status: 400 }); // whole paise
  });
});

describe('products', () => {
  const nut = { name: 'Hex nut M12 GI', hsn_sac: '731816', gst_rate_percent: '18', default_rate_per_piece: '4.50' };
  interface Listed { product_no: number; name: string | null; sku_code: string }
  const add = async (json: Record<string, unknown>, as: Actor = ACTORS.staff) => call((await import('@/app/api/stud-items/route')).POST, { json, as });
  const find = async (q: string, page = 1) =>
    (await call((await import('@/app/api/stud-items/route')).GET, { search: `?${new URLSearchParams({ q, page: String(page) }).toString()}` })).data as unknown as { rows: Listed[]; hasMore: boolean };
  const put = async (id: unknown, json: Record<string, unknown>) =>
    call((await import('@/app/api/stud-items/[id]/route')).PUT, { method: 'PUT', params: { id: id as string }, json });

  it('need a name, HSN and GST %, and get their ID from the database', async () => {
    const first = await add({ ...nut, product_no: 900 });
    const no = first.data.product_no as number;
    expect(first).toMatchObject({
      status: 201,
      data: {
        name: 'Hex nut M12 GI', sku_code: productCode(no), hsn_sac: '731816', gst_rate_percent: '18.00', default_rate_per_piece: '4.500000',
        diameter_mm: null, length_mm: null, thread_type: null, material_grade: null, unit_weight_kg: null, unit_weight_is_manual: false, is_active: true,
      },
    });
    expect(no).toBeLessThan(900);
    expect((await add({ ...nut, name: 'Washer M12' })).data.product_no).toBe(no + 1);
  });

  it('are refused in words when something is missing', async () => {
    expect(await add({ ...nut, gst_rate_percent: '' })).toMatchObject({ status: 400, error: { message: expect.stringContaining('Type the GST %') } });
    expect(await add({ ...nut, hsn_sac: '' })).toMatchObject({ status: 400, error: { message: expect.stringContaining('HSN') } });
    expect(await add({ ...nut, name: '' })).toMatchObject({ status: 400, error: { message: 'Give the product a name' } });
    expect(await add({ ...nut, diameter_mm: '12' })).toMatchObject({ status: 400, error: { message: 'A stud needs its diameter, length, thread and grade' } });
    expect(await add({ ...nut, sku_code: 'P0099' })).toMatchObject({ status: 400, error: { message: expect.stringContaining('given automatically') } });
    await add({ ...nut, sku_code: 'nut-12' });
    expect(await add({ ...nut, sku_code: 'NUT-12' })).toMatchObject({ status: 409, error: { message: 'Another product already has this code' } });
  });

  it('may be given a weight, a size and a code later, and lose them again', async () => {
    const made = await add({ ...nut, name: 'Changing', manual_unit_weight_kg: '0.0125' });
    expect(made.data).toMatchObject({ unit_weight_kg: '0.012500', unit_weight_is_manual: true });
    const size = { diameter_mm: '10', length_mm: '100', thread_type: 'Full thread', material_grade: 'en8' };
    expect((await put(made.data.id, { ...nut, ...size, name: 'Changing', sku_code: 'chg-1' })).data).toMatchObject({
      product_no: made.data.product_no, sku_code: 'CHG-1', diameter_mm: '10.000', material_grade: 'EN8', unit_weight_kg: '0.061652', unit_weight_is_manual: false,
    });
    expect((await put(made.data.id, { ...nut, name: 'Changing' })).data).toMatchObject({
      product_no: made.data.product_no, sku_code: productCode(made.data.product_no as number), diameter_mm: null, unit_weight_kg: null,
    });
  });

  it('are found by ID first, then by part of the name, code or size', async () => {
    const target = await add({ ...nut, name: 'Found by its ID' });
    const no = target.data.product_no as number;
    await add({ ...nut, name: `Spacer ${no} mm` });
    for (const typed of [String(no), `p${no}`, productCode(no), ` ${productCode(no)} `]) {
      const { rows } = await find(typed);
      expect(rows[0], typed).toMatchObject({ product_no: no, name: 'Found by its ID' });
      expect(rows.filter((row) => row.product_no === no), typed).toHaveLength(1);
    }
    expect((await find(String(no))).rows.map((row) => row.name)).toContain(`Spacer ${no} mm`);
    expect((await find('its id')).rows.map((row) => row.name)).toEqual(['Found by its ID']);
    expect((await find('m12x150-e')).rows.map((row) => row.sku_code)).toEqual(['M12X150-EN8']);
    expect((await find('M12X150 EN8')).rows.map((row) => row.sku_code)).toEqual(['M12X150-EN8']); // its size
    expect((await find('100%')).rows).toEqual([]);
    expect((await find('_')).rows).toEqual([]);
    expect((await find('a,b)')).rows).toEqual([]);
  });

  it('are listed by ID, and a search by ID still shows every other match once', async () => {
    const no = (await add({ ...nut, name: 'Asked for' })).data.product_no as number;
    await db.query(`insert into public.stud_items (name, hsn_sac, gst_rate_percent) select 'Lot ' || $1 || ' of ' || i, '7318', 18 from generate_series(1, 120) as i`, [no]);
    const pages = [await find(String(no), 1), await find(String(no), 2), await find(String(no), 3)];
    expect(pages.map((page) => [page.rows.length, page.hasMore])).toEqual([[50, true], [50, true], [21, false]]);
    const seen = pages.flatMap((page) => page.rows.map((row) => row.product_no));
    expect(seen[0]).toBe(no);
    expect(new Set(seen).size).toBe(121);
    expect(seen.slice(1)).toEqual([...seen.slice(1)].sort((a, b) => a - b));
    const all = (await find('')).rows.map((row) => row.product_no);
    expect(all).toEqual([...all].sort((a, b) => a - b));
  });

  it('are nobody else’s business', async () => {
    const { GET } = await import('@/app/api/stud-items/route');
    expect((await call(GET, { search: '?q=1', as: ACTORS.stranger })).data).toMatchObject({ rows: [] });
    expect(await add(nut, ACTORS.stranger)).toMatchObject({ status: 403, error: { code: 'FORBIDDEN' } });
  });
});

describe('billing', () => {
  const draft = () => ({
    client_temp_id: newTempId(), bill_type: 'supply', customer_id: md.tnCustomerId, invoice_date: '2026-11-20', due_date: '2026-12-20',
    lines: [{ stud_item_id: md.studItemId, description: 'M12 x 150 EN8 stud', hsn_sac: '7318', billing_unit: 'pcs', quantity: '1000', rate: '1.50', gst_rate: '18' }],
    delivery: { vehicle_no: 'tn 38 ab 1234', driver_name: 'Ravi', driver_phone: '98765 00000' },
    expected_total_paise: 177_000,
  });
  const sync = async (json: unknown, as: Actor = ACTORS.staff) => call((await import('@/app/api/invoices/sync/route')).POST, { json, as });
  const read = async (invoiceId: unknown) => call((await import('@/app/api/invoices/[id]/route')).GET, { params: { id: invoiceId as string } });

  it('issues a bill, replays a retry, and refuses an edited one', async () => {
    const bill = draft();
    const issued = await sync(bill);
    expect(issued).toMatchObject({ status: 201, data: { invoice_no: 'INV/26-27/0001', dc_no: 'DC/26-27/0001', replayed: false } });
    expect((await sync(bill)).data).toEqual({ ...issued.data, replayed: true });
    const edited = await sync({ ...bill, notes: 'urgent' });
    expect(edited).toMatchObject({
      status: 409,
      error: { code: 'ALREADY_ISSUED', details: { issued: { invoice_id: issued.data.invoice_id, invoice_no: 'INV/26-27/0001', dc_no: 'DC/26-27/0001' } } },
    });
    expect(edited.error.message).toContain('INV/26-27/0001');
    const doc = await read(issued.data.invoice_id);
    expect(doc.data).toMatchObject({
      invoice: { grand_total: '1770.00', cgst: '135.00', supplier_snapshot: { legal_name: 'Demo Stud Works' } },
      items: [{ line_total: '1500.00', cgst_amount: '135.00' }],
      delivery: { vehicle_no: 'TN38AB1234', driver_phone: '9876500000', status: 'pending' },
    });
  });

  it('keeps the buyer’s order on the bill', async () => {
    const issued = await sync({ ...draft(), po_no: '4500012/A', po_date: '2026-11-18' });
    expect((await read(issued.data.invoice_id)).data).toMatchObject({ invoice: { po_no: '4500012/A', po_date: '2026-11-18' } });
    const plain = await sync(draft());
    expect((await read(plain.data.invoice_id)).data).toMatchObject({ invoice: { po_no: null, po_date: null } });
    expect(await sync({ ...draft(), po_date: '2026-11-18' })).toMatchObject({ status: 400 });
  });

  it('never trusts the device’s total', async () => {
    expect(await sync({ ...draft(), expected_total_paise: 100 })).toMatchObject({ status: 409, error: { code: 'TOTAL_CHANGED', message: expect.stringContaining('₹1,770.00') } });
  });

  it('turns typed charges into what the contract and the law need', async () => {
    const kerala = { ...draft(), lines: [{ ...draft().lines[0], rate: '1.00', quantity: '1000' }] }; // Rs 1,000
    // specs/print-templates.md acceptance: TN, packing 20 + freight 30 -> 1239.00
    const tn = await sync({ ...kerala, packing: '20', freight: '30', expected_total_paise: 123_900 });
    expect((await read(tn.data.invoice_id)).data.invoice).toMatchObject({ packing_charge: '20.00', delivery_charge: '30.00', cgst: '94.50', sgst: '94.50', grand_total: '1239.00', charges_cgst: '4.50' });
    // ... out of state, packing as its own line, freight buyer-direct -> 1204.00, round-off 0.40
    const ka = await sync({ ...kerala, client_temp_id: newTempId(), customer_id: md.kaCustomerId, packing: '20', freight: '30', freight_paid_by: 'buyer_to_pay', expected_total_paise: 120_400 });
    expect((await read(ka.data.invoice_id)).data).toMatchObject({
      invoice: { subtotal: '1020.00', igst: '183.60', round_off: '0.40', grand_total: '1204.00', delivery_charge: '0.00' },
      items: [{}, { description: 'Packing charges', line_total: '20.00' }],
      delivery: { freight_paid_by: 'buyer_to_pay', freight_amount: '30.00' },
    });
    // Untaxed delivery becomes a 0% line; packing stays taxed.
    const atCost = await sync({ ...kerala, client_temp_id: newTempId(), packing: '20', freight: '30', delivery_taxable: false, expected_total_paise: 123_400 });
    expect((await read(atCost.data.invoice_id)).data).toMatchObject({
      invoice: { cgst: '91.80', grand_total: '1234.00', round_off: '0.40' },
      items: [{}, { description: 'Packing charges', tax_rate_percent: '18.00' }, { description: 'Delivery, recovered at cost', tax_rate_percent: '0.00' }],
    });
    // Mixed rates: charges are lines at the chosen rate.
    const mixed = [draft().lines[0], { ...draft().lines[0], stud_item_id: null, quantity: '200', rate: '5', gst_rate: '5' }];
    const listed = await sync({ ...draft(), lines: mixed, packing: '100', charges_gst_rate: '5', expected_total_paise: 292_500 });
    expect((await read(listed.data.invoice_id)).data.items).toHaveLength(3);
  });

  it('bills an SEZ unit in Tamil Nadu with IGST', async () => {
    const { POST } = await import('@/app/api/customers/route');
    const sez = await call(POST, { json: { ...customer, name: 'SEZ Unit', gstin: '33AAKCP4321K1ZF', is_sez: true } });
    const issued = await sync({ ...draft(), customer_id: sez.data.id });
    expect((await read(issued.data.invoice_id)).data.invoice).toMatchObject({ place_of_supply: '33', is_sez: true, igst: '270.00', cgst: '0.00' });
  });

  it('moves job-work lots, and frees them when the bill is cancelled', async () => {
    const lots = await import('@/app/api/job-work/route');
    const lot = await call(lots.POST, { json: { customer_id: md.tnCustomerId, party_dc_no: 'PDC-77', party_dc_date: '2026-11-05', material_grade: 'en8', inward_weight_kg: '500' } });
    expect(lot).toMatchObject({ status: 201, data: { balance_weight_kg: '500.000', status: 'open' } });
    const labour = { ...draft(), bill_type: 'job_work', lines: [{ stud_item_id: null, description: 'Threading labour', hsn_sac: '998873', billing_unit: 'kg', quantity: '300.25', rate: '5', gst_rate: '18' }],
      returns: [{ lot_id: lot.data.id, returned_weight_kg: '300.25', scrap_weight_kg: '12.5', pieces: 2400 }], expected_total_paise: 177_100 };
    const issued = await sync(labour);
    expect(issued.status).toBe(201);
    const openLots = async () => (await call(lots.GET, { search: `?customer_id=${md.tnCustomerId}&open=true` })).data.rows as Record<string, unknown>[];
    expect((await openLots()).find((l) => l.id === lot.data.id)).toMatchObject({ balance_weight_kg: '187.250' });
    expect((await read(issued.data.invoice_id)).data.returns).toMatchObject([{ party_dc_no: 'PDC-77', balance_after_kg: '187.250' }]);

    const { POST: cancel } = await import('@/app/api/invoices/[id]/cancel/route');
    const params = { id: issued.data.invoice_id as string };
    expect(await call(cancel, { params, json: { reason: '' } })).toMatchObject({ status: 400 });
    expect(await call(cancel, { params, json: { reason: 'Wrong weight' } })).toMatchObject({ status: 201 });
    expect(await call(cancel, { params, json: { reason: 'Another' } })).toMatchObject({ status: 422 });
    expect((await openLots()).find((l) => l.id === lot.data.id)).toMatchObject({ balance_weight_kg: '500.000' });

    const one = await import('@/app/api/job-work/[id]/route');
    const close = { customer_id: md.tnCustomerId, party_dc_no: 'PDC-77', party_dc_date: '2026-11-05', material_grade: 'EN8', inward_weight_kg: '500', status: 'closed' };
    expect(await call(one.PUT, { method: 'PUT', params: { id: lot.data.id as string }, json: close })).toMatchObject({ status: 422, error: { message: expect.stringMatching(/within 1%/) } });
    expect(await call(one.PUT, { method: 'PUT', params: { id: lot.data.id as string }, json: { ...close, close_reason: 'Material taken back unprocessed' } })).toMatchObject({ data: { status: 'closed' } });
  });

  it('records receipts atomically and lets only the owner void one', async () => {
    const issued = await sync({ ...draft(), paid_now: { amount: '500', mode: 'upi' } });
    const params = { id: issued.data.invoice_id as string };
    const { POST: pay } = await import('@/app/api/invoices/[id]/payments/route');
    const receipt = { client_receipt_id: '33333333-3333-4333-8333-333333333333', amount: '1000', received_on: '2026-11-21', mode: 'bank_transfer', reference: 'UTR 1' };
    expect(await call(pay, { params, json: receipt })).toMatchObject({ status: 201, data: { amount_paid: '1500.00', payment_status: 'partial', replayed: false } });
    expect(await call(pay, { params, json: receipt })).toMatchObject({ data: { amount_paid: '1500.00', replayed: true } });
    expect(await call(pay, { params, json: { ...receipt, client_receipt_id: '44444444-4444-4444-8444-444444444444', amount: '270.01' } })).toMatchObject({ status: 422, error: { message: expect.stringMatching(/only 270.00 is due/) } });
    const { POST: cancel } = await import('@/app/api/invoices/[id]/cancel/route');
    expect(await call(cancel, { params, json: { reason: 'Mistake' } })).toMatchObject({ status: 422, error: { message: expect.stringMatching(/void them/) } });
    const payments = (await read(params.id)).data.payments as { id: string; amount: string }[];
    expect(payments.map((p) => p.amount)).toEqual(['500.00', '1000.00']);
    const { POST: voidIt } = await import('@/app/api/payments/[id]/void/route');
    expect(await call(voidIt, { params: { id: payments[1]!.id }, json: { reason: 'Bounced' } })).toMatchObject({ status: 403 });
    expect(await call(voidIt, { params: { id: payments[1]!.id }, json: { reason: 'Bounced' }, as: ACTORS.owner })).toMatchObject({ data: { amount_paid: '500.00', payment_status: 'partial' } });
  });

  it('updates only the delivery fields that were sent', async () => {
    const issued = await sync({ ...draft(), delivery: { ...draft().delivery, transport_mode: 'transporter', lr_number: 'LR-9' } });
    const delivery = (await read(issued.data.invoice_id)).data.delivery as { id: string };
    const { PATCH } = await import('@/app/api/deliveries/[id]/route');
    const moved = await call(PATCH, { method: 'PATCH', params: { id: delivery.id }, json: { status: 'dispatched' } });
    expect(moved.data).toMatchObject({ status: 'dispatched', transport_mode: 'transporter', lr_number: 'LR-9', vehicle_no: 'TN38AB1234', driver_name: 'Ravi', dispatched_at: expect.any(String) });
    expect(await call(PATCH, { method: 'PATCH', params: { id: delivery.id }, json: { dc_no: 'DC/26-27/9999' } })).toMatchObject({ status: expect.toSatisfy((s: number) => s >= 400) });
  });

  it('refuses to bill until the company profile is filled in', async () => {
    const bare = await createTestDb();
    const full = db;
    try {
      db = bare;
      const { POST } = await import('@/app/api/customers/route');
      const buyer = await call(POST, { json: customer });
      const bill = { ...draft(), customer_id: buyer.data.id, lines: [{ ...draft().lines[0], stud_item_id: null }] };
      expect(await sync(bill)).toMatchObject({ status: 409, error: { code: 'NOT_READY', message: expect.stringMatching(/company profile/) } });
      const company = await import('@/app/api/company/route');
      const profile = { legal_name: 'Demo', gstin: GSTIN.supplier, address: 'Coimbatore' };
      expect(await call(company.PUT, { method: 'PUT', json: { ...profile, gstin: GSTIN.ka }, as: ACTORS.owner })).toMatchObject({ status: 400 });
      expect((await call(company.PUT, { method: 'PUT', json: profile })).status).toBe(403);
      expect(await call(company.PUT, { method: 'PUT', json: profile, as: ACTORS.owner })).toMatchObject({ status: 200 });
      expect(await call(company.PUT, { method: 'PUT', json: { ...profile, legal_name: 'Demo 2' }, as: ACTORS.owner })).toMatchObject({ data: { legal_name: 'Demo 2', tagline: null, factory_address: null, office_phone: null } });
      const before = await sync(bill);
      expect(before).toMatchObject({ status: 201 });
      const head = { tagline: 'Mfrs : Studs', factory_address: '2 Works Road', office_phone: '0422 - 1234567' };
      expect(await call(company.PUT, { method: 'PUT', json: { ...profile, ...head }, as: ACTORS.owner })).toMatchObject({ data: head });
      for (const bad of [{ office_phone: 'call us' }, { office_phone: '123' }, { tagline: 'x'.repeat(161) }]) {
        expect(await call(company.PUT, { method: 'PUT', json: { ...profile, ...bad }, as: ACTORS.owner }), JSON.stringify(bad)).toMatchObject({ status: 400 });
      }
      const after = await sync({ ...bill, client_temp_id: newTempId() });
      expect((await read(after.data.invoice_id)).data).toMatchObject({ invoice: { supplier_snapshot: head } });
      // Issued before the company had these lines: printed without.
      expect((await read(before.data.invoice_id)).data).toMatchObject({ invoice: { supplier_snapshot: { tagline: null, factory_address: null, office_phone: null } } });
    } finally {
      db = full;
      await bare.close();
    }
  });
});
