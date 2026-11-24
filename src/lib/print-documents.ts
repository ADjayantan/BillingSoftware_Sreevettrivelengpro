/** Binds an issued invoice to the field slots of specs/print-templates.md. Pure. */
import { sumKg, sumPaise, summarizeRates, type GstSplit } from './billing-math';
import { formatDate, istDate, stateLabel } from './india';
import { decimalToPaise, formatPaise, rupeesInWords, trimZeros } from './money';
import type { InvoiceDocument } from './schemas/invoices';

type Align = '' | 'num';
export interface LabelValue {
  label: string;
  value: string;
}
export interface PrintDocument {
  key: string;
  title: string;
  issuerName: string;
  issuerAddress: string;
  issuerGstin: string;
  number: string;
  issueDate: string;
  copyLabel: string;
  linked: LabelValue[];
  parties: { role: string; name: string; address: string; stateAndCode: string; registration: string }[];
  facts: LabelValue[];
  declarationText: string[];
  columns: { label: string; align: Align }[];
  items: {
    description: string;
    codeLabel: string;
    code: string;
    quantity: string;
    quantityDetail: string;
    third: string;
    thirdDetail: string;
    fourth: string;
  }[];
  taxBand: { count: number; columns: { label: string; align: Align }[]; rows: { text: string; align: Align }[][] } | null;
  closingTitle: string;
  closingRows: LabelValue[];
  total: LabelValue | null;
  words: LabelValue | null;
  signatures: { organisation: string; role: string; nameDateLabel: string }[];
}

export type Paper = 'a4' | 'a5';
export interface PrintOptions {
  documents: 'both' | 'invoice' | 'dc';
  copies: 'original' | 'all';
}

/** Lines composed from charges (bill-draft.ts): billed, but not goods that travel. */
const CHARGE_LINES = new Set(['Packing charges', 'Delivery charges', 'Delivery, recovered at cost']);

const MODES = {
  own_vehicle: 'Own vehicle', transporter: 'Transporter', courier: 'Courier', customer_pickup: 'Self-collection', hand_delivery: 'Hand delivery',
} as const;
const STATUSES = { pending: 'Pending', packed: 'Packed', dispatched: 'Dispatched', delivered: 'Delivered' } as const;

const money = (decimal: string): string => formatPaise(decimalToPaise(decimal));
const groupWhole = (n: number): string => formatPaise(n * 100).replace(/\.00$/, '');

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
  const jobWork = doc.invoice.bill_type === 'job_work';
  const out: PrintDocument[] = [];
  if (options.documents !== 'dc') {
    const labels = jobWork
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

function transportFacts(delivery: NonNullable<InvoiceDocument['delivery']>): LabelValue[] {
  const lr = delivery.lr_number ?? (delivery.transport_mode === 'transporter' ? 'Pending' : 'N/A');
  return [
    { label: 'Mode', value: MODES[delivery.transport_mode] },
    { label: 'Vehicle No', value: delivery.vehicle_no ?? '—' },
    { label: 'Driver', value: delivery.driver_name ?? '—' },
    { label: 'Driver Phone', value: delivery.driver_phone ?? '—' },
    { label: 'LR No', value: lr },
  ];
}

function invoiceDocument(doc: InvoiceDocument, copyLabel: string): PrintDocument {
  const { invoice, items, delivery, returns } = doc;
  const { supplier_snapshot: supplier, customer_snapshot: buyer } = invoice;
  const jobWork = invoice.bill_type === 'job_work';
  const interState = decimalToPaise(invoice.igst) > 0 || invoice.place_of_supply !== '33' || invoice.is_sez;
  const chargesTaxable = sumPaise([
    decimalToPaise(invoice.packing_charge),
    invoice.delivery_taxable ? decimalToPaise(invoice.delivery_charge) : 0,
  ]);
  const summary = summarizeRates(
    items.map((item) => ({
      tax_rate_percent: item.tax_rate_percent,
      line_total_paise: decimalToPaise(item.line_total),
      ...gst({ cgst: item.cgst_amount, sgst: item.sgst_amount, igst: item.igst_amount }),
    })),
    { taxable_paise: chargesTaxable, ...gst({ cgst: invoice.charges_cgst, sgst: invoice.charges_sgst, igst: invoice.charges_igst }) },
  );

  const registration = (gstin: string | null): string => (gstin ? `GSTIN ${gstin}` : 'GSTIN Unregistered');
  const shipTo = delivery?.delivery_address ?? buyer.address ?? '';
  const declarations: string[] = [];
  if (invoice.cancelled_at) declarations.push(`CANCELLED on ${formatDate(istDate(new Date(invoice.cancelled_at)))} · ${invoice.cancellation_reason ?? ''}`);
  if (invoice.is_sez) {
    declarations.push(
      decimalToPaise(invoice.igst) > 0
        ? 'Supply to SEZ unit / developer for authorised operations on payment of integrated tax'
        : 'Supply to SEZ unit / developer for authorised operations under Bond or Letter of Undertaking without payment of integrated tax',
    );
  }

  const closingRows: LabelValue[] = [{ label: 'Item subtotal', value: money(invoice.subtotal) }];
  if (decimalToPaise(invoice.packing_charge) > 0) closingRows.push({ label: 'Packing', value: money(invoice.packing_charge) });
  if (decimalToPaise(invoice.delivery_charge) > 0 && invoice.delivery_taxable) {
    closingRows.push({ label: 'Delivery', value: money(invoice.delivery_charge) });
  }
  closingRows.push({ label: 'Taxable value', value: formatPaise(summary.taxable_paise) });
  if (interState) closingRows.push({ label: 'IGST', value: money(invoice.igst) });
  else closingRows.push({ label: 'CGST', value: money(invoice.cgst) }, { label: 'SGST', value: money(invoice.sgst) });
  if (decimalToPaise(invoice.delivery_charge) > 0 && !invoice.delivery_taxable) {
    closingRows.push({ label: 'Delivery, not taxed', value: money(invoice.delivery_charge) });
  }
  const roundOff = decimalToPaise(invoice.round_off);
  closingRows.push({ label: 'Round-off', value: `${roundOff > 0 ? '+' : ''}${formatPaise(roundOff)}` });
  if (supplier.bank_account_no) {
    closingRows.push({
      label: 'Pay to',
      value: [supplier.bank_name, supplier.bank_branch, `A/c ${supplier.bank_account_no}`, supplier.bank_ifsc && `IFSC ${supplier.bank_ifsc}`]
        .filter(Boolean)
        .join(' · '),
    });
  }

  const head = (rate: string, paise: number): string => `${rate}% · ${formatPaise(paise)}`;
  const taxColumns: { label: string; align: Align }[] = interState
    ? [{ label: 'GST rate', align: '' }, { label: 'Taxable ₹', align: 'num' }, { label: 'IGST % / ₹', align: 'num' }]
    : [{ label: 'GST rate', align: '' }, { label: 'Taxable ₹', align: 'num' }, { label: 'CGST % / ₹', align: 'num' }, { label: 'SGST % / ₹', align: 'num' }];
  const grandTotal = decimalToPaise(invoice.grand_total);

  return {
    key: `invoice-${copyLabel}`,
    title: jobWork ? 'GST Tax Invoice · Job Work' : 'GST Tax Invoice',
    issuerName: supplier.legal_name,
    issuerAddress: supplier.address,
    issuerGstin: supplier.gstin,
    number: invoice.invoice_no,
    issueDate: formatDate(invoice.invoice_date),
    copyLabel,
    linked: [
      ...(delivery ? [{ label: 'DC', value: `${delivery.dc_no} · ${formatDate(delivery.dc_date)}` }] : []),
      ...returns.map((lot) => ({ label: 'Party DC', value: `${lot.party_dc_no} · ${formatDate(lot.party_dc_date)}` })),
      { label: 'Due date', value: formatDate(invoice.due_date) },
    ],
    parties: [
      { role: 'Bill to', name: buyer.name, address: buyer.address ?? '', stateAndCode: stateLabel(buyer.state_code), registration: registration(buyer.gstin) },
      { role: 'Ship to', name: buyer.name, address: shipTo, stateAndCode: stateLabel(buyer.state_code), registration: registration(buyer.gstin) },
    ],
    facts: [
      { label: 'Place of supply', value: stateLabel(invoice.place_of_supply) },
      { label: 'Reverse charge', value: 'No' },
      ...(delivery ? transportFacts(delivery) : []),
      ...(invoice.notes ? [{ label: 'Note', value: invoice.notes }] : []),
    ],
    declarationText: declarations,
    columns: [
      { label: 'Description / HSN or SAC', align: '' },
      { label: 'Billed qty', align: 'num' },
      { label: 'Rate ₹/unit', align: 'num' },
      { label: 'Taxable ₹', align: 'num' },
    ],
    items: items.map((item) => ({
      description: item.description,
      codeLabel: item.hsn_sac.startsWith('99') ? 'SAC' : 'HSN',
      code: item.hsn_sac,
      quantity: item.billing_unit === 'pcs' ? `${groupWhole(item.qty_pieces ?? 0)} PCS` : `${trimZeros(item.total_weight_kg ?? '0')} KGS`,
      quantityDetail:
        item.billing_unit === 'pcs'
          ? item.total_weight_kg && decimalNotZero(item.total_weight_kg) ? `${trimZeros(item.total_weight_kg)} kg` : ''
          : item.qty_pieces ? `${groupWhole(item.qty_pieces)} pcs` : '',
      third: formatRate(item.unit_rate),
      thirdDetail: item.billing_unit === 'pcs' ? 'per pc' : 'per kg',
      fourth: money(item.line_total),
    })),
    taxBand: {
      count: taxColumns.length,
      columns: taxColumns,
      rows: summary.rates.map((row) => [
        { text: `${row.tax_rate_percent}%`, align: '' },
        { text: formatPaise(row.taxable_paise), align: 'num' },
        ...(interState
          ? [{ text: head(row.tax_rate_percent, row.igst_paise), align: 'num' as const }]
          : [
              { text: head(halfRate(row.tax_rate_percent), row.cgst_paise), align: 'num' as const },
              { text: head(halfRate(row.tax_rate_percent), row.sgst_paise), align: 'num' as const },
            ]),
      ]),
    },
    closingTitle: 'Invoice summary',
    closingRows,
    total: { label: 'Invoice total', value: `₹${formatPaise(grandTotal)}` },
    words: { label: 'Amount in words ·', value: rupeesInWords(grandTotal) },
    signatures: [
      { organisation: buyer.name, role: 'Received by', nameDateLabel: 'Name · Signature · Date' },
      { organisation: `For ${supplier.legal_name}`, role: 'Authorised signatory', nameDateLabel: '' },
    ],
  };
}

function decimalNotZero(decimal: string): boolean {
  return /[1-9]/.test(decimal);
}

function challanDocument(doc: InvoiceDocument, delivery: NonNullable<InvoiceDocument['delivery']>, copyLabel: string): PrintDocument {
  const { invoice, items, returns } = doc;
  const { supplier_snapshot: supplier, customer_snapshot: buyer } = invoice;
  const jobWork = invoice.bill_type === 'job_work' && returns.length > 0;
  const values = returns.map((lot) => lot.declared_value);
  const valued = jobWork && values.every((value) => value !== null);
  const declared = valued ? sumPaise(values.map((value) => decimalToPaise(value ?? '0'))) : 0;
  const registration = (gstin: string | null): string => (gstin ? `GSTIN ${gstin}` : 'GSTIN Unregistered');

  const goods = jobWork
    ? returns.map((lot) => ({
        description: `${lot.goods_description} · ${lot.material_grade} · Party DC ${lot.party_dc_no} (${formatDate(lot.party_dc_date)})`,
        codeLabel: 'HSN', code: lot.goods_hsn,
        quantity: lot.pieces ? `${groupWhole(lot.pieces)} PCS` : '—', quantityDetail: '',
        third: lot.returned_weight_kg, thirdDetail: 'kg',
        fourth: valued ? money(lot.declared_value ?? '0') : '',
      }))
    : items
        .filter((item) => !CHARGE_LINES.has(item.description))
        .map((item) => ({
          description: item.description,
          codeLabel: item.hsn_sac.startsWith('99') ? 'SAC' : 'HSN', code: item.hsn_sac,
          quantity: item.qty_pieces ? `${groupWhole(item.qty_pieces)} PCS` : '—', quantityDetail: '',
          third: item.total_weight_kg && decimalNotZero(item.total_weight_kg) ? trimZeros(item.total_weight_kg) : '—', thirdDetail: 'kg',
          fourth: '',
        }));

  const closingRows: LabelValue[] = jobWork
    ? [
        ...returns.flatMap((lot) => [
          { label: `Inward kg · Party DC ${lot.party_dc_no}`, value: lot.inward_weight_kg },
          { label: 'Returned kg this DC', value: lot.returned_weight_kg },
          { label: 'Scrap / wastage kg', value: lot.scrap_weight_kg },
          { label: 'Balance held kg', value: lot.balance_after_kg },
        ]),
        ...(returns.length > 1 ? [{ label: 'Total returned kg this DC', value: sumKg(returns.map((lot) => lot.returned_weight_kg)) }] : []),
      ]
    : [{ label: 'Value', value: `As per invoice ${invoice.invoice_no}` }];
  if (delivery.freight_paid_by === 'buyer_to_pay' && decimalToPaise(delivery.freight_amount) > 0) {
    closingRows.push({ label: 'Payable directly by buyer · Freight', value: `₹${money(delivery.freight_amount)}` });
  }

  const when = delivery.dispatched_at ? formatDate(istDate(new Date(delivery.dispatched_at))) : null;
  return {
    key: `dc-${copyLabel}`,
    title: jobWork ? 'Delivery Challan · Job-Work Return' : 'Delivery Challan · Sale Dispatch',
    issuerName: supplier.legal_name,
    issuerAddress: supplier.address,
    issuerGstin: supplier.gstin,
    number: delivery.dc_no,
    issueDate: formatDate(delivery.dc_date),
    copyLabel,
    linked: [{ label: 'Invoice', value: `${invoice.invoice_no} · ${formatDate(invoice.invoice_date)}` }],
    parties: [
      {
        role: jobWork ? 'Job worker / Dispatch from' : 'Consignor / Dispatch from', name: supplier.legal_name, address: supplier.address,
        stateAndCode: stateLabel(supplier.state_code), registration: registration(supplier.gstin),
      },
      {
        role: jobWork ? 'Principal / Deliver to' : 'Consignee / Deliver to', name: buyer.name, address: delivery.delivery_address ?? buyer.address ?? '',
        stateAndCode: stateLabel(buyer.state_code), registration: registration(buyer.gstin),
      },
    ],
    facts: [
      { label: 'Reason', value: jobWork ? 'Return after job work' : 'Sale' },
      ...(invoice.place_of_supply !== '33' ? [{ label: 'Place of supply', value: stateLabel(invoice.place_of_supply) }] : []),
      ...transportFacts(delivery),
      { label: 'Status', value: when ? `${STATUSES[delivery.status]} · ${when}` : STATUSES[delivery.status] },
    ],
    declarationText: invoice.cancelled_at ? ['CANCELLED with the linked invoice'] : [],
    columns: [
      { label: 'Goods / HSN', align: '' },
      { label: 'Pieces', align: 'num' },
      { label: 'Net kg', align: 'num' },
      { label: valued ? 'Declared value ₹' : 'Packages / remarks', align: 'num' },
    ],
    items: goods,
    taxBand: null,
    closingTitle: 'Challan summary',
    closingRows,
    total: valued ? { label: 'Declared goods value', value: `₹${formatPaise(declared)}` } : null,
    words: valued ? { label: 'Declared goods value in words ·', value: rupeesInWords(declared) } : null,
    signatures: [
      { organisation: `For ${supplier.legal_name}`, role: 'Dispatched by', nameDateLabel: 'Name · Signature · Date' },
      { organisation: buyer.name, role: 'Received by', nameDateLabel: 'Name · Signature · Date' },
    ],
  };
}

