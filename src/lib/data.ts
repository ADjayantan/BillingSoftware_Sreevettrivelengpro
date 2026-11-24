import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { ApiError, likePattern, must, parseRow } from '@/lib/api/http';
import { weightForPieces } from '@/lib/billing-math';
import { PAGE_SIZE } from '@/lib/schemas/common';
import * as inv from '@/lib/schemas/invoices';
import * as m from '@/lib/schemas/masters';

/*
 * Reads, shared by pages and route handlers. Numerics are cast to text: PostgREST would send
 * them as JSON numbers, which JavaScript reads as floating point.
 */
export const CUSTOMER_COLUMNS =
  'id,name,gstin,phone,state_code,is_sez,credit_days,address,opening_balance::text,is_active';
export const STUD_COLUMNS =
  'id,sku_code,diameter_mm::text,length_mm::text,thread_type,material_grade,hsn_sac,gst_rate_percent::text,unit_weight_kg::text,unit_weight_is_manual,default_rate_per_piece::text,default_rate_per_kg::text,is_active';
export const LOT_COLUMNS =
  'id,customer_id,party_dc_no,party_dc_date,material_grade,description,inward_weight_kg::text,outward_weight_kg::text,scrap_weight_kg::text,balance_weight_kg::text,status,close_reason,notes';
export const COMPANY_COLUMNS =
  'legal_name,gstin,address,state_code,phone,email,bank_name,bank_branch,bank_account_no,bank_ifsc';
const INVOICE_LIST_COLUMNS =
  'id,invoice_no,bill_type,invoice_date,due_date,grand_total::text,amount_paid::text,payment_status,cancelled_at,customer_snapshot';
const INVOICE_COLUMNS =
  'id,invoice_no,client_temp_id,bill_type,customer_id,invoice_date,due_date,place_of_supply,is_sez,customer_snapshot,supplier_snapshot,subtotal::text,packing_charge::text,delivery_charge::text,delivery_taxable,cgst::text,sgst::text,igst::text,charges_cgst::text,charges_sgst::text,charges_igst::text,round_off::text,grand_total::text,amount_paid::text,payment_status,notes,cancelled_at,cancellation_reason';
const ITEM_COLUMNS =
  'line_no,description,hsn_sac,qty_pieces,total_weight_kg::text,billing_unit,unit_rate::text,tax_rate_percent::text,line_total::text,cgst_amount::text,sgst_amount::text,igst_amount::text';
export const DELIVERY_COLUMNS =
  'id,dc_no,dc_date,transport_mode,vehicle_no,driver_name,driver_phone,lr_number,freight_paid_by,freight_amount::text,delivery_address,status,dispatched_at,delivered_at';
const RETURN_COLUMNS =
  'line_no,party_dc_no,party_dc_date,material_grade,goods_description,goods_hsn,pieces,returned_weight_kg::text,scrap_weight_kg::text,inward_weight_kg::text,balance_after_kg::text,declared_value::text';
const PAYMENT_COLUMNS = 'id,amount::text,received_on,mode,reference,settles_invoice,voided_at,void_reason';

export interface Page<T> {
  rows: T[];
  page: number;
  hasMore: boolean;
}

/** One extra row tells whether there is a next page, without a COUNT over the table. */
function toPage<T extends z.ZodType>(schema: T, data: unknown, page: number): Page<z.output<T>> {
  const rows = parseRow(z.array(schema), data);
  return { rows: rows.slice(0, PAGE_SIZE), page, hasMore: rows.length > PAGE_SIZE };
}
const from = (page: number): number => (page - 1) * PAGE_SIZE;

export async function listCustomers(db: SupabaseClient, q: string, page: number): Promise<Page<m.Customer>> {
  let request = db.from('customers').select(CUSTOMER_COLUMNS).order('name').order('id').range(from(page), from(page) + PAGE_SIZE);
  if (q) request = request.ilike('name', likePattern(q));
  return toPage(m.customerRow, must(await request), page);
}

export async function listStudItems(db: SupabaseClient, q: string, page: number): Promise<Page<m.StudItem>> {
  let request = db.from('stud_items').select(STUD_COLUMNS).order('sku_code').range(from(page), from(page) + PAGE_SIZE);
  if (q) request = request.ilike('sku_code', likePattern(q));
  return toPage(m.studItemRow, must(await request), page);
}

export async function listLots(
  db: SupabaseClient,
  filter: { customerId?: string | undefined; openOnly?: boolean; q?: string },
  page: number,
): Promise<Page<m.JobWorkLot>> {
  let request = db
    .from('job_work_ledger')
    .select(LOT_COLUMNS)
    .order('party_dc_date', { ascending: false })
    .order('id')
    .range(from(page), from(page) + PAGE_SIZE);
  if (filter.customerId) request = request.eq('customer_id', filter.customerId);
  if (filter.openOnly) request = request.eq('status', 'open');
  if (filter.q) request = request.ilike('party_dc_no', likePattern(filter.q));
  return toPage(m.jobWorkRow, must(await request), page);
}

export async function listInvoices(db: SupabaseClient, q: string, page: number): Promise<Page<inv.InvoiceListItem>> {
  let request = db
    .from('invoices')
    .select(INVOICE_LIST_COLUMNS)
    .order('invoice_date', { ascending: false })
    .order('invoice_seq', { ascending: false })
    .range(from(page), from(page) + PAGE_SIZE);
  if (q) request = request.ilike('invoice_no', likePattern(q));
  return toPage(inv.invoiceListRow, must(await request), page);
}

/** The invoice a queued bill became, if it did. */
export async function findIssued(db: SupabaseClient, tempId: string): Promise<inv.IssuedBill | null> {
  const rows = must(await db.from('invoices').select('id,invoice_no,grand_total::text').eq('client_temp_id', tempId).limit(1));
  const [found] = parseRow(z.array(z.object({ id: z.uuid(), invoice_no: z.string(), grand_total: z.string() })), rows);
  if (found === undefined) return null;
  const challans = must(await db.from('deliveries').select('dc_no').eq('invoice_id', found.id).order('created_at').limit(1));
  const dcNo = parseRow(z.array(z.object({ dc_no: z.string() })), challans)[0]?.dc_no ?? null;
  return { invoice_id: found.id, invoice_no: found.invoice_no, dc_no: dcNo, grand_total: found.grand_total };
}

export interface MasterPage {
  rows: unknown[];
  /** Pass back as `after`; null when the pass is complete. */
  next: string | null;
  as_of: string;
}

type MasterKind = 'customers' | 'stud_items' | 'lots';
const MASTERS: Record<MasterKind, { table: string; columns: string; schema: z.ZodType<{ id: string }>; live: [string, string | boolean] }> = {
  customers: { table: 'customers', columns: CUSTOMER_COLUMNS, schema: m.customerRow, live: ['is_active', true] },
  stud_items: { table: 'stud_items', columns: STUD_COLUMNS, schema: m.studItemRow, live: ['is_active', true] },
  lots: { table: 'job_work_ledger', columns: LOT_COLUMNS, schema: m.jobWorkRow, live: ['status', 'open'] },
};

/**
 * One page for the device's offline copy, walked by id so concurrent edits cannot shift rows
 * between pages. Without `since`: what is live now. With it: everything touched since, so
 * the device also learns what was deactivated or closed.
 */
export async function listMasters(db: SupabaseClient, kind: MasterKind, since: string | null, after: string | null): Promise<MasterPage> {
  const asOf = new Date().toISOString();
  const { table, columns, schema, live } = MASTERS[kind];
  let request = db.from(table).select(columns).order('id').limit(PAGE_SIZE);
  request = since ? request.gte('updated_at', since) : request.eq(live[0], live[1]);
  if (after) request = request.gt('id', after);
  const rows = parseRow(z.array(schema), must(await request));
  return { rows, next: rows.length === PAGE_SIZE ? (rows.at(-1)?.id ?? null) : null, as_of: asOf };
}

export async function getCompany(db: SupabaseClient): Promise<m.Company | null> {
  const { data, error } = await db.from('company_profile').select(COMPANY_COLUMNS).limit(1);
  if (error) throw error;
  const [row] = parseRow(z.array(m.companyRow), data);
  return row ?? null;
}

export async function getInvoice(db: SupabaseClient, invoiceId: string): Promise<inv.InvoiceDocument> {
  const rows = must(await db.from('invoices').select(INVOICE_COLUMNS).eq('id', invoiceId).limit(1));
  const [found] = parseRow(z.array(inv.invoiceRow), rows);
  if (found === undefined) throw new ApiError(404, 'NOT_FOUND', 'Invoice not found');
  const [items, deliveries, returns, payments] = await Promise.all([
    db.from('invoice_items').select(ITEM_COLUMNS).eq('invoice_id', invoiceId).order('line_no'),
    db.from('deliveries').select(DELIVERY_COLUMNS).eq('invoice_id', invoiceId).order('created_at').limit(1),
    db.from('job_work_returns').select(RETURN_COLUMNS).eq('invoice_id', invoiceId).order('line_no'),
    db.from('payments').select(PAYMENT_COLUMNS).eq('invoice_id', invoiceId).order('created_at'),
  ]);
  return {
    invoice: found,
    items: parseRow(z.array(inv.invoiceItemRow), must(items)),
    delivery: parseRow(z.array(inv.deliveryRow), must(deliveries))[0] ?? null,
    returns: parseRow(z.array(inv.returnRow), must(returns)),
    payments: parseRow(z.array(inv.paymentRow), must(payments)),
  };
}

/** The stored row for a validated stud: the formula weight is always computed, never typed. */
export function studRecord(input: z.output<typeof m.studItemInput>): Record<string, unknown> {
  const { manual_unit_weight_kg, ...rest } = input;
  return {
    ...rest,
    unit_weight_kg: manual_unit_weight_kg ?? weightForPieces(input, 1),
    unit_weight_is_manual: manual_unit_weight_kg !== null,
  };
}
