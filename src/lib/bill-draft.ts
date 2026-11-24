/**
 * Turns what the user typed into the frozen calculateInvoice contract, and its result into
 * the sync_invoice payload. Pure, and shared: the screen previews with exactly the code the
 * server issues with. All arithmetic stays in billing-math.ts.
 */
import { calculateInvoiceDetail, type InvoiceDetail, type InvoiceInput } from './billing-math';
import { taxStateCode } from './india';
import { paiseToDecimal, parseRupees, trimZeros } from './money';
import type { BillDraft } from './schemas/invoices';

export class DraftError extends Error {
  override name = 'DraftError';
}

type DraftLine = BillDraft['lines'][number];
export type ComposableDraft = Pick<
  BillDraft,
  'bill_type' | 'lines' | 'packing' | 'freight' | 'freight_paid_by' | 'delivery_taxable' | 'charges_gst_rate'
>;

export interface ComposedBill {
  /** The typed lines, then any packing/delivery lines the contract wants classified. */
  lines: DraftLine[];
  input: InvoiceInput;
  detail: InvoiceDetail;
}

function paise(text: string, label: string): number {
  const value = parseRupees(text);
  if (value === null) throw new DraftError(`${label}: enter an amount with at most 2 decimals`);
  return value;
}

/** '18.00', '18.0' and '18' are one rate. */
export const sameRate = (a: string, b: string): boolean => trimZeros(a) === trimZeros(b);

export function distinctRates(lines: readonly { gst_rate: string }[]): string[] {
  return [...new Set(lines.map((line) => trimZeros(line.gst_rate)))];
}

/** The rate a separately listed charge takes: the bill's own, else the chosen, else the highest. */
export function chargesRate(draft: ComposableDraft): string {
  const rates = distinctRates(draft.lines);
  const only = rates.length === 1 ? rates[0] : undefined;
  if (only !== undefined) return only;
  if (draft.charges_gst_rate !== null) return draft.charges_gst_rate;
  return rates.reduce((highest, rate) => (Number(rate) > Number(highest) ? rate : highest), rates[0] ?? '0');
}

export function composeBill(draft: ComposableDraft, customer: { state_code: string; is_sez: boolean }): ComposedBill {
  const first = draft.lines[0];
  if (first === undefined) throw new DraftError('Add at least one line');
  const packing = paise(draft.packing, 'Packing');
  const freight = paise(draft.freight, 'Freight');
  const buyerPays = draft.freight_paid_by === 'buyer_to_pay';
  const untaxedDelivery = !buyerPays && freight > 0 && !draft.delivery_taxable;
  // A charge can sit in the header only while the whole bill is one GST rate.
  const listCharges = untaxedDelivery || distinctRates(draft.lines).length > 1;
  const packingAsLine = packing > 0 && (listCharges || buyerPays);
  const deliveryAsLine = !buyerPays && freight > 0 && listCharges;

  const charge = (description: string, amount: string, gstRate: string): DraftLine => ({
    stud_item_id: null, description, hsn_sac: first.hsn_sac, billing_unit: 'pcs', quantity: '1',
    pieces: null, weight_kg: null, rate: amount, gst_rate: gstRate,
  });
  const lines = [...draft.lines];
  if (packingAsLine) lines.push(charge('Packing charges', draft.packing, chargesRate(draft)));
  if (deliveryAsLine) {
    lines.push(
      untaxedDelivery
        ? charge('Delivery, recovered at cost', draft.freight, '0')
        : charge('Delivery charges', draft.freight, chargesRate(draft)),
    );
  }

  const input: InvoiceInput = {
    bill_type: draft.bill_type,
    state_code: taxStateCode(customer),
    lines: lines.map((line, i) => ({
      billing_unit: line.billing_unit,
      quantity: line.quantity,
      unit_rate_paise: paise(line.rate, `Line ${i + 1} rate`),
      tax_rate_percent: line.gst_rate,
    })),
    packing_charge_paise: packingAsLine ? 0 : packing,
    delivery_charge_paise: deliveryAsLine ? 0 : freight,
    delivery_taxable: true,
    freight_paid_by: draft.freight_paid_by,
  };
  return { lines, input, detail: calculateInvoiceDetail(input) };
}

export function buildSyncPayload(draft: BillDraft, bill: ComposedBill): Record<string, unknown> {
  const { amounts, lines, charges } = bill.detail;
  const billed = bill.input.freight_paid_by === 'seller';
  const paid = draft.paid_now === null ? 0 : paise(draft.paid_now.amount, 'Amount received');
  if (paid > amounts.grand_total_paise) throw new DraftError('Amount received is more than the bill');
  return {
    client_temp_id: draft.client_temp_id,
    bill_type: draft.bill_type,
    customer_id: draft.customer_id,
    invoice_date: draft.invoice_date,
    due_date: draft.due_date,
    notes: draft.notes,
    subtotal: paiseToDecimal(amounts.subtotal_paise),
    packing_charge: paiseToDecimal(billed ? bill.input.packing_charge_paise : 0),
    delivery_charge: paiseToDecimal(billed ? bill.input.delivery_charge_paise : 0),
    delivery_taxable: draft.delivery_taxable,
    cgst: paiseToDecimal(amounts.cgst_paise),
    sgst: paiseToDecimal(amounts.sgst_paise),
    igst: paiseToDecimal(amounts.igst_paise),
    charges_cgst: paiseToDecimal(charges.cgst_paise),
    charges_sgst: paiseToDecimal(charges.sgst_paise),
    charges_igst: paiseToDecimal(charges.igst_paise),
    round_off: paiseToDecimal(amounts.round_off_paise),
    grand_total: paiseToDecimal(amounts.grand_total_paise),
    amount_paid: paiseToDecimal(paid),
    payment_status: paid === 0 ? 'unpaid' : paid === amounts.grand_total_paise ? 'paid' : 'partial',
    payment_mode: draft.paid_now?.mode ?? null,
    items: bill.lines.map((line, i) => {
      const computed = lines[i];
      if (computed === undefined) throw new DraftError('line mismatch');
      return {
        line_no: i + 1,
        stud_item_id: line.stud_item_id,
        description: line.description,
        hsn_sac: line.hsn_sac,
        billing_unit: line.billing_unit,
        qty_pieces: line.billing_unit === 'pcs' ? Number(line.quantity) : line.pieces,
        total_weight_kg: line.billing_unit === 'kg' ? line.quantity : line.weight_kg,
        unit_rate: line.rate,
        tax_rate_percent: line.gst_rate,
        line_total: paiseToDecimal(computed.line_total_paise),
        cgst_amount: paiseToDecimal(computed.cgst_paise),
        sgst_amount: paiseToDecimal(computed.sgst_paise),
        igst_amount: paiseToDecimal(computed.igst_paise),
      };
    }),
    delivery: { ...draft.delivery, freight_paid_by: draft.freight_paid_by, freight_amount: draft.freight },
    job_work_returns: draft.returns,
  };
}
