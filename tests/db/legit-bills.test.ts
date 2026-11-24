// Real-world bills the constraints must keep ACCEPTING. Every tightening of the schema has to
// leave this file green: a wrongly refused bill stops dispatch at the factory gate.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import {
  ACTORS,
  createTestDb,
  goodsLine,
  interStatePayload,
  intraStatePayload,
  outcome,
  queryAs,
  recordPayment,
  seedMasterData,
  syncInvoice,
  type Line,
  type MasterData,
  type Payload,
} from './harness';

const pcs = (lineNo: number, qty: number, rate: string, percent: string, total: string): Line => ({
  line_no: lineNo, stud_item_id: null, description: `Stud line ${lineNo}`, hsn_sac: '7318', qty_pieces: qty,
  total_weight_kg: null, billing_unit: 'pcs', unit_rate: rate, tax_rate_percent: percent, line_total: total,
});
const kg = (hsn: string, description: string, qty: number | null, weight: string, rate: string, total: string): Line => ({
  line_no: 1, stud_item_id: null, description, hsn_sac: hsn, qty_pieces: qty, total_weight_kg: weight,
  billing_unit: 'kg', unit_rate: rate, tax_rate_percent: '18.00', line_total: total,
});

const BILLS: [string, (md: MasterData) => Payload][] = [
  ['nil-rated goods, no GST', (md) => ({ cgst: '0.00', sgst: '0.00', grand_total: '1500.00',
    items: [goodsLine(md, { tax_rate_percent: '0.00' })] })],
  ['four GST rates on one bill: 18 / 12 / 5 / 0', () => ({ subtotal: '4000.00', cgst: '220.00', sgst: '220.00', grand_total: '4440.00',
    items: [pcs(1, 1000, '1.50', '18.00', '1500.00'), pcs(2, 100, '10.00', '12.00', '1000.00'),
            pcs(3, 200, '5.00', '5.00', '1000.00'), pcs(4, 10, '50.00', '0.00', '500.00')] })],
  ['two rates, each rounded per line, with a round-off', () => ({ subtotal: '1334.56', cgst: '113.61', sgst: '113.61',
    round_off: '0.22', grand_total: '1562.00',
    items: [pcs(1, 100, '12.3457', '18.00', '1234.57'), pcs(2, 1, '99.99', '5.00', '99.99')] })],
  ['a rate quoted per 1000 pcs: 100,000 x Rs 0.04375', () => ({ subtotal: '4375.00', cgst: '393.75', sgst: '393.75', round_off: '0.50',
    grand_total: '5163.00', items: [pcs(1, 100000, '0.04375', '18.00', '4375.00')] })],
  ['a 4-decimal rate: 100,000 x Rs 0.0425', () => ({ subtotal: '4250.00', cgst: '382.50', sgst: '382.50', grand_total: '5015.00',
    items: [pcs(1, 100000, '0.0425', '18.00', '4250.00')] })],
  ['a 0.1% supply to a merchant exporter', () => ({ subtotal: '15000.00', cgst: '7.50', sgst: '7.50', grand_total: '15015.00',
    items: [pcs(1, 10000, '1.50', '0.10', '15000.00')] })],
  ['a round-off of exactly +0.50', () => ({ subtotal: '1499.58', cgst: '134.96', sgst: '134.96', round_off: '0.50', grand_total: '1770.00',
    items: [pcs(1, 1, '1499.58', '18.00', '1499.58')] })],
  ['an unrounded bill that keeps its paise', () => ({ subtotal: '1234.57', cgst: '111.11', sgst: '111.11', grand_total: '1456.79',
    items: [pcs(1, 100, '12.3457', '18.00', '1234.57')] })],
  ['job work by the kg (SAC 998873), round-off -0.23', () => ({ bill_type: 'job_work', subtotal: '3092.57', cgst: '278.33', sgst: '278.33',
    round_off: '-0.23', grand_total: '3649.00',
    items: [kg('998873', 'Threading (job work) on customer rods', null, '250.500', '12.3456', '3092.57')] })],
  ['heavy studs by the kg: 50,505.549 kg x Rs 95.50, 8-digit HSN', () => ({ subtotal: '4823279.93', cgst: '434095.19', sgst: '434095.19',
    round_off: '-0.31', grand_total: '5691470.00', items: [kg('73181500', 'M64 x 2000 EN8 stud', 1000, '50505.549', '95.50', '4823279.93')] })],
  ['a one-piece sample whose weight rounds to 0.000 kg', () => ({ subtotal: '3.00', cgst: '0.27', sgst: '0.27', round_off: '0.46',
    grand_total: '4.00', items: [{ ...pcs(1, 1, '3.00', '18.00', '3.00'), total_weight_kg: '0.000' }] })],
  ['packing + delivery inside the taxable value', () => ({ packing_charge: '100.00', delivery_charge: '200.00', cgst: '162.00',
    sgst: '162.00', grand_total: '2124.00' })],
  ['delivery recovered at cost, outside the taxable value', () => ({ delivery_charge: '200.00', delivery_taxable: false, grand_total: '1970.00' })],
  ['packing + delivery taxed at the lowest rate on a mixed bill', () => ({ subtotal: '2500.00', packing_charge: '100.00',
    cgst: '162.50', sgst: '162.50', grand_total: '2925.00',
    items: [pcs(1, 1000, '1.50', '18.00', '1500.00'), pcs(2, 200, '5.00', '5.00', '1000.00')] })],
  ['packing + delivery taxed at the highest rate on a mixed bill', () => ({ subtotal: '2500.00', packing_charge: '100.00',
    cgst: '169.00', sgst: '169.00', grand_total: '2938.00',
    items: [pcs(1, 1000, '1.50', '18.00', '1500.00'), pcs(2, 200, '5.00', '5.00', '1000.00')] })],
  ['a cash sale paid on the spot', () => ({ payment_status: 'paid', amount_paid: '1770.00', due_date: '2026-11-20' })],
  ['buyer-paid freight, shown on the DC only', () => ({ delivery: { transport_mode: 'transporter', lr_number: 'LR-1188',
    freight_paid_by: 'buyer_to_pay', freight_amount: '350.00' } })],
];

describe('legitimate bills are accepted', () => {
  let db: PGlite;
  let md: MasterData;
  let unregistered: string;
  let foreignBuyer: string;
  beforeAll(async () => {
    db = await createTestDb();
    md = await seedMasterData(db);
    const addCustomer = async (name: string, state: string, address: string) =>
      (await db.query<{ id: string }>('insert into public.customers (name, state_code, address) values ($1, $2, $3) returning id', [name, state, address]))
        .rows[0]!.id;
    unregistered = await addCustomer('Walk-in: Selvam Lathe Works', '33', 'Ganapathy, Coimbatore 641006');
    foreignBuyer = await addCustomer('Gulf Fastening LLC', '96', 'Jebel Ali Free Zone, Dubai, UAE');
  });
  afterAll(async () => {
    await db?.close();
  });

  const bill = (payload: Payload) => outcome(syncInvoice(db, ACTORS.staff, payload));

  it.each(BILLS)('%s', async (_label, build) => {
    expect(await bill(intraStatePayload(md, build(md)))).toMatch(/^accepted/);
  });

  it('an inter-state bill with IGST', async () => {
    expect(await bill(interStatePayload(md))).toMatch(/^accepted/);
  });

  it('an unregistered Tamil Nadu buyer', async () => {
    expect(await bill(intraStatePayload(md, { customer_id: unregistered }))).toMatch(/^accepted/);
  });

  it('exports: on payment of IGST, and zero-rated (0% lines) under LUT', async () => {
    const abroad = { customer_id: foreignBuyer, due_date: '2027-01-19' };
    expect(await bill(interStatePayload(md, abroad))).toMatch(/^accepted/);
    expect(
      await bill(interStatePayload(md, { ...abroad, igst: '0.00', grand_total: '1500.00', items: [goodsLine(md, { tax_rate_percent: '0.00' })] })),
    ).toMatch(/^accepted/);
  });

  it('a 500-line bill', async () => {
    const items = Array.from({ length: 500 }, (_, i) => pcs(i + 1, 1, '0.33', '18.00', '0.33'));
    // 500 x 0.33 = 165.00; each half per line = 0.0297 -> 0.03, x 500 = 15.00
    const perLine = { subtotal: '165.00', cgst: '15.00', sgst: '15.00', grand_total: '195.00', items };
    const perInvoice = { subtotal: '165.00', cgst: '14.85', sgst: '14.85', round_off: '0.30', grand_total: '195.00', items };
    expect(await bill(intraStatePayload(md, perLine))).toMatch(/^accepted/);
    expect(await bill(intraStatePayload(md, perInvoice))).toMatch(/^accepted/);
  });

  it('a part payment, then settlement net of TDS, then a cancellation that keeps number and amounts', async () => {
    const paid = await syncInvoice(db, ACTORS.staff, intraStatePayload(md));
    expect(await recordPayment(db, ACTORS.staff, paid.invoice_id, '1000.00')).toMatchObject({ payment_status: 'partial' });
    expect(await recordPayment(db, ACTORS.staff, paid.invoice_id, '740.00', { settles_invoice: true })).toMatchObject({
      payment_status: 'paid',
      amount_paid: '1740.00',
    });
    const other = await syncInvoice(db, ACTORS.staff, intraStatePayload(md));
    const [cancelled] = await queryAs(
      db,
      ACTORS.staff,
      `update public.invoices set cancelled_at = now(), cancellation_reason = 'Order cancelled before dispatch'
        where id = $1 returning invoice_no, grand_total::text`,
      [other.invoice_id],
    );
    expect(cancelled).toEqual({ invoice_no: other.invoice_no, grand_total: '1770.00' });
  });
});
