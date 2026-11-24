/**
 * StudFlow billing contract. Place this file in tests/ beside src/ in the app.
 * Run: npx vitest run tests/billing-math.test.ts
 *
 * The three named exports below are the production entry points. PostgreSQL
 * NUMERIC rupees must be parsed exactly into integer paise at the boundary.
 * Pass kg, dimensions, quantity and GST percentages as base-10 strings.
 * Monetary inputs and outputs are safe JS integers. Reject unrepresentable
 * amounts. Work in exact decimal or rational arithmetic before rounding.
 *
 * weightForPieces(spec, n) returns total kg as a fixed six-decimal string.
 * wholePiecesForWeight(spec, kg) returns the number of complete pieces that
 * fit. Both use the exact unit mass. A positive manual mass supersedes the
 * steel estimate. A null or omitted override selects the formula.
 *
 * calculateInvoice(input) returns the eight paise columns in Amounts below.
 * unit_rate_paise is the selling rate for supply, the agreed processing rate
 * for job work. raw_metal_cost_paise is optional costing metadata. Quantities
 * are positive on invoice lines. A piece count is integral.
 *
 * Round each line extension half-up to one paisa. Sum by numeric GST rate.
 * For ordinary domestic supplies from TN where the customer state is the
 * determined place of supply, state 33 selects CGST + SGST, otherwise IGST.
 * Resolve exceptions such as bill-to/ship-to and SEZ outside this API. All
 * percentages below are test fixtures. Use the approved item/service rate.
 * Round each tax head per rate bucket half-up to a paisa. An odd-paisa case
 * can therefore differ from the comparable IGST by one paisa. Round the
 * final invoice payable half-up to a rupee, recording its signed adjustment.
 *
 * The two header charge amounts share one payer and treatment. Seller-billed
 * incidental charges inherit the underlying supply rate. On mixed rates,
 * pass explicitly classified charge lines and zero the corresponding header
 * amounts. Buyer-to-pay represents amounts payable directly by the buyer to
 * the third party and produces the DC amount. When only freight is to-pay,
 * pass seller-billed packing as a taxable line and only freight in the header.
 */
import { describe, expect, it } from 'vitest'
import {
  calculateInvoice,
  weightForPieces,
  wholePiecesForWeight,
} from '../src/lib/billing-math'

type WeightSpec = {
  diameter_mm: string
  length_mm: string
  manual_unit_weight_kg?: string | null
}

type Line = {
  billing_unit: 'pcs' | 'kg'
  quantity: string
  unit_rate_paise: number
  tax_rate_percent: string
  raw_metal_cost_paise?: number
}

type InvoiceInput = {
  bill_type: 'supply' | 'job_work'
  state_code: string
  lines: Line[]
  packing_charge_paise: number
  delivery_charge_paise: number
  delivery_taxable: boolean
  freight_paid_by: 'seller' | 'buyer_to_pay'
}

type Amounts = {
  subtotal_paise: number
  taxable_value_paise: number
  cgst_paise: number
  sgst_paise: number
  igst_paise: number
  round_off_paise: number
  grand_total_paise: number
  dc_to_pay_paise: number
}

const m8: WeightSpec = { diameter_mm: '8', length_mm: '100' }
const measured: WeightSpec = { ...m8, manual_unit_weight_kg: '0.125000' }

function line(quantity = '1', ratePaise = 10_000, gst = '18', unit: Line['billing_unit'] = 'pcs'): Line {
  return { billing_unit: unit, quantity, unit_rate_paise: ratePaise, tax_rate_percent: gst }
}

function invoice(changes: Partial<InvoiceInput> = {}): InvoiceInput {
  return {
    bill_type: 'supply',
    state_code: '33',
    lines: [line()],
    packing_charge_paise: 0,
    delivery_charge_paise: 0,
    delivery_taxable: true,
    freight_paid_by: 'seller',
    ...changes,
  }
}

// Centralize only the ledger invariants. Expected amounts are literal vectors.
function bill(changes: Partial<InvoiceInput> = {}): Amounts {
  const result: Amounts = calculateInvoice(invoice(changes))
  for (const amount of [
    result.subtotal_paise, result.taxable_value_paise, result.cgst_paise,
    result.sgst_paise, result.igst_paise, result.round_off_paise,
    result.grand_total_paise, result.dc_to_pay_paise,
  ]) {
    expect(Number.isSafeInteger(amount)).toBe(true)
  }
  expect(result.grand_total_paise).toBe(
    result.taxable_value_paise + result.cgst_paise + result.sgst_paise
    + result.igst_paise + result.round_off_paise,
  )
  expect(result.grand_total_paise % 100).toBe(0)
  return result
}

describe('stud quantities', () => {
  it('uses both millimetre dimensions and the 162.2 steel divisor', () => {
    expect(weightForPieces(m8, 1)).toBe('0.039457')
  })

  it('multiplies by the count before rounding the unit mass for display', () => {
    expect(weightForPieces(m8, 1_000)).toBe('39.457460')
  })

  it('supports fractional cut lengths on M24', () => {
    expect(weightForPieces({ diameter_mm: '24', length_mm: '125.5' }, 17)).toBe('7.576424')
  })

  it('rounds an exact half-milligram up even when binary evaluation falls below the tie', () => {
    expect(weightForPieces({ diameter_mm: '10', length_mm: '81.100811' }, 1)).toBe('0.050001')
  })

  it('uses the measured unit weight for an entire lot', () => {
    expect(weightForPieces(measured, 8)).toBe('1.000000')
  })

  it('accepts a null override from the item master', () => {
    expect(weightForPieces({ ...m8, manual_unit_weight_kg: null }, 1)).toBe('0.039457')
  })

  it('handles zero pieces and zero kg as empty conversions', () => {
    expect(weightForPieces(m8, 0)).toBe('0.000000')
    expect(wholePiecesForWeight(m8, '0')).toBe(0)
  })

  it('uses the unrounded theoretical mass on either side of a piece boundary', () => {
    expect(wholePiecesForWeight(m8, '0.039457')).toBe(0)
    expect(wholePiecesForWeight(m8, '0.039458')).toBe(1)
  })

  it('converts an exact 162.2 kg lot into 811 M10 × 324.4 mm studs', () => {
    expect(wholePiecesForWeight({ diameter_mm: '10', length_mm: '324.4' }, '162.2')).toBe(811)
  })

  it('uses the override for inverse conversion and drops a partial piece', () => {
    expect(wholePiecesForWeight(measured, '1.000000')).toBe(8)
    expect(wholePiecesForWeight(measured, '0.999999')).toBe(7)
  })

  it('returns the largest safe piece count exactly and rejects the next count', () => {
    expect(wholePiecesForWeight(measured, '1125899906842623.875')).toBe(Number.MAX_SAFE_INTEGER)
    expect(() => wholePiecesForWeight(measured, '1125899906842624')).toThrow()
  })

  it.each([-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])('rejects invalid piece count %s', count => {
    expect(() => weightForPieces(m8, count)).toThrow()
  })

  it.each([
    { ...m8, diameter_mm: '0' },
    { ...m8, length_mm: '-100' },
    { ...m8, manual_unit_weight_kg: '0' },
    { ...m8, manual_unit_weight_kg: '-0.1' },
    { ...m8, manual_unit_weight_kg: 'unknown' },
  ])('rejects an invalid dimension or override (%o)', spec => {
    expect(() => weightForPieces(spec, 1)).toThrow()
    expect(() => wholePiecesForWeight(spec, '1')).toThrow()
  })

  it.each(['-0.001', '1kg', ''])('rejects invalid inverse weight "%s"', kg => {
    expect(() => wholePiecesForWeight(m8, kg)).toThrow()
  })
})

describe('GST and invoice lines', () => {
  it('splits an ordinary TN sale equally between CGST and SGST', () => {
    expect(bill()).toMatchObject({
      subtotal_paise: 10_000, taxable_value_paise: 10_000,
      cgst_paise: 900, sgst_paise: 900, igst_paise: 0,
      round_off_paise: 0, grand_total_paise: 11_800, dc_to_pay_paise: 0,
    })
  })

  it.each(['32', '29'])('applies only IGST to a sale from TN to %s', state_code => {
    expect(bill({ state_code })).toMatchObject({
      subtotal_paise: 10_000, taxable_value_paise: 10_000,
      cgst_paise: 0, sgst_paise: 0, igst_paise: 1_800, grand_total_paise: 11_800,
    })
  })

  it('bills a 1,000-piece M8 lot by its converted weight at ₹104.25/kg', () => {
    const kg = weightForPieces(m8, 1_000)
    expect(bill({ lines: [line(kg, 10_425, '18', 'kg')] })).toMatchObject({
      subtotal_paise: 411_344, taxable_value_paise: 411_344,
      cgst_paise: 37_021, sgst_paise: 37_021, igst_paise: 0,
      round_off_paise: 14, grand_total_paise: 485_400,
    })
  })

  it('calculates a multiple-rate invoice with independently rated lines', () => {
    expect(bill({ lines: [line('2', 5_000, '5'), line('3', 10_000, '18')] })).toMatchObject({
      subtotal_paise: 40_000, taxable_value_paise: 40_000,
      cgst_paise: 2_950, sgst_paise: 2_950, igst_paise: 0, grand_total_paise: 45_900,
    })
  })

  it('groups equivalent decimal spellings before rounding each equal TN half-rate', () => {
    // Each line alone yields < 0.5 paisa per head. Together 6 × 9% = 0.54 paisa per head.
    expect(bill({ lines: [line('1', 3, '18.00'), line('1', 3, '18')] })).toMatchObject({
      subtotal_paise: 6, cgst_paise: 1, sgst_paise: 1, igst_paise: 0, round_off_paise: -8,
    })
  })

  it('rounds a single interstate tax head on the same six-paise base', () => {
    expect(bill({ state_code: '32', lines: [line('1', 6)] })).toMatchObject({
      cgst_paise: 0, sgst_paise: 0, igst_paise: 1, round_off_paise: -7,
    })
  })

  it('rounds tax within each distinct rate bucket before totaling', () => {
    // 9 × 5% = 0.45 paisa and 2 × 18% = 0.36 paisa.
    expect(bill({ state_code: '29', lines: [line('1', 9, '5'), line('1', 2)] })).toMatchObject({
      taxable_value_paise: 11, igst_paise: 0, round_off_paise: -11,
    })
  })

  it('rounds a tax head exactly at half a paisa up', () => {
    expect(bill({ state_code: '32', lines: [line('1', 25)] })).toMatchObject({
      igst_paise: 5, grand_total_paise: 0, round_off_paise: -30,
    })
  })
})

describe('packing, delivery and the linked challan', () => {
  const charges = { packing_charge_paise: 1_250, delivery_charge_paise: 1_875 }

  it('adds both seller charges to the supply base before calculating TN tax', () => {
    expect(bill(charges)).toMatchObject({
      subtotal_paise: 10_000, taxable_value_paise: 13_125,
      cgst_paise: 1_181, sgst_paise: 1_181, igst_paise: 0,
      round_off_paise: 13, grand_total_paise: 15_500, dc_to_pay_paise: 0,
    })
  })

  it('applies interstate tax to the same seller-billed charges', () => {
    expect(bill({ ...charges, state_code: '32' })).toMatchObject({
      taxable_value_paise: 13_125, cgst_paise: 0, sgst_paise: 0,
      igst_paise: 2_363, round_off_paise: 12, grand_total_paise: 15_500,
    })
  })

  it.each([true, false])('keeps buyer-direct charges on the DC when delivery_taxable=%s', delivery_taxable => {
    expect(bill({ ...charges, freight_paid_by: 'buyer_to_pay', delivery_taxable })).toMatchObject({
      subtotal_paise: 10_000, taxable_value_paise: 10_000,
      cgst_paise: 900, sgst_paise: 900, igst_paise: 0,
      round_off_paise: 0, grand_total_paise: 11_800, dc_to_pay_paise: 3_125,
    })
  })

  it('charges GST on seller packing while showing only buyer-paid freight on the DC', () => {
    const sellerPacking = line('1', 1_500, '18')
    expect(bill({
      lines: [line(), sellerPacking],
      freight_paid_by: 'buyer_to_pay', delivery_taxable: false, delivery_charge_paise: 4_500,
    })).toMatchObject({
      taxable_value_paise: 11_500, cgst_paise: 1_035, sgst_paise: 1_035,
      igst_paise: 0, round_off_paise: 30, grand_total_paise: 13_600, dc_to_pay_paise: 4_500,
    })
  })

  it('requires explicit classification for a positive seller charge marked untaxed', () => {
    expect(() => calculateInvoice(invoice({ ...charges, delivery_taxable: false }))).toThrow()
  })

  it('accepts an unticked delivery tax flag when there are no charges', () => {
    expect(bill({ delivery_taxable: false }).grand_total_paise).toBe(11_800)
  })

  it('requires an explicit allocation for seller charges on a mixed-rate invoice', () => {
    expect(() => calculateInvoice(invoice({
      ...charges, lines: [line(), line('1', 1_000, '5')],
    }))).toThrow()
  })

  it('accepts a common seller charge when two rate strings denote one numeric rate', () => {
    expect(bill({
      lines: [line('1', 1_000, '18.0'), line('1', 1_000, '18')],
      packing_charge_paise: 500,
    })).toMatchObject({ taxable_value_paise: 2_500, cgst_paise: 225, sgst_paise: 225 })
  })

  it('requires no GST allocation of buyer-direct freight on a mixed-rate invoice', () => {
    expect(bill({
      lines: [line(), line('1', 1_000, '5')],
      freight_paid_by: 'buyer_to_pay', delivery_charge_paise: 200,
    })).toMatchObject({
      taxable_value_paise: 11_000, cgst_paise: 925, sgst_paise: 925,
      grand_total_paise: 12_900, dc_to_pay_paise: 200,
    })
  })
})

describe('job-work processing', () => {
  it('bills 40 pieces at the labour rate without charging the principal for its metal', () => {
    const batch = { ...line('40', 750), raw_metal_cost_paise: 680_000 }
    expect(bill({ bill_type: 'job_work', lines: [batch] })).toMatchObject({
      subtotal_paise: 30_000, taxable_value_paise: 30_000,
      cgst_paise: 2_700, sgst_paise: 2_700, igst_paise: 0,
      round_off_paise: 0, grand_total_paise: 35_400,
    })
  })

  it('bills a Kerala principal by processed kg and applies IGST to labour', () => {
    const batch = { ...line('12.750', 1_440, '18', 'kg'), raw_metal_cost_paise: 720_000 }
    expect(bill({ bill_type: 'job_work', state_code: '32', lines: [batch] })).toMatchObject({
      subtotal_paise: 18_360, taxable_value_paise: 18_360,
      cgst_paise: 0, sgst_paise: 0, igst_paise: 3_305,
      round_off_paise: 35, grand_total_paise: 21_700,
    })
  })

  it('never substitutes raw metal value for a zero labour rate', () => {
    const batch = { ...line('20', 0), raw_metal_cost_paise: 500_000 }
    expect(bill({ bill_type: 'job_work', lines: [batch] })).toMatchObject({
      taxable_value_paise: 0, cgst_paise: 0, sgst_paise: 0, igst_paise: 0, grand_total_paise: 0,
    })
  })

  it('uses the configured service rate even when it differs from the ordinary fixture', () => {
    const batch = { ...line('100', 500, '5'), raw_metal_cost_paise: 900_000 }
    expect(bill({ bill_type: 'job_work', lines: [batch] })).toMatchObject({
      taxable_value_paise: 50_000, cgst_paise: 1_250, sgst_paise: 1_250,
      igst_paise: 0, grand_total_paise: 52_500,
    })
  })
})

describe('paise precision and signed rupee round-off', () => {
  it.each([
    [100, 0, 100], [149, -49, 100], [150, 50, 200], [151, 49, 200], [199, 1, 200],
  ])('rounds %i paise by %i paise to %i paise', (amount, adjustment, total) => {
    expect(bill({ lines: [line('1', amount, '0')] })).toMatchObject({
      taxable_value_paise: amount, cgst_paise: 0, sgst_paise: 0, igst_paise: 0,
      round_off_paise: adjustment, grand_total_paise: total,
    })
  })

  it('rounds a 1.005 kg extension at ₹1/kg to 101 paise', () => {
    expect(bill({ lines: [line('1.005', 100, '0', 'kg')] }).subtotal_paise).toBe(101)
  })

  it('rounds each extension to paise before summing the invoice', () => {
    const halfPaisa = line('0.005', 100, '0', 'kg')
    expect(bill({ lines: [halfPaisa, { ...halfPaisa }] }).subtotal_paise).toBe(2)
  })

  it('accumulates a thousand tiny fractional-kg lines to an exact number of paise', () => {
    const lines = Array.from({ length: 1_000 }, () => line('0.1', 3_330, '0', 'kg'))
    expect(bill({ lines })).toMatchObject({
      subtotal_paise: 333_000, round_off_paise: 0, grand_total_paise: 333_000,
    })
  })

  it('does not turn a below-half-paisa remainder into a tie near a large decimal boundary', () => {
    expect(bill({ lines: [line('1000000000000.004999', 100, '0', 'kg')] })).toMatchObject({
      subtotal_paise: 100_000_000_000_000, round_off_paise: 0,
      grand_total_paise: 100_000_000_000_000,
    })
  })

  it('rejects a final rounded rupee amount outside the exact numeric output range', () => {
    expect(() => calculateInvoice(invoice({ lines: [line('1', Number.MAX_SAFE_INTEGER, '0')] }))).toThrow()
  })
})

describe('invalid input cannot silently become a bill', () => {
  const cases: Array<[string, Partial<InvoiceInput>]> = [
    ['missing lines', { lines: [] }],
    ['missing customer state', { state_code: '' }],
    ['malformed state', { state_code: 'TN' }],
    ['zero invoice quantity', { lines: [line('0')] }],
    ['fractional piece', { lines: [line('1.25')] }],
    ['negative kg quantity', { lines: [line('-0.1', 100, '18', 'kg')] }],
    ['quantity with trailing text', { lines: [line('2 studs')] }],
    ['negative rate', { lines: [line('1', -1)] }],
    ['sub-paisa rate', { lines: [line('1', 30.0000001)] }],
    ['nonfinite rate', { lines: [line('1', Number.NaN)] }],
    ['unsafe rate', { lines: [line('1', Number.MAX_SAFE_INTEGER + 1)] }],
    ['negative tax rate', { lines: [line('1', 100, '-5')] }],
    ['negative seller packing', { packing_charge_paise: -50 }],
    ['sub-paisa buyer freight', { freight_paid_by: 'buyer_to_pay', delivery_charge_paise: 0.1 }],
  ]

  it.each(cases)('rejects %s', (_label, change) => {
    expect(() => calculateInvoice(invoice(change))).toThrow()
  })
})
