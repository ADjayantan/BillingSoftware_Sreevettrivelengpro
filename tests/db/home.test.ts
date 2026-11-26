// 008: the figures of Home, finding bills, what came in and what is still to be sent
// (specs/new-look.md). Every expected figure here is counted by hand.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { ACTORS, asActor, createTestDb, interStatePayload, intraStatePayload, pgError, queryAs, recordPayment, seedMasterData, syncInvoice, type Actor, type MasterData, type Payload } from './harness';

const TODAY = '2026-11-23';

let db: PGlite;
let md: MasterData;
/** 1770.00 each. */
const bills: Record<string, { invoice_id: string; invoice_no: string; dc_no: string }> = {};

const issue = async (name: string, over: Payload, build = intraStatePayload): Promise<void> => {
  bills[name] = await syncInvoice(db, ACTORS.staff, build(md, over));
};
async function call<T = Record<string, unknown>>(fn: string, args: unknown[], actor: Actor = ACTORS.staff, on = db): Promise<T> {
  const [row] = await queryAs<{ r: T }>(on, actor, `select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) as r`, args);
  return row!.r;
}
interface Found {
  counts: Record<string, number>;
  shown: { bills: number; total: string; balance: string };
  rows: { invoice_no: string; customer: string; grand_total: string; amount_paid: string; due_date: string; payment_status: string; cancelled: boolean; po_no: string | null }[];
}
interface Ask { q?: string; show?: string; month?: string | null; customer?: string | null; skip?: number; take?: number }
const find = ({ q = '', show = 'all', month = null, customer = null, skip = 0, take = 50 }: Ask = {}, actor: Actor = ACTORS.staff): Promise<Found> =>
  call<Found>('find_bills', [q, show, month, customer, TODAY, skip, take], actor);
const numbers = (found: Found): string[] => found.rows.map((row) => row.invoice_no);
/** Bills older than 31 days cannot be made in tests through the door; only the date is moved here. */
async function move(name: string, invoiceDate: string, dueDate: string): Promise<void> {
  await db.exec('set session_replication_role = replica');
  await db.query('update public.invoices set invoice_date = $2, due_date = $3 where id = $1', [bills[name]!.invoice_id, invoiceDate, dueDate]);
  await db.exec('set session_replication_role = origin');
}

beforeAll(async () => {
  db = await createTestDb();
  md = await seedMasterData(db);
  await issue('today', { invoice_date: TODAY, due_date: '2026-12-23', po_no: 'PO 100%_A' });
  await issue('todayKa', { invoice_date: TODAY, due_date: '2027-01-07' }, interStatePayload);
  await issue('late', { invoice_date: '2026-11-01', due_date: '2026-11-02' });
  await issue('lateAndPart', { invoice_date: '2026-11-10', due_date: '2026-11-15' });
  await issue('dueToday', { invoice_date: '2026-11-12', due_date: TODAY });
  await issue('paid', { invoice_date: '2026-11-13', due_date: '2026-11-20' });
  await issue('tds', { invoice_date: '2026-11-14', due_date: '2026-11-20' });
  await issue('cancelled', { invoice_date: TODAY, due_date: '2026-11-24' });
  await issue('october', { invoice_date: '2026-11-15', due_date: '2026-12-15' });
  await issue('june', { invoice_date: '2026-11-15', due_date: '2026-12-15' });
  await recordPayment(db, ACTORS.staff, bills.lateAndPart!.invoice_id, '770.00', { received_on: '2026-11-18', mode: 'cash' });
  await recordPayment(db, ACTORS.staff, bills.paid!.invoice_id, '1770.00', { received_on: '2026-11-19', mode: 'upi', reference: 'UTR 42' });
  await recordPayment(db, ACTORS.staff, bills.tds!.invoice_id, '1734.60', { received_on: '2026-11-20', settles_invoice: true });
  await recordPayment(db, ACTORS.staff, bills.today!.invoice_id, '10.00', { received_on: TODAY });
  await asActor(db, ACTORS.owner, async (tx) => {
    await tx.query(`select public.void_payment(id, 'typed twice') from public.payments where invoice_id = $1`, [bills.today!.invoice_id]);
    await tx.query(`update public.invoices set cancelled_at = now(), cancellation_reason = 'wrong customer' where id = $1`, [bills.cancelled!.invoice_id]);
  });
  await move('october', '2026-10-31', '2026-11-30');
  await move('june', '2026-06-30', '2026-07-30');
});
afterAll(async () => {
  await db.close();
});

describe('finding bills', () => {
  it('counts every kind, whatever tab is open', async () => {
    const counts = { all: 10, open: 7, overdue: 3, paid: 2, cancelled: 1 };
    expect((await find()).counts).toEqual(counts);
    expect((await find({ show: 'paid' })).counts).toEqual(counts);
  });

  it('shows each kind; money to collect oldest first, the rest newest first', async () => {
    expect(numbers(await find({ show: 'overdue' }))).toEqual([bills.june, bills.late, bills.lateAndPart].map((bill) => bill!.invoice_no));
    expect(numbers(await find({ show: 'open' })).slice(0, 4)).toEqual([bills.june, bills.late, bills.lateAndPart, bills.dueToday].map((bill) => bill!.invoice_no));
    expect(numbers(await find({ show: 'paid' }))).toEqual([bills.tds, bills.paid].map((bill) => bill!.invoice_no));
    expect(numbers(await find({ show: 'cancelled' }))).toEqual([bills.cancelled!.invoice_no]);
    expect(numbers(await find()).at(-1)).toBe(bills.june!.invoice_no);
  });

  it('a bill due today is not late, and one settled short (TDS) owes nothing', async () => {
    const overdue = numbers(await find({ show: 'overdue' }));
    expect(overdue).not.toContain(bills.dueToday!.invoice_no);
    expect(numbers(await find({ show: 'open' }))).not.toContain(bills.tds!.invoice_no);
  });

  it('adds up what is shown, as text, without the cancelled ones', async () => {
    expect((await find()).shown).toEqual({ bills: 9, total: '15930.00', balance: '11620.00' }); // 9 × 1770; 7 × 1770 − 770
    expect((await find({ show: 'overdue' })).shown).toEqual({ bills: 3, total: '5310.00', balance: '4540.00' });
    expect((await find({ show: 'cancelled' })).shown).toEqual({ bills: 0, total: '0.00', balance: '0.00' });
    expect((await find({ q: 'nobody at all' })).shown).toEqual({ bills: 0, total: '0.00', balance: '0.00' });
  });

  it('finds by number, customer or P.O., in any case, and takes what is typed literally', async () => {
    expect(numbers(await find({ q: bills.late!.invoice_no.toLowerCase() }))).toEqual([bills.late!.invoice_no]);
    expect(numbers(await find({ q: 'BHARAT' }))).toEqual([bills.todayKa!.invoice_no]);
    expect(numbers(await find({ q: '100%_a' }))).toEqual([bills.today!.invoice_no]);
    expect((await find({ q: '%' })).rows).toHaveLength(1); // the one P.O. with a % in it
    expect((await find({ q: '_' })).rows).toHaveLength(1);
    expect((await find({ q: '\\' })).rows).toEqual([]);
    expect((await find({ q: `'; drop table public.invoices; --` })).rows).toEqual([]);
  });

  it('looks at one month, or one customer', async () => {
    expect(numbers(await find({ month: '2026-10-01' }))).toEqual([bills.october!.invoice_no]);
    expect((await find({ month: '2026-11-01' })).counts.all).toBe(8);
    expect(numbers(await find({ customer: md.kaCustomerId }))).toEqual([bills.todayKa!.invoice_no]);
    expect((await find({ customer: md.tnCustomerId, show: 'open' })).shown).toEqual({ bills: 6, total: '10620.00', balance: '9850.00' });
  });

  it('gives a page at a time', async () => {
    const first = numbers(await find({ take: 4 }));
    const second = numbers(await find({ skip: 4, take: 4 }));
    expect(first).toHaveLength(4);
    expect(new Set([...first, ...second]).size).toBe(8);
    expect((await find({ skip: 4, take: 4 })).counts.all).toBe(10);
  });

  it('says what a list needs, with amounts as text', async () => {
    const [row] = (await find({ q: bills.lateAndPart!.invoice_no })).rows;
    expect(row).toEqual({
      id: bills.lateAndPart!.invoice_id, invoice_no: bills.lateAndPart!.invoice_no, bill_type: 'supply', invoice_date: '2026-11-10', due_date: '2026-11-15',
      grand_total: '1770.00', amount_paid: '770.00', payment_status: 'partial', cancelled: false, po_no: null,
      customer: 'Murugan Engineering Works', phone: '9876543210', supplier: 'Demo Stud Works',
    });
    expect((await find({ show: 'cancelled' })).rows[0]).toMatchObject({ cancelled: true });
  });

  it('refuses what makes no sense', async () => {
    expect(await pgError(find({ show: 'everything' }))).toMatchObject({ code: '22023' });
    expect(await pgError(find({ take: 0 }))).toMatchObject({ code: '22023' });
    expect(await pgError(find({ take: 1000 }))).toMatchObject({ code: '22023' });
    expect(await pgError(find({ skip: -1 }))).toMatchObject({ code: '22023' });
  });
});

describe('the figures of Home', () => {
  it('are today, this month, the month before, what is to collect and what is late', async () => {
    expect(await call('home_figures', [TODAY])).toMatchObject({
      today: { bills: 2, total: '3540.00' },
      month: { bills: 7, total: '12390.00' },
      last_month: { bills: 1, total: '1770.00' },
      to_collect: { bills: 7, total: '11620.00' },
      overdue: { bills: 3, total: '4540.00', oldest: '2026-07-30' },
    });
  });

  it('give six months, the empty ones too', async () => {
    const { months } = await call<{ months: unknown }>('home_figures', [TODAY]);
    expect(months).toEqual([
      { month: '2026-06-01', total: '1770.00' }, { month: '2026-07-01', total: '0.00' }, { month: '2026-08-01', total: '0.00' },
      { month: '2026-09-01', total: '0.00' }, { month: '2026-10-01', total: '1770.00' }, { month: '2026-11-01', total: '12390.00' },
    ]);
  });

  it('say how many goods wait and how many bills are not on Drive yet (without cancelled ones)', async () => {
    expect(await call('home_figures', [TODAY])).toMatchObject({ to_send: 9, not_on_drive: 9 });
    await db.query('update public.invoices set drive_sync_pending = false where id = $1', [bills.today!.invoice_id]);
    expect(await call('home_figures', [TODAY])).toMatchObject({ not_on_drive: 8 });
  });

  it('are empty, not missing, in an empty book', async () => {
    const empty = await createTestDb();
    try {
      expect(await call('home_figures', [TODAY], ACTORS.staff, empty)).toMatchObject({
        today: { bills: 0, total: '0.00' }, month: { bills: 0, total: '0.00' }, to_collect: { bills: 0, total: '0.00' },
        overdue: { bills: 0, total: '0.00', oldest: null }, to_send: 0, not_on_drive: 0,
      });
      expect(await call('find_bills', ['', 'all', null, null, TODAY, 0, 50], ACTORS.staff, empty)).toMatchObject({ counts: { all: 0 }, rows: [] });
      expect(await call('goods_to_send', [], ACTORS.staff, empty)).toEqual([]);
      expect(await call('receipts_found', ['', null, 0, 50], ACTORS.staff, empty)).toEqual({ receipts: 0, total: '0.00', rows: [] });
    } finally {
      await empty.close();
    }
  });
});

describe('money that came in', () => {
  type Receipts = { receipts: number; total: string; rows: Record<string, unknown>[] };
  const receipts = (q = '', month: string | null = null, skip = 0, take = 50): Promise<Receipts> => call<Receipts>('receipts_found', [q, month, skip, take]);

  it('newest first; a voided receipt is shown and not added', async () => {
    const found = await receipts();
    expect(found).toMatchObject({ receipts: 3, total: '4274.60' });
    expect(found.rows.map((row) => [row.amount, row.mode, row.received_on, row.voided])).toEqual([
      ['10.00', 'bank_transfer', TODAY, true], ['1734.60', 'bank_transfer', '2026-11-20', false], ['1770.00', 'upi', '2026-11-19', false], ['770.00', 'cash', '2026-11-18', false],
    ]);
    expect(found.rows[2]).toMatchObject({ invoice_id: bills.paid!.invoice_id, invoice_no: bills.paid!.invoice_no, customer: 'Murugan Engineering Works', reference: 'UTR 42', settles_invoice: false });
  });

  it('found by customer, bill, reference or month', async () => {
    expect((await receipts('utr 4')).rows).toHaveLength(1);
    expect((await receipts(bills.tds!.invoice_no)).rows).toHaveLength(1);
    expect((await receipts('murugan')).rows).toHaveLength(4);
    expect((await receipts('bharat')).rows).toEqual([]);
    expect((await receipts('', '2026-10-01')).rows).toEqual([]);
    expect((await receipts('', '2026-11-01', 1, 2)).rows).toHaveLength(2);
  });
});

describe('goods to send', () => {
  it('are those of standing bills that did not arrive yet, oldest first', async () => {
    const rows = await call<{ dc_no: string; status: string; customer: string; items: number; invoice_no: string; transport_mode: string; vehicle_no: string }[]>('goods_to_send', []);
    expect(rows).toHaveLength(9);
    expect(rows.map((row) => row.dc_no)).not.toContain(bills.cancelled!.dc_no);
    expect(rows.find((row) => row.dc_no === bills.todayKa!.dc_no)).toMatchObject({ customer: 'Bharat Fasteners Pvt Ltd', items: 1, invoice_no: bills.todayKa!.invoice_no, vehicle_no: 'TN38AB1234', status: 'pending', transport_mode: 'own_vehicle' });
    await queryAs(db, ACTORS.staff, `update public.deliveries set status = 'delivered' where dc_no = $1`, [bills.today!.dc_no]);
    await queryAs(db, ACTORS.staff, `update public.deliveries set status = 'dispatched' where dc_no = $1`, [bills.late!.dc_no]);
    const left = await call<{ dc_no: string; status: string }[]>('goods_to_send', []);
    expect(left).toHaveLength(8);
    expect(left.find((row) => row.dc_no === bills.late!.dc_no)?.status).toBe('dispatched');
    // On the way is not waiting any more.
    expect(await call('home_figures', [TODAY])).toMatchObject({ to_send: 7 });
  });
});

describe('what each customer owes', () => {
  interface OwesRow {
    id: string; name: string; gstin: string | null; phone: string | null; opening_balance: string; is_active: boolean;
    bills: number; on_bills: string; overdue: string; oldest: string | null; balance: string;
  }
  interface Owes { customers: number; owing: number; balance: string; overdue: string; rows: OwesRow[] }
  interface AskOwes { q?: string; sort?: string; skip?: number; take?: number }
  const owes = ({ q = '', sort = 'name', skip = 0, take = 50 }: AskOwes = {}, actor: Actor = ACTORS.staff): Promise<Owes> =>
    call<Owes>('customer_balances', [q, sort, TODAY, skip, take], actor);
  const names = (found: Owes): string[] => found.rows.map((row) => row.name);

  beforeAll(async () => {
    // Dues from before this software are typed in by hand; minus is what we owe them.
    await queryAs(db, ACTORS.staff, `insert into public.customers (name, opening_balance) values ('Annai Tools', 500), ('Zenith Credit', -300), ('Walk-in', 0)`);
  });

  it('adds up the bills not paid, the late part of them, and what was owed before', async () => {
    const found = await owes();
    const of = (name: string) => found.rows.find((row) => row.name === name);
    // Murugan: 5 × 1770 + (1770 − 770); late: 1770 + 1000 + 1770. Paid, settled and cancelled bills owe nothing.
    expect(of('Murugan Engineering Works')).toMatchObject({ bills: 6, on_bills: '9850.00', overdue: '4540.00', oldest: '2026-07-30', opening_balance: '0.00', balance: '9850.00' });
    expect(of('Bharat Fasteners Pvt Ltd')).toMatchObject({ bills: 1, on_bills: '1770.00', overdue: '0.00', oldest: null, balance: '1770.00' });
    expect(of('Annai Tools')).toMatchObject({ bills: 0, on_bills: '0.00', overdue: '0.00', oldest: null, opening_balance: '500.00', balance: '500.00' });
    expect(of('Zenith Credit')).toMatchObject({ bills: 0, balance: '-300.00' });
    expect(of('Walk-in')).toMatchObject({ bills: 0, balance: '0.00' });
  });

  it('says how many owe and how much in all; what we owe is not taken off', async () => {
    expect(await owes()).toMatchObject({ customers: 5, owing: 3, balance: '12120.00', overdue: '4540.00' });
    expect(await owes({ q: 'nobody at all' })).toMatchObject({ customers: 0, owing: 0, balance: '0.00', overdue: '0.00', rows: [] });
  });

  it('by name, or who owes most first', async () => {
    expect(names(await owes())).toEqual(['Annai Tools', 'Bharat Fasteners Pvt Ltd', 'Murugan Engineering Works', 'Walk-in', 'Zenith Credit']);
    expect(names(await owes({ sort: 'owes' }))).toEqual(['Murugan Engineering Works', 'Bharat Fasteners Pvt Ltd', 'Annai Tools', 'Walk-in', 'Zenith Credit']);
  });

  it('finds by name, phone or GSTIN, in any case, and takes what is typed literally', async () => {
    expect(names(await owes({ q: 'murugan' }))).toEqual(['Murugan Engineering Works']);
    expect(names(await owes({ q: '98450' }))).toEqual(['Bharat Fasteners Pvt Ltd']);
    const [bharat] = (await owes({ q: 'bharat' })).rows;
    expect(names(await owes({ q: bharat!.gstin!.slice(2, 9).toLowerCase() }))).toEqual(['Bharat Fasteners Pvt Ltd']);
    expect((await owes({ q: '%' })).rows).toEqual([]);
    expect((await owes({ q: `'; drop table public.customers; --` })).rows).toEqual([]);
  });

  it('gives a page at a time, with the counts of all', async () => {
    const first = names(await owes({ sort: 'owes', take: 2 }));
    const second = await owes({ sort: 'owes', skip: 2, take: 2 });
    expect(first).toEqual(['Murugan Engineering Works', 'Bharat Fasteners Pvt Ltd']);
    expect(names(second)).toEqual(['Annai Tools', 'Walk-in']);
    expect(second).toMatchObject({ customers: 5, owing: 3 });
  });

  it('refuses what makes no sense', async () => {
    expect(await pgError(owes({ sort: 'richest' }))).toMatchObject({ code: '22023' });
    expect(await pgError(owes({ take: 0 }))).toMatchObject({ code: '22023' });
    expect(await pgError(owes({ take: 101 }))).toMatchObject({ code: '22023' });
    expect(await pgError(owes({ skip: -1 }))).toMatchObject({ code: '22023' });
    expect(await pgError(call('customer_balances', ['', 'name', null, 0, 50]))).toMatchObject({ code: '22023' });
  });
});

describe('who may ask', () => {
  it.each([
    ['home_figures', [TODAY]],
    ['find_bills', ['', 'all', null, null, TODAY, 0, 50]],
    ['receipts_found', ['', null, 0, 50]],
    ['goods_to_send', []],
    ['customer_balances', ['', 'name', TODAY, 0, 50]],
  ] as const)('%s: active people of the firm only', async (fn, args) => {
    for (const actor of [ACTORS.owner, ACTORS.staff]) await call(fn, [...args], actor);
    for (const actor of [ACTORS.stranger, ACTORS.former, ACTORS.anon, ACTORS.service]) {
      expect(await pgError(call(fn, [...args], actor)), JSON.stringify(actor)).toMatchObject({ code: '42501' });
    }
  });
});
