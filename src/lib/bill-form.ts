/** What the billing screen holds while a bill is typed, and how it becomes a draft. Pure. */
import { BillingMathError, lotBalance, weightForPieces, wholePiecesForWeight, type LotBalance, type WeightSpec } from './billing-math';
import { CHARGE_LINE, composeBill, DraftError, type ComposedBill } from './bill-draft';
import { reviveCustomer, type CustomerForm } from './customer-form';
import { addDays } from './india';
import { trimZeros } from './money';
import { isService, lineText, plainPercent, productCode, revivedProduct, typedProductNo } from './products';
import type { BillDraftInput, EditBillInput, InvoiceDocument } from './schemas/invoices';
import type { Customer, JobWorkLot, StudItem } from './schemas/masters';

export type BillType = 'supply' | 'job_work';

export interface FormLine {
  key: number;
  stud: StudItem | null;
  text: string;
  hsn: string;
  gst: string;
  /** Who gave the GST %: typed on this line, taken from the hand-typed line above, or the product's own. */
  gstFrom: '' | 'hand' | 'above' | 'product';
  unit: 'pcs' | 'kg';
  quantity: string;
  rate: string;
  /** Preserved from an existing invoice item during in-place edit when the full product row was not re-picked. */
  savedStudId?: string | null;
  savedPieces?: number | null;
  savedWeightKg?: string | null;
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
  /** A new customer being typed inside this bill: part of the draft, so a crash keeps it. */
  newCustomer: CustomerForm | null;
  invoiceDate: string;
  /** Null follows the customer's credit days. */
  dueDate: string | null;
  /** The buyer's order; its date counts only with a number. */
  poNo: string;
  poDate: string;
  lines: FormLine[];
  packing: string;
  freight: string;
  freightPaidBy: 'seller' | 'buyer_to_pay';
  deliveryTaxable: boolean;
  chargesRate: string;
  /** `transport_mode` is '' until somebody chooses one: see transportOf. */
  transport: { transport_mode: string; vehicle_no: string; driver_name: string; driver_phone: string; lr_number: string; delivery_address: string; status: string };
  lots: JobWorkLot[];
  returns: Record<string, FormReturn>;
  paid: string;
  paidMode: string;
  notes: string;
}

const HSN = { supply: '731815', job_work: '998873' } as const;

export const blankLine = (key: number, type: BillType): FormLine => ({
  key, stud: null, text: '', hsn: HSN[type], gst: '', gstFrom: '', unit: 'pcs', quantity: '', rate: '',
});

export const blankReturn: FormReturn = { pieces: '', returned: '', scrap: '', value: '', close: false, reason: '' };

export function newBill(tempId: string, today: string, type: BillType = 'supply'): BillForm {
  return {
    tempId, today, type, customer: null, customerText: '', newCustomer: null, invoiceDate: today, dueDate: null, poNo: '', poDate: '', lines: [blankLine(1, type)],
    packing: '', freight: '', freightPaidBy: 'seller', deliveryTaxable: true, chargesRate: '',
    transport: { transport_mode: '', vehicle_no: '', driver_name: '', driver_phone: '', lr_number: '', delivery_address: '', status: 'pending' },
    lots: [], returns: {}, paid: '', paidMode: 'cash', notes: '',
  };
}

export const isBlank = (line: FormLine): boolean => line.text.trim() === '' && line.quantity === '' && line.rate === '';

/** Nothing typed yet: not worth keeping as a draft. */
export const isEmptyForm = (form: BillForm): boolean =>
  form.customer === null && form.newCustomer === null && form.lines.every(isBlank) &&
  [form.customerText, form.poNo, form.packing, form.freight, form.paid, form.notes, form.transport.vehicle_no, form.transport.driver_name, form.transport.driver_phone, form.transport.lr_number, form.transport.delivery_address].every((text) => text.trim() === '');

/** A draft from disk, perhaps written by an older version: complete, or null if unusable. */
export function reviveForm(stored: unknown, today: string): BillForm | null {
  if (typeof stored !== 'object' || stored === null) return null;
  const form = stored as Partial<BillForm>;
  if (typeof form.tempId !== 'string' || !/^OFFLINE-[0-9a-f-]{36}$/.test(form.tempId)) return null;
  if (form.type !== 'supply' && form.type !== 'job_work') return null;
  const base = newBill(form.tempId, today, form.type);
  const lines = (Array.isArray(form.lines) ? form.lines : []).map((line, i) => ({ ...blankLine(i + 1, base.type), ...line, stud: line.stud ? revivedProduct(line.stud) : null }));
  return {
    ...base, ...form,
    today,
    newCustomer: reviveCustomer(form.newCustomer),
    lines: withTrailingBlank(lines, base.type),
    transport: { ...base.transport, ...form.transport },
    lots: Array.isArray(form.lots) ? form.lots : [],
    returns: form.returns ?? {},
  };
}

/** There is always one empty line to type into. */
export function withTrailingBlank(lines: FormLine[], type: BillType): FormLine[] {
  const last = lines.at(-1);
  if (!last || !isBlank(last)) return [...lines, gstFromAbove(blankLine(Math.max(0, ...lines.map((line) => line.key)) + 1, type), last)];
  const kept = gstFromAbove(last, lines.at(-2));
  return kept === last ? lines : [...lines.slice(0, -1), kept];
}

/** Until somebody types on it, the empty line shows the GST % typed by hand on the line above. */
function gstFromAbove(line: FormLine, above: FormLine | undefined): FormLine {
  if (line.gstFrom === 'hand') return line;
  const gst = above?.gstFrom === 'hand' || above?.gstFrom === 'above' ? above.gst : '';
  const gstFrom = gst === '' ? '' : 'above';
  return gst === line.gst && gstFrom === line.gstFrom ? line : { ...line, gst, gstFrom };
}

/** Labour is billed under its own SAC, tax and agreed rate, never those of the goods it was done to. */
const fillsLine = (stud: StudItem, type: BillType): boolean => type === 'supply' || isService(stud);

const productRate = (stud: StudItem, unit: 'pcs' | 'kg'): string => {
  const rate = unit === 'kg' ? stud.default_rate_per_kg : stud.default_rate_per_piece;
  return rate === null ? '' : trimZeros(rate);
};

/** What a product puts on its line. */
function filledBy(stud: StudItem, unit: 'pcs' | 'kg', type: BillType): Pick<FormLine, 'text' | 'hsn' | 'gst' | 'gstFrom' | 'rate'> {
  const text = lineText(stud, type);
  return fillsLine(stud, type)
    ? { text, hsn: stud.hsn_sac, gst: trimZeros(stud.gst_rate_percent), gstFrom: 'product', rate: productRate(stud, unit) }
    : { text, hsn: HSN[type], gst: '', gstFrom: '', rate: '' };
}

/** On a switch, untouched lines get the new HSN/SAC, and a product's line what the product fills there. What was typed stays. */
export function changeType(form: BillForm, type: BillType): BillForm {
  const lines = form.lines.map((line) => {
    if (isBlank(line)) return blankLine(line.key, type);
    if (!line.stud) return { ...line, hsn: line.hsn === HSN[form.type] ? HSN[type] : line.hsn };
    const was = filledBy(line.stud, line.unit, form.type);
    const now = filledBy(line.stud, line.unit, type);
    const typedGst = line.gstFrom === 'hand' || line.gstFrom === 'above';
    return {
      ...line,
      text: line.text === was.text ? now.text : line.text,
      hsn: line.hsn === was.hsn ? now.hsn : line.hsn,
      rate: line.rate === was.rate ? now.rate : line.rate,
      ...(typedGst ? {} : { gst: now.gst, gstFrom: now.gstFrom }),
    };
  });
  return { ...form, type, returns: {}, lines: withTrailingBlank(lines, type) };
}

/** The line without its product: what the product filled goes with it, what was typed stays. */
function dropProduct(line: FormLine, type: BillType): FormLine {
  const clean: FormLine = {
    key: line.key,
    stud: line.stud,
    text: line.text,
    hsn: line.hsn,
    gst: line.gst,
    gstFrom: line.gstFrom,
    unit: line.unit,
    quantity: line.quantity,
    rate: line.rate,
  };
  if (!clean.stud) return clean;
  if (!fillsLine(clean.stud, type)) return { ...clean, stud: null };
  return { ...clean, stud: null, hsn: HSN[type], unit: 'pcs', rate: '', ...(clean.gstFrom === 'product' ? { gst: '', gstFrom: '' } : {}) };
}

export function pickStud(line: FormLine, stud: StudItem, type: BillType): FormLine {
  const bare = dropProduct(line, type);
  const unit = stud.default_rate_per_piece === null && stud.default_rate_per_kg !== null ? 'kg' : 'pcs';
  const filled = filledBy(stud, unit, type);
  if (!fillsLine(stud, type)) return { ...bare, stud, unit, text: filled.text };
  return { ...bare, stud, unit, ...filled, rate: filled.rate || bare.rate };
}

/** Did one change throw away nearly all of the text? Typing over it does, editing it does not. */
function typedOver(before: string, after: string): boolean {
  if (after === '') return true;
  const shorter = Math.min(before.length, after.length);
  let start = 0;
  while (start < shorter && before[start] === after[start]) start += 1;
  let end = 0;
  while (end < shorter - start && before.at(-1 - end) === after.at(-1 - end)) end += 1;
  const kept = start + end;
  return before.length > 2 && (kept <= 1 || kept * 4 < before.length);
}

/** Another item typed over a picked product must not keep its GST %, HSN and rate. */
export const typeText = (line: FormLine, text: string, type: BillType): FormLine =>
  ({ ...(typedOver(line.text, text) ? dropProduct(line, type) : line), text });

export function typeGst(line: FormLine, typed: string): FormLine {
  const gst = plainPercent(typed);
  return { ...line, gst, gstFrom: gst === '' ? '' : 'hand' };
}

export function changeUnit(line: FormLine, unit: 'pcs' | 'kg', type: BillType): FormLine {
  if (!line.stud || !fillsLine(line.stud, type)) return { ...line, unit };
  const next = productRate(line.stud, unit);
  // A rate per piece must not stay as the rate per kg; a price somebody typed is theirs to change.
  return { ...line, unit, rate: next === '' && line.rate !== productRate(line.stud, line.unit) ? line.rate : next };
}

/** A line of an earlier bill. */
export interface EarlierGoods {
  stud: StudItem | null;
  description: string;
  hsn_sac: string;
  billing_unit: 'pcs' | 'kg';
  quantity: string;
  rate: string;
}

/**
 * The goods of an earlier bill, below what is typed already. The words, quantity and rate are the
 * earlier ones. GST is never copied from a bill: a product brings its own of today, with its HSN,
 * and without a product a person types the GST % again (the earlier HSN stays).
 */
export function repeatGoods(form: BillForm, goods: readonly EarlierGoods[]): BillForm {
  const kept = form.lines.filter((line) => !isBlank(line));
  const next = Math.max(0, ...form.lines.map((line) => line.key)) + 1;
  const added = goods.map((item, i): FormLine => {
    const line = blankLine(next + i, form.type);
    const fills = item.stud !== null && fillsLine(item.stud, form.type);
    const picked = item.stud ? changeUnit(pickStud(line, item.stud, form.type), item.billing_unit, form.type) : { ...line, unit: item.billing_unit };
    return { ...picked, text: item.description, quantity: item.quantity, rate: item.rate, ...(fills ? {} : { hsn: item.hsn_sac }) };
  });
  return { ...form, lines: withTrailingBlank([...kept, ...added], form.type) };
}

const weightSpec = (stud: StudItem): WeightSpec => ({
  diameter_mm: stud.diameter_mm,
  length_mm: stud.length_mm,
  manual_unit_weight_kg: stud.unit_weight_is_manual ? stud.unit_weight_kg : null,
});

/** The other measurement of a product line, where its weight is known: kg for pieces, pieces for kg. */
export function supporting(line: FormLine): { pieces: number | null; weightKg: string | null } {
  if (line.quantity === '') return { pieces: null, weightKg: null };
  if (line.stud && line.stud.unit_weight_kg !== null) {
    try {
      if (line.unit === 'pcs') return { pieces: null, weightKg: weightForPieces(weightSpec(line.stud), Number(line.quantity)) };
      const pieces = wholePiecesForWeight(weightSpec(line.stud), line.quantity);
      return { pieces: pieces > 0 ? pieces : null, weightKg: null };
    } catch {
      return { pieces: null, weightKg: null };
    }
  }
  if (line.unit === 'pcs' && line.savedWeightKg && line.savedPieces && line.savedPieces > 0) {
    const qty = Number(line.quantity);
    if (Number.isInteger(qty) && qty > 0) {
      const scaled = (Number(line.savedWeightKg) * qty) / line.savedPieces;
      if (Number.isFinite(scaled) && scaled > 0) return { pieces: null, weightKg: scaled.toFixed(6) };
    }
  }
  if (line.unit === 'kg' && line.savedPieces && line.savedWeightKg && Number(line.savedWeightKg) > 0) {
    const qty = Number(line.quantity);
    if (Number.isFinite(qty) && qty > 0) {
      const scaled = Math.round((line.savedPieces * qty) / Number(line.savedWeightKg));
      if (scaled > 0) return { pieces: scaled, weightKg: null };
    }
  }
  return { pieces: null, weightKg: null };
}

/** Goods whose driver the customer pays do not go in our own vehicle, unless somebody says so. */
export const transportOf = (form: BillForm): BillForm['transport'] => ({
  ...form.transport,
  transport_mode: form.transport.transport_mode || (form.freightPaidBy === 'buyer_to_pay' ? 'transporter' : 'own_vehicle'),
});

/** A change in the transport boxes. The mode they show is only kept once somebody has changed it. */
export function changeTransport(form: BillForm, next: BillForm['transport']): BillForm {
  const untouched = next.transport_mode === transportOf(form).transport_mode;
  return { ...form, transport: { ...next, transport_mode: untouched ? form.transport.transport_mode : next.transport_mode } };
}

/** Something is in the boxes behind "More details", so they are not hidden. */
export function hasDispatchDetails(form: BillForm): boolean {
  const { transport_mode, status, ...typed } = form.transport;
  return transport_mode !== '' || status !== 'pending' || [...Object.values(typed), form.notes].some((text) => text.trim() !== '');
}

export const dueDateOf = (form: BillForm): string => form.dueDate ?? addDays(form.invoiceDate, form.customer?.credit_days ?? 0);

const draftLines = (form: BillForm) =>
  form.lines.filter((line) => !isBlank(line)).map((line) => {
    const other = supporting(line);
    return {
      stud_item_id: line.stud?.id ?? line.savedStudId ?? null, description: line.text.trim(), hsn_sac: line.hsn.trim(), billing_unit: line.unit, quantity: line.quantity.trim(),
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

export type LineBox = 'text' | 'quantity' | 'rate' | 'gst';

function lineProblem(line: FormLine, no: number): { box: LineBox; problem: string } | null {
  // A typed ID that was not picked, or is nobody's, must not become the description of goods.
  const id = line.stud ? null : typedProductNo(line.text);
  if (id !== null) return { box: 'text', problem: `Line ${no}: press Enter to pick product ${productCode(id)}, or type the item by name` };
  const empty = (['text', 'quantity', 'rate'] as const).find((box) => line[box].trim() === '');
  if (empty) return { box: empty, problem: `Line ${no} needs a description, quantity and rate` };
  if (line.gst.trim() === '') return { box: 'gst', problem: `Line ${no} needs its GST %` };
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(line.gst.trim()) || Number(line.gst) > 100) return { box: 'gst', problem: `Line ${no}: GST % is a number from 0 to 100` };
  return null;
}

/** Rule 46: from here the buyer's address is mandatory. sync_invoice refuses the bill at the same rupee. */
const ADDRESS_FROM_PAISE = 5_000_000;

/** The live total, or why it cannot be saved yet. With only the address missing there are both. */
export function previewBill(form: BillForm): { bill: ComposedBill } | { problem: string; place?: 'address'; bill?: ComposedBill } {
  const typed = form.lines.filter((line) => !isBlank(line));
  const lines = draftLines(form);
  if (!form.customer) return { problem: 'Pick the customer' };
  if (typed.length === 0) return { problem: 'Add a line' };
  for (const [i, line] of typed.entries()) {
    const found = lineProblem(line, i + 1);
    if (found) return { problem: found.problem };
  }
  try {
    const bill = composeBill({ bill_type: form.type, lines, ...charges(form) }, form.customer);
    if (form.customer.address === null && bill.detail.amounts.taxable_value_paise >= ADDRESS_FROM_PAISE) {
      return { problem: 'A bill of ₹50,000 or more needs the customer’s address', place: 'address', bill };
    }
    return { bill };
  } catch (error) {
    if (error instanceof DraftError || error instanceof BillingMathError) return { problem: error.message };
    throw error;
  }
}

export type Place = { place: 'customer' | 'address' | 'packing' } | { place: 'line'; key: number; box: LineBox };

/** Where the cursor belongs: the first thing still missing, in the order of the counter. */
export function firstUnfinished(form: BillForm): Place {
  if (!form.customer) return { place: 'customer' };
  const typed = form.lines.filter((line) => !isBlank(line));
  if (typed.length === 0) return { place: 'line', key: form.lines[0]?.key ?? 1, box: 'text' };
  for (const line of typed) {
    const found = lineProblem(line, 0);
    if (found) return { place: 'line', key: line.key, box: found.box };
  }
  const preview = previewBill(form);
  return { place: 'problem' in preview && preview.place === 'address' ? 'address' : 'packing' };
}

/** The customer of this bill; everything else typed so far stays. */
export const takeCustomer = (form: BillForm, customer: Customer): BillForm => ({ ...form, customer, customerText: customer.name, newCustomer: null, dueDate: null });

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
    po_no: form.poNo.trim(), po_date: form.poNo.trim() === '' ? null : form.poDate || null,
    notes: form.notes, lines: draftLines(form), ...charges(form),
    // The route's Zod enums re-check the select values, so plain strings are fine here.
    delivery: transportOf(form) as BillDraftInput['delivery'],
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

/** Reconstructs an editable BillForm from an issued InvoiceDocument without duplicating charge lines. */
export function formFromInvoice(doc: InvoiceDocument, today = doc.invoice.invoice_date): BillForm {
  const { invoice, items, delivery } = doc;
  const snap = invoice.customer_snapshot;
  const customer: Customer = {
    id: invoice.customer_id,
    name: snap.name,
    gstin: snap.gstin,
    phone: snap.phone,
    state_code: snap.state_code,
    is_sez: snap.is_sez,
    credit_days: 0,
    address: snap.address,
    opening_balance: '0.00',
    is_active: true,
  };

  let packingAmt = Number(invoice.packing_charge) > 0 ? trimZeros(invoice.packing_charge) : '';
  let freightAmt = delivery && Number(delivery.freight_amount) > 0 ? trimZeros(delivery.freight_amount) : Number(invoice.delivery_charge) > 0 ? trimZeros(invoice.delivery_charge) : '';
  let deliveryTaxable = invoice.delivery_taxable;
  let chargesGstRate = '';

  const goodsItems = items.filter((item) => {
    if (item.description === CHARGE_LINE.packing) {
      if (!packingAmt && Number(item.unit_rate) > 0) packingAmt = trimZeros(item.unit_rate);
      chargesGstRate = trimZeros(item.tax_rate_percent);
      return false;
    }
    if (item.description === CHARGE_LINE.delivery) {
      if (!freightAmt && Number(item.unit_rate) > 0) freightAmt = trimZeros(item.unit_rate);
      chargesGstRate = chargesGstRate || trimZeros(item.tax_rate_percent);
      return false;
    }
    if (item.description === CHARGE_LINE.recovered) {
      if (!freightAmt && Number(item.unit_rate) > 0) freightAmt = trimZeros(item.unit_rate);
      deliveryTaxable = false;
      return false;
    }
    return true;
  });

  const lines: FormLine[] = goodsItems.map((item, idx) => ({
    key: idx + 1,
    stud: null,
    text: item.description,
    hsn: item.hsn_sac,
    gst: trimZeros(item.tax_rate_percent),
    gstFrom: 'hand',
    unit: item.billing_unit,
    quantity: item.billing_unit === 'pcs' ? String(item.qty_pieces ?? 1) : trimZeros(item.total_weight_kg ?? '1'),
    rate: trimZeros(item.unit_rate),
    savedStudId: item.stud_item_id ?? null,
    savedPieces: item.qty_pieces,
    savedWeightKg: item.total_weight_kg,
  }));

  return {
    ...newBill(invoice.client_temp_id, today, invoice.bill_type),
    customer,
    customerText: customer.name,
    invoiceDate: invoice.invoice_date,
    dueDate: invoice.due_date,
    poNo: invoice.po_no ?? '',
    poDate: invoice.po_date ?? '',
    notes: invoice.notes ?? '',
    lines: withTrailingBlank(lines.length > 0 ? lines : [blankLine(1, invoice.bill_type)], invoice.bill_type),
    packing: packingAmt,
    freight: freightAmt,
    freightPaidBy: delivery?.freight_paid_by ?? 'seller',
    deliveryTaxable,
    chargesRate: chargesGstRate,
  };
}

export function toEditDraft(form: BillForm, bill: ComposedBill): EditBillInput {
  return {
    due_date: dueDateOf(form),
    po_no: form.poNo.trim(),
    po_date: form.poNo.trim() === '' ? null : form.poDate || null,
    notes: form.notes,
    lines: draftLines(form),
    ...charges(form),
    expected_total_paise: bill.detail.amounts.grand_total_paise,
  };
}
