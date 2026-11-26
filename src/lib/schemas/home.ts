/** What Home, the list of bills, "Money received" and "Send goods" read (008_home.sql). */
import { z } from 'zod';
import * as c from './common';
import { deliveryStatus, paymentMode, transportMode } from './invoices';
import { customerRow, studItemRow } from './masters';

/** A sum of the database, never a JSON number. */
const sum = z.string().regex(/^-?\d{1,14}\.\d{2}$/);
const bills = z.number().int().nonnegative();

/** Which bills a list shows. */
export const BILL_TABS = ['all', 'open', 'overdue', 'paid', 'cancelled'] as const;
export type BillTab = (typeof BILL_TABS)[number];

/** '2026-11', as a month box gives it; '' is every month. */
const month = z.union([z.literal(''), z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/)]).default('');

export const billsQuery = z.object({
  q: z.string().trim().max(60).default(''),
  show: z.enum(BILL_TABS).default('all'),
  month,
  customer: z.union([z.literal(''), c.id]).default(''),
  page: z.coerce.number().int().min(1).max(1000).default(1),
});
export type BillsQuery = z.infer<typeof billsQuery>;

export const receiptsQuery = billsQuery.pick({ q: true, month: true, page: true });

/** The customers by name, or who owes most first. */
export const CUSTOMER_SORTS = ['name', 'owes'] as const;
export const customersQuery = z.object({
  q: z.string().trim().max(60).default(''),
  sort: z.enum(CUSTOMER_SORTS).default('name'),
  page: z.coerce.number().int().min(1).max(1000).default(1),
});
export type CustomersQuery = z.infer<typeof customersQuery>;

/** A customer and what it owes: bills not settled (`on_bills`), the late part, and `balance` with the dues from before. */
export const customerBalance = customerRow.extend({ bills, on_bills: sum, overdue: sum, oldest: z.string().nullable(), balance: sum });
export type CustomerBalance = z.infer<typeof customerBalance>;

export const customerBalances = z.object({ customers: bills, owing: bills, balance: sum, overdue: sum, rows: z.array(customerBalance) });
export type CustomerBalances = z.infer<typeof customerBalances>;

export const foundBill = z.object({
  id: c.id,
  invoice_no: z.string(),
  bill_type: z.enum(['supply', 'job_work']),
  invoice_date: z.string(),
  due_date: z.string(),
  grand_total: z.string(),
  amount_paid: z.string(),
  payment_status: z.enum(['unpaid', 'partial', 'paid']),
  cancelled: z.boolean(),
  po_no: z.string().nullable(),
  customer: z.string(),
  phone: z.string().nullable(),
  supplier: z.string(),
});
export type FoundBill = z.infer<typeof foundBill>;

export const billsFound = z.object({
  counts: z.object({ all: bills, open: bills, overdue: bills, paid: bills, cancelled: bills }),
  shown: z.object({ bills, total: sum, balance: sum }),
  rows: z.array(foundBill),
});
export type BillsFound = z.infer<typeof billsFound>;

export const homeFigures = z.object({
  today: z.object({ bills, total: sum }),
  month: z.object({ bills, total: sum }),
  last_month: z.object({ bills, total: sum }),
  to_collect: z.object({ bills, total: sum }),
  overdue: z.object({ bills, total: sum, oldest: z.string().nullable() }),
  months: z.array(z.object({ month: z.string(), total: sum })).length(6),
  to_send: bills,
  not_on_drive: bills,
});
export type HomeFigures = z.infer<typeof homeFigures>;

export const receiptsFound = z.object({
  receipts: bills,
  total: sum,
  rows: z.array(
    z.object({
      id: c.id,
      invoice_id: c.id,
      invoice_no: z.string(),
      customer: z.string(),
      amount: z.string(),
      received_on: z.string(),
      mode: paymentMode,
      reference: z.string().nullable(),
      settles_invoice: z.boolean(),
      voided: z.boolean(),
    }),
  ),
});
export type ReceiptsFound = z.infer<typeof receiptsFound>;

export const goodsRow = z.object({
  id: c.id,
  dc_no: z.string(),
  dc_date: z.string(),
  status: deliveryStatus,
  transport_mode: transportMode,
  vehicle_no: z.string().nullable(),
  driver_name: z.string().nullable(),
  driver_phone: z.string().nullable(),
  lr_number: z.string().nullable(),
  delivery_address: z.string().nullable(),
  invoice_id: c.id,
  invoice_no: z.string(),
  customer: z.string(),
  items: z.number(),
});
export type GoodsRow = z.infer<typeof goodsRow>;

export const metalRate = z.object({
  material_grade: z.string(),
  rate_per_kg: z.string(),
  previous_rate_per_kg: z.string().nullable(),
  change_delta: z.string().nullable(),
  recorded_at: z.string(),
});
export type MetalRate = z.infer<typeof metalRate>;

export const alertRule = z.object({ material_grade: z.string(), threshold_rs_per_kg: z.string(), is_active: z.boolean() });
export type AlertRule = z.infer<typeof alertRule>;

/** What a bill for a customer begins with: what is owed, and the goods of the last bill. */
export const customerGlance = z.object({
  bills,
  balance: sum,
  last: z
    .object({
      invoice_no: z.string(),
      invoice_date: z.string(),
      grand_total: z.string(),
      lines: z.array(
        z.object({
          stud: studItemRow.nullable(),
          description: z.string(),
          hsn_sac: z.string(),
          billing_unit: z.enum(['pcs', 'kg']),
          quantity: z.string(),
          rate: z.string(),
        }),
      ),
    })
    .nullable(),
});
export type CustomerGlance = z.infer<typeof customerGlance>;
