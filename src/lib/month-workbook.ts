/**
 * One month as an Excel workbook: one row per bill, one per line, dispatch and job work, receipts.
 * Figures are the issued ones; the only arithmetic is adding up, in billing-math.ts. Pure.
 */
import { CHARGE_LINE } from './bill-draft';
import { outstandingPaise, sumKg, sumPaise } from './billing-math';
import { formatTime, monthName, stateLabel } from './india';
import { decimalToPaise, paiseToDecimal } from './money';
import type { BookDelivery, BookInvoice, BookItem, BookPayment, BookReturn } from './schemas/books';
import { xlsx, type Column, type Kind, type Row, type Sheet } from './xlsx';

export interface MonthData {
  /** Its first day, YYYY-MM-01. */
  month: string;
  company: string | null;
  /** Bills by their own date. */
  invoices: BookInvoice[];
  /** Bills of other months that this month's challans and receipts belong to. */
  elsewhere: BookInvoice[];
  items: BookItem[];
  /** The challans of this month's bills. */
  deliveries: BookDelivery[];
  /** The challans dated in this month. */
  sentNow: BookDelivery[];
  returns: BookReturn[];
  /** Receipts by the day the money came. */
  payments: BookPayment[];
}

const CANCELLED = 'CANCELLED';
const VOIDED = 'VOIDED';

/** A column, and how a row fills it. */
type Spec<T> = readonly [title: string, kind: Kind, width: number, value: (row: T) => string | number | null];

function sheet<T>(name: string, specs: readonly Spec<T>[], records: readonly T[], options: {
  isVoid: (row: T) => boolean;
  /** The word of the Status column that takes a row out of the totals. */
  except: string;
  sums: Readonly<Record<string, 'money' | 'kg'>>;
  totalLabel: string;
  empty: string;
  notes: readonly string[];
}): Sheet {
  const columns: Column[] = specs.map(([title, kind, width]) => ({ title, kind, width }));
  const cellsOf = (record: T): (string | null)[] => specs.map(([, , , value]) => {
    const cell = value(record);
    return cell === null ? null : String(cell);
  });
  const rows: Row[] = records.map((record) => ({ cells: cellsOf(record), ...(options.isVoid(record) ? { void: true } : {}) }));
  const counted = rows.filter((row) => !row.void);
  const values = Object.fromEntries(
    Object.entries(options.sums).map(([title, kind]) => {
      const at = columns.findIndex((column) => column.title === title);
      const amounts = counted.flatMap((row) => row.cells[at] ?? []);
      return [title, kind === 'kg' ? sumKg(amounts) : paiseToDecimal(sumPaise(amounts.map(decimalToPaise)))];
    }),
  );
  return { name, columns, rows, totals: { label: options.totalLabel, status: 'Status', except: options.except, values }, notes: options.notes, empty: options.empty };
}

const orNull = (text: string | null): string | null => text?.trim() || null;

type Charge = 'Packing' | 'Freight' | null;
/** A charge billed as a line of its own (composeBill): not goods. */
const chargeOf = (item: BookItem): Charge =>
  item.stud_item_id !== null ? null
  : item.description === CHARGE_LINE.packing ? 'Packing'
  : item.description === CHARGE_LINE.delivery || item.description === CHARGE_LINE.recovered ? 'Freight'
  : null;

const TRANSPORT = { own_vehicle: 'Own vehicle', transporter: 'Transporter', courier: 'Courier', customer_pickup: 'Customer pickup', hand_delivery: 'Hand delivery' } as const;
const DISPATCH = { pending: 'Pending', packed: 'Packed', dispatched: 'Dispatched', delivered: 'Delivered' } as const;
const MODE = { cash: 'Cash', upi: 'UPI', bank_transfer: 'Bank transfer', cheque: 'Cheque', tds: 'TDS', other: 'Other' } as const;

export function monthWorkbook(data: MonthData, asOf: string): Uint8Array {
  const invoices = [...data.invoices].sort((a, b2) => a.invoice_seq - b2.invoice_seq);
  const heads = new Map([...data.invoices, ...data.elsewhere].map((invoice) => [invoice.id, invoice]));
  const head = (row: { invoice_id: string }): BookInvoice => {
    const found = heads.get(row.invoice_id);
    if (!found) throw new Error('a row without its bill'); // the worker tries again
    return found;
  };
  const itemsOf = Map.groupBy(data.items, (item) => item.invoice_id);
  const challanOf = new Map(data.deliveries.map((delivery) => [delivery.invoice_id, delivery]));
  const name = monthName(data.month);
  const made = [name, data.company, `made by StudFlow on ${formatTime(Date.parse(asOf))}`].filter(Boolean).join(' · ');
  const warning = 'Do not type in this file: it is written again, whole, whenever a bill or a receipt of this month changes.';

  // ---- Bills -------------------------------------------------------------------
  const charges = (invoice: BookInvoice, kind: Charge): number =>
    sumPaise((itemsOf.get(invoice.id) ?? []).filter((item) => chargeOf(item) === kind).map((item) => decimalToPaise(item.line_total)));
  const packing = (invoice: BookInvoice): string => paiseToDecimal(sumPaise([decimalToPaise(invoice.packing_charge), charges(invoice, 'Packing')]));
  const freight = (invoice: BookInvoice): string => paiseToDecimal(sumPaise([decimalToPaise(invoice.delivery_charge), charges(invoice, 'Freight')]));
  const beforeGst = (invoice: BookInvoice): string => paiseToDecimal(sumPaise([invoice.subtotal, invoice.packing_charge, invoice.delivery_charge].map(decimalToPaise)));
  const dcOnly = (delivery: BookDelivery | undefined): string | null =>
    delivery?.freight_paid_by === 'buyer_to_pay' && decimalToPaise(delivery.freight_amount) > 0 ? delivery.freight_amount : null;
  const balance = (invoice: BookInvoice): number =>
    invoice.cancelled_at !== null || invoice.payment_status === 'paid' ? 0 : outstandingPaise(decimalToPaise(invoice.grand_total), decimalToPaise(invoice.amount_paid));
  const status = (invoice: BookInvoice): string => {
    if (invoice.cancelled_at !== null) return CANCELLED;
    if (invoice.payment_status === 'unpaid') return 'Unpaid';
    if (invoice.payment_status === 'partial') return 'Part paid';
    return decimalToPaise(invoice.amount_paid) < decimalToPaise(invoice.grand_total) ? 'Paid, settled short' : 'Paid';
  };

  const bills = sheet<BookInvoice>('Bills', [
    ['Invoice no', 'text', 17, (i) => i.invoice_no],
    ['Date', 'date', 13, (i) => i.invoice_date],
    ['Type', 'text', 10, (i) => (i.bill_type === 'job_work' ? 'Job work' : 'Supply')],
    ['Customer', 'text', 30, (i) => i.customer_snapshot.name],
    ['GSTIN', 'text', 18, (i) => i.customer_snapshot.gstin],
    ['Phone', 'text', 14, (i) => i.customer_snapshot.phone],
    ['State', 'text', 18, (i) => `${stateLabel(i.place_of_supply)}${i.is_sez ? ' · SEZ' : ''}`],
    ['Address', 'text', 30, (i) => orNull(i.customer_snapshot.address)],
    ['DC no', 'text', 16, (i) => challanOf.get(i.id)?.dc_no ?? null],
    ['P.O. no', 'text', 16, (i) => i.po_no],
    ['P.O. date', 'date', 13, (i) => i.po_date],
    ['Lines', 'whole', 7, (i) => (itemsOf.get(i.id) ?? []).length],
    ['Items ₹', 'money', 14, (i) => paiseToDecimal(charges(i, null))],
    ['Packing ₹', 'money', 12, packing],
    ['Freight on bill ₹', 'money', 17, freight],
    ['Before GST ₹', 'money', 14, beforeGst],
    ['CGST ₹', 'money', 12, (i) => i.cgst],
    ['SGST ₹', 'money', 12, (i) => i.sgst],
    ['IGST ₹', 'money', 12, (i) => i.igst],
    ['Round-off ₹', 'money', 11, (i) => i.round_off],
    ['Final amount ₹', 'money', 16, (i) => i.grand_total],
    ['Received ₹', 'money', 14, (i) => i.amount_paid],
    ['Balance ₹', 'money', 14, (i) => paiseToDecimal(balance(i))],
    ['Freight on DC only ₹', 'money', 20, (i) => dcOnly(challanOf.get(i.id))],
    ['Due date', 'date', 13, (i) => i.due_date],
    ['Status', 'text', 18, status],
    ['Why cancelled', 'text', 24, (i) => i.cancellation_reason],
    ['Note', 'text', 24, (i) => orNull(i.notes)],
  ], invoices, {
    isVoid: (i) => i.cancelled_at !== null, except: CANCELLED, totalLabel: 'Total without cancelled',
    sums: Object.fromEntries(['Items ₹', 'Packing ₹', 'Freight on bill ₹', 'Before GST ₹', 'CGST ₹', 'SGST ₹', 'IGST ₹', 'Round-off ₹', 'Final amount ₹', 'Received ₹', 'Balance ₹', 'Freight on DC only ₹'].map((title) => [title, 'money' as const])),
    empty: 'No bills this month.', notes: [made, warning, 'Freight on DC only: paid by the customer to the driver. It is on the challan, not on the bill.'],
  });

  // ---- Items -------------------------------------------------------------------
  const lines = invoices.flatMap((invoice) => [...(itemsOf.get(invoice.id) ?? [])].sort((a, b2) => a.line_no - b2.line_no));
  const items = sheet<BookItem>('Items', [
    ['Invoice no', 'text', 17, (l) => head(l).invoice_no],
    ['Date', 'date', 13, (l) => head(l).invoice_date],
    ['Customer', 'text', 30, (l) => head(l).customer_snapshot.name],
    ['Line', 'whole', 6, (l) => l.line_no],
    ['Kind', 'text', 10, (l) => chargeOf(l) ?? (head(l).bill_type === 'job_work' ? 'Job work' : 'Goods')],
    ['Description', 'text', 34, (l) => l.description],
    ['Grade', 'text', 10, (l) => l.material_grade],
    ['Size', 'text', 16, (l) => l.size_text],
    ['HSN/SAC', 'text', 10, (l) => l.hsn_sac],
    ['Pieces', 'whole', 10, (l) => l.qty_pieces],
    ['Kg', 'number', 12, (l) => l.total_weight_kg],
    ['Rate ₹', 'rate', 12, (l) => l.unit_rate],
    ['Per', 'text', 6, (l) => l.billing_unit],
    ['Amount ₹', 'money', 14, (l) => l.line_total],
    ['GST %', 'number', 8, (l) => l.tax_rate_percent],
    ['CGST ₹', 'money', 12, (l) => l.cgst_amount],
    ['SGST ₹', 'money', 12, (l) => l.sgst_amount],
    ['IGST ₹', 'money', 12, (l) => l.igst_amount],
    ['Status', 'text', 12, (l) => (head(l).cancelled_at === null ? 'Issued' : CANCELLED)],
  ], lines, {
    isVoid: (l) => head(l).cancelled_at !== null, except: CANCELLED, totalLabel: 'Total without cancelled',
    sums: { 'Amount ₹': 'money', 'CGST ₹': 'money', 'SGST ₹': 'money', 'IGST ₹': 'money' },
    empty: 'No bills this month.', notes: ['One row per line. Sales are counted on the Bills sheet, once per bill; packing and freight that are not lines are there too.'],
  });

  // ---- Dispatch & Job Work -------------------------------------------------------
  type Sent = { delivery: BookDelivery; back: BookReturn | null };
  const backOf = Map.groupBy(data.returns, (row) => row.delivery_id);
  const sent = [...data.sentNow]
    .sort((a, b2) => a.dc_date.localeCompare(b2.dc_date) || a.dc_seq - b2.dc_seq)
    .flatMap((delivery): Sent[] => [{ delivery, back: null }, ...[...(backOf.get(delivery.id) ?? [])].sort((a, b2) => a.line_no - b2.line_no).map((back) => ({ delivery, back }))]);
  const isOff = ({ delivery, back }: Sent): boolean => head(delivery).cancelled_at !== null || (back !== null && back.reversed_at !== null);
  const challan = (value: (delivery: BookDelivery) => string | null) => (row: Sent): string | null => (row.back === null ? value(row.delivery) : null);
  const material = (value: (back: BookReturn) => string | number | null) => (row: Sent): string | number | null => (row.back === null ? null : value(row.back));
  const dispatch = sheet<Sent>('Dispatch & Job Work', [
    ['Kind', 'text', 18, (r) => (r.back === null ? 'Dispatch' : 'Job work returned')],
    ['DC no', 'text', 16, (r) => r.delivery.dc_no],
    ['DC date', 'date', 13, (r) => r.delivery.dc_date],
    ['Invoice no', 'text', 17, (r) => head(r.delivery).invoice_no],
    ['Customer', 'text', 30, (r) => head(r.delivery).customer_snapshot.name],
    ['Deliver to', 'text', 24, challan((d) => orNull(d.delivery_address))],
    ['Transport', 'text', 16, challan((d) => TRANSPORT[d.transport_mode])],
    ['Vehicle no', 'text', 14, challan((d) => d.vehicle_no)],
    ['Driver', 'text', 16, challan((d) => d.driver_name)],
    ['Driver phone', 'text', 14, challan((d) => d.driver_phone)],
    ['LR no', 'text', 14, challan((d) => d.lr_number)],
    ['Freight paid by', 'text', 22, challan((d) => (decimalToPaise(d.freight_amount) === 0 ? null : d.freight_paid_by === 'buyer_to_pay' ? 'Customer, to the driver' : 'Us, on the bill'))],
    ['Freight on DC only ₹', 'money', 20, challan(dcOnly)],
    ['Dispatch', 'text', 12, challan((d) => DISPATCH[d.status])],
    ['Dispatched at', 'time', 18, challan((d) => d.dispatched_at)],
    ['Delivered at', 'time', 18, challan((d) => d.delivered_at)],
    ['Party DC no', 'text', 14, material((m) => m.party_dc_no)],
    ['Party DC date', 'date', 13, material((m) => m.party_dc_date)],
    ['Grade', 'text', 10, material((m) => m.material_grade)],
    ['Goods', 'text', 24, material((m) => m.goods_description)],
    ['HSN', 'text', 9, material((m) => m.goods_hsn)],
    ['Pieces', 'whole', 10, material((m) => m.pieces)],
    ['Returned kg', 'number', 12, material((m) => m.returned_weight_kg)],
    ['Scrap kg', 'number', 11, material((m) => m.scrap_weight_kg)],
    ['Balance kg', 'number', 12, material((m) => m.balance_after_kg)],
    ['Goods value ₹', 'money', 14, material((m) => m.declared_value)],
    ['Status', 'text', 12, (r) => (isOff(r) ? CANCELLED : 'Issued')],
  ], sent, {
    isVoid: isOff, except: CANCELLED, totalLabel: 'Total without cancelled',
    sums: { 'Freight on DC only ₹': 'money', 'Returned kg': 'kg', 'Scrap kg': 'kg', 'Goods value ₹': 'money' },
    empty: 'Nothing was sent this month.', notes: ['By the date of the challan. Goods value is the customer’s own material: it is not a sale.'],
  });

  // ---- Receipts ------------------------------------------------------------------
  const payments = [...data.payments].sort((a, b2) => a.received_on.localeCompare(b2.received_on) || a.created_at.localeCompare(b2.created_at) || head(a).invoice_no.localeCompare(head(b2).invoice_no));
  const receipts = sheet<BookPayment>('Receipts', [
    ['Received on', 'date', 13, (p) => p.received_on],
    ['Invoice no', 'text', 17, (p) => head(p).invoice_no],
    ['Invoice date', 'date', 13, (p) => head(p).invoice_date],
    ['Customer', 'text', 30, (p) => head(p).customer_snapshot.name],
    ['Amount ₹', 'money', 14, (p) => p.amount],
    ['Mode', 'text', 14, (p) => MODE[p.mode]],
    ['Reference', 'text', 20, (p) => orNull(p.reference)],
    ['Settles the bill', 'text', 14, (p) => (p.settles_invoice ? 'Yes' : null)],
    ['Status', 'text', 12, (p) => (p.voided_at === null ? 'Received' : VOIDED)],
    ['Why voided', 'text', 24, (p) => p.void_reason],
  ], payments, {
    isVoid: (p) => p.voided_at !== null, except: VOIDED, totalLabel: 'Total without voided',
    sums: { 'Amount ₹': 'money' }, empty: 'No money was received this month.', notes: ['By the day the money came, whichever month the bill is from.'],
  });

  return xlsx([bills, items, dispatch, receipts], { title: `Billing ${data.month.slice(0, 7)}` });
}
