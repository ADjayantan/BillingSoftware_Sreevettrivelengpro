// billing-math.ts computes, sync_invoice verifies. Whatever the first produces, the second must
// accept and store unchanged: a disagreement would stop a legitimate bill at the factory gate.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { calculateInvoiceDetail, weightForPieces, type InvoiceInput, type InvoiceLine } from '../../src/lib/billing-math';
import { ACTORS, createTestDb, intraStatePayload, outcome, queryAs, seedMasterData, syncInvoice, type MasterData, type Payload } from './harness';

/** Exact paise -> '1180.00', without floating point. */
function rupees(paise: number): string {
  const digits = Math.abs(paise).toString().padStart(3, '0');
  return `${paise < 0 ? '-' : ''}${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

function toPayload(md: MasterData, input: InvoiceInput): Payload {
  const { amounts, lines, charges } = calculateInvoiceDetail(input);
  const billed = input.freight_paid_by === 'seller';
  return intraStatePayload(md, {
    bill_type: input.bill_type,
    customer_id: input.state_code === '33' ? md.tnCustomerId : md.kaCustomerId,
    due_date: '2027-01-31',
    subtotal: rupees(amounts.subtotal_paise),
    packing_charge: rupees(billed ? input.packing_charge_paise : 0),
    delivery_charge: rupees(billed ? input.delivery_charge_paise : 0),
    delivery_taxable: input.delivery_taxable,
    cgst: rupees(amounts.cgst_paise),
    sgst: rupees(amounts.sgst_paise),
    igst: rupees(amounts.igst_paise),
    charges_cgst: rupees(charges.cgst_paise),
    charges_sgst: rupees(charges.sgst_paise),
    charges_igst: rupees(charges.igst_paise),
    round_off: rupees(amounts.round_off_paise),
    grand_total: rupees(amounts.grand_total_paise),
    items: input.lines.map((line, i) => ({
      line_no: i + 1,
      stud_item_id: null,
      description: `Line ${i + 1}`,
      hsn_sac: input.bill_type === 'supply' ? '7318' : '998873',
      qty_pieces: line.billing_unit === 'pcs' ? Number(line.quantity) : null,
      total_weight_kg: line.billing_unit === 'kg' ? line.quantity : null,
      billing_unit: line.billing_unit,
      unit_rate: rupees(line.unit_rate_paise),
      tax_rate_percent: line.tax_rate_percent,
      line_total: rupees(lines[i]!.line_total_paise),
      cgst_amount: rupees(lines[i]!.cgst_paise),
      sgst_amount: rupees(lines[i]!.sgst_paise),
      igst_amount: rupees(lines[i]!.igst_paise),
    })),
    delivery: { freight_paid_by: input.freight_paid_by, freight_amount: rupees(amounts.dc_to_pay_paise) },
  });
}

/** Deterministic generator (mulberry32), so a failure reproduces. */
function random(seed: number) {
  let a = seed;
  return (max: number): number => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) % max;
  };
}

function randomInvoice(seed: number): InvoiceInput {
  const r = random(seed);
  const rates = ['18', '18.00', '5', '12', '0', '0.1', '28', '2.5'];
  const mixed = r(2) === 0;
  const oneRate = rates[r(rates.length)]!;
  const lines = Array.from({ length: 1 + r(r(6) === 0 ? 60 : 5) }, (): InvoiceLine => {
    const kg = r(2) === 0;
    return {
      billing_unit: kg ? 'kg' : 'pcs',
      quantity: kg ? weightForPieces({ diameter_mm: `${6 + r(40)}`, length_mm: `${20 + r(900)}.5` }, 1 + r(3000)) : `${1 + r(20_000)}`,
      unit_rate_paise: r(8) === 0 ? r(4) : r(60_000),
      tax_rate_percent: mixed ? rates[r(rates.length)]! : oneRate,
    };
  });
  const charged = !mixed && r(2) === 0;
  return {
    bill_type: r(3) === 0 ? 'job_work' : 'supply',
    state_code: r(2) === 0 ? '33' : '29',
    lines,
    packing_charge_paise: charged ? r(50_000) : 0,
    delivery_charge_paise: charged ? r(90_000) : 0,
    delivery_taxable: charged ? true : r(2) === 0,
    freight_paid_by: r(4) === 0 ? 'buyer_to_pay' : 'seller',
  };
}

describe('billing-math.ts and sync_invoice agree to the paisa', () => {
  let db: PGlite;
  let md: MasterData;
  beforeAll(async () => {
    db = await createTestDb();
    md = await seedMasterData(db);
  });
  afterAll(async () => {
    await db?.close();
  });

  const syncAndCompare = async (input: InvoiceInput, label: string) => {
    const payload = toPayload(md, input);
    const result = await outcome(syncInvoice(db, ACTORS.staff, payload));
    expect(result, `${label}: ${JSON.stringify(input)}`).toMatch(/^accepted/);
    const [stored] = await queryAs(
      db,
      ACTORS.staff,
      `select subtotal::text, cgst::text, sgst::text, igst::text, round_off::text, grand_total::text
         from public.invoices where client_temp_id = $1`,
      [payload.client_temp_id],
    );
    const { subtotal, cgst, sgst, igst, round_off, grand_total } = payload;
    expect(stored, label).toEqual({ subtotal, cgst, sgst, igst, round_off, grand_total });
  };

  it('accepts and stores 400 generated bills unchanged', async () => {
    for (let seed = 1; seed <= 400; seed += 1) await syncAndCompare(randomInvoice(seed), `seed ${seed}`);
  }, 120_000);

  const base: InvoiceInput = {
    bill_type: 'supply', state_code: '33', lines: [], packing_charge_paise: 0, delivery_charge_paise: 0,
    delivery_taxable: true, freight_paid_by: 'seller',
  };
  const line = (quantity: string, paise: number, rate = '18', unit: InvoiceLine['billing_unit'] = 'pcs'): InvoiceLine => ({
    billing_unit: unit, quantity, unit_rate_paise: paise, tax_rate_percent: rate,
  });

  it.each<[string, Partial<InvoiceInput>]>([
    ['a lot billed by its converted six-decimal weight', { lines: [line('39.457460', 10_425, '18', 'kg')] }],
    ['a half-paisa line rounded up', { lines: [line('1.005', 100, '0', 'kg'), line('0.005', 100, '0', 'kg')] }],
    ['a bill that rounds down to nothing', { state_code: '29', lines: [line('1', 25)] }],
    ['500 lines whose tax rounds as one bucket', { lines: Array.from({ length: 500 }, () => line('1', 3)) }],
    ['500 distinct rates that each round separately', { lines: Array.from({ length: 500 }, (_, i) => line('1', 7, `${(i / 100).toFixed(2)}`)) }],
    ['seller packing + delivery in the taxable value', { lines: [line('1', 10_000)], packing_charge_paise: 1_250, delivery_charge_paise: 1_875 }],
    ['untaxed delivery as its own 0% line', { lines: [line('1', 10_000), line('1', 2_000, '0')], delivery_taxable: false }],
    ['buyer-paid charges on the DC only', { lines: [line('1', 10_000)], delivery_charge_paise: 4_500, freight_paid_by: 'buyer_to_pay' }],
    ['a crore-scale bill', { lines: [line('99999.999999', 99_999, '28', 'kg')] }],
  ])('%s', async (label, change) => {
    await syncAndCompare({ ...base, ...change }, label);
  });

  it('keeps every formula weight inside the stud master CHECK', async () => {
    const r = random(7);
    for (let i = 0; i < 100; i += 1) {
      const spec = { diameter_mm: `${2 + r(60)}.${r(10)}`, length_mm: `${6 + r(2000)}.${r(10)}` };
      const insert = queryAs(
        db,
        ACTORS.staff,
        `insert into public.stud_items (sku_code, diameter_mm, length_mm, thread_type, material_grade, hsn_sac, gst_rate_percent, unit_weight_kg)
         values ($1, $2, $3, 'Metric', 'EN8', '731815', 18, $4)`,
        [`GEN-${i}`, spec.diameter_mm, spec.length_mm, weightForPieces(spec, 1)],
      );
      expect(await outcome(insert), JSON.stringify(spec)).toMatch(/^accepted/);
    }
  });
});
