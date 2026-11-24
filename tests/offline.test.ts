// The offline engine end to end: real Dexie (fake IndexedDB), the real api client, the real
// routes and SQL (PGlite). Only the wire between browser and server is simulated.
import 'fake-indexeddb/auto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createClient as createSupabase } from '@supabase/supabase-js';
import { api } from '@/lib/api-client';
import { autosave } from '@/lib/autosave';
import * as f from '@/lib/bill-form';
import { connection, setConnection } from '@/lib/connection';
import { LIMITS, cachedCustomers, cachedOpenLots, cachedStuds, refreshMasters, type FetchMasters } from '@/lib/master-cache';
import { openLots, searchCustomers, searchStuds } from '@/lib/master-search';
import * as store from '@/lib/offline-db';
import { drainQueue, judge, type SendBill } from '@/lib/offline-sync';
import type { BillDraftInput } from '@/lib/schemas/invoices';
import type { Customer, JobWorkLot } from '@/lib/schemas/masters';
import { ACTORS, TEST_TODAY, createTestDb, seedMasterData, type MasterData } from './db/harness';
import { pgliteFetch } from './support/postgrest';

let pg: PGlite;
let md: MasterData;
/** What the wire between this PC and the server does. */
let wire: 'up' | 'down' | '503' | 'portal' | '401' | '500' | 'lose-reply';
let calls: string[];
/** The wire between the server and the database loses the reply of the next issue. */
let loseDbReply = false;

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => {
    const client = createSupabase('http://localhost', 'sb_publishable_test', {
      global: {
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const reply = await pgliteFetch(pg, () => ACTORS.staff)(input, init);
          if (loseDbReply && String(input).endsWith('/rpc/sync_invoice')) {
            loseDbReply = false;
            throw new TypeError('fetch failed');
          }
          return reply;
        },
      },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    client.auth.getClaims = (async () => ({ data: { claims: {} }, error: null })) as unknown as typeof client.auth.getClaims;
    return client;
  },
}));

type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;
const ROUTES: Record<string, () => Promise<Record<string, unknown>>> = {
  '/api/customers': () => import('@/app/api/customers/route'),
  '/api/stud-items': () => import('@/app/api/stud-items/route'),
  '/api/job-work': () => import('@/app/api/job-work/route'),
  '/api/invoices/sync': () => import('@/app/api/invoices/sync/route'),
  '/api/offline-cache': () => import('@/app/api/offline-cache/route'),
  '/api/ping': () => import('@/app/api/ping/route'),
};

async function serve(path: string, init: RequestInit = {}): Promise<Response> {
  calls.push(path);
  const error = (status: number, code: string) => Response.json({ error: { code, message: code } }, { status });
  if (wire === 'down') throw new TypeError('Failed to fetch');
  if (wire === '503') return error(503, 'UNAVAILABLE');
  if (wire === '401') return error(401, 'UNAUTHENTICATED');
  if (wire === '500') return error(500, 'INTERNAL');
  if (wire === 'portal') return new Response('<html>Sign in to Wi-Fi</html>', { status: 200, headers: { 'content-type': 'text/html' } });
  const url = new URL(path, 'http://localhost');
  const route = await ROUTES[url.pathname]?.();
  const handler = route?.[init.method ?? 'GET'] as Handler | undefined;
  if (!handler) throw new Error(`no route ${path}`);
  const request = new Request(url, { method: init.method ?? 'GET', ...(init.headers ? { headers: init.headers } : {}), ...(init.body ? { body: init.body } : {}) });
  const response = await handler(request, { params: Promise.resolve({}) });
  if (wire === 'lose-reply') throw new TypeError('network connection was lost'); // after COMMIT
  return response;
}

const send: SendBill = (draft) => api('/api/invoices/sync', 'POST', draft);
const fetchMasters: FetchMasters = (kind, since, after) =>
  api(`/api/offline-cache?${new URLSearchParams({ kind, ...(since ? { since } : {}), ...(after ? { after } : {}) }).toString()}`);

let customer: Customer;
let databases = 0;
let db: store.OfflineDb;
/** Closing and opening again is what a crash or a closed tab leaves behind: only the disk. */
function reopenPc(): void {
  const { name } = db;
  db.close();
  db = new store.OfflineDb(name);
}

beforeAll(async () => {
  pg = await createTestDb();
  md = await seedMasterData(pg);
  vi.stubGlobal('fetch', (input: string, init?: RequestInit) => serve(input, init));
  wire = 'up';
  calls = [];
  const found = await api<{ rows: Customer[] }>('/api/customers?q=Murugan');
  if (!found.ok || !found.data.rows[0]) throw new Error('no customer');
  customer = found.data.rows[0];
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await pg.close();
});
beforeEach(() => {
  wire = 'up';
  calls = [];
  setConnection('online');
  db = new store.OfflineDb(`test-${++databases}`);
});

function typedBill(over: Partial<f.BillForm> = {}): f.BillForm {
  const form = f.newBill(`OFFLINE-${crypto.randomUUID()}`, TEST_TODAY);
  return {
    ...form, customer, customerText: customer.name, packing: '20', freight: '30',
    lines: f.withTrailingBlank([{ ...f.blankLine(1, 'supply'), text: 'Studs M12', quantity: '10', rate: '100' }], 'supply'),
    transport: { ...form.transport, vehicle_no: 'TN38AB1234', driver_name: 'Kumar', lr_number: 'LR9' },
    ...over,
  };
}

async function queue(form: f.BillForm): Promise<BillDraftInput> {
  const preview = f.previewBill(form);
  if ('problem' in preview) throw new Error(preview.problem);
  const draft = f.toDraft(form, preview.bill);
  await store.enqueueBill(db, { form, draft, customer: customer.name, total_paise: preview.bill.detail.amounts.grand_total_paise });
  return draft;
}

const bill = async (form: f.BillForm): Promise<store.QueueRecord> => {
  const item = await store.queuedBill(db, form.tempId);
  if (!item) throw new Error('not queued');
  return item;
};
const invoicesOf = async (form: f.BillForm) =>
  (await pg.query<{ id: string; invoice_no: string; grand_total: string }>('select id, invoice_no, grand_total::text from public.invoices where client_temp_id = $1', [form.tempId])).rows;

describe('draft recovery', () => {
  it('has the first keystroke on disk at once, and the whole bill after a crash', async () => {
    const saver = autosave<f.BillForm>((form) => store.saveDraft(db, form), 300);
    const started = { ...f.newBill(`OFFLINE-${crypto.randomUUID()}`, TEST_TODAY), customerText: 'M' };
    saver.push(started);
    await vi.waitFor(async () => expect(await store.listDrafts(db)).toHaveLength(1), { timeout: 150 });

    const typed = { ...typedBill(), tempId: started.tempId };
    saver.push(typed);
    await saver.flush();
    reopenPc();
    const [draft] = await store.listDrafts(db);
    expect(draft?.temp_id).toBe(started.tempId);
    expect(f.reviveForm(draft?.form, TEST_TODAY)).toEqual(typed);
  });

  it('keeps saving while someone types without a pause, and loses at most one interval', async () => {
    let writes = 0;
    const saver = autosave<f.BillForm>(async (form) => {
      writes += 1;
      await store.saveDraft(db, form);
    }, 40);
    const form = typedBill();
    for (let i = 0; i < 30; i++) {
      saver.push({ ...form, notes: 'x'.repeat(i + 1) });
      await new Promise((resolve) => setTimeout(resolve, 8));
    }
    // Not debounced to the end of typing: several states are already safe.
    expect(writes).toBeGreaterThan(2);
    expect(writes).toBeLessThan(20);
    const onDisk = (await store.listDrafts(db))[0]?.form.notes.length ?? 0;
    expect(onDisk).toBeGreaterThan(15);
    await saver.flush();
    expect((await store.listDrafts(db))[0]?.form.notes).toHaveLength(30);
  });

  it('restores the bill that was on screen, not an older one', async () => {
    const older = typedBill();
    const newer = typedBill({ notes: 'on screen' });
    await store.saveDraft(db, older, 1000);
    await store.saveDraft(db, newer, 2000);
    reopenPc();
    expect((await store.listDrafts(db)).map((draft) => draft.temp_id)).toEqual([newer.tempId, older.tempId]);
  });

  it('opens drafts written by another version, and refuses rubbish', () => {
    const form = typedBill();
    const partial: Partial<f.BillForm> = { tempId: form.tempId, type: 'job_work', lines: [{ ...f.blankLine(1, 'job_work'), text: 'Threading' }] };
    const revived = f.reviveForm(partial, TEST_TODAY);
    expect(revived).toMatchObject({ tempId: form.tempId, type: 'job_work', packing: '', today: TEST_TODAY, transport: { status: 'pending' } });
    expect(revived?.lines.map((line) => line.text)).toEqual(['Threading', '']);
    for (const rubbish of [null, 3, {}, { tempId: 'x', type: 'supply' }, { tempId: form.tempId, type: 'gift' }]) expect(f.reviveForm(rubbish, TEST_TODAY)).toBeNull();
  });

  it('never leaves the same bill both typed and queued', async () => {
    const form = typedBill();
    await store.saveDraft(db, form);
    await queue(form);
    expect(await store.listDrafts(db)).toEqual([]);
    await store.saveDraft(db, { ...form, notes: 'a late autosave' });
    expect(await store.listDrafts(db)).toEqual([]);
    await expect(queue(form)).rejects.toThrow(); // one id, one place in the queue
    expect(await store.listDrafts(db)).toEqual([]);
  });

  it('gives a draft to one tab only, and to the next tab once the first is gone', async () => {
    const tab = async () => {
      vi.resetModules();
      return import('@/lib/offline-client');
    };
    const first = await tab();
    const form = typedBill();
    await first.saveDraft(form);
    const mine = await first.openDraft(null, 'OFFLINE-a');
    expect(mine.record?.temp_id).toBe(form.tempId);
    const second = await tab();
    const other = await second.openDraft(null, 'OFFLINE-b');
    expect(other.record).toBeNull();
    other.release();
    mine.release(); // what the browser does when a tab crashes
    expect((await second.openDraft(null, 'OFFLINE-c')).record?.temp_id).toBe(form.tempId);
    await second.deleteDraft(form.tempId);
  });
});

describe('offline queue', () => {
  it('waits while offline and goes out unchanged when the internet is back', async () => {
    const form = typedBill();
    const draft = await queue(form);
    wire = 'down';
    expect(await drainQueue(db, send)).toMatchObject({ stopped: 'offline' });
    expect(await bill(form)).toMatchObject({ status: 'pending', attempts: 1 });
    expect(connection()).toBe('offline');
    reopenPc(); // and the PC is switched off overnight
    expect((await bill(form)).draft).toEqual(draft);
    expect((await bill(form)).draft).toMatchObject({ client_temp_id: form.tempId, expected_total_paise: 123_900, delivery: { vehicle_no: 'TN38AB1234', lr_number: 'LR9' } });
    wire = 'up';
    expect(await drainQueue(db, send)).toEqual({ stopped: 'done', message: null });
    const [invoice] = await invoicesOf(form);
    // Issued: the number is kept, the bill itself is not (no invoice history on the device).
    expect(await bill(form)).toMatchObject({ status: 'synced', draft: null, form: null, issued: { invoice_id: invoice?.id, invoice_no: invoice?.invoice_no } });
    expect(connection()).toBe('online');
  });

  it('sends in the order typed, so numbers follow', async () => {
    const forms = [typedBill(), typedBill(), typedBill()];
    for (const form of forms) await queue(form);
    await drainQueue(db, send);
    const numbers = await Promise.all(forms.map(async (form) => Number((await bill(form)).issued?.invoice_no.split('/')[2])));
    expect(numbers).toEqual([numbers[0], (numbers[0] ?? 0) + 1, (numbers[0] ?? 0) + 2]);
  });

  it('issues once when the reply is lost after the books were written', async () => {
    const form = typedBill();
    await queue(form);
    wire = 'lose-reply';
    expect((await drainQueue(db, send)).stopped).toBe('offline');
    const [issued] = await invoicesOf(form);
    expect(issued).toBeDefined();
    expect(await bill(form)).toMatchObject({ status: 'pending', attempts: 1 });
    // It may be out: not editable, not dismissable.
    expect(store.isReopenable(await bill(form))).toBe(false);
    expect(await store.reopenBill(db, form.tempId)).toBe(false);
    await store.dismissBill(db, form.tempId);
    reopenPc();
    wire = 'up';
    await drainQueue(db, send);
    await drainQueue(db, send);
    expect(await invoicesOf(form)).toEqual([issued]);
    expect((await bill(form)).issued?.invoice_no).toBe(issued?.invoice_no);
  });

  it('replays, not conflicts, when the database answered but the server never heard', async () => {
    const form = typedBill();
    await queue(form);
    loseDbReply = true;
    expect((await drainQueue(db, send)).stopped).toBe('offline');
    expect((await bill(form)).status).toBe('pending');
    expect(await invoicesOf(form)).toHaveLength(1);
    await drainQueue(db, send);
    expect(await bill(form)).toMatchObject({ status: 'synced', issued: { invoice_no: (await invoicesOf(form))[0]?.invoice_no } });
  });

  it.each(['503', 'portal', '401'] as const)('keeps the bill on %s', async (answer) => {
    const form = typedBill();
    await queue(form);
    wire = answer;
    expect((await drainQueue(db, send)).stopped).toBe(answer === '401' ? 'signed_out' : 'offline');
    expect((await bill(form)).status).toBe('pending');
    expect(connection()).toBe(answer === '401' ? 'signed_out' : 'offline');
  });

  it('lets a bill the server stumbles on wait without blocking the rest', async () => {
    const bad = typedBill();
    const good = typedBill();
    await queue(bad);
    await queue(good);
    const result = await drainQueue(db, (draft) => {
      wire = draft.client_temp_id === bad.tempId ? '500' : 'up';
      return send(draft);
    });
    expect(result.stopped).toBe('retry');
    expect((await bill(bad)).status).toBe('pending');
    expect((await bill(good)).status).toBe('synced');
  });

  it('hands a refused bill back under its own id, and the next one still goes out', async () => {
    const stale = typedBill({ invoiceDate: '2026-09-01', dueDate: '2026-12-01' });
    const good = typedBill();
    await queue(stale);
    await queue(good);
    expect((await drainQueue(db, send)).stopped).toBe('done');
    expect(await bill(stale)).toMatchObject({ status: 'rejected', message: expect.stringContaining('31 days') as string });
    expect((await bill(good)).status).toBe('synced');
    expect(await store.queueSummary(db)).toMatchObject({ pending: 0, attention: 1 });
    expect(await store.reopenBill(db, stale.tempId)).toBe(true);
    const [draft] = await store.listDrafts(db);
    expect(draft?.form).toEqual(stale);
    await queue({ ...stale, invoiceDate: TEST_TODAY });
    await drainQueue(db, send);
    expect(await invoicesOf(stale)).toHaveLength(1);
  });

  it('may be edited while it has never been sent', async () => {
    const form = typedBill();
    await queue(form);
    expect(await store.reopenBill(db, form.tempId)).toBe(true);
    expect(await store.queuedBill(db, form.tempId)).toBeUndefined();
  });

  it('does not send a damaged record', async () => {
    const form = typedBill();
    await queue(form);
    await db.offline_queue.where('temp_id').equals(form.tempId).modify((item) => {
      if (item.draft) item.draft.lines = [];
    });
    await drainQueue(db, send);
    expect((await bill(form)).status).toBe('rejected');
    expect(calls).not.toContain('/api/invoices/sync');
  });

  it('remembers only the last few issued bills', async () => {
    for (let i = 0; i < 25; i++) {
      const form = typedBill();
      await queue(form);
      await db.offline_queue.where('temp_id').equals(form.tempId).modify({ status: 'synced' });
    }
    await store.pruneSynced(db);
    expect(await db.offline_queue.count()).toBe(20);
  });

  it('treats setup problems as "not yet", never as a bad bill', () => {
    const refusal = (code: string, status: number) => judge({ ok: false, status, code, message: 'm' });
    expect(refusal('NOT_READY', 409)).toMatchObject({ kind: 'wait', reason: 'not_ready' });
    expect(refusal('FORBIDDEN', 403).kind).toBe('wait');
    expect(refusal('SLOW_DOWN', 429).kind).toBe('wait');
    expect(refusal('TOTAL_CHANGED', 409).kind).toBe('rejected');
    expect(judge({ ok: true, data: {} as never }).kind).toBe('wait');
  });
});

describe('409: already issued', () => {
  it('shows the issued invoice when the resend no longer matches it', async () => {
    const form = typedBill();
    await queue(form);
    wire = 'lose-reply';
    await drainQueue(db, send);
    const [issued] = await invoicesOf(form);
    await db.offline_queue.where('temp_id').equals(form.tempId).modify((item) => {
      if (item.draft) item.draft.notes = 'changed meanwhile';
    });
    wire = 'up';
    expect((await drainQueue(db, send)).stopped).toBe('done');
    const settled = await bill(form);
    expect(settled).toMatchObject({
      status: 'conflict', message: `This bill was already issued as ${issued?.invoice_no}`,
      issued: { invoice_id: issued?.id, invoice_no: issued?.invoice_no, grand_total: '1239.00' }, draft: null, form: null,
    });
    expect(await store.queueSummary(db)).toMatchObject({ pending: 0, attention: 1 });
    expect(store.isReopenable(settled)).toBe(false);
    expect(await invoicesOf(form)).toHaveLength(1);
    await store.dismissBill(db, form.tempId);
    expect(await store.queueSummary(db)).toMatchObject({ attention: 0 });
  });

  it('is found even when the resend fails for another reason, so nobody bills it twice', async () => {
    const { POST } = await import('@/app/api/customers/route');
    const created = (await (await (POST as unknown as Handler)(
      new Request('http://localhost/api/customers', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Moving Works', gstin: '', phone: '', state_code: '33', credit_days: 0, address: 'x', opening_balance: '0' }),
      }),
      { params: Promise.resolve({}) },
    )).json()) as { data: Customer };
    const form = typedBill({ customer: created.data, customerText: 'Moving Works', lines: [{ ...f.blankLine(1, 'supply'), text: 'Stud', quantity: '1', rate: '10.01' }], packing: '', freight: '' });
    await queue(form);
    wire = 'lose-reply';
    await drainQueue(db, send);
    const [issued] = await invoicesOf(form);
    // The customer moves to Kerala: the recomputed total may differ (TOTAL_CHANGED), and "check the bill
    // and save again" would be a second invoice for the same goods.
    await pg.query("update public.customers set state_code = '32' where id = $1", [created.data.id]);
    await db.offline_queue.where('temp_id').equals(form.tempId).modify((item) => {
      if (item.draft) item.draft.expected_total_paise += 100;
    });
    wire = 'up';
    await drainQueue(db, send);
    expect(await bill(form)).toMatchObject({ status: 'conflict', issued: { invoice_no: issued?.invoice_no } });
    expect(await invoicesOf(form)).toHaveLength(1);
  });

  it('still says TOTAL_CHANGED when there is no invoice', async () => {
    const form = typedBill();
    await queue(form);
    await db.offline_queue.where('temp_id').equals(form.tempId).modify((item) => {
      if (item.draft) item.draft.expected_total_paise += 100;
    });
    await drainQueue(db, send);
    expect(await bill(form)).toMatchObject({ status: 'rejected', message: expect.stringContaining('₹1,239.00') as string });
    expect(await invoicesOf(form)).toEqual([]);
  });
});

describe('master copy', () => {
  it('walks every page, then only what changed, and drops what is no longer live', async () => {
    await pg.exec(`insert into public.customers (name, state_code, credit_days, address)
                   select 'Bulk ' || lpad(i::text, 3, '0'), '33', 0, 'x' from generate_series(1, 120) as i`);
    expect(await refreshMasters(db, fetchMasters)).toBe(true);
    const pages = calls.filter((path) => path.includes('kind=customers'));
    expect(pages.length).toBeGreaterThan(2);
    expect(await db.cached_customers.count()).toBe((await pg.query<{ n: number }>('select count(*)::int as n from public.customers where is_active')).rows[0]?.n);

    await pg.exec(`update public.customers set is_active = false where name = 'Bulk 001'`);
    await pg.exec(`update public.customers set name = 'Bulk renamed' where name = 'Bulk 002'`);
    calls = [];
    expect(await refreshMasters(db, fetchMasters, Date.now() + 1000)).toBe(true);
    expect(calls.every((path) => path.includes('since='))).toBe(true);
    expect(await cachedCustomers(db, 'bulk 001')).toEqual([]);
    expect((await cachedCustomers(db, 'RENAMED')).map((row) => row.name)).toEqual(['Bulk renamed']);

    // A hard delete leaves no trace to ask for; the daily full pass notices.
    await pg.exec(`delete from public.customers where name = 'Bulk 003'`);
    await refreshMasters(db, fetchMasters, Date.now() + 2000);
    expect(await cachedCustomers(db, 'bulk 003')).toHaveLength(1);
    await refreshMasters(db, fetchMasters, Date.now() + 86_500_000);
    expect(await cachedCustomers(db, 'bulk 003')).toEqual([]);
    expect(await cachedCustomers(db, 'bulk')).toHaveLength(12); // a search never returns the table
  });

  it('keeps the old copy when a refresh breaks half way', async () => {
    await refreshMasters(db, fetchMasters);
    const before = await db.cached_customers.count();
    let served = 0;
    expect(await refreshMasters(db, (kind, since, after) => (served++ > 0 ? Promise.resolve({ ok: false, status: 0, code: 'OFFLINE', message: '' }) : fetchMasters(kind, since, after)), Date.now() + 90_000_000)).toBe(false);
    expect(await db.cached_customers.count()).toBe(before);
  });

  it('has a ceiling', async () => {
    const endless: FetchMasters = (kind, _since, after) => {
      const from = Number(after ?? 0);
      const rows = Array.from({ length: 50 }, (_, i) => ({ id: String(from + i + 1), name: `C${from + i}`, sku_code: `S${from + i}`, status: 'open', is_active: true, customer_id: 'c' }));
      return Promise.resolve({ ok: true, data: { rows, next: String(from + 50), as_of: new Date().toISOString(), kind } });
    };
    await refreshMasters(db, endless);
    expect(await db.cached_customers.count()).toBe(LIMITS.customers);
    expect(await db.cached_lots.count()).toBe(LIMITS.lots);
  });

  it('shows nothing to a signed-in stranger and refuses bad questions', async () => {
    const { GET } = await import('@/app/api/offline-cache/route');
    const ask = async (search: string) => ((GET as unknown as Handler)(new Request(`http://localhost/api/offline-cache${search}`), { params: Promise.resolve({}) }));
    expect((await ask('?kind=payments')).status).toBe(400);
    expect((await ask('?kind=customers&since=yesterday')).status).toBe(400);
    const answer = await ask('?kind=customers');
    expect(answer.headers.get('cache-control')).toBe('no-store');
    expect(JSON.stringify(await answer.json())).not.toMatch(/created_by/);
  });

  it('leaves with the user: sign-out forgets the customers, never an unsent bill', async () => {
    await refreshMasters(db, fetchMasters);
    const form = typedBill();
    await queue(form);
    await store.forgetMasters(db);
    expect(await Promise.all([db.cached_customers.count(), db.cached_stud_items.count(), db.cached_lots.count(), db.cache_state.count()])).toEqual([0, 0, 0, 0]);
    expect((await bill(form)).status).toBe('pending');
  });
});

describe('search falls back to this PC', () => {
  // The engine uses the PC's own database ('studflow').
  const pc = new store.OfflineDb();
  beforeAll(async () => {
    wire = 'up';
    calls = [];
    await pg.query(
      `insert into public.job_work_ledger (customer_id, party_dc_no, party_dc_date, material_grade, inward_weight_kg) values ($1, 'ME/501', $2, 'MS', 100)`,
      [md.tnCustomerId, TEST_TODAY],
    );
    await refreshMasters(pc, fetchMasters);
  });
  afterAll(() => pc.close());

  it.each(['down', '503', 'portal'] as const)('when the cloud is %s', async (answer) => {
    wire = answer;
    expect((await searchCustomers('murug')).map((option) => option.label)).toEqual(['Murugan Engineering Works']);
    expect(connection()).toBe('offline'); // which is what shows "Offline Mode"
    expect((await searchStuds('m12x')).map((option) => option.label)).toEqual(['M12X150-EN8']);
    expect((await openLots(md.tnCustomerId)).map((lot) => lot.party_dc_no)).toEqual(['ME/501']);
    expect(await openLots(md.kaCustomerId)).toEqual([]);
  });

  it('gives the same options online and offline', async () => {
    const online = [await searchCustomers('murug'), await searchStuds('M12X'), await openLots(md.tnCustomerId)];
    wire = 'down';
    const strip = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (key, inner: unknown) => (key === 'pass' || key === 'name_lc' ? undefined : inner)));
    expect(strip([await searchCustomers('murug'), await searchStuds('M12X'), await openLots(md.tnCustomerId)])).toEqual(online);
  });

  it('does not make every keystroke wait for a dead network, and comes back by itself', async () => {
    wire = 'down';
    await searchCustomers('m');
    calls = [];
    await searchCustomers('mu');
    await searchStuds('m12');
    expect(calls).toEqual([]);
    wire = 'up';
    expect((await api('/api/ping')).ok).toBe(true);
    expect(connection()).toBe('online');
    await searchCustomers('mur');
    expect(calls).toEqual(['/api/ping', '/api/customers?q=mur']);
  });

  it('is not a way around signing in', async () => {
    wire = '401';
    expect(await searchCustomers('murug')).toEqual([]);
    expect(connection()).toBe('signed_out');
  });

  it('can bill a whole job-work return from the copy', async () => {
    wire = 'down';
    const [found] = await searchCustomers('murug');
    const lots: JobWorkLot[] = await openLots(found?.value.id ?? '');
    const lot = lots[0];
    if (!found || !lot) throw new Error('cache is empty');
    const form: f.BillForm = {
      ...f.newBill(`OFFLINE-${crypto.randomUUID()}`, TEST_TODAY, 'job_work'), customer: found.value, customerText: found.label, lots,
      lines: [{ ...f.blankLine(1, 'job_work'), text: 'Threading', unit: 'kg', quantity: '40', rate: '12' }],
      returns: { [lot.id]: { ...f.blankReturn, returned: '40' } },
    };
    await queue(form);
    await drainQueue(db, send);
    wire = 'up';
    expect((await drainQueue(db, send)).stopped).toBe('done');
    expect((await bill(form)).status).toBe('synced');
    const { rows } = await pg.query<{ kg: string }>('select outward_weight_kg::text as kg from public.job_work_ledger where id = $1', [lot.id]);
    expect(rows[0]?.kg).toBe('40.000');
  });
});

it('cached studs are searched by SKU in capitals', async () => {
  await refreshMasters(db, fetchMasters);
  expect((await cachedStuds(db, ' m12x150 ')).map((row) => row.sku_code)).toEqual(['M12X150-EN8']);
  expect(await cachedOpenLots(db, 'nobody')).toEqual([]);
});
