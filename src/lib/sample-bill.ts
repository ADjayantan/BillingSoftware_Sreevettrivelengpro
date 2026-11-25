/**
 * A made-up bill under the company's own head, so that the owner sees what customers will get
 * before there is a first bill. SAMPLE stands across it and for its number. Pure.
 */
import { buildDocuments, type PrintDocument } from './print-documents';
import type { InvoiceDocument } from './schemas/invoices';
import type { Company } from './schemas/masters';

const NOBODY = '00000000-0000-4000-8000-000000000000';

/** Its figures are written down, not worked out: 100 × 42.50 + 40 × 118.75 = 9,000, and 9% twice. */
function sampleDocument(company: Company, today: string): InvoiceDocument {
  const item = (line_no: number, description: string, qty_pieces: number, unit_rate: string, line_total: string, half: string) => ({
    line_no, description, hsn_sac: '731815', qty_pieces, total_weight_kg: null, billing_unit: 'pcs' as const, unit_rate, tax_rate_percent: '18.00', line_total,
    cgst_amount: half, sgst_amount: half, igst_amount: '0.00',
  });
  return {
    invoice: {
      id: NOBODY, invoice_no: 'SAMPLE', client_temp_id: `OFFLINE-${NOBODY}`, bill_type: 'supply', customer_id: NOBODY, invoice_date: today, due_date: today, place_of_supply: '33', is_sez: false,
      customer_snapshot: { name: 'Name of the customer', gstin: null, address: 'Street and town', state_code: '33', phone: null, is_sez: false },
      supplier_snapshot: company,
      subtotal: '9000.00', packing_charge: '0.00', delivery_charge: '0.00', delivery_taxable: true, cgst: '810.00', sgst: '810.00', igst: '0.00', charges_cgst: '0.00', charges_sgst: '0.00', charges_igst: '0.00',
      round_off: '0.00', grand_total: '10620.00', amount_paid: '0.00', payment_status: 'unpaid', po_no: null, po_date: null, notes: null, cancelled_at: null, cancellation_reason: null,
    },
    items: [item(1, 'SS 304 stud M12 × 150 mm', 100, '42.500000', '4250.00', '382.50'), item(2, 'SS 410 stud M16 × 220 mm', 40, '118.750000', '4750.00', '427.50')],
    delivery: null, returns: [], payments: [],
  };
}

export const sampleBill = (company: Company, today: string): PrintDocument[] =>
  buildDocuments(sampleDocument(company, today), { documents: 'invoice', copies: 'original' }).map((document) => ({ ...document, stamp: 'SAMPLE' }));
