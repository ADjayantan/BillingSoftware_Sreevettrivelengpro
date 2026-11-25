// What is in a month's Excel book: real bills and receipts in real SQL, read through the API
// stand-in, written as .xlsx, read back by an independent reader and compared with the database.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { createClient as createSupabase, type SupabaseClient } from '@supabase/supabase-js';
import { buildSyncPayload, composeBill } from '@/lib/bill-draft';
import { readMonth } from '@/lib/month-data';
import { monthWorkbook } from '@/lib/month-workbook';
import { billDraft, type BillDraftInput } from '@/lib/schemas/invoices';
import { ACTORS, GSTIN, createTestDb, openSeries, queryAs, recordPayment, seedMasterData, setToday, syncInvoice, type MasterData, type SyncResult } from './db/harness';
import { pgliteFetch } from './support/postgrest';
import { dateOf, readXlsx, table, totals, type ReadSheet } from './support/xlsx-reader';

let db: PGlite;
let md: MasterData;
let server: SupabaseClient;
const client = (on: PGlite, maxRows?: number): SupabaseClient =>
  createSupabase('http://localhost', 'sb_secret_test', { global: { fetch: pgliteFetch(on, () => ACTORS.service, maxRows) }, auth: { persistSession: false, autoRefreshToken: false } });

beforeAll(async () => {
  db = await createTestDb();
  md = await seedMasterData(db);
  server = client(db);
});
afterAll(async () => {
  await db.close();
});

const line = (over: Partial<BillDraftInput['lines'][number]> = {}): BillDraftInput['lines'][number] => ({
  stud_item_id: null, description: 'EN8 M12 × 80 mm stud', hsn_sac: '731815', billing_unit: 'pcs', quantity: '50', rate: '12', gst_rate: '18', ...over,
});

/** A bill the way the app issues it: the same composer, the same RPC. */
async function issue(over: Partial<BillDraftInput> = {}, on = db): Promise<SyncResult> {
  const customerId = over.customer_id ?? md.tnCustomerId;
  const { rows } = await on.query<{ state_code: string; is_sez: boolean }>('select state_code, is_sez from public.customers where id = $1', [customerId]);
  const input = {
    client_temp_id: `OFFLINE-${randomUUID()}`, bill_type: 'supply' as const, customer_id: customerId, invoice_date: '2026-11-20', due_date: '2027-06-30',
    lines: [line()], delivery: {}, expected_total_paise: 0, ...over,
  };
  const draft = billDraft.parse(input);
  return syncInvoice(on, ACTORS.staff, buildSyncPayload(draft, composeBill(draft, rows[0]!)));
}

interface Book {
  bills: Record<string, string>[];
  items: Record<string, string>[];
  dispatch: Record<string, string>[];
  receipts: Record<string, string>[];
  sheets: Record<'Bills' | 'Items' | 'Dispatch & Job Work' | 'Receipts', ReadSheet>;
}
async function book(month: string, on = server): Promise<Book> {
  const { sheets } = readXlsx(monthWorkbook(await readMonth(on, month), '2026-11-25T05:02:30Z'));
  expect(sheets.map((sheet) => sheet.name)).toEqual(['Bills', 'Items', 'Dispatch & Job Work', 'Receipts']);
  const [bills, items, dispatch, receipts] = sheets as [ReadSheet, ReadSheet, ReadSheet, ReadSheet];
  return { bills: table(bills), items: table(items), dispatch: table(dispatch), receipts: table(receipts), sheets: { Bills: bills, Items: items, 'Dispatch & Job Work': dispatch, Receipts: receipts } };
}
const of = (rows: Record<string, string>[], no: string): Record<string, string>[] => rows.filter((row) => row['Invoice no'] === no);
const sql = async (query: string, params: unknown[] = []): Promise<string> => String((await db.query<{ v: string | null }>(`select (${query})::text as v`, params)).rows[0]?.v ?? '');
const num = (text: string | undefined): number => Number(text ?? 'NaN');

describe('the order of the brief', () => {
  it('50 EN8 M12 × 80 mm studs, packing on the bill, ₹300 to the driver', async () => {
    const [stud] = await queryAs<{ id: string }>(db, ACTORS.staff, `insert into public.stud_items (sku_code, diameter_mm, length_mm, thread_type, material_grade, hsn_sac, gst_rate_percent, unit_weight_kg, default_rate_per_piece)
      values ('M12X80-EN8', 12, 80, 'Metric Coarse', 'EN8', '731815', 18, round(144 / 162.2 * 0.08, 6), 12) returning id`);
    const { invoice_no, dc_no } = await issue({ lines: [line({ stud_item_id: stud!.id, weight_kg: '3.551171' })], packing: '40', freight: '300', freight_paid_by: 'buyer_to_pay', delivery: { transport_mode: 'transporter' } });
    const { bills, items, dispatch } = await book('2026-11-01');
    expect(of(bills, invoice_no)).toMatchObject([{
      'Invoice no': invoice_no, Type: 'Supply', Customer: 'Murugan Engineering Works', GSTIN: GSTIN.tn, Phone: '9876543210', State: 'Tamil Nadu (33)', 'DC no': dc_no,
      Lines: '2', 'Items ₹': '600', 'Packing ₹': '40', 'Freight on bill ₹': '0', 'Before GST ₹': '640', 'CGST ₹': '57.6', 'SGST ₹': '57.6', 'IGST ₹': '0', 'Round-off ₹': '-0.2',
      'Final amount ₹': '755', 'Received ₹': '0', 'Balance ₹': '755', 'Freight on DC only ₹': '300', Status: 'Unpaid',
    }]);
    expect(of(items, invoice_no).map((row) => [row.Line, row.Kind, row.Grade, row.Size, row['HSN/SAC'], row.Pieces, row.Kg, row['Rate ₹'], row.Per, row['Amount ₹'], row['GST %'], row['CGST ₹'], row['SGST ₹']])).toEqual([
      ['1', 'Goods', 'EN8', 'M12 × 80 mm', '731815', '50', '3.551171', '12', 'pcs', '600', '18', '54', '54'],
      ['2', 'Packing', '', '', '731815', '1', '', '40', 'pcs', '40', '18', '3.6', '3.6'],
    ]);
    expect(of(dispatch, invoice_no)).toMatchObject([{ Kind: 'Dispatch', 'DC no': dc_no, Transport: 'Transporter', 'Freight paid by': 'Customer, to the driver', 'Freight on DC only ₹': '300', Dispatch: 'Pending' }]);
  });
});

describe('the buyer’s order', () => {
  it('is in the row of the bill, the number as text', async () => {
    const withOrder = await issue({ po_no: '0045', po_date: '2026-11-18' });
    const without = await issue();
    const { bills, sheets } = await book('2026-11-01');
    expect(of(bills, withOrder.invoice_no)).toMatchObject([{ 'P.O. no': '0045' }]);
    expect(of(bills, without.invoice_no)).toMatchObject([{ 'P.O. no': '', 'P.O. date': '' }]);
    const titles = sheets.Bills.rows[0]!.map((cell) => cell?.value);
    const row = sheets.Bills.rows.find((cells) => cells?.[0]?.value === withOrder.invoice_no)!;
    expect(row[titles.indexOf('P.O. no')]).toMatchObject({ type: 'text', format: '@' });
    expect(dateOf(row[titles.indexOf('P.O. date')]?.value ?? '')).toBe('2026-11-18');
  });
});

describe('one row per bill, one per line', () => {
  it('counts a bill with five items once, and adds up to the database', async () => {
    const five = await issue({ lines: Array.from({ length: 5 }, (_, i) => line({ description: `Stud ${i + 1}`, quantity: String(10 * (i + 1)) })), packing: '75', freight: '250' });
    const { bills, items, sheets } = await book('2026-11-01');
    expect(of(bills, five.invoice_no)).toMatchObject([{ Lines: '5', 'Items ₹': '1800', 'Packing ₹': '75', 'Freight on bill ₹': '250', 'Before GST ₹': '2125', 'Freight on DC only ₹': '' }]);
    expect(of(items, five.invoice_no).map((row) => row.Line)).toEqual(['1', '2', '3', '4', '5']);
    const live = `from public.invoices where invoice_date between '2026-11-01' and '2026-11-30' and cancelled_at is null`;
    const added = totals(sheets.Bills);
    expect(num(added['Final amount ₹']?.value)).toBe(num(await sql(`select sum(grand_total) ${live}`)));
    expect(num(added['CGST ₹']?.value)).toBe(num(await sql(`select sum(cgst) ${live}`)));
    expect(num(added['Before GST ₹']?.value)).toBe(num(await sql(`select sum(subtotal + packing_charge + delivery_charge) ${live}`)));
    expect(bills).toHaveLength(num(await sql(`select count(*) from public.invoices where invoice_date between '2026-11-01' and '2026-11-30'`)));
    expect(items).toHaveLength(num(await sql(`select count(*) from public.invoice_items l join public.invoices i on i.id = l.invoice_id where i.invoice_date between '2026-11-01' and '2026-11-30'`)));
    expect(num(totals(sheets.Items)['Amount ₹']?.value)).toBe(num(await sql(`select sum(subtotal) ${live}`)));
  });

  it('every bill adds up across its row', async () => {
    await issue({ customer_id: md.kaCustomerId, lines: [line({ rate: '12.37' }), line({ gst_rate: '12', rate: '7.10' })], packing: '33', freight: '120' });
    await issue({ lines: [line()], freight: '99', delivery_taxable: false });
    for (const row of (await book('2026-11-01')).bills) {
      const paise = (name: string): number => Math.round(num(row[name]) * 100);
      expect(paise('Items ₹') + paise('Packing ₹') + paise('Freight on bill ₹'), row['Invoice no']).toBe(paise('Before GST ₹'));
      expect(paise('Before GST ₹') + paise('CGST ₹') + paise('SGST ₹') + paise('IGST ₹') + paise('Round-off ₹'), row['Invoice no']).toBe(paise('Final amount ₹'));
    }
  });

  it('finds packing and freight that are billed as lines of their own', async () => {
    const mixed = await issue({ customer_id: md.kaCustomerId, lines: [line(), line({ gst_rate: '12' })], packing: '33', freight: '120' });
    const atCost = await issue({ lines: [line()], freight: '99', delivery_taxable: false });
    const { bills, items } = await book('2026-11-01');
    expect(of(bills, mixed.invoice_no)).toMatchObject([{ 'Items ₹': '1200', 'Packing ₹': '33', 'Freight on bill ₹': '120', State: 'Karnataka (29)', 'CGST ₹': '0' }]);
    expect(of(items, mixed.invoice_no).map((row) => row.Kind)).toEqual(['Goods', 'Goods', 'Packing', 'Freight']);
    expect(of(bills, atCost.invoice_no)).toMatchObject([{ 'Items ₹': '600', 'Freight on bill ₹': '99' }]);
    expect(of(items, atCost.invoice_no).map((row) => [row.Kind, row['GST %']])).toEqual([['Goods', '18'], ['Freight', '0']]);
  });

  it('is in the order of the numbers', async () => {
    const { bills, items } = await book('2026-11-01');
    const numbers = bills.map((row) => row['Invoice no']!);
    expect(numbers).toEqual([...numbers].sort());
    expect(items.map((row) => `${row['Invoice no']} ${row.Line!.padStart(3, '0')}`)).toEqual(items.map((row) => `${row['Invoice no']} ${row.Line!.padStart(3, '0')}`).sort());
  });
});

describe('as issued', () => {
  it('keeps the customer’s details as they were on the bill', async () => {
    const [other] = await queryAs<{ id: string }>(db, ACTORS.staff, `insert into public.customers (name, gstin, phone, state_code, address) values ('Old Name & Sons', '33AAFCW1234B1ZY', '09000000001', '33', 'Old Street') returning id`);
    const { invoice_no } = await issue({ customer_id: other!.id });
    await queryAs(db, ACTORS.staff, `update public.customers set name = 'New Name', phone = '9111111111', gstin = null where id = $1`, [other!.id]);
    const { bills, items, sheets } = await book('2026-11-01');
    expect(of(bills, invoice_no)).toMatchObject([{ Customer: 'Old Name & Sons', GSTIN: '33AAFCW1234B1ZY', Phone: '09000000001' }]);
    expect(of(items, invoice_no)).toMatchObject([{ Customer: 'Old Name & Sons' }]);
    const row = sheets.Bills.rows.find((cells) => cells?.[0]?.value === invoice_no)!;
    const titles = sheets.Bills.rows[0]!.map((cell) => cell?.value);
    for (const title of ['Invoice no', 'GSTIN', 'Phone', 'DC no']) expect(row[titles.indexOf(title)], title).toMatchObject({ type: 'text', format: '@' });
    for (const title of ['Final amount ₹', 'Date']) expect(row[titles.indexOf(title)], title).toMatchObject({ type: 'number' });
    expect(dateOf(row[titles.indexOf('Date')]!.value)).toBe('2026-11-20');
  });

  it('marks an SEZ unit and an unregistered buyer', async () => {
    const [sez] = await queryAs<{ id: string }>(db, ACTORS.staff, `insert into public.customers (name, gstin, state_code, address, is_sez) values ('SEZ Unit', '33AAGCT5678C1ZA', '33', 'SEZ', true) returning id`);
    const [walkIn] = await queryAs<{ id: string }>(db, ACTORS.staff, `insert into public.customers (name) values ('Walk-in') returning id`);
    const a = await issue({ customer_id: sez!.id });
    const b = await issue({ customer_id: walkIn!.id });
    const { bills } = await book('2026-11-01');
    expect(of(bills, a.invoice_no)).toMatchObject([{ State: 'Tamil Nadu (33) · SEZ', 'CGST ₹': '0', 'IGST ₹': '108' }]);
    expect(of(bills, b.invoice_no)).toMatchObject([{ GSTIN: '', Phone: '' }]);
  });
});

describe('money', () => {
  it('a November bill paid in December: November’s balance, December’s receipts, no second sale', async () => {
    const november = await issue();
    await setToday(db, '2026-12-05');
    await recordPayment(db, ACTORS.staff, november.invoice_id, '500.00', { received_on: '2026-12-03', mode: 'upi', reference: '004512345678' });
    const [first, second] = [await book('2026-11-01'), await book('2026-12-01')];
    expect(of(first.bills, november.invoice_no)).toMatchObject([{ 'Received ₹': '500', 'Balance ₹': '208', Status: 'Part paid' }]);
    expect(of(first.receipts, november.invoice_no)).toEqual([]);
    expect(second.bills).toEqual([]);
    expect(second.items).toEqual([]);
    expect(of(second.receipts, november.invoice_no)).toMatchObject([{ 'Amount ₹': '500', Mode: 'UPI', Reference: '004512345678', Customer: 'Murugan Engineering Works', Status: 'Received' }]);
    expect(dateOf(of(second.receipts, november.invoice_no)[0]!['Received on']!)).toBe('2026-12-03');
    expect(dateOf(of(second.receipts, november.invoice_no)[0]!['Invoice date']!)).toBe('2026-11-20');
    expect(totals(second.sheets.Receipts)['Amount ₹']).toMatchObject({ value: '500' });
    await setToday(db, '2026-11-23');
  });

  it('a voided receipt stays, labelled, and is not added up', async () => {
    const bill = await issue();
    const wrong = await recordPayment(db, ACTORS.staff, bill.invoice_id, '100.00');
    await recordPayment(db, ACTORS.staff, bill.invoice_id, '50.00');
    const before = num(totals((await book('2026-11-01')).sheets.Receipts)['Amount ₹']?.value);
    await queryAs(db, ACTORS.owner, 'select * from public.void_payment($1, $2)', [wrong.payment_id, 'wrong bill']);
    const { receipts, bills, sheets } = await book('2026-11-01');
    expect(of(receipts, bill.invoice_no).map((row) => [row['Amount ₹'], row.Status, row['Why voided']])).toEqual([['100', 'VOIDED', 'wrong bill'], ['50', 'Received', '']]);
    expect(num(totals(sheets.Receipts)['Amount ₹']?.value)).toBe(before - 100);
    expect(num(totals(sheets.Receipts)['Amount ₹']?.value)).toBe(num(await sql(`select sum(amount) from public.payments where received_on between '2026-11-01' and '2026-11-30' and voided_at is null`)));
    expect(of(bills, bill.invoice_no)).toMatchObject([{ 'Received ₹': '50', 'Balance ₹': '658' }]);
    expect(sheets.Receipts.rows.find((row) => row?.some((cell) => cell?.value === 'VOIDED'))?.filter(Boolean).every((cell) => cell!.strike)).toBe(true);
  });

  it('a bill settled short has no balance', async () => {
    const bill = await issue();
    await recordPayment(db, ACTORS.staff, bill.invoice_id, '700.00', { settles_invoice: true });
    const { bills, receipts } = await book('2026-11-01');
    expect(of(bills, bill.invoice_no)).toMatchObject([{ 'Final amount ₹': '708', 'Received ₹': '700', 'Balance ₹': '0', Status: 'Paid, settled short' }]);
    expect(of(receipts, bill.invoice_no)).toMatchObject([{ 'Settles the bill': 'Yes' }]);
  });

  it('a bill paid at the counter is paid, with its receipt', async () => {
    const bill = await issue({ paid_now: { amount: '708', mode: 'cash' } });
    const { bills, receipts } = await book('2026-11-01');
    expect(of(bills, bill.invoice_no)).toMatchObject([{ 'Received ₹': '708', 'Balance ₹': '0', Status: 'Paid' }]);
    expect(of(receipts, bill.invoice_no)).toMatchObject([{ 'Amount ₹': '708', Mode: 'Cash' }]);
  });
});

describe('a cancelled bill', () => {
  it('stays everywhere, labelled, and is in no total', async () => {
    const before = await book('2026-11-01');
    const bill = await issue({ packing: '40', freight: '300', freight_paid_by: 'buyer_to_pay' });
    await queryAs(db, ACTORS.staff, `update public.invoices set cancelled_at = now(), cancellation_reason = 'wrong buyer' where id = $1`, [bill.invoice_id]);
    const after = await book('2026-11-01');
    expect(of(after.bills, bill.invoice_no)).toMatchObject([{ Status: 'CANCELLED', 'Why cancelled': 'wrong buyer', 'Final amount ₹': '755', 'Balance ₹': '0' }]);
    expect(of(after.items, bill.invoice_no).map((row) => row.Status)).toEqual(['CANCELLED', 'CANCELLED']);
    expect(of(after.dispatch, bill.invoice_no).map((row) => row.Status)).toEqual(['CANCELLED']);
    for (const name of ['Bills', 'Items', 'Dispatch & Job Work'] as const) {
      expect(Object.fromEntries(Object.entries(totals(after.sheets[name])).map(([title, { value }]) => [title, value])), name).toEqual(
        Object.fromEntries(Object.entries(totals(before.sheets[name])).map(([title, { value }]) => [title, value])),
      );
    }
    expect(after.sheets.Bills.rows.find((row) => row?.[0]?.value === bill.invoice_no)?.filter(Boolean).every((cell) => cell!.strike)).toBe(true);
  });
});

describe('dispatch and job work', () => {
  it('shows a challan once, and the material that went back on rows of its own', async () => {
    const lots = await queryAs<{ id: string }>(db, ACTORS.staff, `insert into public.job_work_ledger (customer_id, party_dc_no, party_dc_date, material_grade, description, inward_weight_kg)
      values ($1, '000123', '2026-11-01', 'EN8', 'Rounds', 100), ($1, 'B-2', '2026-11-02', 'MS', 'Rounds', 50) returning id`, [md.tnCustomerId]);
    const bill = await issue({
      bill_type: 'job_work', lines: [line({ description: 'Threading', hsn_sac: '998873' })], freight: '300', freight_paid_by: 'buyer_to_pay',
      delivery: { vehicle_no: 'TN38AB1234', driver_name: 'Kumar', driver_phone: '09876500000', lr_number: '00077', transport_mode: 'transporter', status: 'dispatched', delivery_address: 'Unit 2' },
      returns: [
        { lot_id: lots[0]!.id, returned_weight_kg: '40', scrap_weight_kg: '1.5', pieces: 90, declared_value: '5000', goods_description: 'Threaded rounds' },
        { lot_id: lots[1]!.id, returned_weight_kg: '10', scrap_weight_kg: '0', goods_description: 'Threaded rounds' },
      ],
    });
    const { bills, items, dispatch, sheets } = await book('2026-11-01');
    expect(of(bills, bill.invoice_no)).toMatchObject([{ Type: 'Job work' }]);
    expect(of(items, bill.invoice_no)).toMatchObject([{ Kind: 'Job work' }]);
    const all = of(dispatch, bill.invoice_no);
    const rows = [all[0]!, ...all.slice(1).sort((x, y) => x['Party DC no']!.localeCompare(y['Party DC no']!))]; // numbered by lot id
    expect(rows.map((row) => [row.Kind, row['Freight on DC only ₹'], row['Party DC no'], row.Grade, row.Pieces, row['Returned kg'], row['Scrap kg'], row['Balance kg'], row['Goods value ₹']])).toEqual([
      ['Dispatch', '300', '', '', '', '', '', '', ''],
      ['Job work returned', '', '000123', 'EN8', '90', '40', '1.5', '58.5', '5000'],
      ['Job work returned', '', 'B-2', 'MS', '', '10', '0', '40', ''],
    ]);
    expect(rows[0]).toMatchObject({ 'Vehicle no': 'TN38AB1234', Driver: 'Kumar', 'Driver phone': '09876500000', 'LR no': '00077', 'Deliver to': 'Unit 2', Dispatch: 'Dispatched' });
    const row = sheets['Dispatch & Job Work'].rows.find((cells) => cells?.some((cell) => cell?.value === '09876500000'))!;
    expect(row.find((cell) => cell?.value === '00077')).toMatchObject({ type: 'text' });
    expect(num(totals(sheets['Dispatch & Job Work'])['Returned kg']?.value)).toBe(num(await sql(`select sum(returned_weight_kg) from public.job_work_returns where reversed_at is null`)));
    await queryAs(db, ACTORS.staff, `update public.invoices set cancelled_at = now(), cancellation_reason = 'wrong lot' where id = $1`, [bill.invoice_id]);
    expect(of((await book('2026-11-01')).dispatch, bill.invoice_no).map((each) => each.Status)).toEqual(['CANCELLED', 'CANCELLED', 'CANCELLED']);
  });
});

describe('the year ends on 31 March', () => {
  it('puts a bill where its own date says', async () => {
    const year = await createTestDb({ today: '2027-04-01' });
    try {
      const masters = await seedMasterData(year);
      await openSeries(year, '26-27');
      const bill = (date: string) => issue({ customer_id: masters.tnCustomerId, invoice_date: date }, year);
      const march = await bill('2027-03-31');
      const april = await bill('2027-04-01');
      const server2 = client(year);
      expect((await book('2027-03-01', server2)).bills.map((row) => [row['Invoice no'], dateOf(row.Date!)])).toEqual([[march.invoice_no, '2027-03-31']]);
      expect((await book('2027-04-01', server2)).bills.map((row) => [row['Invoice no'], dateOf(row.Date!)])).toEqual([[april.invoice_no, '2027-04-01']]);
      expect([march.invoice_no, april.invoice_no]).toEqual(['INV/26-27/0001', 'INV/27-28/0001']);
    } finally {
      await year.close();
    }
  });
});

describe('large months', () => {
  it('reads every row, however few the API gives at a time', async () => {
    const whole = await book('2026-11-01');
    expect(await book('2026-11-01', client(db, 7))).toMatchObject({ bills: whole.bills, items: whole.items, dispatch: whole.dispatch, receipts: whole.receipts });
  });

  it('holds more than 1000 bills, lines and receipts, and adds up to the database', async () => {
    const big = await createTestDb({ today: '2026-11-23' });
    try {
      const masters = await seedMasterData(big);
      const customer = { state_code: '33', is_sez: false };
      const draft = billDraft.parse({
        client_temp_id: `OFFLINE-${randomUUID()}`, bill_type: 'supply', customer_id: masters.tnCustomerId, invoice_date: '2026-11-20', due_date: '2026-12-20',
        lines: [line(), line({ description: 'Second line', quantity: '7', rate: '3.33' })], delivery: {}, paid_now: { amount: '100', mode: 'cash' }, expected_total_paise: 0,
      });
      const payload = JSON.stringify(buildSyncPayload(draft, composeBill(draft, customer)));
      await queryAs(big, ACTORS.staff, `select public.sync_invoice(jsonb_set($1::jsonb, '{client_temp_id}', to_jsonb('OFFLINE-' || gen_random_uuid()::text))) from generate_series(1, 1050)`, [payload]);
      const { bills, items, dispatch, receipts, sheets } = await book('2026-11-01', client(big));
      expect([bills.length, items.length, dispatch.length, receipts.length]).toEqual([1050, 2100, 1050, 1050]);
      expect(new Set(bills.map((row) => row['Invoice no'])).size).toBe(1050);
      const { rows } = await big.query<{ total: string; lines: string; paid: string }>(`select sum(grand_total)::text as total, (select sum(line_total)::text from public.invoice_items) as lines, (select sum(amount)::text from public.payments) as paid from public.invoices`);
      expect(num(totals(sheets.Bills)['Final amount ₹']?.value)).toBe(num(rows[0]!.total));
      expect(num(totals(sheets.Items)['Amount ₹']?.value)).toBe(num(rows[0]!.lines));
      expect(num(totals(sheets.Receipts)['Amount ₹']?.value)).toBe(num(rows[0]!.paid));
      expect(totals(sheets.Bills)['Final amount ₹']?.formula).toMatch(/^SUMIFS\([A-Z]+2:[A-Z]+1051,[A-Z]+2:[A-Z]+1051,"<>CANCELLED"\)$/);
    } finally {
      await big.close();
    }
  }, 120_000);
});

describe('the file', () => {
  it('says where it came from, and that changes in it are lost', async () => {
    const { sheets } = await book('2026-11-01');
    const said = sheets.Bills.rows.flat().map((cell) => cell?.value ?? '');
    expect(said).toContain('November 2026 · Demo Stud Works · made by StudFlow on 25 Nov, 10:32 am');
    expect(said.some((text) => /written again/.test(text))).toBe(true);
  });

  it('is the same file when nothing has changed', async () => {
    const data = await readMonth(server, '2026-11-01');
    expect(Buffer.from(monthWorkbook(data, '2026-11-25T05:02:30Z')).equals(Buffer.from(monthWorkbook(await readMonth(server, '2026-11-01'), '2026-11-25T05:02:30Z')))).toBe(true);
  });

  it('receipts of one moment are in the order of their bills', async () => {
    const data = await readMonth(server, '2026-11-01');
    const same = data.payments.map((payment) => ({ ...payment, received_on: '2026-11-21', created_at: '2026-11-21T10:00:00+00:00' }));
    const numbers = (payments: typeof same) => table(readXlsx(monthWorkbook({ ...data, payments }, '2026-11-25T05:02:30Z')).sheets[3]!).map((row) => row['Invoice no']);
    expect(new Set(numbers(same)).size).toBeGreaterThan(2);
    expect(numbers(same)).toEqual([...numbers(same)].sort());
    expect(numbers([...same].reverse())).toEqual(numbers(same));
  });

  it('a month with nothing in it says so', async () => {
    const { bills, sheets } = await book('2026-08-01');
    expect(bills).toEqual([]);
    expect(sheets.Bills.rows.flat().map((cell) => cell?.value)).toContain('No bills this month.');
  });
});
