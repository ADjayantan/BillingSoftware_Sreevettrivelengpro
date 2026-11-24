// Route handlers end to end: real Zod, real supabase-js, real SQL and RLS (PGlite).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createClient as createSupabase } from '@supabase/supabase-js';
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

describe('stud master', () => {
  const stud = { sku_code: 'm10x100-en8', diameter_mm: '10', length_mm: '100', thread_type: 'ISO metric RH, 1.5 mm pitch, fully threaded', material_grade: 'en8', hsn_sac: '731815', gst_rate_percent: '18' };

  it('computes the formula weight, honours a measured one, and recomputes when dimensions change', async () => {
    const { POST } = await import('@/app/api/stud-items/route');
    const one = await import('@/app/api/stud-items/[id]/route');
    const created = await call(POST, { json: stud });
    expect(created).toMatchObject({ status: 201, data: { sku_code: 'M10X100-EN8', material_grade: 'EN8', unit_weight_kg: '0.061652', unit_weight_is_manual: false } });
    const params = { id: created.data.id as string };
    expect(await call(one.PUT, { method: 'PUT', params, json: { ...stud, length_mm: '200' } })).toMatchObject({ data: { unit_weight_kg: '0.123305' } });
    expect(await call(one.PUT, { method: 'PUT', params, json: { ...stud, manual_unit_weight_kg: '0.0669' } })).toMatchObject({ data: { unit_weight_kg: '0.066900', unit_weight_is_manual: true } });
    expect(await call(POST, { json: stud })).toMatchObject({ status: 409, error: { message: 'Another stud already has this SKU' } });
    expect(await call(POST, { json: { ...stud, sku_code: 'X', default_rate_per_piece: '0.04375' } })).toMatchObject({ status: 400 }); // whole paise
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
    expect(edited).toMatchObject({ status: 409, error: { code: 'CONFLICT' } });
    expect(edited.error.message).toContain('INV/26-27/0001');
    const doc = await read(issued.data.invoice_id);
    expect(doc.data).toMatchObject({
      invoice: { grand_total: '1770.00', cgst: '135.00', supplier_snapshot: { legal_name: 'Demo Stud Works' } },
      items: [{ line_total: '1500.00', cgst_amount: '135.00' }],
      delivery: { vehicle_no: 'TN38AB1234', driver_phone: '9876500000', status: 'pending' },
    });
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
      expect(await call(company.PUT, { method: 'PUT', json: { ...profile, legal_name: 'Demo 2' }, as: ACTORS.owner })).toMatchObject({ data: { legal_name: 'Demo 2' } });
      expect(await sync(bill)).toMatchObject({ status: 201 });
    } finally {
      db = full;
      await bare.close();
    }
  });
});
