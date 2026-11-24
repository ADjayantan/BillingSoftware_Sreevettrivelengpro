/** What the billing screen holds while a bill is typed, and how it becomes a draft. Pure. */
import { BillingMathError, lotBalance, weightForPieces, wholePiecesForWeight, type LotBalance, type WeightSpec } from './billing-math';
import { composeBill, DraftError, type ComposedBill } from './bill-draft';
import { addDays } from './india';
import { trimZeros } from './money';
import type { BillDraftInput } from './schemas/invoices';
import type { Customer, JobWorkLot, StudItem } from './schemas/masters';

export type BillType = 'supply' | 'job_work';

export interface FormLine {
  key: number;
  stud: StudItem | null;
  text: string;
  hsn: string;
  gst: string;
  unit: 'pcs' | 'kg';
  quantity: string;
  rate: string;
}

export interface FormReturn {
  pieces: string;
  returned: string;
  scrap: string;
  value: string;
  close: boolean;
  reason: string;
}

export interface BillForm {
  tempId: string;
  /** IST date the form was opened: bounds the invoice date. */
  today: string;
  type: BillType;
  customer: Customer | null;
  customerText: string;
  invoiceDate: string;
  /** Null follows the customer's credit days. */
  dueDate: string | null;
  lines: FormLine[];
  packing: string;
  freight: string;
  freightPaidBy: 'seller' | 'buyer_to_pay';
  deliveryTaxable: boolean;
  chargesRate: string;
  transport: { transport_mode: string; vehicle_no: string; driver_name: string; driver_phone: string; lr_number: string; delivery_address: string; status: string };
  lots: JobWorkLot[];
  returns: Record<string, FormReturn>;
  paid: string;
  paidMode: string;
  notes: string;
}

const HSN = { supply: '731815', job_work: '998873' } as const;

export const blankLine = (key: number, type: BillType): FormLine => ({
  key, stud: null, text: '', hsn: HSN[type], gst: '18', unit: 'pcs', quantity: '', rate: '',
});

export const blankReturn: FormReturn = { pieces: '', returned: '', scrap: '', value: '', close: false, reason: '' };

export function newBill(tempId: string, today: string, type: BillType = 'supply'): BillForm {
  return {
    tempId, today, type, customer: null, customerText: '', invoiceDate: today, dueDate: null, lines: [blankLine(1, type)],
    packing: '', freight: '', freightPaidBy: 'seller', deliveryTaxable: true, chargesRate: '',
    transport: { transport_mode: 'own_vehicle', vehicle_no: '', driver_name: '', driver_phone: '', lr_number: '', delivery_address: '', status: 'pending' },
    lots: [], returns: {}, paid: '', paidMode: 'cash', notes: '',
  };
}

export const isBlank = (line: FormLine): boolean => line.text.trim() === '' && line.quantity === '' && line.rate === '';

/** There is always one empty line to type into. */
export function withTrailingBlank(lines: FormLine[], type: BillType): FormLine[] {
  const last = lines.at(-1);
  if (last && isBlank(last)) return lines;
  return [...lines, blankLine(Math.max(0, ...lines.map((line) => line.key)) + 1, type)];
}

/** Switching type re-seeds the HSN/SAC of untouched lines only. */
export function changeType(form: BillForm, type: BillType): BillForm {
  return {
    ...form, type, returns: {},
    lines: form.lines.map((line) => (isBlank(line) ? blankLine(line.key, type) : line.hsn === HSN[form.type] ? { ...line, hsn: HSN[type] } : line)),
  };
}

export function pickStud(line: FormLine, stud: StudItem, type: BillType): FormLine {
  const perKg = stud.default_rate_per_piece === null && stud.default_rate_per_kg !== null;
  const size = `M${trimZeros(stud.diameter_mm)} × ${trimZeros(stud.length_mm)} mm · ${stud.material_grade} · ${stud.thread_type}`;
  const rate = perKg ? stud.default_rate_per_kg : stud.default_rate_per_piece;
  return {
    ...line, stud,
    text: type === 'job_work' ? `Threading ${stud.sku_code} · ${size}` : `Stud ${stud.sku_code} · ${size}`,
    // Labour is billed under its own SAC, tax and agreed rate, never the stud's.
    hsn: type === 'job_work' ? line.hsn : stud.hsn_sac,
    gst: type === 'job_work' ? line.gst : trimZeros(stud.gst_rate_percent),
    unit: perKg ? 'kg' : 'pcs',
    rate: type === 'job_work' || rate === null ? line.rate : trimZeros(rate),
  };
}

export function changeUnit(line: FormLine, unit: 'pcs' | 'kg', type: BillType): FormLine {
  const rate = unit === 'kg' ? line.stud?.default_rate_per_kg : line.stud?.default_rate_per_piece;
  return { ...line, unit, rate: type === 'supply' && rate ? trimZeros(rate) : line.rate };
}

const weightSpec = (stud: StudItem): WeightSpec => ({
  diameter_mm: stud.diameter_mm,
  length_mm: stud.length_mm,
  manual_unit_weight_kg: stud.unit_weight_is_manual ? stud.unit_weight_kg : null,
});

/** The other measurement of a stud line: kg for pieces, pieces for kg. */
export function supporting(line: FormLine): { pieces: number | null; weightKg: string | null } {
  if (!line.stud || line.quantity === '') return { pieces: null, weightKg: null };
  try {
    if (line.unit === 'pcs') return { pieces: null, weightKg: weightForPieces(weightSpec(line.stud), Number(line.quantity)) };
    const pieces = wholePiecesForWeight(weightSpec(line.stud), line.quantity);
    return { pieces: pieces > 0 ? pieces : null, weightKg: null };
  } catch {
    return { pieces: null, weightKg: null };
  }
}

export const dueDateOf = (form: BillForm): string => form.dueDate ?? addDays(form.invoiceDate, form.customer?.credit_days ?? 0);

const draftLines = (form: BillForm) =>
  form.lines.filter((line) => !isBlank(line)).map((line) => {
    const other = supporting(line);
    return {
      stud_item_id: line.stud?.id ?? null, description: line.text.trim(), hsn_sac: line.hsn.trim(), billing_unit: line.unit, quantity: line.quantity.trim(),
      pieces: other.pieces, weight_kg: other.weightKg, rate: line.rate.trim(), gst_rate: line.gst.trim(),
    };
  });

const charges = (form: BillForm) => ({
  packing: form.packing.trim() || '0',
  freight: form.freight.trim() || '0',
  freight_paid_by: form.freightPaidBy,
  delivery_taxable: form.deliveryTaxable,
  charges_gst_rate: form.chargesRate || null,
});

/** The live total, or the reason there is none yet. */
export function previewBill(form: BillForm): { bill: ComposedBill } | { problem: string } {
  const lines = draftLines(form);
  const incomplete = lines.findIndex((line) => line.description === '' || line.quantity === '' || line.rate === '');
  if (!form.customer) return { problem: 'Pick the customer' };
  if (lines.length === 0) return { problem: 'Add a line' };
  if (incomplete >= 0) return { problem: `Line ${incomplete + 1} needs a description, quantity and rate` };
  try {
    return { bill: composeBill({ bill_type: form.type, lines, ...charges(form) }, form.customer) };
  } catch (error) {
    if (error instanceof DraftError || error instanceof BillingMathError) return { problem: error.message };
    throw error;
  }
}

export function returnBalance(lot: JobWorkLot, entry: FormReturn): LotBalance | null {
  try {
    return lotBalance({ inward: lot.inward_weight_kg, outward: lot.outward_weight_kg, scrap: lot.scrap_weight_kg }, entry.returned || '0', entry.scrap || '0');
  } catch {
    return null;
  }
}

export function toDraft(form: BillForm, bill: ComposedBill): BillDraftInput {
  if (!form.customer) throw new DraftError('Pick the customer');
  return {
    client_temp_id: form.tempId, bill_type: form.type, customer_id: form.customer.id, invoice_date: form.invoiceDate, due_date: dueDateOf(form),
    notes: form.notes, lines: draftLines(form), ...charges(form),
    // The route's Zod enums re-check the select values, so plain strings are fine here.
    delivery: form.transport as BillDraftInput['delivery'],
    returns:
      form.type === 'supply'
        ? []
        : form.lots.flatMap((lot) => {
            const entry = form.returns[lot.id];
            if (!entry || (entry.returned === '' && entry.scrap === '')) return [];
            return [{
              lot_id: lot.id, goods_description: lot.description, pieces: entry.pieces === '' ? null : Number(entry.pieces), returned_weight_kg: entry.returned || '0',
              scrap_weight_kg: entry.scrap || '0', declared_value: entry.value || null, close: entry.close, close_reason: entry.reason.trim() || null,
            }];
          }),
    paid_now: form.paid.trim() === '' ? null : { amount: form.paid.trim(), mode: form.paidMode as 'cash' },
    expected_total_paise: bill.detail.amounts.grand_total_paise,
  };
}
