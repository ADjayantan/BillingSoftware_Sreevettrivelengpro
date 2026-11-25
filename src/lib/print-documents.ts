/**
 * What an issued bill and its challan say on paper (specs/print-templates.md). Formats issued
 * figures, adds nothing to them. How it looks: bill-sheets.ts. Pure.
 */
import { CHARGE_LINE } from './bill-draft';
import { sumKg, sumPaise, summarizeRates, type GstSplit } from './billing-math';
import { formatDate, formatPhone, isMobile, istDate, shortDate, stateLabel } from './india';
import { decimalToPaise, formatPaise, rupeesInWords, trimZeros } from './money';
import type { InvoiceDocument } from './schemas/invoices';

export interface LabelValue {
  label: string;
  value: string;
}

export interface PrintItem {
  code: string;
  /** Its GST %, on a bill of several rates. */
  codeNote: string;
  description: string;
  /** Small, under the description. */
  detail: string;
  /** Invoice: the rate, and per what. Challan: the pieces. */
  third: string;
  thirdNote: string;
  /** Invoice: the billed quantity, and the other measurement. Challan: the kilograms. */
  fourth: string;
  fourthNote: string;
  amount: string | null;
}

export interface PrintSum {
  label: string;
  rate: string;
  /** What the rate is on, when there is more than one. */
  base: string;
  /** Null: a row of the book that this bill leaves empty. */
  amount: string | null;
}

export interface PrintDocument {
  key: string;
  kind: 'invoice' | 'challan';
  title: string;
  subtitle: string;
  copyLabel: string;
  /** A word across the rows. */
  stamp: string;
  issuer: { name: string; tagline: string; addresses: string[]; contact: string[]; gstin: string };
  number: string;
  issueDate: string;
  refs: { label: string; value: string; date: string }[];
  to: { role: string; name: string; address: string; phone: string; gstin: string; state: string };
  notes: { label: string; value: string; strong?: true }[];
  /** `split`: the last column is money, rupees and paise apart. */
  heads: { code: string; third: string; fourth: string; amount: string; split: boolean };
  items: PrintItem[];
  sums: PrintSum[];
  rows: LabelValue[];
  facts: LabelValue[];
  total: { label: string; amount: string } | null;
  words: LabelValue | null;
  bank: LabelValue[];
  /** `own`: the company signs. */
  signatures: { organisation: string; role: string; hint: string; own: boolean }[];
}

export interface PrintOptions {
  documents: 'both' | 'invoice' | 'dc';
  copies: 'original' | 'all';
}

/** Lines composed from charges (bill-draft.ts): billed, but not goods that travel. */
const CHARGE_LINES = new Set<string>(Object.values(CHARGE_LINE));

const MODES = {
  own_vehicle: 'Own vehicle', transporter: 'Transporter', courier: 'Courier', customer_pickup: 'Self-collection', hand_delivery: 'Hand delivery',
} as const;
const STATUSES = { pending: 'Pending', packed: 'Packed', dispatched: 'Dispatched', delivered: 'Delivered' } as const;

const money = (decimal: string): string => formatPaise(decimalToPaise(decimal));
const groupWhole = (n: number): string => formatPaise(n * 100).replace(/\.00$/, '');
const notZero = (decimal: string): boolean => /[1-9]/.test(decimal);
/** Billed kilograms to the last digit; a weight that only goes along with the pieces, in grams. */
const kilograms = (item: InvoiceDocument['items'][number]): string =>
  item.total_weight_kg === null || !notZero(item.total_weight_kg) ? ''
  : trimZeros(item.billing_unit === 'kg' ? item.total_weight_kg : sumKg([item.total_weight_kg]));
const oneLine = (text: string): string => text.split(/[\r\n]+/).map((part) => part.trim()).filter(Boolean).join(', ').replace(/,(\s*,)+/g, ',');
const inWords = (paise: number): string => rupeesInWords(paise).replace(/^Rupees /, '');

/** Rates keep their significant decimals, with at least two: '0.0425', '1.50'. */
function formatRate(decimal: string): string {
  const [whole = '0', decimals = ''] = decimal.split('.');
  return `${groupWhole(Number(whole))}.${decimals.replace(/0+$/, '').padEnd(2, '0')}`;
}

const halfRate = (rate: string): string => String(Number(rate) / 2);

function gst(part: { cgst: string; sgst: string; igst: string }): GstSplit {
  return { cgst_paise: decimalToPaise(part.cgst), sgst_paise: decimalToPaise(part.sgst), igst_paise: decimalToPaise(part.igst) };
}

export function buildDocuments(doc: InvoiceDocument, options: PrintOptions): PrintDocument[] {
  const out: PrintDocument[] = [];
  if (options.documents !== 'dc') {
    const labels = doc.invoice.bill_type === 'job_work'
      ? ['Original for Recipient', 'Duplicate for Supplier']
      : ['Original for Recipient', 'Duplicate for Transporter', 'Triplicate for Supplier'];
    for (const label of options.copies === 'all' ? labels : labels.slice(0, 1)) out.push(invoiceDocument(doc, label));
  }
  if (options.documents !== 'invoice' && doc.delivery) {
    const labels = ['Original for Consignee', 'Duplicate for Transporter', 'Triplicate for Consigner'];
    for (const label of options.copies === 'all' ? labels : labels.slice(0, 1)) out.push(challanDocument(doc, doc.delivery, label));
  }
  return out;
}

type Delivery = NonNullable<InvoiceDocument['delivery']>;

/** The head of the bill, as the company was when it was issued. */
function issuerOf(doc: InvoiceDocument): PrintDocument['issuer'] {
  const supplier = doc.invoice.supplier_snapshot;
  const { factory_address, office_phone, phone, email } = supplier;
  return {
    name: supplier.legal_name,
    tagline: supplier.tagline ?? '',
    addresses: factory_address ? [`Office : ${oneLine(supplier.address)}`, `Factory : ${oneLine(factory_address)}`] : [oneLine(supplier.address)],
    contact: [
      ...(office_phone ? [`Office : ${office_phone}`] : []),
      ...(phone ? [`${isMobile(phone) ? 'Mobile' : 'Phone'} : ${formatPhone(phone)}`] : []),
      ...(email ? [`E-mail : ${email}`] : []),
    ],
    gstin: supplier.gstin,
  };
}

/** The party DC of a job-work bill stands with the numbers when it is one, else in a note. */
function partyDcs(doc: InvoiceDocument): { refs: PrintDocument['refs']; notes: PrintDocument['notes'] } {
  const { returns } = doc;
  const [only] = returns;
  if (returns.length === 1 && only) return { refs: [{ label: 'Party DC', value: only.party_dc_no, date: shortDate(only.party_dc_date) }], notes: [] };
  if (returns.length === 0) return { refs: [], notes: [] };
  return { refs: [], notes: [{ label: 'Party DC', value: returns.map((lot) => `${lot.party_dc_no} dt ${shortDate(lot.party_dc_date)}`).join(', ') }] };
}

/** Always there, as in the book; empty when there is none. */
const orderRef = (doc: InvoiceDocument): PrintDocument['refs'][number] =>
  ({ label: 'P. O. No.', value: doc.invoice.po_no ?? '', date: doc.invoice.po_date === null ? '' : shortDate(doc.invoice.po_date) });

function sumsOf(doc: InvoiceDocument): PrintSum[] {
  const { invoice, items } = doc;
  const interState = decimalToPaise(invoice.igst) > 0 || invoice.place_of_supply !== '33' || invoice.is_sez;
  const taxedDelivery = invoice.delivery_taxable ? decimalToPaise(invoice.delivery_charge) : 0;
  const { rates, taxable_paise } = summarizeRates(
    items.map((item) => ({
      tax_rate_percent: item.tax_rate_percent,
      line_total_paise: decimalToPaise(item.line_total),
      ...gst({ cgst: item.cgst_amount, sgst: item.sgst_amount, igst: item.igst_amount }),
    })),
    { taxable_paise: sumPaise([decimalToPaise(invoice.packing_charge), taxedDelivery]), ...gst({ cgst: invoice.charges_cgst, sgst: invoice.charges_sgst, igst: invoice.charges_igst }) },
  );
  const plain = (label: string, amount: string | null): PrintSum => ({ label, rate: '', base: '', amount });

  const sums = [plain('SUB TOTAL', money(invoice.subtotal))];
  if (notZero(invoice.packing_charge)) sums.push(plain('Packing', money(invoice.packing_charge)));
  if (taxedDelivery > 0) sums.push(plain('Delivery', formatPaise(taxedDelivery)));
  if (sums.length > 1) sums.push(plain('Taxable value', formatPaise(taxable_paise)));

  // A rate of 0% has no tax to show next to others; its lines say 0% themselves.
  const taxed = rates.length > 1 ? rates.filter((row) => notZero(row.tax_rate_percent)) : rates;
  const head = (label: string, rate: string, base: number, paise: number): PrintSum =>
    ({ label, rate: `${rate}%`, base: rates.length > 1 ? `on ${formatPaise(base)}` : '', amount: formatPaise(paise) });
  if (interState) {
    sums.push(plain('CGST', null), plain('SGST', null));
    for (const row of taxed) sums.push(head('IGST', row.tax_rate_percent, row.taxable_paise, row.igst_paise));
  } else {
    for (const row of taxed) {
      const half = halfRate(row.tax_rate_percent);
      sums.push(head('CGST', half, row.taxable_paise, row.cgst_paise), head('SGST', half, row.taxable_paise, row.sgst_paise));
    }
    sums.push(plain('IGST', null));
  }
  if (notZero(invoice.delivery_charge) && !invoice.delivery_taxable) sums.push(plain('Delivery, not taxed', money(invoice.delivery_charge)));
  sums.push(plain('R. Off', money(invoice.round_off)));
  return sums;
}

function invoiceDocument(doc: InvoiceDocument, copyLabel: string): PrintDocument {
  const { invoice, items, delivery } = doc;
  const { supplier_snapshot: supplier, customer_snapshot: buyer } = invoice;
  const jobWork = invoice.bill_type === 'job_work';
  const party = partyDcs(doc);

  const notes: PrintDocument['notes'] = [];
  if (invoice.cancelled_at) notes.push({ label: 'CANCELLED', value: `on ${formatDate(istDate(new Date(invoice.cancelled_at)))} · ${invoice.cancellation_reason ?? ''}`, strong: true });
  if (invoice.is_sez) {
    notes.push({
      label: '', strong: true,
      value: notZero(invoice.igst)
        ? 'Supply to SEZ unit / developer for authorised operations on payment of integrated tax'
        : 'Supply to SEZ unit / developer for authorised operations under Bond or Letter of Undertaking without payment of integrated tax',
    });
  }
  const deliverTo = delivery?.delivery_address ?? null;
  if (deliverTo && oneLine(deliverTo) !== oneLine(buyer.address ?? '')) notes.push({ label: 'Delivery at', value: oneLine(deliverTo) });
  notes.push(...party.notes);
  if (invoice.notes) notes.push({ label: 'Note', value: oneLine(invoice.notes) });

  const facts: LabelValue[] = [
    { label: 'Place of supply', value: stateLabel(invoice.place_of_supply) },
    { label: 'Reverse charge', value: 'No' },
    { label: 'Due date', value: formatDate(invoice.due_date) },
  ];
  if (delivery) {
    const driver = [delivery.driver_name, delivery.driver_phone && formatPhone(delivery.driver_phone)].filter(Boolean).join(' · ');
    if (delivery.transport_mode !== 'own_vehicle') facts.push({ label: 'Transport', value: MODES[delivery.transport_mode] });
    if (delivery.vehicle_no) facts.push({ label: 'Vehicle', value: delivery.vehicle_no });
    if (driver) facts.push({ label: 'Driver', value: driver });
    if (delivery.lr_number) facts.push({ label: 'LR No', value: delivery.lr_number });
  }

  const services = items.filter((item) => item.hsn_sac.startsWith('99')).length;
  const severalRates = new Set(items.map((item) => Number(item.tax_rate_percent))).size > 1;
  const grandTotal = decimalToPaise(invoice.grand_total);

  return {
    key: `invoice-${copyLabel}`,
    kind: 'invoice',
    title: 'TAX INVOICE',
    subtitle: jobWork ? 'JOB WORK' : '',
    copyLabel,
    stamp: invoice.cancelled_at === null ? '' : 'CANCELLED',
    issuer: issuerOf(doc),
    number: invoice.invoice_no,
    issueDate: formatDate(invoice.invoice_date),
    refs: [
      { label: 'DC No.', value: delivery?.dc_no ?? '', date: delivery ? shortDate(delivery.dc_date) : '' },
      ...party.refs,
      orderRef(doc),
    ],
    to: {
      role: 'To,', name: buyer.name, address: buyer.address ?? '', phone: buyer.phone ? formatPhone(buyer.phone) : '',
      gstin: buyer.gstin ?? 'Unregistered', state: stateLabel(buyer.state_code),
    },
    notes,
    heads: {
      code: services === 0 ? 'HSN CODE' : services === items.length ? 'SAC CODE' : 'HSN / SAC',
      third: 'RATE', fourth: 'QTY.', amount: 'AMOUNT', split: true,
    },
    items: items.map((item) => ({
      code: item.hsn_sac,
      codeNote: severalRates ? `${trimZeros(item.tax_rate_percent)}%` : '',
      description: item.description,
      detail: '',
      third: formatRate(item.unit_rate),
      thirdNote: item.billing_unit === 'pcs' ? '/pc' : '/kg',
      fourth: item.billing_unit === 'pcs' ? `${groupWhole(item.qty_pieces ?? 0)} PCS` : `${kilograms(item)} KGS`,
      fourthNote: item.billing_unit === 'pcs'
        ? (kilograms(item) && `${kilograms(item)} kg`)
        : item.qty_pieces ? `${groupWhole(item.qty_pieces)} pcs` : '',
      amount: money(item.line_total),
    })),
    sums: sumsOf(doc),
    rows: [],
    facts,
    total: { label: 'TOTAL AMOUNT', amount: formatPaise(grandTotal) },
    words: { label: 'Rupees', value: inWords(grandTotal) },
    bank: supplier.bank_account_no === null ? [] : [
      ...(supplier.bank_name ? [{ label: 'BANK NAME', value: supplier.bank_name }] : []),
      ...(supplier.bank_branch ? [{ label: 'BRANCH', value: supplier.bank_branch }] : []),
      { label: 'ACCOUNT No.', value: supplier.bank_account_no },
      ...(supplier.bank_ifsc ? [{ label: 'IFS CODE', value: supplier.bank_ifsc }] : []),
    ],
    signatures: [{ organisation: supplier.legal_name, role: 'Authorised Signatory', hint: '', own: true }],
  };
}

function challanDocument(doc: InvoiceDocument, delivery: Delivery, copyLabel: string): PrintDocument {
  const { invoice, items, returns } = doc;
  const { supplier_snapshot: supplier, customer_snapshot: buyer } = invoice;
  const jobWork = invoice.bill_type === 'job_work' && returns.length > 0;
  const party = partyDcs(doc);
  const valued = jobWork && returns.every((lot) => lot.declared_value !== null);
  const declared = valued ? sumPaise(returns.map((lot) => decimalToPaise(lot.declared_value ?? '0'))) : 0;
  const [only] = returns;

  const goods: PrintItem[] = jobWork
    ? returns.map((lot) => ({
        code: lot.goods_hsn, codeNote: '', description: `${lot.goods_description} · ${lot.material_grade}`,
        detail: [
          `Party DC ${lot.party_dc_no} dt ${shortDate(lot.party_dc_date)}`,
          ...(returns.length > 1 ? [`Inward ${lot.inward_weight_kg} kg`, `Scrap ${lot.scrap_weight_kg} kg`, `Balance ${lot.balance_after_kg} kg`] : []),
        ].join(' · '),
        third: lot.pieces ? `${groupWhole(lot.pieces)} PCS` : '', thirdNote: '',
        fourth: lot.returned_weight_kg, fourthNote: '',
        amount: valued ? money(lot.declared_value ?? '0') : null,
      }))
    : items
        .filter((item) => !CHARGE_LINES.has(item.description))
        .map((item) => ({
          code: item.hsn_sac, codeNote: '', description: item.description, detail: '',
          third: item.qty_pieces ? `${groupWhole(item.qty_pieces)} PCS` : '', thirdNote: '',
          fourth: kilograms(item), fourthNote: '',
          amount: null,
        }));

  const rows: LabelValue[] = [];
  if (jobWork) {
    if (returns.length === 1 && only) rows.push({ label: 'Inward kg', value: only.inward_weight_kg });
    rows.push(
      { label: 'Returned kg, this DC', value: sumKg(returns.map((lot) => lot.returned_weight_kg)) },
      { label: 'Scrap / wastage kg', value: sumKg(returns.map((lot) => lot.scrap_weight_kg)) },
    );
    if (returns.length === 1 && only) rows.push({ label: 'Balance held kg', value: only.balance_after_kg });
  } else {
    rows.push({ label: 'Value', value: `As per invoice ${invoice.invoice_no}` });
  }
  if (delivery.freight_paid_by === 'buyer_to_pay' && notZero(delivery.freight_amount)) {
    rows.push({ label: 'Payable directly by buyer · Freight', value: `₹${money(delivery.freight_amount)}` });
  }

  const when = delivery.dispatched_at ? formatDate(istDate(new Date(delivery.dispatched_at))) : null;
  return {
    key: `dc-${copyLabel}`,
    kind: 'challan',
    title: 'DELIVERY CHALLAN',
    subtitle: jobWork ? 'JOB-WORK RETURN' : 'SALE DISPATCH',
    copyLabel,
    stamp: invoice.cancelled_at === null ? '' : 'CANCELLED',
    issuer: issuerOf(doc),
    number: delivery.dc_no,
    issueDate: formatDate(delivery.dc_date),
    refs: [{ label: 'Invoice No.', value: invoice.invoice_no, date: shortDate(invoice.invoice_date) }, ...party.refs, orderRef(doc)],
    to: {
      role: jobWork ? 'Principal / deliver to,' : 'Deliver to,', name: buyer.name, address: delivery.delivery_address ?? buyer.address ?? '',
      phone: buyer.phone ? formatPhone(buyer.phone) : '', gstin: buyer.gstin ?? 'Unregistered', state: stateLabel(buyer.state_code),
    },
    notes: invoice.cancelled_at ? [{ label: 'CANCELLED', value: 'with the linked invoice', strong: true }] : [],
    heads: { code: 'HSN CODE', third: 'PIECES', fourth: 'NET KG', amount: valued ? 'VALUE' : 'REMARKS', split: valued },
    items: goods,
    sums: [],
    rows,
    facts: [
      { label: 'Reason', value: jobWork ? 'Return after job work' : 'Sale' },
      ...(invoice.place_of_supply !== '33' ? [{ label: 'Place of supply', value: stateLabel(invoice.place_of_supply) }] : []),
      { label: 'Mode', value: MODES[delivery.transport_mode] },
      { label: 'Vehicle No', value: delivery.vehicle_no ?? '—' },
      { label: 'Driver', value: delivery.driver_name ?? '—' },
      { label: 'Driver Phone', value: delivery.driver_phone ? formatPhone(delivery.driver_phone) : '—' },
      { label: 'LR No', value: delivery.lr_number ?? (delivery.transport_mode === 'transporter' ? 'Pending' : 'N/A') },
      { label: 'Status', value: when ? `${STATUSES[delivery.status]} · ${when}` : STATUSES[delivery.status] },
    ],
    total: valued ? { label: 'DECLARED GOODS VALUE', amount: formatPaise(declared) } : null,
    words: valued ? { label: 'Declared goods value, Rupees', value: inWords(declared) } : null,
    bank: [],
    signatures: [
      { organisation: buyer.name, role: 'Received by', hint: 'Name · Signature · Date', own: false },
      { organisation: supplier.legal_name, role: 'Dispatched by', hint: '', own: true },
    ],
  };
}
