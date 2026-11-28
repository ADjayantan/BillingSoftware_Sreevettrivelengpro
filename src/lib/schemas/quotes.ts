import { z } from 'zod';
import * as c from './common';

export const quoteCode = (no: number): string => `Q${String(no).padStart(4, '0')}`;

export const quoteLine = z
  .object({
    stud_item_id: c.id.nullable().default(null),
    description: c.requiredText(300),
    hsn_sac: c.hsnSac,
    billing_unit: z.enum(['pcs', 'kg']),
    quantity: c.positiveDecimal(6, 8),
    pieces: z.number().int().positive().max(2_000_000_000).nullable().default(null),
    weight_kg: c.decimal(6, 8).nullable().default(null),
    rate: c.rupees,
    gst_rate: c.gstRate,
  })
  .refine((line) => line.billing_unit === 'kg' || /^\d+$/.test(line.quantity), {
    path: ['quantity'],
    message: 'Pieces must be whole',
  });
export type QuoteLine = z.infer<typeof quoteLine>;

export const quoteInput = z
  .object({
    bill_type: z.enum(['supply', 'job_work']).default('supply'),
    customer_id: c.id,
    quote_date: c.isoDate,
    valid_until: c.isoDate,
    notes: c.optionalText(1000),
    lines: z.array(quoteLine).min(1, 'Add at least one line').max(100),
    packing: c.rupees.default('0'),
    freight: c.rupees.default('0'),
    freight_paid_by: z.enum(['seller', 'buyer_to_pay']).default('seller'),
    delivery_taxable: z.boolean().default(true),
    charges_gst_rate: c.gstRate.nullable().default(null),
    expected_total_paise: z.number().int().nonnegative(),
  })
  .refine((q) => q.valid_until >= q.quote_date, {
    path: ['valid_until'],
    message: 'Valid until date is before the quote date',
  });
export type QuoteInput = z.infer<typeof quoteInput>;

export const quoteRow = z.object({
  id: c.id,
  quote_no: z.number().int(),
  bill_type: z.enum(['supply', 'job_work']),
  customer_id: c.id,
  quote_date: c.isoDate,
  valid_until: c.isoDate,
  place_of_supply: z.string(),
  is_sez: z.boolean(),
  customer_snapshot: z.object({
    name: z.string(),
    gstin: z.string().nullable(),
    address: z.string().nullable(),
    state_code: z.string(),
    phone: z.string().nullable(),
    is_sez: z.boolean(),
  }),
  lines: z.array(quoteLine),
  packing_charge: z.string(),
  delivery_charge: z.string(),
  freight_paid_by: z.enum(['seller', 'buyer_to_pay']),
  delivery_taxable: z.boolean(),
  charges_gst_rate: z.string().nullable(),
  subtotal: z.string(),
  cgst: z.string(),
  sgst: z.string(),
  igst: z.string(),
  round_off: z.string(),
  grand_total: z.string(),
  notes: z.string().nullable(),
  status: z.enum(['open', 'converted', 'cancelled']),
  converted_invoice_id: c.id.nullable(),
  converted_invoice_no: z.string().nullable(),
});
export type QuoteRow = z.infer<typeof quoteRow>;
