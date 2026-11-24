import { z } from 'zod';
import * as c from './common';

const TEMP_ID = /^OFFLINE-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const clientTempId = z.string().regex(TEMP_ID);

const draftLine = z
  .object({
    stud_item_id: c.id.nullable(),
    description: c.requiredText(300),
    hsn_sac: c.hsnSac,
    billing_unit: z.enum(['pcs', 'kg']),
    quantity: c.positiveDecimal(6, 8),
    /** The measurement that is not billed: pieces on a kg line, kg on a piece line. */
    pieces: z.number().int().positive().max(2_000_000_000).nullable().default(null),
    weight_kg: c.decimal(6, 8).nullable().default(null),
    rate: c.rupees,
    gst_rate: c.gstRate,
  })
  .refine((line) => line.billing_unit === 'kg' || /^\d+$/.test(line.quantity), {
    path: ['quantity'],
    message: 'Pieces must be whole',
  });

const lotReturn = z.object({
  lot_id: c.id,
  goods_description: c.optionalText(300),
  goods_hsn: c.hsnSac.default('7318'),
  pieces: z.number().int().positive().max(2_000_000_000).nullable().default(null),
  returned_weight_kg: c.decimal(3, 8),
  scrap_weight_kg: c.decimal(3, 8).default('0'),
  declared_value: c.rupees.nullable().default(null),
  close: z.boolean().default(false),
  close_reason: z.string().trim().min(3).max(300).nullable().default(null),
});

const vehicle = z
  .string()
  .trim()
  .toUpperCase()
  .transform((value) => value.replace(/[\s-]/g, ''))
  .pipe(z.union([z.literal('').transform(() => null), z.string().regex(/^[A-Z0-9]{4,15}$/, 'Vehicle number looks like TN38AB1234')]))
  .nullish()
  .transform((value) => value ?? null);

export const transportMode = z.enum(['own_vehicle', 'transporter', 'courier', 'customer_pickup', 'hand_delivery']);
export const deliveryStatus = z.enum(['pending', 'packed', 'dispatched', 'delivered']);
export const paymentMode = z.enum(['cash', 'upi', 'bank_transfer', 'cheque', 'tds', 'other']);

const transport = z.object({
  transport_mode: transportMode.default('own_vehicle'),
  vehicle_no: vehicle,
  driver_name: c.optionalText(80),
  driver_phone: c.optionalPhone,
  lr_number: c.optionalText(40),
  delivery_address: c.optionalText(500),
  status: deliveryStatus.default('pending'),
});

/** What the device sends. Amounts are never taken from it: the server recomputes them. */
export const billDraft = z
  .object({
    client_temp_id: clientTempId,
    bill_type: z.enum(['supply', 'job_work']),
    customer_id: c.id,
    invoice_date: c.isoDate,
    due_date: c.isoDate,
    notes: c.optionalText(1000),
    lines: z.array(draftLine).min(1, 'Add at least one line').max(497), // leaves room for charge lines
    packing: c.rupees.default('0'),
    freight: c.rupees.default('0'),
    freight_paid_by: z.enum(['seller', 'buyer_to_pay']).default('seller'),
    delivery_taxable: z.boolean().default(true),
    /** GST rate for packing/delivery when the lines carry different rates. */
    charges_gst_rate: c.gstRate.nullable().default(null),
    delivery: transport,
    returns: z.array(lotReturn).max(50).default([]),
    paid_now: z.object({ amount: c.rupees, mode: paymentMode }).nullable().default(null),
    /** The total the user saw; a mismatch stops the bill instead of issuing a surprise. */
    expected_total_paise: z.number().int().nonnegative(),
  })
  .refine((draft) => draft.due_date >= draft.invoice_date, { path: ['due_date'], message: 'Due date is before the invoice date' })
  .refine((draft) => draft.returns.length === 0 || draft.bill_type === 'job_work', {
    path: ['returns'],
    message: 'Only a job-work bill returns customer material',
  });
export type BillDraft = z.infer<typeof billDraft>;
export type BillDraftInput = z.input<typeof billDraft>;

export const syncResult = z.object({
  invoice_id: c.id,
  invoice_no: z.string(),
  dc_no: z.string(),
  replayed: z.boolean(),
});

/** What a bill that is already in the books was issued as. */
export const issuedBill = z.object({ invoice_id: c.id, invoice_no: z.string(), dc_no: z.string().nullable(), grand_total: z.string().nullable() });
export type IssuedBill = z.infer<typeof issuedBill>;

export const cancelInput = z.object({ reason: z.string().trim().min(3, 'Give a short reason').max(300) });

export const paymentInput = z.object({
  client_receipt_id: c.id,
  amount: c.rupees.refine((value) => /[1-9]/.test(value), 'Must be more than zero'),
  received_on: c.isoDate,
  mode: paymentMode,
  reference: c.optionalText(80),
  /** Accept as full settlement although less than the total came (e.g. TDS deducted). */
  settles_invoice: z.boolean().default(false),
});

export const paymentResult = z.object({
  payment_id: c.id,
  amount_paid: z.string(),
  payment_status: z.enum(['unpaid', 'partial', 'paid']),
  replayed: z.boolean().default(false),
});

export const voidInput = z.object({ reason: z.string().trim().min(3, 'Give a short reason').max(300) });

export const deliveryUpdate = transport.partial().extend({ status: deliveryStatus.optional() });

// ---- Rows -------------------------------------------------------------------
export const invoiceListRow = z.object({
  id: c.id,
  invoice_no: z.string(),
  bill_type: z.enum(['supply', 'job_work']),
  invoice_date: z.string(),
  due_date: z.string(),
  grand_total: z.string(),
  amount_paid: z.string(),
  payment_status: z.enum(['unpaid', 'partial', 'paid']),
  cancelled_at: z.string().nullable(),
  customer_snapshot: z.looseObject({ name: z.string() }),
});
export type InvoiceListItem = z.infer<typeof invoiceListRow>;

const party = z.object({
  name: z.string(),
  gstin: z.string().nullable(),
  address: z.string().nullable(),
  state_code: z.string(),
  phone: z.string().nullable(),
  is_sez: z.boolean(),
});
const supplier = z.object({
  legal_name: z.string(),
  gstin: z.string(),
  address: z.string(),
  state_code: z.string(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  bank_name: z.string().nullable(),
  bank_branch: z.string().nullable(),
  bank_account_no: z.string().nullable(),
  bank_ifsc: z.string().nullable(),
});

export const invoiceRow = z.object({
  id: c.id,
  invoice_no: z.string(),
  client_temp_id: z.string(),
  bill_type: z.enum(['supply', 'job_work']),
  customer_id: c.id,
  invoice_date: z.string(),
  due_date: z.string(),
  place_of_supply: z.string(),
  is_sez: z.boolean(),
  customer_snapshot: party,
  supplier_snapshot: supplier,
  subtotal: z.string(),
  packing_charge: z.string(),
  delivery_charge: z.string(),
  delivery_taxable: z.boolean(),
  cgst: z.string(),
  sgst: z.string(),
  igst: z.string(),
  charges_cgst: z.string(),
  charges_sgst: z.string(),
  charges_igst: z.string(),
  round_off: z.string(),
  grand_total: z.string(),
  amount_paid: z.string(),
  payment_status: z.enum(['unpaid', 'partial', 'paid']),
  notes: z.string().nullable(),
  cancelled_at: z.string().nullable(),
  cancellation_reason: z.string().nullable(),
});
export const invoiceItemRow = z.object({
  line_no: z.number(),
  description: z.string(),
  hsn_sac: z.string(),
  qty_pieces: z.number().nullable(),
  total_weight_kg: z.string().nullable(),
  billing_unit: z.enum(['pcs', 'kg']),
  unit_rate: z.string(),
  tax_rate_percent: z.string(),
  line_total: z.string(),
  cgst_amount: z.string(),
  sgst_amount: z.string(),
  igst_amount: z.string(),
});
export const deliveryRow = z.object({
  id: c.id,
  dc_no: z.string(),
  dc_date: z.string(),
  transport_mode: transportMode,
  vehicle_no: z.string().nullable(),
  driver_name: z.string().nullable(),
  driver_phone: z.string().nullable(),
  lr_number: z.string().nullable(),
  freight_paid_by: z.enum(['seller', 'buyer_to_pay']),
  freight_amount: z.string(),
  delivery_address: z.string().nullable(),
  status: deliveryStatus,
  dispatched_at: z.string().nullable(),
  delivered_at: z.string().nullable(),
});
export const returnRow = z.object({
  line_no: z.number(),
  party_dc_no: z.string(),
  party_dc_date: z.string(),
  material_grade: z.string(),
  goods_description: z.string(),
  goods_hsn: z.string(),
  pieces: z.number().nullable(),
  returned_weight_kg: z.string(),
  scrap_weight_kg: z.string(),
  inward_weight_kg: z.string(),
  balance_after_kg: z.string(),
  declared_value: z.string().nullable(),
});
export const paymentRow = z.object({
  id: c.id,
  amount: z.string(),
  received_on: z.string(),
  mode: paymentMode,
  reference: z.string().nullable(),
  settles_invoice: z.boolean(),
  voided_at: z.string().nullable(),
  void_reason: z.string().nullable(),
});

export interface InvoiceDocument {
  invoice: z.infer<typeof invoiceRow>;
  items: z.infer<typeof invoiceItemRow>[];
  delivery: z.infer<typeof deliveryRow> | null;
  returns: z.infer<typeof returnRow>[];
  payments: z.infer<typeof paymentRow>[];
}
