/** Rows of the monthly Excel books. */
import { z } from 'zod';
import * as c from './common';
import { deliveryStatus, paymentMode, transportMode } from './invoices';

export const bookInvoice = z.object({
  id: c.id,
  invoice_no: z.string(),
  invoice_seq: z.number(),
  bill_type: z.enum(['supply', 'job_work']),
  invoice_date: z.string(),
  due_date: z.string(),
  place_of_supply: z.string(),
  is_sez: z.boolean(),
  customer_snapshot: z.looseObject({ name: z.string(), gstin: z.string().nullable(), phone: z.string().nullable(), address: z.string().nullable() }),
  subtotal: z.string(),
  packing_charge: z.string(),
  delivery_charge: z.string(),
  cgst: z.string(),
  sgst: z.string(),
  igst: z.string(),
  round_off: z.string(),
  grand_total: z.string(),
  amount_paid: z.string(),
  payment_status: z.enum(['unpaid', 'partial', 'paid']),
  po_no: z.string().nullable(),
  po_date: z.string().nullable(),
  notes: z.string().nullable(),
  cancelled_at: z.string().nullable(),
  cancellation_reason: z.string().nullable(),
});
export type BookInvoice = z.infer<typeof bookInvoice>;

export const bookItem = z.object({
  id: c.id,
  invoice_id: c.id,
  line_no: z.number(),
  stud_item_id: c.id.nullable(),
  description: z.string(),
  hsn_sac: z.string(),
  material_grade: z.string().nullable(),
  size_text: z.string().nullable(),
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
export type BookItem = z.infer<typeof bookItem>;

export const bookDelivery = z.object({
  id: c.id,
  invoice_id: c.id,
  dc_no: z.string(),
  dc_seq: z.number(),
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
export type BookDelivery = z.infer<typeof bookDelivery>;

export const bookReturn = z.object({
  id: c.id,
  invoice_id: c.id,
  delivery_id: c.id,
  line_no: z.number(),
  party_dc_no: z.string(),
  party_dc_date: z.string(),
  material_grade: z.string(),
  goods_description: z.string(),
  goods_hsn: z.string(),
  pieces: z.number().nullable(),
  returned_weight_kg: z.string(),
  scrap_weight_kg: z.string(),
  balance_after_kg: z.string(),
  declared_value: z.string().nullable(),
  reversed_at: z.string().nullable(),
});
export type BookReturn = z.infer<typeof bookReturn>;

export const bookPayment = z.object({
  id: c.id,
  invoice_id: c.id,
  amount: z.string(),
  received_on: z.string(),
  mode: paymentMode,
  reference: z.string().nullable(),
  settles_invoice: z.boolean(),
  voided_at: z.string().nullable(),
  void_reason: z.string().nullable(),
  created_at: z.string(),
});
export type BookPayment = z.infer<typeof bookPayment>;

// ---- The outbox ---------------------------------------------------------------
/** '2026-11' in an address -> '2026-11-01' */
export const monthParam = z.string().regex(/^20[2-9]\d-(0[1-9]|1[0-2])$/, 'Not a month').transform((month) => `${month}-01`);

/** A month of the books, named by its first day. */
export const bookMonth = z.string().regex(/^20[2-9]\d-(0[1-9]|1[0-2])-01$/, 'Not a month');

export const bookClaim = z.object({
  month: bookMonth,
  token: c.id,
  change_ids: z.array(z.number().int().nonnegative()),
  drive_file_id: z.string().nullable(),
  drive_link: z.string().nullable(),
  revision: z.number().int().nonnegative(),
});
export type BookClaim = z.infer<typeof bookClaim>;

export const bookMonthRow = z.object({
  month: bookMonth,
  bills: z.number(),
  waiting: z.number(),
  waiting_since: z.string().nullable(),
  written_at: z.string().nullable(),
  drive_link: z.string().nullable(),
  retry_at: z.string().nullable(),
  last_error: z.string().nullable(),
  updating: z.boolean(),
});
export type BookMonthRow = z.infer<typeof bookMonthRow>;
