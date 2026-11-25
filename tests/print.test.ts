// What the bill and the challan say (acceptance cases of specs/print-templates.md): typed on the
// billing form, issued through the real route and database, then bound. How it is drawn:
// bill-sheets.test.ts.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createClient as createSupabase } from '@supabase/supabase-js';
import * as f from '@/lib/bill-form';
import { billSheets } from '@/lib/bill-sheets';
import { buildDocuments, type PrintDocument } from '@/lib/print-documents';
import { sampleBill } from '@/lib/sample-bill';
import type { InvoiceDocument } from '@/lib/schemas/invoices';
import type { Customer, JobWorkLot } from '@/lib/schemas/masters';
import { ACTORS, TEST_TODAY, createTestDb, seedMasterData, type MasterData } from './db/harness';
import { pgliteFetch } from './support/postgrest';

let db: PGlite;
let md: MasterData;

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => {
    const client = createSupabase('http://localhost', 'sb_publishable_test', {
      global: { fetch: pgliteFetch(db, () => ACTORS.staff) },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    client.auth.getClaims = (async () => ({ data: { claims: {} }, error: null })) as unknown as typeof client.auth.getClaims;
    return client;
  },
}));

type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;
async function call<T>(handler: unknown, json?: unknown, params: Record<string, string> = {}): Promise<T> {
  const response = await (handler as Handler)(
    new Request('http://localhost/api/x', json === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(json) }),
    { params: Promise.resolve(params) },
  );
  const reply = (await response.json()) as { data: T; error?: unknown };
  expect(reply.error).toBeUndefined();
  return reply.data;
}

const newForm = (type: f.BillType = 'supply'): f.BillForm => f.newBill(`OFFLINE-${crypto.randomUUID()}`, TEST_TODAY, type);
const line = (key: number, over: Partial<f.FormLine>): f.FormLine => ({ ...f.typeGst(f.blankLine(key, 'supply'), '18'), ...over });

async function issue(form: f.BillForm): Promise<InvoiceDocument> {
  const preview = f.previewBill(form);
  if ('problem' in preview) throw new Error(preview.problem);
  const { POST } = await import('@/app/api/invoices/sync/route');
  const { GET } = await import('@/app/api/invoices/[id]/route');
  const saved = await call<{ invoice_id: string }>(POST, f.toDraft(form, preview.bill));
  return call<InvoiceDocument>(GET, undefined, { id: saved.invoice_id });
}

const sum = (doc: PrintDocument, label: string): (string | null)[] => doc.sums.filter((row) => row.label === label).map((row) => row.amount);
const value = (rows: readonly { label: string; value: string }[], label: string): string | undefined => rows.find((row) => row.label === label)?.value;
const ref = (doc: PrintDocument, label: string): string[] => doc.refs.filter((row) => row.label === label).map((row) => `${row.value} dt ${row.date}`);
const pair = (doc: InvoiceDocument): [PrintDocument, PrintDocument] => {
  const [invoice, dc] = buildDocuments(doc, { documents: 'both', copies: 'original' });
  if (!invoice || !dc) throw new Error('expected an invoice and a challan');
  return [invoice, dc];
};
const receive = async (customer: Customer, partyDc: string, kg: string): Promise<JobWorkLot> => {
  const lots = await import('@/app/api/job-work/route');
  return call<JobWorkLot>(lots.POST, { customer_id: customer.id, party_dc_no: partyDc, party_dc_date: TEST_TODAY, material_grade: 'MS', description: '12 mm rods', inward_weight_kg: kg });
};

let kerala: Customer;
let local: Customer;

beforeAll(async () => {
  db = await createTestDb();
  md = await seedMasterData(db);
  const { POST } = await import('@/app/api/customers/route');
  const base = { phone: '', is_sez: false, credit_days: 30, opening_balance: '0', is_active: true };
  local = await call<Customer>(POST, { ...base, name: 'Kovai Fasteners', gstin: '', phone: '9876543210', state_code: '33', address: 'SIDCO, Coimbatore' });
  kerala = await call<Customer>(POST, { ...base, name: 'Kochi Marine', gstin: '', state_code: '32', address: 'Kochi' });
});
afterAll(async () => {
  await db.close();
});

describe('print acceptance cases', () => {
  it('TN supply: ₹1,239.00 with words, both references matching', async () => {
    const doc = await issue({ ...newForm(), customer: local, lines: [line(1, { text: 'Studs M12', quantity: '10', rate: '100' })], packing: '20', freight: '30' });
    const [invoice, dc] = pair(doc);
    expect(invoice.sums).toEqual([
      { label: 'SUB TOTAL', rate: '', base: '', amount: '1,000.00' },
      { label: 'Packing', rate: '', base: '', amount: '20.00' },
      { label: 'Delivery', rate: '', base: '', amount: '30.00' },
      { label: 'Taxable value', rate: '', base: '', amount: '1,050.00' },
      { label: 'CGST', rate: '9%', base: '', amount: '94.50' },
      { label: 'SGST', rate: '9%', base: '', amount: '94.50' },
      { label: 'IGST', rate: '', base: '', amount: null },
      { label: 'R. Off', rate: '', base: '', amount: '0.00' },
    ]);
    expect(invoice.total).toEqual({ label: 'TOTAL AMOUNT', amount: '1,239.00' });
    expect(invoice.words).toEqual({ label: 'Rupees', value: 'One Thousand Two Hundred Thirty-Nine Only' });
    expect(invoice.items).toEqual([{ code: '731815', codeNote: '', description: 'Studs M12', detail: '', third: '100.00', thirdNote: '/pc', fourth: '10 PCS', fourthNote: '', amount: '1,000.00' }]);
    expect(invoice).toMatchObject({ kind: 'invoice', title: 'TAX INVOICE', subtitle: '', number: doc.invoice.invoice_no, issueDate: '23 Nov 2026', copyLabel: 'Original for Recipient', stamp: '', rows: [] });
    expect(ref(invoice, 'DC No.')).toEqual([`${dc.number} dt 23.11.26`]);
    expect(ref(dc, 'Invoice No.')).toEqual([`${invoice.number} dt 23.11.26`]);
    expect(ref(invoice, 'P. O. No.')).toEqual([' dt ']); // always there, as in the book
    expect(dc).toMatchObject({ kind: 'challan', title: 'DELIVERY CHALLAN', subtitle: 'SALE DISPATCH', total: null, words: null, sums: [], bank: [] }); // a challan never asks for payment
    expect(dc.items).toEqual([{ code: '731815', codeNote: '', description: 'Studs M12', detail: '', third: '10 PCS', thirdNote: '', fourth: '', fourthNote: '', amount: null }]);
    expect(value(dc.rows, 'Value')).toBe(`As per invoice ${invoice.number}`);
  });

  it('an ordinary bill has the five sums of the book, and nothing else', async () => {
    const [invoice] = pair(await issue({ ...newForm(), customer: local, lines: [line(1, { text: 'Studs M12', quantity: '3', rate: '3.33' })] }));
    expect(invoice.sums.map((row) => [row.label, row.rate, row.amount])).toEqual([['SUB TOTAL', '', '9.99'], ['CGST', '9%', '0.90'], ['SGST', '9%', '0.90'], ['IGST', '', null], ['R. Off', '', '0.21']]);
    expect(invoice.notes).toEqual([]);
    expect(invoice.facts).toEqual([{ label: 'Place of supply', value: 'Tamil Nadu (33)' }, { label: 'Reverse charge', value: 'No' }, { label: 'Due date', value: '23 Dec 2026' }]);
    expect(invoice.to).toEqual({ role: 'To,', name: 'Kovai Fasteners', address: 'SIDCO, Coimbatore', phone: '98765 43210', gstin: 'Unregistered', state: 'Tamil Nadu (33)' });
    expect(invoice.heads).toEqual({ code: 'HSN CODE', third: 'RATE', fourth: 'QTY.', amount: 'AMOUNT', split: true });
    expect(invoice.bank).toEqual([{ label: 'BANK NAME', value: 'Demo Bank' }, { label: 'ACCOUNT No.', value: '000011112222' }, { label: 'IFS CODE', value: 'DEMO0000001' }]);
    expect(invoice.signatures).toEqual([{ organisation: 'Demo Stud Works', role: 'Authorised Signatory', hint: '', own: true }]);
  });

  it('Kerala, To-Pay: ₹1,204.00, and the DC carries the ₹30.00 buyer payment', async () => {
    const doc = await issue({
      ...newForm(), customer: kerala, lines: [line(1, { text: 'Studs M12', quantity: '10', rate: '100' })], packing: '20', freight: '30', freightPaidBy: 'buyer_to_pay',
    });
    const [invoice, dc] = pair(doc);
    expect(invoice.items.map((item) => item.description)).toEqual(['Studs M12', 'Packing charges']);
    expect(invoice.sums.map((row) => [row.label, row.rate, row.amount])).toEqual([
      ['SUB TOTAL', '', '1,020.00'], ['CGST', '', null], ['SGST', '', null], ['IGST', '18%', '183.60'], ['R. Off', '', '0.40'],
    ]);
    expect(invoice.total?.amount).toBe('1,204.00');
    expect(value(dc.rows, 'Payable directly by buyer · Freight')).toBe('₹30.00');
    expect(dc.items.map((item) => item.description)).toEqual(['Studs M12']); // packing is not goods
    expect(value(dc.facts, 'Place of supply')).toBe('Kerala (32)');
  });

  it('several GST rates: each with its base, on each line its own, and the rows add up', async () => {
    const doc = await issue({
      ...newForm(), customer: local,
      lines: [line(1, { text: 'Studs', quantity: '100', rate: '42.50' }), line(2, { text: 'Bush', quantity: '200', rate: '6.25', gst: '12', gstFrom: 'hand' }), line(3, { text: 'Free of tax', quantity: '1', rate: '15.35', gst: '0', gstFrom: 'hand' })],
    });
    const [invoice] = pair(doc);
    expect(invoice.sums.map((row) => [row.label, row.rate, row.base, row.amount])).toEqual([
      ['SUB TOTAL', '', '', '5,515.35'],
      ['CGST', '9%', 'on 4,250.00', '382.50'], ['SGST', '9%', 'on 4,250.00', '382.50'],
      ['CGST', '6%', 'on 1,250.00', '75.00'], ['SGST', '6%', 'on 1,250.00', '75.00'],
      ['IGST', '', '', null], ['R. Off', '', '', '-0.35'],
    ]);
    expect(invoice.items.map((item) => item.codeNote)).toEqual(['18%', '12%', '0%']);
    const paise = (text: string | null): number => (text === null ? 0 : Math.round(Number(text.replace(/,/g, '')) * 100));
    expect(invoice.sums.reduce((total, row) => total + paise(row.amount), 0)).toBe(paise(invoice.total?.amount ?? null));
  });

  it('a bill that is all 0% says so', async () => {
    const [invoice] = pair(await issue({ ...newForm(), customer: local, lines: [line(1, { text: 'Exempt', quantity: '1', rate: '100', gst: '0', gstFrom: 'hand' })] }));
    expect(invoice.sums.map((row) => [row.label, row.rate, row.amount])).toEqual([['SUB TOTAL', '', '100.00'], ['CGST', '0%', '0.00'], ['SGST', '0%', '0.00'], ['IGST', '', null], ['R. Off', '', '0.00']]);
  });

  it('the other measurement, the order, where it goes and how', async () => {
    const { GET } = await import('@/app/api/stud-items/[id]/route');
    const stud = await call<Parameters<typeof f.pickStud>[1]>(GET, undefined, { id: md.studItemId });
    const form = newForm();
    const [invoice, dc] = pair(await issue({
      ...form, customer: local, poNo: '4500012/A', poDate: '2026-11-18', notes: 'Handle with care',
      lines: [f.typeGst({ ...f.pickStud(f.blankLine(1, 'supply'), stud, 'supply'), quantity: '1000', rate: '1.5' }, '18'), line(2, { text: 'By weight', unit: 'kg', quantity: '25.5', rate: '96' })],
      transport: { ...form.transport, vehicle_no: 'TN38AB1234', driver_name: 'Kumar', driver_phone: '9876500000', lr_number: 'LR/7', delivery_address: 'Plot 88, Bengaluru' },
    }));
    expect(invoice.items.map((item) => [item.third, item.thirdNote, item.fourth, item.fourthNote])).toEqual([['1.50', '/pc', '1,000 PCS', '133.169 kg'], ['96.00', '/kg', '25.5 KGS', '']]);
    expect(ref(invoice, 'P. O. No.')).toEqual(['4500012/A dt 18.11.26']);
    expect(ref(dc, 'P. O. No.')).toEqual(['4500012/A dt 18.11.26']);
    expect(invoice.notes).toEqual([{ label: 'Delivery at', value: 'Plot 88, Bengaluru' }, { label: 'Note', value: 'Handle with care' }]);
    expect(invoice.facts.slice(3)).toEqual([{ label: 'Vehicle', value: 'TN38AB1234' }, { label: 'Driver', value: 'Kumar · 98765 00000' }, { label: 'LR No', value: 'LR/7' }]);
    expect(dc.to).toMatchObject({ role: 'Deliver to,', address: 'Plot 88, Bengaluru' });
    expect(dc.facts).toEqual([
      { label: 'Reason', value: 'Sale' }, { label: 'Mode', value: 'Own vehicle' }, { label: 'Vehicle No', value: 'TN38AB1234' }, { label: 'Driver', value: 'Kumar' },
      { label: 'Driver Phone', value: '98765 00000' }, { label: 'LR No', value: 'LR/7' }, { label: 'Status', value: 'Pending' },
    ]);
    expect(dc.items.map((item) => [item.third, item.fourth])).toEqual([['1,000 PCS', '133.169'], ['', '25.5']]);
    expect(dc.signatures).toEqual([
      { organisation: 'Kovai Fasteners', role: 'Received by', hint: 'Name · Signature · Date', own: false },
      { organisation: 'Demo Stud Works', role: 'Dispatched by', hint: '', own: true },
    ]);
  });

  it('job-work return: labour on the invoice, goods and weights on the DC', async () => {
    const lot = await receive(local, 'KF/101', '500');
    const form: f.BillForm = {
      ...newForm('job_work'), customer: local, lots: [lot],
      lines: [{ ...f.typeGst(f.blankLine(1, 'job_work'), '18'), text: 'Threading M12 both ends', unit: 'kg', quantity: '480.5', rate: '12' }],
      returns: { [lot.id]: { ...f.blankReturn, returned: '480.5', scrap: '15', pieces: '5400', value: '5000.50', close: true } },
    };
    expect(f.returnBalance(lot, form.returns[lot.id] ?? f.blankReturn)).toEqual({ balance_kg: '4.500', within_tolerance: true, over_returned: false });
    const [invoice, dc] = pair(await issue(form));
    expect(invoice).toMatchObject({ title: 'TAX INVOICE', subtitle: 'JOB WORK', heads: { code: 'SAC CODE' } });
    expect(invoice.items[0]).toMatchObject({ code: '998873', fourth: '480.5 KGS', third: '12.00', thirdNote: '/kg', amount: '5,766.00' });
    expect(ref(invoice, 'Party DC')).toEqual(['KF/101 dt 23.11.26']);
    expect(dc).toMatchObject({ title: 'DELIVERY CHALLAN', subtitle: 'JOB-WORK RETURN', heads: { amount: 'VALUE', split: true } });
    expect(dc.items).toEqual([{ code: '7318', codeNote: '', description: '12 mm rods · MS', detail: 'Party DC KF/101 dt 23.11.26', third: '5,400 PCS', thirdNote: '', fourth: '480.500', fourthNote: '', amount: '5,000.50' }]);
    expect(dc.rows).toEqual([
      { label: 'Inward kg', value: '500.000' },
      { label: 'Returned kg, this DC', value: '480.500' },
      { label: 'Scrap / wastage kg', value: '15.000' },
      { label: 'Balance held kg', value: '4.500' },
    ]);
    expect(dc.total).toEqual({ label: 'DECLARED GOODS VALUE', amount: '5,000.50' });
    expect(dc.words).toEqual({ label: 'Declared goods value, Rupees', value: 'Five Thousand and Fifty Paise Only' });
  });

  it('job-work return of several lots: each with its own weights, the totals below', async () => {
    const lots = [await receive(local, 'KF/201', '100'), await receive(local, 'KF/202', '50')];
    const [first, second] = lots as [JobWorkLot, JobWorkLot];
    const [invoice, dc] = pair(await issue({
      ...newForm('job_work'), customer: local, lots, lines: [{ ...f.typeGst(f.blankLine(1, 'job_work'), '18'), text: 'Threading', unit: 'kg', quantity: '130', rate: '12' }],
      returns: { [first.id]: { ...f.blankReturn, returned: '90', scrap: '1.5', value: '900' }, [second.id]: { ...f.blankReturn, returned: '40.125' } },
    }));
    expect(ref(invoice, 'Party DC')).toEqual([]);
    expect(invoice.notes).toEqual([{ label: 'Party DC', value: expect.stringMatching(/^KF\/20[12] dt 23\.11\.26, KF\/20[12] dt 23\.11\.26$/) as string }]);
    expect(dc.items.map((item) => item.detail).sort()).toEqual([
      'Party DC KF/201 dt 23.11.26 · Inward 100.000 kg · Scrap 1.500 kg · Balance 8.500 kg',
      'Party DC KF/202 dt 23.11.26 · Inward 50.000 kg · Scrap 0.000 kg · Balance 9.875 kg',
    ]);
    expect(dc.rows).toEqual([{ label: 'Returned kg, this DC', value: '130.125' }, { label: 'Scrap / wastage kg', value: '1.500' }]);
    // One lot has no declared value: none is shown.
    expect(dc).toMatchObject({ heads: { amount: 'REMARKS', split: false }, total: null, words: null });
    expect(dc.items.every((item) => item.amount === null)).toBe(true);
  });

  it('SEZ: its declaration stands out, and the tax is IGST', async () => {
    const { POST } = await import('@/app/api/customers/route');
    const sez = await call<Customer>(POST, { name: 'SEZ Unit', gstin: '33AAGCT5678C1ZA', phone: '', state_code: '33', is_sez: true, credit_days: 0, address: 'SEZ', opening_balance: '0' });
    const [invoice] = pair(await issue({ ...newForm(), customer: sez, lines: [line(1, { text: 'Stud', quantity: '10', rate: '10' })] }));
    expect(sum(invoice, 'IGST')).toEqual(['18.00']);
    expect(invoice.notes).toEqual([{ label: '', value: 'Supply to SEZ unit / developer for authorised operations on payment of integrated tax', strong: true }]);
  });

  it('a cancelled bill says so on both papers', async () => {
    const doc = await issue({ ...newForm(), customer: local, lines: [line(1, { text: 'Stud', quantity: '1', rate: '1' })] });
    doc.invoice = { ...doc.invoice, cancelled_at: '2026-11-23T20:30:00Z', cancellation_reason: 'wrong buyer' };
    const [invoice, dc] = pair(doc);
    expect(invoice).toMatchObject({ stamp: 'CANCELLED', notes: [{ label: 'CANCELLED', value: 'on 24 Nov 2026 · wrong buyer', strong: true }] }); // IST
    expect(dc).toMatchObject({ stamp: 'CANCELLED', notes: [{ label: 'CANCELLED', value: 'with the linked invoice', strong: true }] });
  });

  it('the head comes from the snapshot: all of it, or what an older bill has', async () => {
    const doc = await issue({ ...newForm(), customer: local, lines: [line(1, { text: 'Stud', quantity: '1', rate: '1' })] });
    expect(pair(doc)[0].issuer).toEqual({ name: 'Demo Stud Works', tagline: '', addresses: ['1 Test Road, Coimbatore 641001'], contact: ['Mobile : 90000 00000'], gstin: '33AAECS2468R1ZS' });
    doc.invoice.supplier_snapshot = {
      ...doc.invoice.supplier_snapshot, tagline: 'Mfrs : Studs', address: '1 Test Road,\r\n Coimbatore', factory_address: '2 Works Road', office_phone: '0422 - 1234567', phone: '+919000000000', email: 'a@example.com', bank_branch: 'Main',
    };
    const [invoice] = pair(doc);
    expect(invoice.issuer).toMatchObject({
      tagline: 'Mfrs : Studs', addresses: ['Office : 1 Test Road, Coimbatore', 'Factory : 2 Works Road'],
      contact: ['Office : 0422 - 1234567', 'Mobile : +91 90000 00000', 'E-mail : a@example.com'],
    });
    expect(invoice.bank.map((row) => row.label)).toEqual(['BANK NAME', 'BRANCH', 'ACCOUNT No.', 'IFS CODE']);
    doc.invoice.supplier_snapshot = { ...doc.invoice.supplier_snapshot, bank_account_no: null };
    expect(pair(doc)[0].bank).toEqual([]);
  });

  it('copies are labelled as the law wants them', async () => {
    const doc = await issue({ ...newForm(), customer: local, lines: [line(1, { text: 'Stud', quantity: '1', rate: '1' })] });
    expect(buildDocuments(doc, { documents: 'both', copies: 'all' }).map((one) => one.copyLabel)).toEqual([
      'Original for Recipient', 'Duplicate for Transporter', 'Triplicate for Supplier', 'Original for Consignee', 'Duplicate for Transporter', 'Triplicate for Consigner',
    ]);
    doc.invoice = { ...doc.invoice, bill_type: 'job_work' };
    expect(buildDocuments(doc, { documents: 'invoice', copies: 'all' }).map((one) => one.copyLabel)).toEqual(['Original for Recipient', 'Duplicate for Supplier']);
  });
});

describe('the sample on the Company page', () => {
  const company = {
    legal_name: 'Demo Stud Works', tagline: 'Mfrs : Studs', gstin: '33AAECS2468R1ZS', address: '1 Test Road', factory_address: '2 Works Road', state_code: '33', phone: '9000000000',
    office_phone: '0422 - 1234567', email: 'a@example.com', bank_name: 'Demo Bank', bank_branch: 'Main', bank_account_no: '000011112222', bank_ifsc: 'DEMO0000001',
  };

  it('has the company’s own head and bank, and cannot be taken for a bill', () => {
    const [sample, ...more] = sampleBill(company, TEST_TODAY);
    expect(more).toEqual([]);
    expect(sample).toMatchObject({ stamp: 'SAMPLE', number: 'SAMPLE', issuer: { name: 'Demo Stud Works', tagline: 'Mfrs : Studs', addresses: ['Office : 1 Test Road', 'Factory : 2 Works Road'] } });
    expect(sample!.bank).toHaveLength(4);
    const [sheet, ...pages] = billSheets(sampleBill(company, TEST_TODAY));
    expect(pages).toEqual([]);
    expect(sheet!.ops.some((op) => op.kind === 'text' && op.text === 'SAMPLE' && op.ink === 'blush')).toBe(true);
  });

  it('adds up like a real one', () => {
    const [sample] = sampleBill(company, TEST_TODAY);
    const paise = (text: string | null): number => (text === null ? 0 : Math.round(Number(text.replace(/,/g, '')) * 100));
    expect(sample!.items.reduce((total, item) => total + paise(item.amount), 0)).toBe(paise(sample!.sums[0]!.amount));
    expect(sample!.sums.reduce((total, row) => total + paise(row.amount), 0)).toBe(paise(sample!.total!.amount));
    for (const item of sample!.items) expect(Math.round(Number(item.third) * Number(item.fourth.replace(' PCS', '')) * 100)).toBe(paise(item.amount));
    expect(sample!.words?.value).toBe('Ten Thousand Six Hundred Twenty Only');
  });

  it('is there with the least a company can have', () => {
    const least = { ...company, tagline: null, factory_address: null, phone: null, office_phone: null, email: null, bank_name: null, bank_branch: null, bank_account_no: null, bank_ifsc: null };
    expect(billSheets(sampleBill(least, TEST_TODAY))).toHaveLength(1);
  });
});

describe('billing form', () => {
  it('keeps one empty line, and swaps the HSN default with the bill type', () => {
    const typed = f.withTrailingBlank([line(1, { text: 'x' })], 'supply');
    expect(typed.map((row) => row.key)).toEqual([1, 2]);
    expect(f.withTrailingBlank(typed, 'supply')).toBe(typed);
    const form = f.changeType({ ...newForm(), lines: typed }, 'job_work');
    expect(form.lines.map((row) => row.hsn)).toEqual(['998873', '998873']);
    expect(f.changeType({ ...newForm(), lines: [line(1, { text: 'x', hsn: '7318' })] }, 'job_work').lines[0]?.hsn).toBe('7318');
  });

  it('says what is missing instead of guessing', () => {
    expect(f.previewBill(newForm())).toEqual({ problem: 'Pick the customer' });
    expect(f.previewBill({ ...newForm(), customer: local })).toEqual({ problem: 'Add a line' });
    const half = { ...newForm(), customer: local, lines: [line(1, { text: 'x', quantity: '2' })] };
    expect(f.previewBill(half)).toMatchObject({ problem: 'Line 1 needs a description, quantity and rate' });
    expect(f.previewBill({ ...half, lines: [line(1, { text: 'x', quantity: '2', rate: '1.234' })] })).toHaveProperty('problem');
    expect(f.previewBill({ ...half, lines: [line(1, { text: 'x', quantity: '1.5', rate: '1' })] })).toHaveProperty('problem');
  });

  it('converts pieces and kg of a picked stud, and never takes its price for labour', async () => {
    const { GET } = await import('@/app/api/stud-items/[id]/route');
    const stud = await call<Parameters<typeof f.pickStud>[1]>(GET, undefined, { id: md.studItemId });
    const priced = { ...stud, diameter_mm: '12.000', length_mm: '100.00', unit_weight_is_manual: false, default_rate_per_piece: '12.50', default_rate_per_kg: '90' };
    const supply = f.pickStud(f.blankLine(1, 'supply'), priced, 'supply');
    expect(supply).toMatchObject({ unit: 'pcs', rate: '12.5' });
    expect(f.supporting({ ...supply, quantity: '100' })).toEqual({ pieces: null, weightKg: '8.877928' });
    expect(f.changeUnit(supply, 'kg', 'supply').rate).toBe('90');
    expect(f.supporting({ ...f.changeUnit(supply, 'kg', 'supply'), quantity: '8.88' })).toEqual({ pieces: 100, weightKg: null });
    expect(f.pickStud(f.blankLine(1, 'job_work'), priced, 'job_work')).toMatchObject({ hsn: '998873', rate: '' });
  });

  it('warns before the database refuses an over-return', () => {
    const lot = { inward_weight_kg: '100.000', outward_weight_kg: '0.000', scrap_weight_kg: '0.000' } as JobWorkLot;
    expect(f.returnBalance(lot, { ...f.blankReturn, returned: '101' })).toEqual({ balance_kg: '-1.000', within_tolerance: true, over_returned: false });
    expect(f.returnBalance(lot, { ...f.blankReturn, returned: '101.001' })).toEqual({ balance_kg: '-1.001', within_tolerance: false, over_returned: true });
    expect(f.returnBalance(lot, { ...f.blankReturn, returned: 'abc' })).toBeNull();
  });
});

