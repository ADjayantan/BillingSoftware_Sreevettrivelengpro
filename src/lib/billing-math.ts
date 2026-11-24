/**
 * The ONLY place money, GST, weights and totals are computed. Pure: no I/O, no clock, no
 * floating point. Values are exact BigInt fractions until one explicit half-up rounding.
 * Contract: tests/billing-math.test.ts (frozen).
 */

export type BillType = 'supply' | 'job_work';
export type BillingUnit = 'pcs' | 'kg';
export type FreightPayer = 'seller' | 'buyer_to_pay';

export interface WeightSpec {
  diameter_mm: string;
  length_mm: string;
  /** A positive measured mass replaces the steel formula; null or omitted selects it. */
  manual_unit_weight_kg?: string | null;
}

export interface InvoiceLine {
  billing_unit: BillingUnit;
  quantity: string;
  /** Selling rate for supply, agreed processing rate for job work. */
  unit_rate_paise: number;
  tax_rate_percent: string;
  /** Costing metadata only. Never billed, so never read here. */
  raw_metal_cost_paise?: number;
}

export interface InvoiceInput {
  bill_type: BillType;
  state_code: string;
  lines: InvoiceLine[];
  packing_charge_paise: number;
  delivery_charge_paise: number;
  delivery_taxable: boolean;
  freight_paid_by: FreightPayer;
}

export interface InvoiceAmounts {
  subtotal_paise: number;
  /** Subtotal plus seller-billed packing and delivery. */
  taxable_value_paise: number;
  cgst_paise: number;
  sgst_paise: number;
  igst_paise: number;
  round_off_paise: number;
  grand_total_paise: number;
  /** Charges the buyer pays the third party directly: shown on the DC, never billed. */
  dc_to_pay_paise: number;
}

export interface GstSplit {
  cgst_paise: number;
  sgst_paise: number;
  igst_paise: number;
}

/** The same invoice with its GST attributed to each line, for storage, printing and GSTR-1. */
export interface InvoiceDetail {
  amounts: InvoiceAmounts;
  /** Parallel to input.lines. Lines plus charges add up to the invoice GST exactly. */
  lines: (GstSplit & { line_total_paise: number })[];
  charges: GstSplit;
  /** One entry per numeric GST rate, in order of first appearance. */
  rates: (GstSplit & { tax_rate_percent: string; taxable_paise: number })[];
}

export class BillingMathError extends Error {
  override name = 'BillingMathError';
}

/** A non-negative exact fraction. */
interface Fraction {
  n: bigint;
  d: bigint;
}

const HOME_STATE = '33'; // Tamil Nadu
/** d² / 162.2 × L / 1000 = d² × L / 162200 */
const STEEL_DIVISOR = 162_200n;
const MICRO = 1_000_000n;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

function fail(message: string): never {
  throw new BillingMathError(message);
}

function parseDecimal(value: string, label: string): Fraction {
  // The length cap keeps hostile input from turning into huge BigInt work.
  if (typeof value !== 'string' || value.length > 40 || !/^\d+(\.\d+)?$/.test(value)) {
    fail(`${label} must be a plain non-negative decimal string`);
  }
  const [whole = '', decimals = ''] = value.split('.');
  return { n: BigInt(whole + decimals), d: 10n ** BigInt(decimals.length) };
}

function parsePositive(value: string, label: string): Fraction {
  const parsed = parseDecimal(value, label);
  if (parsed.n === 0n) fail(`${label} must be greater than zero`);
  return parsed;
}

function parsePaise(value: number, label: string): bigint {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} must be whole, non-negative paise`);
  return BigInt(value);
}

/** Rounds n/d half-up. Both are non-negative here. */
function roundHalfUp(n: bigint, d: bigint): bigint {
  return (2n * n + d) / (2n * d);
}

function toSafeNumber(value: bigint, label: string): number {
  if (value > MAX_SAFE || value < -MAX_SAFE) fail(`${label} is too large to represent exactly`);
  return Number(value);
}

function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

/** Exact kg per piece: never rounded, so lot weights and piece counts do not drift. */
function unitMass(spec: WeightSpec): Fraction {
  const diameter = parsePositive(spec.diameter_mm, 'diameter_mm');
  const length = parsePositive(spec.length_mm, 'length_mm');
  if (spec.manual_unit_weight_kg !== null && spec.manual_unit_weight_kg !== undefined) {
    return parsePositive(spec.manual_unit_weight_kg, 'manual_unit_weight_kg');
  }
  return {
    n: diameter.n * diameter.n * length.n,
    d: diameter.d * diameter.d * length.d * STEEL_DIVISOR,
  };
}

/** Total kg of `pieces` studs, as a fixed six-decimal string. */
export function weightForPieces(spec: WeightSpec, pieces: number): string {
  const mass = unitMass(spec);
  if (!Number.isSafeInteger(pieces) || pieces < 0) fail('piece count must be a whole, non-negative number');
  const micros = roundHalfUp(mass.n * BigInt(pieces) * MICRO, mass.d);
  return `${micros / MICRO}.${(micros % MICRO).toString().padStart(6, '0')}`;
}

/** Complete pieces that fit in `kg`; a partial piece is dropped. */
export function wholePiecesForWeight(spec: WeightSpec, kg: string): number {
  const mass = unitMass(spec);
  const weight = parseDecimal(kg, 'weight');
  return toSafeNumber((weight.n * mass.d) / (weight.d * mass.n), 'piece count');
}

function lineExtension(line: InvoiceLine, label: string): bigint {
  if (line.billing_unit !== 'pcs' && line.billing_unit !== 'kg') fail(`${label}: unknown billing unit`);
  const quantity = parsePositive(line.quantity, `${label} quantity`);
  if (line.billing_unit === 'pcs' && quantity.n % quantity.d !== 0n) fail(`${label}: pieces must be whole`);
  const rate = parsePaise(line.unit_rate_paise, `${label} rate`);
  return roundHalfUp(quantity.n * rate, quantity.d);
}

/** Splits `total` by weight, largest remainder first, so the parts always add up to it. */
function allocate(total: bigint, weights: bigint[]): bigint[] {
  const sum = weights.reduce((acc, weight) => acc + weight, 0n);
  if (sum === 0n) return weights.map(() => 0n);
  const parts = weights.map((weight) => (total * weight) / sum);
  const byRemainder = weights
    .map((weight, index) => ({ index, remainder: (total * weight) % sum }))
    .sort((a, b) => (a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1));
  let left = total - parts.reduce((acc, part) => acc + part, 0n);
  for (const { index } of byRemainder) {
    if (left === 0n) break;
    parts[index] = (parts[index] ?? 0n) + 1n;
    left -= 1n;
  }
  return parts;
}

export function calculateInvoice(input: InvoiceInput): InvoiceAmounts {
  return calculateInvoiceDetail(input).amounts;
}

export function calculateInvoiceDetail(input: InvoiceInput): InvoiceDetail {
  if (input.bill_type !== 'supply' && input.bill_type !== 'job_work') fail('unknown bill type');
  if (typeof input.state_code !== 'string' || !/^\d{2}$/.test(input.state_code)) fail('state code must be two digits');
  if (input.freight_paid_by !== 'seller' && input.freight_paid_by !== 'buyer_to_pay') fail('unknown freight payer');
  if (typeof input.delivery_taxable !== 'boolean') fail('delivery_taxable must be true or false');
  if (!Array.isArray(input.lines) || input.lines.length === 0) fail('an invoice needs at least one line');

  // Tax is rounded per numeric GST rate, so '18' and '18.00' must share a bucket.
  const buckets = new Map<string, { rate: Fraction; label: string; base: bigint; members: number[] }>();
  const extensions: bigint[] = [];
  let subtotal = 0n;
  input.lines.forEach((line, index) => {
    const label = `line ${index + 1}`;
    const extension = lineExtension(line, label);
    const rate = parseDecimal(line.tax_rate_percent, `${label} GST rate`);
    if (rate.n > 100n * rate.d) fail(`${label}: GST rate cannot exceed 100%`);
    const divisor = gcd(rate.n, rate.d);
    const key = `${rate.n / divisor}/${rate.d / divisor}`;
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.base += extension;
      bucket.members.push(index);
    } else {
      buckets.set(key, { rate, label: line.tax_rate_percent, base: extension, members: [index] });
    }
    extensions.push(extension);
    subtotal += extension;
  });

  const packing = parsePaise(input.packing_charge_paise, 'packing charge');
  const delivery = parsePaise(input.delivery_charge_paise, 'delivery charge');
  const charges = packing + delivery;
  const billedCharges = input.freight_paid_by === 'seller' ? charges : 0n;
  if (billedCharges > 0n) {
    // Packing is always part of the value of supply (CGST s.15(2)(c)); the flag covers delivery.
    if (delivery > 0n && !input.delivery_taxable) {
      fail('untaxed delivery must be billed as an explicitly classified line');
    }
    const [only, ...others] = buckets.values();
    if (only === undefined || others.length > 0) {
      fail('on a mixed-rate invoice, bill packing and delivery as explicitly classified lines');
    }
    only.base += billedCharges;
  }

  let halfTax = 0n; // CGST, and equally SGST
  let igst = 0n;
  const intraState = input.state_code === HOME_STATE;
  const lineTax = extensions.map(() => 0n); // per head: the CGST half, or the IGST
  let chargeTax = 0n;
  const split = (head: bigint): GstSplit => ({
    cgst_paise: intraState ? toSafeNumber(head, 'CGST') : 0,
    sgst_paise: intraState ? toSafeNumber(head, 'SGST') : 0,
    igst_paise: intraState ? 0 : toSafeNumber(head, 'IGST'),
  });
  const rates: InvoiceDetail['rates'] = [];
  for (const { rate, label, base, members } of buckets.values()) {
    const head = roundHalfUp(base * rate.n, rate.d * (intraState ? 200n : 100n));
    if (intraState) halfTax += head;
    else igst += head;
    // billedCharges is only ever non-zero when there is a single bucket.
    const parts = allocate(head, [...members.map((i) => extensions[i] ?? 0n), billedCharges]);
    members.forEach((i, at) => {
      lineTax[i] = parts[at] ?? 0n;
    });
    chargeTax += parts[members.length] ?? 0n;
    rates.push({ tax_rate_percent: label, taxable_paise: toSafeNumber(base, 'taxable value'), ...split(head) });
  }

  const taxable = subtotal + billedCharges;
  const exactTotal = taxable + 2n * halfTax + igst;
  const grandTotal = roundHalfUp(exactTotal, 100n) * 100n;

  const amounts: InvoiceAmounts = {
    subtotal_paise: toSafeNumber(subtotal, 'subtotal'),
    taxable_value_paise: toSafeNumber(taxable, 'taxable value'),
    cgst_paise: toSafeNumber(halfTax, 'CGST'),
    sgst_paise: toSafeNumber(halfTax, 'SGST'),
    igst_paise: toSafeNumber(igst, 'IGST'),
    round_off_paise: toSafeNumber(grandTotal - exactTotal, 'round-off'),
    grand_total_paise: toSafeNumber(grandTotal, 'grand total'),
    dc_to_pay_paise: toSafeNumber(input.freight_paid_by === 'buyer_to_pay' ? charges : 0n, 'DC to-pay amount'),
  };
  return {
    amounts,
    lines: extensions.map((extension, i) => ({
      line_total_paise: toSafeNumber(extension, 'line total'),
      ...split(lineTax[i] ?? 0n),
    })),
    charges: split(chargeTax),
    rates,
  };
}

// ---- Summaries of issued figures (no new tax is computed) ---------------------

export interface IssuedLine extends GstSplit {
  tax_rate_percent: string;
  line_total_paise: number;
}

export interface RateSummary extends GstSplit {
  /** Canonical rate, e.g. '18' or '2.5'. */
  tax_rate_percent: string;
  taxable_paise: number;
}

/**
 * Groups an issued invoice by GST rate for the tax table. Header charges exist only on a
 * single-rate bill, so they join its one bucket.
 */
export function summarizeRates(
  lines: readonly IssuedLine[],
  charges: GstSplit & { taxable_paise: number },
): { rates: RateSummary[]; taxable_paise: number } {
  const rates = new Map<string, RateSummary>();
  const add = (rate: string, part: GstSplit, taxable: number): void => {
    const row = rates.get(rate) ?? { tax_rate_percent: rate, taxable_paise: 0, cgst_paise: 0, sgst_paise: 0, igst_paise: 0 };
    row.taxable_paise += taxable;
    row.cgst_paise += part.cgst_paise;
    row.sgst_paise += part.sgst_paise;
    row.igst_paise += part.igst_paise;
    rates.set(rate, row);
  };
  for (const line of lines) {
    const rate = parseDecimal(line.tax_rate_percent, 'GST rate');
    const [whole = '0', decimals = ''] = line.tax_rate_percent.split('.');
    const kept = decimals.replace(/0+$/, '');
    add(rate.n === 0n ? '0' : kept ? `${whole}.${kept}` : whole, line, line.line_total_paise);
  }
  if (charges.taxable_paise > 0) {
    const [only] = rates.keys();
    if (only === undefined || rates.size > 1) fail('header charges need a single GST rate');
    add(only, charges, charges.taxable_paise);
  }
  const rows = [...rates.values()];
  return { rates: rows, taxable_paise: rows.reduce((sum, row) => sum + row.taxable_paise, 0) };
}

export function outstandingPaise(grandTotalPaise: number, amountPaidPaise: number): number {
  return grandTotalPaise - amountPaidPaise;
}

export function sumPaise(values: readonly number[]): number {
  return toSafeNumber(values.reduce((sum, value) => sum + BigInt(value), 0n), 'sum');
}

/** Adds kg strings exactly, to three decimals. */
export function sumKg(values: readonly string[]): string {
  const grams = values.reduce((sum, value) => {
    const parsed = parseDecimal(value, 'weight');
    return sum + roundHalfUp(parsed.n * 1000n, parsed.d);
  }, 0n);
  return `${grams / 1000n}.${(grams % 1000n).toString().padStart(3, '0')}`;
}

export interface LotBalance {
  /** Signed kg, three decimals: negative when more went back than came in. */
  balance_kg: string;
  /** Within 1% of inward either way, so the lot closes without a reason. */
  within_tolerance: boolean;
  /** Over-returned by more than 1%: the database refuses it. */
  over_returned: boolean;
}

/** What stays in the customer's lot after a return and its scrap are posted. */
export function lotBalance(lot: { inward: string; outward: string; scrap: string }, returned: string, scrap: string): LotBalance {
  const grams = (value: string, label: string): bigint => {
    const parsed = parseDecimal(value, label);
    return roundHalfUp(parsed.n * 1000n, parsed.d);
  };
  const inward = grams(lot.inward, 'inward weight');
  const left =
    inward - grams(lot.outward, 'outward weight') - grams(lot.scrap, 'scrap weight') - grams(returned, 'returned weight') - grams(scrap, 'scrap now');
  const size = left < 0n ? -left : left;
  const within = size * 100n <= inward;
  return {
    balance_kg: `${left < 0n ? '-' : ''}${size / 1000n}.${(size % 1000n).toString().padStart(3, '0')}`,
    within_tolerance: within,
    over_returned: left < 0n && !within,
  };
}
