// A first bill for a customer the books have never heard of, with and without the cloud: real
// Dexie (fake IndexedDB), the real routes and SQL (PGlite). Only the wire is simulated.
import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createClient as createSupabase } from '@supabase/supabase-js';
import { addCustomer, addressSaved, switchedOn, type AddEngine } from '@/lib/add-customer';
import { api } from '@/lib/api-client';
import * as f from '@/lib/bill-form';
import { setConnection } from '@/lib/connection';
import { localCustomer, newCustomer, type CustomerForm } from '@/lib/customer-form';
import { cachedCustomers, keepCustomer, knownMatches, refreshMasters, unsyncedCustomers, type FetchMasters } from '@/lib/master-cache';
import { searchCustomers } from '@/lib/master-search';
import * as store from '@/lib/offline-db';
import { drainQueue, type CreateCustomer, type DrainResult, type SendBill } from '@/lib/offline-sync';
import type { Customer } from '@/lib/schemas/masters';
import { ACTORS, GSTIN, TEST_TODAY, createTestDb, seedMasterData, type MasterData } from './db/harness';
import { pgliteFetch } from './support/postgrest';

let pg: PGlite;
let md: MasterData;
/** What the wire between this PC and the server does, per path. */
let wire: (path: string, method: string) => 'up' | 'down' | '401' | '500' | 'lose-reply';
let calls: string[];

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => {
    const client = createSupabase('http://localhost', 'sb_publishable_test', {
      global: { fetch: pgliteFetch(pg, () => ACTORS.staff) },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    client.auth.getClaims = (async () => ({ data: { claims: {} }, error: null })) as unknown as typeof client.auth.getClaims;
    return client;
  },
}));

type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;
const ROUTES: Record<string, () => Promise<Record<string, unknown>>> = {
  '/api/customers': () => import('@/app/api/customers/route'),
  '/api/invoices/sync': () => import('@/app/api/invoices/sync/route'),
  '/api/offline-cache': () => import('@/app/api/offline-cache/route'),
  '/api/customers/:id': () => import('@/app/api/customers/[id]/route'),
};

async function serve(path: string, init: RequestInit = {}): Promise<Response> {
  const method = init.method ?? 'GET';
  calls.push(`${method} ${path}`);
  const url = new URL(path, 'http://localhost');
  const state = wire(url.pathname, method);
  const error = (status: number, code: string) => Response.json({ error: { code, message: code } }, { status });
  if (state === 'down') throw new TypeError('Failed to fetch');
  if (state === '401') return error(401, 'UNAUTHENTICATED');
  if (state === '500') return error(500, 'INTERNAL');
  const one = /^\/api\/customers\/(.+)$/.exec(url.pathname)?.[1];
  const handler = (await ROUTES[one ? '/api/customers/:id' : url.pathname]?.())?.[method] as Handler | undefined;
  if (!handler) throw new Error(`no route ${method} ${path}`);
  const request = new Request(url, { method, ...(init.headers ? { headers: init.headers } : {}), ...(init.body ? { body: init.body } : {}) });
  const params: Record<string, string> = one ? { id: one } : {};
  const response = await handler(request, { params: Promise.resolve(params) });
  if (state === 'lose-reply') throw new TypeError('network connection was lost'); // after COMMIT
  return response;
}

const send: SendBill = (draft) => api('/api/invoices/sync', 'POST', draft);
const create: CreateCustomer = (body) => api('/api/customers', 'POST', body);
const drain = (db: store.OfflineDb): Promise<DrainResult> => drainQueue(db, send, create);
const fetchMasters: FetchMasters = (kind, since, after) =>
  api(`/api/offline-cache?${new URLSearchParams({ kind, ...(since ? { since } : {}), ...(after ? { after } : {}) }).toString()}`);

let databases = 0;
let db: store.OfflineDb;
/** All that a crash or a closed browser leaves behind: the disk. */
function restart(): void {
  const { name } = db;
  db.close();
  db = new store.OfflineDb(name);
}
const device = (): store.OfflineDb => new store.OfflineDb(`counter-${++databases}`);

beforeAll(async () => {
  pg = await createTestDb();
  md = await seedMasterData(pg);
  vi.stubGlobal('fetch', (input: string, init?: RequestInit) => serve(input, init));
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await pg.close();
});
beforeEach(() => {
  wire = () => 'up';
  calls = [];
  setConnection('online');
  db = device();
});

const typed = (name: string, over: Partial<CustomerForm> = {}): CustomerForm => ({ ...newCustomer(crypto.randomUUID(), name), ...over });
const billFor = (customer: Customer, over: Partial<f.BillForm> = {}): f.BillForm => ({
  ...f.newBill(`OFFLINE-${crypto.randomUUID()}`, TEST_TODAY), customer, customerText: customer.name,
  lines: f.withTrailingBlank([{ ...f.typeGst(f.blankLine(1, 'supply'), '18'), text: 'EN8 M12 x 80 stud', quantity: '50', rate: '12' }], 'supply'),
  packing: '40', freight: '300', freightPaidBy: 'buyer_to_pay', ...over,
});
/** Save & use in this bill, then Save bill: as the screen does it. */
async function bill(form: CustomerForm, on = db, over: Partial<f.BillForm> = {}): Promise<f.BillForm> {
  await store.saveNewCustomer(on, form);
  return queue(billFor(localCustomer(form), over), on);
}
async function queue(form: f.BillForm, on = db): Promise<f.BillForm> {
  const preview = f.previewBill(form);
  if ('problem' in preview) throw new Error(preview.problem);
  await store.enqueueBill(on, { form, draft: f.toDraft(form, preview.bill), customer: form.customer?.name ?? '', total_paise: preview.bill.detail.amounts.grand_total_paise });
  return form;
}
const item = async (form: f.BillForm, on = db): Promise<store.QueueRecord> => {
  const found = await store.queuedBill(on, form.tempId);
  if (!found) throw new Error('not queued');
  return found;
};
const customersNamed = async (name: string) => (await pg.query<{ id: string; gstin: string | null }>('select id, gstin from public.customers where name = $1 order by created_at', [name])).rows;
const invoicesOf = async (form: f.BillForm) =>
  (await pg.query<{ invoice_no: string; customer_id: string; grand_total: string; name: string }>(
    `select invoice_no, customer_id, grand_total::text, customer_snapshot ->> 'name' as name from public.invoices where client_temp_id = $1`, [form.tempId],
  )).rows;

describe('the device’s database', () => {
  it('keeps every draft and queued bill when it is upgraded', async () => {
    const name = `upgrade-${++databases}`;
    const old = new Dexie(name);
    old.version(1).stores({
      drafts: 'temp_id, updated_at', offline_queue: '++seq, &temp_id, status', cached_customers: 'id, name_lc', cached_stud_items: 'id, sku_code', cached_lots: 'id, customer_id', cache_state: 'kind',
    });
    const customer = localCustomer(typed('Old Device Party'));
    const draft = billFor(customer);
    const queued = billFor(customer);
    await old.table('drafts').put({ temp_id: draft.tempId, form: draft, updated_at: 5 });
    await old.table('offline_queue').add({ temp_id: queued.tempId, status: 'pending', customer: customer.name, total_paise: 1, created_at: 1, attempts: 3, message: 'x', issued: null, settled_at: null, draft: null, form: queued });
    await old.table('cached_customers').put({ ...customer, name_lc: 'old device party', pass: 1 });
    old.close();

    const now = new store.OfflineDb(name);
    expect((await store.listDrafts(now)).map((record) => record.form)).toEqual([draft]);
    expect(await store.queuedBill(now, queued.tempId)).toMatchObject({ seq: 1, status: 'pending', attempts: 3, form: queued });
    expect(await now.cached_customers.count()).toBe(1);
    expect(await now.new_customers.count()).toBe(0);
    now.close();
  });

  it('lets a tab that still runs the old version go on saving its bill', async () => {
    const name = `two-versions-${++databases}`;
    const oldTab = new Dexie(name);
    oldTab.version(1).stores({
      drafts: 'temp_id, updated_at', offline_queue: '++seq, &temp_id, status', cached_customers: 'id, name_lc', cached_stud_items: 'id, sku_code', cached_lots: 'id, customer_id', cache_state: 'kind',
    });
    const form = billFor(localCustomer(typed('Two Tabs')));
    await oldTab.table('drafts').put({ temp_id: form.tempId, form, updated_at: 1 });
    const newTab = new store.OfflineDb(name);
    await newTab.new_customers.count(); // opens it: the upgrade happens here
    await oldTab.table('drafts').put({ temp_id: form.tempId, form: { ...form, notes: 'typed later' }, updated_at: 2 });
    expect((await store.listDrafts(newTab))[0]?.form.notes).toBe('typed later');
    oldTab.close();
    newTab.close();
  });
});

describe('offline: a new customer, the browser closed, the PC restarted', () => {
  it('comes back whole, and syncs customer first, then the same bill', async () => {
    wire = () => 'down';
    const form = typed('Sri Balaji Fabricators', { phone: '9000011111', state: '33' });
    const made = await bill(form);
    const before = (await item(made)).draft;
    expect(await drain(db)).toMatchObject({ stopped: 'offline' });
    expect(await customersNamed('Sri Balaji Fabricators')).toEqual([]);
    expect(await invoicesOf(made)).toEqual([]);

    restart();
    expect((await item(made)).form).toEqual(made);
    expect(await db.new_customers.get(form.id)).toMatchObject({ status: 'pending', form });

    wire = () => 'up';
    calls = [];
    expect(await drain(db)).toEqual({ stopped: 'done', message: null });
    expect(calls.filter((call) => call.startsWith('POST'))).toEqual(['POST /api/customers', 'POST /api/invoices/sync']);
    expect(await customersNamed('Sri Balaji Fabricators')).toEqual([{ id: form.id, gstin: null }]);
    const [invoice] = await invoicesOf(made);
    expect(invoice).toMatchObject({ customer_id: form.id, name: 'Sri Balaji Fabricators', grand_total: '755.00' }); // (600 + 40) + 18%; the driver's 300 is not in it
    expect((await item(made))).toMatchObject({ status: 'synced', issued: { invoice_no: invoice?.invoice_no } });
    expect(before).toMatchObject({ customer_id: form.id, client_temp_id: made.tempId }); // nothing in it had to change
    const { rows } = await pg.query(`select freight_paid_by, freight_amount::text as freight from public.deliveries d join public.invoices i on i.id = d.invoice_id where i.client_temp_id = $1`, [made.tempId]);
    expect(rows).toEqual([{ freight_paid_by: 'buyer_to_pay', freight: '300.00' }]);
  });

  it('gets its draft back with the half-typed customer', async () => {
    const half: f.BillForm = { ...f.newBill(`OFFLINE-${crypto.randomUUID()}`, TEST_TODAY), customerText: 'Half Typed', newCustomer: typed('Half Typed', { registered: true, gstin: '33AB', address: 'SIDCO' }), packing: '15' };
    await store.saveDraft(db, half);
    restart();
    expect(f.reviveForm((await store.listDrafts(db))[0]?.form, TEST_TODAY)).toEqual(half);
  });

  it('bills the same new customer twice and makes it once', async () => {
    wire = () => 'down';
    const form = typed('Twice Billed Party');
    const first = await bill(form);
    const second = await queue(billFor(localCustomer(form), { notes: 'second' }));
    await drain(db);
    wire = () => 'up';
    await drain(db);
    expect(await customersNamed('Twice Billed Party')).toHaveLength(1);
    expect([(await invoicesOf(first))[0]?.customer_id, (await invoicesOf(second))[0]?.customer_id]).toEqual([form.id, form.id]);
  });

  it('sends a customer that was saved but not billed', async () => {
    const form = typed('Saved Without A Bill');
    await store.saveNewCustomer(db, form);
    expect(await drain(db)).toMatchObject({ stopped: 'done' });
    expect(await customersNamed('Saved Without A Bill')).toEqual([{ id: form.id, gstin: null }]);
    calls = [];
    await drain(db);
    expect(calls).toEqual([]); // once is enough
  });
});

describe('lost replies and double sending', () => {
  it('makes one customer and one invoice when both replies are lost', async () => {
    const form = typed('Lost Reply Works');
    const made = await bill(form);
    wire = (path) => (path === '/api/customers' ? 'lose-reply' : 'up');
    expect(await drain(db)).toMatchObject({ stopped: 'offline' });
    expect(await invoicesOf(made)).toEqual([]); // the bill waits until the customer is certain
    wire = (path) => (path === '/api/invoices/sync' ? 'lose-reply' : 'up');
    expect(await drain(db)).toMatchObject({ stopped: 'offline' });
    wire = () => 'up';
    expect(await drain(db)).toMatchObject({ stopped: 'done' });
    expect(await customersNamed('Lost Reply Works')).toEqual([{ id: form.id, gstin: null }]);
    expect(await invoicesOf(made)).toHaveLength(1);
  });

  it('keeps one record when Save & use is pressed twice', async () => {
    const form = typed('Pressed Twice');
    await Promise.all([store.saveNewCustomer(db, form), store.saveNewCustomer(db, form)]);
    expect(await db.new_customers.count()).toBe(1);
    await Promise.all([create({ ...(await import('@/lib/customer-form')).customerBody(form) }), create({ ...(await import('@/lib/customer-form')).customerBody(form) })]);
    expect(await customersNamed('Pressed Twice')).toHaveLength(1);
  });

  it('stays what the books have, even if the device saves it again', async () => {
    const form = typed('Already There');
    await store.saveNewCustomer(db, form);
    await drain(db);
    await store.saveNewCustomer(db, { ...form, phone: '9000099999' });
    expect(await db.new_customers.get(form.id)).toMatchObject({ status: 'created' });
  });

  it('waits for a sign-in instead of giving up', async () => {
    const made = await bill(typed('Signed Out Party'));
    wire = () => '401';
    expect(await drain(db)).toMatchObject({ stopped: 'signed_out' });
    expect(await item(made)).toMatchObject({ status: 'pending', attempts: 0 });
  });

  it('a customer that makes the server stumble holds up its own bill only', async () => {
    const stuck = await bill(typed('Stumbling Party'));
    const { rows } = await pg.query<Customer & { opening_balance: string }>('select id, name, gstin, phone, state_code, is_sez, credit_days, address, opening_balance::text, is_active from public.customers where id = $1', [md.tnCustomerId]);
    const other = await queue(billFor(rows[0]!));
    wire = (path) => (path === '/api/customers' ? '500' : 'up');
    expect(await drain(db)).toMatchObject({ stopped: 'retry' });
    expect(await invoicesOf(other)).toHaveLength(1);
    expect(await item(stuck)).toMatchObject({ status: 'pending', attempts: 0, message: expect.any(String) });
  });
});

describe('two devices', () => {
  const registered = (name: string, gstin: string, over: Partial<CustomerForm> = {}) => typed(name, { registered: true, gstin, address: 'SIDCO, Coimbatore', ...over });

  it('with the same GSTIN under different names: the whole bill waits for the owner', async () => {
    const one = device();
    const two = device();
    const first = await bill(registered('Kumaran Industries', '33AAECS2468R1ZS'), one);
    const second = await bill(registered('Kannan Steels', '33AAECS2468R1ZS'), two, { notes: 'deliver Monday' });
    await drain(one);
    expect(await drain(two)).toMatchObject({ stopped: 'done' });
    const held = await item(second, two);
    expect(held).toMatchObject({ status: 'review', attempts: 0, form: second, message: 'This GSTIN is already Kumaran Industries' });
    expect(held.draft).toMatchObject({ client_temp_id: second.tempId, notes: 'deliver Monday' });
    expect(await invoicesOf(second)).toEqual([]);
    expect(await store.queueSummary(two)).toMatchObject({ pending: 0, attention: 1 });
    await store.dismissBill(two, second.tempId); // cannot be thrown away
    expect((await item(second, two)).status).toBe('review');
    expect(store.isReopenable(held)).toBe(true);

    const record = await two.new_customers.get(held.draft?.customer_id ?? '');
    expect(record).toMatchObject({ status: 'review', reason: 'gstin', candidates: [{ name: 'Kumaran Industries', gstin: '33AAECS2468R1ZS' }] });
    await store.joinCustomer(two, record!.id, record!.candidates[0]!);
    expect(await item(second, two)).toMatchObject({ status: 'pending', customer: 'Kumaran Industries', message: null, form: { customer: { name: 'Kumaran Industries' }, tempId: second.tempId, notes: 'deliver Monday' } });
    await drain(two);
    const [kept] = await customersNamed('Kumaran Industries');
    expect(await invoicesOf(second)).toMatchObject([{ customer_id: kept?.id, name: 'Kumaran Industries' }]);
    expect(await customersNamed('Kannan Steels')).toEqual([]);
    expect(await invoicesOf(first)).toHaveLength(1);
  });

  it('with the same GSTIN and the same name: one business, and the owner is told', async () => {
    const one = device();
    const two = device();
    const first = await bill(registered('Velan Precision (P) Ltd', '29AACCB5678G1ZD', { gstin: '27AAPFU0939F1ZV' }), one);
    const second = await bill(registered('VELAN PRECISION PRIVATE LIMITED', '27AAPFU0939F1ZV'), two);
    await drain(one);
    await drain(two);
    const [kept, ...others] = await customersNamed('Velan Precision (P) Ltd');
    expect(others).toEqual([]);
    expect(await invoicesOf(second)).toMatchObject([{ customer_id: kept?.id, name: 'Velan Precision (P) Ltd' }]);
    expect(await invoicesOf(first)).toMatchObject([{ customer_id: kept?.id }]);
    expect((await item(second, two)).message).toBe('Velan Precision (P) Ltd was already in the books with this GSTIN: billed to it');
  });

  it('with like-sounding names: the owner says which, and both answers work', async () => {
    const one = device();
    const [same, different] = [device(), device()];
    await bill(typed('Pandian Tools', { phone: '9000022222' }), one);
    const sameBill = await bill(typed('Pandian Tool'), same);
    const differentForm = typed('Pandiyan Tools', { phone: '9000022222' });
    const differentBill = await bill(differentForm, different);
    for (const each of [one, same, different]) await drain(each);
    const [pandian] = await customersNamed('Pandian Tools');

    const sameRecord = await same.new_customers.get((await item(sameBill, same)).draft?.customer_id ?? '');
    expect(sameRecord).toMatchObject({ status: 'review', reason: 'similar', candidates: [{ id: pandian?.id }] });
    await store.joinCustomer(same, sameRecord!.id, sameRecord!.candidates[0]!);
    await drain(same);
    expect(await invoicesOf(sameBill)).toMatchObject([{ customer_id: pandian?.id }]);

    expect((await item(differentBill, different)).status).toBe('review');
    await store.differentCustomer(different, differentForm.id);
    expect((await item(differentBill, different)).status).toBe('pending');
    await drain(different);
    expect(await customersNamed('Pandiyan Tools')).toEqual([{ id: differentForm.id, gstin: null }]);
    expect(await invoicesOf(differentBill)).toMatchObject([{ customer_id: differentForm.id }]);
  });

  it('billing at the same time get two numbers, and nothing is lost', async () => {
    const one = device();
    const two = device();
    const bills = [await bill(typed('Parallel One'), one), await bill(typed('Parallel Two'), two)];
    await Promise.all([drain(one), drain(two)]);
    const numbers = await Promise.all(bills.map(async (form) => (await invoicesOf(form))[0]?.invoice_no));
    expect(new Set(numbers).size).toBe(2);
    expect(numbers.every(Boolean)).toBe(true);
  });

  it('moves a bill still being typed, and one typed in another tab, to the customer that was chosen', async () => {
    const form = registered('Third Party Name', GSTIN.ka, { gstin: GSTIN.ka });
    const queued = await bill(form);
    const draft = billFor(localCustomer(form));
    await store.saveDraft(db, draft);
    await drain(db);
    const record = (await db.new_customers.get(form.id))!;
    await store.joinCustomer(db, form.id, record.candidates[0]!);
    expect((await store.listDrafts(db))[0]?.form).toMatchObject({ tempId: draft.tempId, customer: { id: md.kaCustomerId, name: 'Bharat Fasteners Pvt Ltd' }, customerText: 'Bharat Fasteners Pvt Ltd' });
    const late = await queue(billFor(localCustomer(form))); // another tab still had the old one in memory
    await drain(db);
    expect((await invoicesOf(late))[0]?.customer_id).toBe(md.kaCustomerId);
    expect((await invoicesOf(queued))[0]?.customer_id).toBe(md.kaCustomerId);
  });
});

describe('details the books refuse', () => {
  it('bring the bill back to be corrected, with the customer form', async () => {
    const form = typed('Wrong State Works', { registered: true, gstin: '33ABCPV1357D1ZX', address: 'x' });
    await store.saveNewCustomer(db, form);
    const made = await queue(billFor(localCustomer(form)));
    await db.new_customers.update(form.id, { form: { ...form, creditDays: '999' } }); // as a damaged record would be
    await drain(db);
    expect(await item(made)).toMatchObject({ status: 'review', attempts: 0 });
    expect(await db.new_customers.get(form.id)).toMatchObject({ status: 'review', reason: null, candidates: [] });
    expect(await store.queueSummary(db)).toMatchObject({ attention: 1, reviews: [{ id: form.id }] });
    expect(await store.reopenBill(db, made.tempId)).toBe(true);
    const back = (await store.listDrafts(db))[0]?.form;
    expect(back).toMatchObject({ tempId: made.tempId, customer: null, customerText: 'Wrong State Works', newCustomer: { id: form.id, creditDays: '999' }, packing: '40' });
    expect(await store.saveNewCustomer(db, form)).toMatchObject({ id: form.id });
    expect(await db.new_customers.get(form.id)).toMatchObject({ status: 'pending' });
    await queue(made);
    await drain(db);
    expect(await invoicesOf(made)).toHaveLength(1);
  });

  it('is said even when the customer has no bill', async () => {
    const form = typed('No Bill Yet', { registered: true, gstin: GSTIN.tn, address: 'x' });
    await store.saveNewCustomer(db, form);
    await drain(db);
    expect(await store.queueSummary(db)).toMatchObject({ pending: 0, attention: 1, items: [], reviews: [{ id: form.id, reason: 'gstin' }] });
  });

  it('can be taken off this device, as long as no bill needs them', async () => {
    const alone = typed('Never Mind', { registered: true, gstin: GSTIN.tn, address: 'x' });
    await store.saveNewCustomer(db, alone);
    const used = typed('Has A Bill', { registered: true, gstin: GSTIN.ka, address: 'x' });
    const made = await bill(used);
    const drafted = typed('Has A Draft', { registered: true, gstin: GSTIN.supplier, address: 'x' });
    await store.saveNewCustomer(db, drafted);
    await store.saveDraft(db, billFor(localCustomer(drafted)));
    const fresh = typed('Still Waiting');
    await store.saveNewCustomer(db, fresh);
    for (const one of [alone, used, drafted]) await store.holdForReview(db, one.id, { reason: 'gstin', candidates: [], message: 'x' });
    for (const one of [alone, used, drafted, fresh]) await store.dropNewCustomer(db, one.id);
    expect((await db.new_customers.toArray()).map((one) => one.form.name).sort()).toEqual(['Has A Bill', 'Has A Draft', 'Still Waiting']);
    expect((await item(made)).status).toBe('review');
  });

  it('a rubbish record does not hide the others from a search', async () => {
    await db.new_customers.put({ id: 'rubbish', status: 'review', form: { id: 3 } as unknown as CustomerForm, reason: null, candidates: [], merged_into: null, message: null, created_at: 1 });
    await store.saveNewCustomer(db, typed('Findable Party'));
    expect((await unsyncedCustomers(db, 'findable')).map((one) => one.name)).toEqual(['Findable Party']);
    expect((await knownMatches(db, typed('Findable Party'))).alike).toHaveLength(1);
  });

  it('do not let a rubbish record stop the others', async () => {
    await db.new_customers.put({ id: 'rubbish', status: 'pending', form: { id: 3 } as unknown as CustomerForm, reason: null, candidates: [], merged_into: null, message: null, created_at: 1 });
    const form = typed('After Rubbish');
    const made = await bill(form);
    expect(await drain(db)).toMatchObject({ stopped: 'done' });
    expect(await db.new_customers.get('rubbish')).toMatchObject({ status: 'review', reason: null });
    expect(await invoicesOf(made)).toHaveLength(1);
  });

  it('release every bill of that customer once they are corrected', async () => {
    const form = typed('Released Party', { registered: true, gstin: '33AAGCT5678C1ZA', address: 'x' });
    await store.saveNewCustomer(db, form);
    const bills = [await queue(billFor(localCustomer(form))), await queue(billFor(localCustomer(form), { notes: 'second' }))];
    await db.new_customers.update(form.id, { form: { ...form, creditDays: '999' } });
    await drain(db);
    expect((await store.queueSummary(db)).attention).toBe(2);
    await store.saveNewCustomer(db, form);
    await drain(db);
    for (const made of bills) expect(await invoicesOf(made)).toHaveLength(1);
  });
});

describe('what a late or wrong answer must not do', () => {
  it('a bill that may have reached the books is never moved to another customer', async () => {
    const form = typed('Never Moved', { registered: true, gstin: '33AAHCM2345D1ZW', address: 'x' });
    const made = await bill(form);
    const seq = (await item(made)).seq;
    await db.offline_queue.update(seq, { attempts: 1 });
    const before = (await item(made)).draft;
    const { rows } = await pg.query<Customer>('select id, name, gstin, phone, state_code, is_sez, credit_days, address, opening_balance::text, is_active from public.customers where id = $1', [md.tnCustomerId]);
    await store.joinCustomer(db, form.id, rows[0]!);
    expect((await item(made)).draft).toEqual(before);
  });

  it('a bill that was sent before is sent again as it is, never left behind', async () => {
    const form = typed('Sent Before');
    const made = await bill(form);
    await db.offline_queue.update((await item(made)).seq, { attempts: 1 });
    await store.holdForReview(db, form.id, { reason: 'similar', candidates: [], message: 'late' });
    expect((await item(made)).status).toBe('pending'); // it may have reached the books: not held
    await drain(db);
    expect(await item(made)).toMatchObject({ status: 'rejected', message: 'The customer of this bill is not in the books: pick the customer again' });
  });

  it('a customer the books have under its own id cannot be turned into another', async () => {
    const form = typed('Already Created Party');
    await store.saveNewCustomer(db, form);
    await drain(db);
    const { rows } = await pg.query<Customer>('select id, name, gstin, phone, state_code, is_sez, credit_days, address, opening_balance::text, is_active from public.customers where id = $1', [md.tnCustomerId]);
    await store.joinCustomer(db, form.id, rows[0]!);
    await store.differentCustomer(db, form.id);
    await store.holdForReview(db, form.id, { reason: 'similar', candidates: [], message: 'late' });
    expect(await db.new_customers.get(form.id)).toMatchObject({ status: 'created', merged_into: null });
  });

  it('an inactive customer with the same GSTIN and name is for the owner to say', async () => {
    const gone = typed('Closed Down Traders', { registered: true, gstin: '29AAKCR6789E1ZN', address: 'x' });
    await store.saveNewCustomer(db, gone);
    await drain(db);
    await pg.query(`update public.customers set is_active = false where id = $1`, [gone.id]);
    const again = device();
    const made = await bill(typed('CLOSED DOWN TRADERS', { registered: true, gstin: '29AAKCR6789E1ZN', address: 'x' }), again);
    await drain(again);
    expect(await item(made, again)).toMatchObject({ status: 'review' });
  });
});

describe('finding people', () => {
  it('finds a customer that only this device has, offline and online, and says so', async () => {
    const pc = new store.OfflineDb(); // the PC's own database, which the engine uses
    await refreshMasters(pc, fetchMasters);
    await store.saveNewCustomer(pc, typed('Only Here Party', { phone: '9000033333' }));
    for (const state of ['up', 'down'] as const) {
      wire = () => state;
      setConnection('online');
      for (const q of ['only here', '9000033333']) {
        expect((await searchCustomers(q)).map((option) => [option.label, option.detail])).toEqual([['Only Here Party', 'No GSTIN · Tamil Nadu (33) · new, saved on this device']]);
      }
    }
    expect((await unsyncedCustomers(pc, 'only')).map((one) => one.name)).toEqual(['Only Here Party']);
    wire = () => 'up';
    await drain(pc);
    expect(await unsyncedCustomers(pc, 'only')).toEqual([]);
    expect((await cachedCustomers(pc, 'only here')).map((one) => one.name)).toEqual(['Only Here Party']);
    expect((await searchCustomers('only here')).map((option) => option.detail)).toEqual(['No GSTIN · Tamil Nadu (33)']);
    pc.close();
  });

  it('finds the copy by name, phone and GSTIN', async () => {
    await refreshMasters(db, fetchMasters);
    for (const q of ['murugan eng', '98765432', GSTIN.tn.toLowerCase()]) expect((await cachedCustomers(db, q)).map((one) => one.name)).toEqual(['Murugan Engineering Works']);
  });

  it('knows a match before anything is sent: in the copy, and among the customers waiting here', async () => {
    await refreshMasters(db, fetchMasters);
    expect(await knownMatches(db, typed('Anybody', { registered: true, gstin: GSTIN.tn }))).toMatchObject({ gstin: { id: md.tnCustomerId } });
    expect((await knownMatches(db, typed('Murugan Engg Works'))).alike.map((one) => one.id)).toEqual([md.tnCustomerId]);
    expect((await knownMatches(db, typed('Murugan Engg Works', { differentFrom: [md.tnCustomerId] }))).alike).toEqual([]);
    const waiting = typed('Waiting Here', { registered: true, gstin: '33AAFCW1234B1ZY', address: 'x' });
    await store.saveNewCustomer(db, waiting);
    expect(await knownMatches(db, typed('Other', { registered: true, gstin: '33AAFCW1234B1ZY' }))).toMatchObject({ gstin: { id: waiting.id } });
    expect((await knownMatches(db, typed('Waiting  here')))).toMatchObject({ alike: [{ id: waiting.id }] });
    expect(await knownMatches(db, waiting)).toEqual({ gstin: null, alike: [] }); // not a match of itself
  });

  it('signing out takes what the books have, never what is still waiting', async () => {
    await store.saveNewCustomer(db, typed('Goes Away'));
    await drain(db);
    const waiting = typed('Must Stay');
    await store.saveNewCustomer(db, waiting);
    await store.forgetMasters(db);
    expect((await db.new_customers.toArray()).map((record) => record.id)).toEqual([waiting.id]);
  });
});

describe('Save & use in this bill', () => {
  const engine = (on = db): AddEngine => ({
    knownMatches: (form) => knownMatches(on, form),
    saveNewCustomer: (form) => store.saveNewCustomer(on, form),
    keepCustomer: async (customer) => {
      await store.markCreated(on, customer.id);
      await keepCustomer(on, customer);
    },
    newCustomer: (id) => on.new_customers.get(id),
  });
  const rowOf = async (id: string) => (await pg.query<Customer>('select id, name, gstin, phone, state_code, is_sez, credit_days, address, opening_balance::text, is_active from public.customers where id = $1', [id])).rows[0]!;

  it('with the cloud: the customer is in the books at once, and in this PC’s copy', async () => {
    const form = typed('Counter Online Party', { phone: '90000 44444' });
    expect(await addCustomer(form, engine())).toMatchObject({ customer: { id: form.id, name: 'Counter Online Party', phone: '9000044444' }, here: false });
    expect(await customersNamed('Counter Online Party')).toHaveLength(1);
    expect((await cachedCustomers(db, '9000044444')).map((one) => one.id)).toEqual([form.id]);
    expect(await db.new_customers.count()).toBe(0);
  });

  it('without it: kept on this device, and used', async () => {
    wire = () => 'down';
    const form = typed('Counter Offline Party');
    expect(await addCustomer(form, engine())).toMatchObject({ customer: { id: form.id }, here: true });
    expect(await db.new_customers.get(form.id)).toMatchObject({ status: 'pending' });
  });

  it('does not wait for a cloud that is known to be silent', async () => {
    setConnection('offline');
    await addCustomer(typed('Known Offline Party'), engine());
    expect(calls).toEqual([]);
  });

  it('a lost reply or a double click makes one customer', async () => {
    const form = typed('Counter Lost Reply');
    wire = () => 'lose-reply';
    expect(await addCustomer(form, engine())).toMatchObject({ here: true });
    wire = () => 'up';
    await drain(db);
    expect(await customersNamed('Counter Lost Reply')).toEqual([{ id: form.id, gstin: null }]);
    setConnection('online');
    const twice = typed('Counter Double Click');
    const both = await Promise.all([addCustomer(twice, engine()), addCustomer(twice, engine())]);
    expect(both).toMatchObject([{ customer: { id: twice.id } }, { customer: { id: twice.id } }]);
    expect(await customersNamed('Counter Double Click')).toHaveLength(1);
  });

  it('offers the customer who has the GSTIN, with and without the cloud', async () => {
    await refreshMasters(db, fetchMasters);
    for (const state of ['up', 'down'] as const) {
      wire = () => state;
      setConnection('online');
      const found = await addCustomer(typed('Somebody Else', { registered: true, gstin: GSTIN.tn, address: 'x' }), engine());
      expect(found).toMatchObject({ match: { reason: 'gstin', candidates: [{ id: md.tnCustomerId, name: 'Murugan Engineering Works' }] } });
    }
    expect(await customersNamed('Somebody Else')).toEqual([]);
    expect(await db.new_customers.count()).toBe(0);
  });

  it('asks about a like-sounding name, and takes "different" for an answer', async () => {
    await refreshMasters(db, fetchMasters);
    for (const [state, name, other] of [['up', 'Murugan Engineering Work', md.tnCustomerId], ['down', 'M/s Bharat Fastener', md.kaCustomerId]] as const) {
      wire = () => state;
      setConnection('online');
      const form = typed(name);
      expect(await addCustomer(form, engine())).toMatchObject({ match: { reason: 'similar', candidates: [{ id: other }] } });
      expect(await addCustomer({ ...form, differentFrom: [other] }, engine())).toMatchObject({ customer: { id: form.id }, here: state === 'down' });
    }
  });

  it('signed out: kept for the next sign-in, without asking the copy', async () => {
    await refreshMasters(db, fetchMasters);
    wire = () => '401';
    const form = typed('Murugan Engineering Works');
    expect(await addCustomer(form, engine())).toMatchObject({ here: true });
    wire = () => 'up';
    await drain(db);
    expect(await db.new_customers.get(form.id)).toMatchObject({ status: 'review', reason: 'similar' });
  });

  it('says what the books refuse, and saves nothing', async () => {
    expect(await addCustomer(typed('Refused', { creditDays: '999' }), engine())).toMatchObject({ problem: expect.any(String) });
    expect(await db.new_customers.count()).toBe(0);
  });

  it('a browser without a store needs the internet, and says so', async () => {
    expect(await addCustomer(typed('No Store Party'), null)).toMatchObject({ customer: { name: 'No Store Party' }, here: false });
    wire = () => 'down';
    expect(await addCustomer(typed('No Store Offline'), null)).toMatchObject({ problem: expect.stringContaining('internet') });
  });

  it('an address typed in the bill is saved with the customer, and changes nothing else', async () => {
    const form = typed('Address Later', { phone: '9000055555', creditDays: '7' });
    const added = await addCustomer(form, engine());
    if (!('customer' in added)) throw new Error('not added');
    await pg.query(`update public.customers set phone = '9000066666' where id = $1`, [form.id]); // changed meanwhile by somebody else
    expect(await addressSaved(added.customer, ' 12 SIDCO, Coimbatore ', engine())).toMatchObject({ customer: { id: form.id, address: '12 SIDCO, Coimbatore', phone: '9000066666', credit_days: 7 } });
    expect(await rowOf(form.id)).toMatchObject({ address: '12 SIDCO, Coimbatore', phone: '9000066666', credit_days: 7 });
    wire = () => 'down';
    expect(await addressSaved(added.customer, 'elsewhere', engine())).toMatchObject({ problem: expect.stringContaining('internet') });
  });

  it('for a customer only this device has, offline too', async () => {
    wire = () => 'down';
    const form = typed('Address Offline');
    const made = await addCustomer(form, engine());
    if (!('customer' in made)) throw new Error('not added');
    expect(await addressSaved(made.customer, 'Peelamedu', engine())).toMatchObject({ customer: { id: form.id, address: 'Peelamedu' } });
    const big = billFor(localCustomer({ ...form, address: 'Peelamedu' }), { lines: f.withTrailingBlank([{ ...f.typeGst(f.blankLine(1, 'supply'), '18'), text: 'Studs', quantity: '100', rate: '600' }], 'supply') });
    await queue(big);
    wire = () => 'up';
    await drain(db);
    expect(await rowOf(form.id)).toMatchObject({ address: 'Peelamedu' });
    expect(await invoicesOf(big)).toHaveLength(1);
  });

  it('a bill that came back for its customer goes out once the books have taken the corrected details', async () => {
    const form = typed('Corrected Online', { registered: true, gstin: '29AAKCR6789E1ZN', address: 'x' }); // the GSTIN of somebody else
    const held = await bill(form);
    const second = await queue(billFor(localCustomer(form), { notes: 'second' }));
    await drain(db);
    expect((await item(held)).status).toBe('review');
    await store.reopenBill(db, held.tempId);
    const right = { ...form, gstin: '33AAHCM2345D1ZW' };
    const added = await addCustomer(right, engine());
    if (!('customer' in added)) throw new Error('not added');
    expect(added.here).toBe(false);
    expect(await db.new_customers.get(form.id)).toMatchObject({ status: 'created', reason: null, candidates: [] });
    expect((await item(second)).status).toBe('pending'); // the other one goes too
    await queue(f.takeCustomer(held, added.customer));
    await drain(db);
    expect(await invoicesOf(held)).toMatchObject([{ customer_id: form.id }]);
    expect(await invoicesOf(second)).toMatchObject([{ customer_id: form.id }]);
    expect(await store.queueSummary(db)).toMatchObject({ attention: 0, reviews: [] });
  });

  it('a customer that was switched off is switched on by being used', async () => {
    const form = typed('Switched Off Party');
    const added = await addCustomer(form, engine());
    if (!('customer' in added)) throw new Error('not added');
    expect(await switchedOn(added.customer)).toMatchObject({ customer: { id: form.id } });
    await pg.query(`update public.customers set is_active = false where id = $1`, [form.id]);
    expect(await switchedOn(await rowOf(form.id))).toMatchObject({ customer: { id: form.id, is_active: true } });
    expect(await rowOf(form.id)).toMatchObject({ is_active: true });
  });
});
