// The print acceptance cases of specs/print-templates.md: typed on the billing form, issued
// through the real route and database, then bound and rendered as paper.
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createClient as createSupabase } from '@supabase/supabase-js';
import { PrintPacket } from '@/components/print-packet';
import * as f from '@/lib/bill-form';
import { buildDocuments, type PrintDocument } from '@/lib/print-documents';
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
const line = (key: number, over: Partial<f.FormLine>): f.FormLine => ({ ...f.blankLine(key, 'supply'), ...over });

async function issue(form: f.BillForm): Promise<InvoiceDocument> {
  const preview = f.previewBill(form);
  if ('problem' in preview) throw new Error(preview.problem);
  const { POST } = await import('@/app/api/invoices/sync/route');
  const { GET } = await import('@/app/api/invoices/[id]/route');
  const saved = await call<{ invoice_id: string }>(POST, f.toDraft(form, preview.bill));
  return call<InvoiceDocument>(GET, undefined, { id: saved.invoice_id });
}

const find = (rows: { label: string; value: string }[], label: string): string | undefined => rows.find((row) => row.label === label)?.value;
const pair = (doc: InvoiceDocument): [PrintDocument, PrintDocument] => {
  const [invoice, dc] = buildDocuments(doc, { documents: 'both', copies: 'original' });
  if (!invoice || !dc) throw new Error('expected an invoice and a challan');
  return [invoice, dc];
};

let kerala: Customer;
let local: Customer;

beforeAll(async () => {
  db = await createTestDb();
  md = await seedMasterData(db);
  const { POST } = await import('@/app/api/customers/route');
  const base = { phone: '', is_sez: false, credit_days: 30, opening_balance: '0', is_active: true };
  local = await call<Customer>(POST, { ...base, name: 'Kovai Fasteners', gstin: '', state_code: '33', address: 'SIDCO, Coimbatore' });
  kerala = await call<Customer>(POST, { ...base, name: 'Kochi Marine', gstin: '', state_code: '32', address: 'Kochi' });
});
afterAll(async () => {
  await db.close();
});

describe('print acceptance cases', () => {
  it('TN supply: ₹1,239.00 with words, both references matching', async () => {
    const doc = await issue({ ...newForm(), customer: local, lines: [line(1, { text: 'Studs M12', quantity: '10', rate: '100' })], packing: '20', freight: '30' });
    const [invoice, dc] = pair(doc);
    expect(find(invoice.closingRows, 'Taxable value')).toBe('1,050.00');
    expect(find(invoice.closingRows, 'CGST')).toBe('94.50');
    expect(find(invoice.closingRows, 'SGST')).toBe('94.50');
    expect(invoice.total).toEqual({ label: 'Invoice total', value: '₹1,239.00' });
    expect(invoice.words?.value).toBe('Rupees One Thousand Two Hundred Thirty-Nine Only');
    expect(invoice.taxBand?.rows).toEqual([[
      { text: '18%', align: '' }, { text: '1,050.00', align: 'num' }, { text: '9% · 94.50', align: 'num' }, { text: '9% · 94.50', align: 'num' },
    ]]);
    expect(find(invoice.linked, 'DC')).toContain(dc.number);
    expect(find(dc.linked, 'Invoice')).toContain(invoice.number);
    expect(dc.total).toBeNull(); // a challan never asks for payment
  });

  it('Kerala, To-Pay: ₹1,204.00, and the DC carries the ₹30.00 buyer payment', async () => {
    const doc = await issue({
      ...newForm(), customer: kerala, lines: [line(1, { text: 'Studs M12', quantity: '10', rate: '100' })], packing: '20', freight: '30', freightPaidBy: 'buyer_to_pay',
    });
    const [invoice, dc] = pair(doc);
    expect(invoice.items.map((item) => item.description)).toEqual(['Studs M12', 'Packing charges']);
    expect(find(invoice.closingRows, 'Taxable value')).toBe('1,020.00');
    expect(find(invoice.closingRows, 'IGST')).toBe('183.60');
    expect(find(invoice.closingRows, 'Round-off')).toBe('+0.40');
    expect(invoice.total?.value).toBe('₹1,204.00');
    expect(find(invoice.closingRows, 'Delivery')).toBeUndefined();
    expect(find(dc.closingRows, 'Payable directly by buyer · Freight')).toBe('₹30.00');
    expect(dc.items.map((item) => item.description)).toEqual(['Studs M12']); // packing is not goods
  });

  it('job-work return: labour on the invoice, goods and weights on the DC', async () => {
    const lots = await import('@/app/api/job-work/route');
    const lot = await call<JobWorkLot>(lots.POST, {
      customer_id: local.id, party_dc_no: 'KF/101', party_dc_date: TEST_TODAY, material_grade: 'MS', description: '12 mm rods', inward_weight_kg: '500',
    });
    const form: f.BillForm = {
      ...newForm('job_work'), customer: local, lots: [lot],
      lines: [{ ...f.blankLine(1, 'job_work'), text: 'Threading M12 both ends', unit: 'kg', quantity: '480.5', rate: '12' }],
      returns: { [lot.id]: { ...f.blankReturn, returned: '480.5', scrap: '15', pieces: '5400', value: '5000.50', close: true } },
    };
    expect(f.returnBalance(lot, form.returns[lot.id] ?? f.blankReturn)).toEqual({ balance_kg: '4.500', within_tolerance: true, over_returned: false });
    const [invoice, dc] = pair(await issue(form));
    expect(invoice.title).toBe('GST Tax Invoice · Job Work');
    expect(invoice.items[0]).toMatchObject({ codeLabel: 'SAC', code: '998873', quantity: '480.5 KGS', third: '12.00', thirdDetail: 'per kg', fourth: '5,766.00' });
    expect(find(invoice.linked, 'Party DC')).toContain('KF/101');
    expect(dc.title).toBe('Delivery Challan · Job-Work Return');
    expect(dc.items[0]).toMatchObject({ codeLabel: 'HSN', code: '7318', quantity: '5,400 PCS', third: '480.500', fourth: '5,000.50' });
    expect(dc.closingRows).toEqual([
      { label: 'Inward kg · Party DC KF/101', value: '500.000' },
      { label: 'Returned kg this DC', value: '480.500' },
      { label: 'Scrap / wastage kg', value: '15.000' },
      { label: 'Balance held kg', value: '4.500' },
    ]);
    expect(dc.total).toEqual({ label: 'Declared goods value', value: '₹5,000.50' });
    expect(dc.words?.value).toBe('Rupees Five Thousand and Fifty Paise Only');
  });

  it('60 lines up to a crore: every line once, words once per copy, references on each header', async () => {
    const lines = Array.from({ length: 60 }, (_, i) => line(i + 1, { text: `Stud line ${String(i + 1).padStart(2, '0')}`, quantity: '1', rate: '174376.82' }));
    const doc = await issue({ ...newForm(), customer: local, lines });
    const html = renderToStaticMarkup(createElement(PrintPacket, { documents: buildDocuments(doc, { documents: 'invoice', copies: 'all' }), paper: 'a5' }));
    expect(html).toContain('data-paper="a5"');
    expect(html.match(/<article class="sheet">/g)).toHaveLength(3);
    for (let i = 1; i <= 60; i++) expect(html.split(`Stud line ${String(i).padStart(2, '0')}<`)).toHaveLength(4); // once per copy
    expect(html.match(/Amount in words/g)).toHaveLength(3);
    expect(html.match(/Crore/g)).toHaveLength(3);
    expect(html).toContain('₹1,23,45,879.00');
    expect(html.match(new RegExp(`GST Tax Invoice · ${doc.invoice.invoice_no} · `, 'g'))).toHaveLength(3);
  });

  it('a name or address with markup prints as text', async () => {
    const { POST } = await import('@/app/api/customers/route');
    const evil = await call<Customer>(POST, {
      name: '<img src=x onerror=alert(1)>', gstin: '', phone: '', state_code: '33', credit_days: 0, address: '<b>x</b>', opening_balance: '0',
    });
    const doc = await issue({ ...newForm(), customer: evil, lines: [line(1, { text: 'Stud', quantity: '1', rate: '1' })] });
    const html = renderToStaticMarkup(createElement(PrintPacket, { documents: buildDocuments(doc, { documents: 'both', copies: 'original' }), paper: 'a4' }));
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});

describe('print stylesheet', () => {
  const read = (path: string): string => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  it('is the spec CSS, and each paper has exactly its page rule', () => {
    const blocks = [...read('specs/print-templates.md').matchAll(/```css\n([\s\S]*?)```/g)].map((match) => (match[1] ?? '').trim());
    expect(blocks).toHaveLength(3);
    const css = read('src/app/invoices/[id]/print/print.css');
    expect(css).toContain(blocks[0]);
    expect(css).not.toContain('@page {');
    const page = read('src/app/invoices/[id]/print/page.tsx');
    for (const block of blocks.slice(1)) expect(page).toContain(block.split('\n').at(-1));
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

