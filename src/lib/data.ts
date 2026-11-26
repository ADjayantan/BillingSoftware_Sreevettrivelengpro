import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { ApiError, likePattern, must, parseRow } from '@/lib/api/http';
import { weightForPieces } from '@/lib/billing-math';
import { typedProductNo } from '@/lib/products';
import { bookMonthRow, type BookMonthRow } from '@/lib/schemas/books';
import { PAGE_SIZE } from '@/lib/schemas/common';
import * as h from '@/lib/schemas/home';
import * as inv from '@/lib/schemas/invoices';
import * as m from '@/lib/schemas/masters';

/*
 * Reads, shared by pages and route handlers. Numerics are cast to text: PostgREST would send
 * them as JSON numbers, which JavaScript reads as floating point.
 */
export const CUSTOMER_COLUMNS =
  'id,name,gstin,phone,state_code,is_sez,credit_days,address,opening_balance::text,is_active';
export const STUD_COLUMNS =
  'id,product_no,name,sku_code,search_text,diameter_mm::text,length_mm::text,thread_type,material_grade,hsn_sac,gst_rate_percent::text,unit_weight_kg::text,unit_weight_is_manual,default_rate_per_piece::text,default_rate_per_kg::text,is_active';
export const LOT_COLUMNS =
  'id,customer_id,party_dc_no,party_dc_date,material_grade,description,inward_weight_kg::text,outward_weight_kg::text,scrap_weight_kg::text,balance_weight_kg::text,status,close_reason,notes';
export const COMPANY_COLUMNS =
  'legal_name,tagline,gstin,address,factory_address,state_code,phone,office_phone,email,bank_name,bank_branch,bank_account_no,bank_ifsc';
const INVOICE_COLUMNS =
  'id,invoice_no,client_temp_id,bill_type,customer_id,invoice_date,due_date,place_of_supply,is_sez,customer_snapshot,supplier_snapshot,subtotal::text,packing_charge::text,delivery_charge::text,delivery_taxable,cgst::text,sgst::text,igst::text,charges_cgst::text,charges_sgst::text,charges_igst::text,round_off::text,grand_total::text,amount_paid::text,payment_status,po_no,po_date,notes,cancelled_at,cancellation_reason';
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
  if (q) request = request.ilike('search_text', likePattern(q)); // name, phone or GSTIN
  return toPage(m.customerRow, must(await request), page);
}

/** By ID. A typed ID puts that product before everything else that matches. */
export async function listStudItems(db: SupabaseClient, q: string, page: number): Promise<Page<m.StudItem>> {
  const no = typedProductNo(q);
  const asked: unknown[] = no === null ? [] : must(await db.from('stud_items').select(STUD_COLUMNS).eq('product_no', no));
  // It takes the first place of page 1, so everyone else moves down by one.
  const shift = asked.length;
  let request = db.from('stud_items').select(STUD_COLUMNS).order('product_no').range(Math.max(0, from(page) - shift), from(page) + PAGE_SIZE - shift);
  if (q) request = request.ilike('search_text', likePattern(q));
  if (no !== null) request = request.neq('product_no', no);
  const others: unknown[] = must(await request);
  return toPage(m.studItemRow, page === 1 ? [...asked, ...others] : others, page);
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

const monthArg = (month: string | undefined): string | null => (month ? `${month}-01` : null);

/** Bills by number, customer or P.O.; the counts of every tab with them. `today` decides what is late. */
export async function findBills(db: SupabaseClient, ask: Partial<h.BillsQuery>, today: string, take = PAGE_SIZE): Promise<h.BillsFound & { page: number; hasMore: boolean }> {
  const { q = '', show = 'all', page = 1 } = ask;
  const skip = (page - 1) * take;
  const found = parseRow(h.billsFound, must(await db.rpc('find_bills', {
    p_q: q, p_show: show, p_month: monthArg(ask.month), p_customer: ask.customer || null, p_today: today, p_skip: skip, p_take: take,
  })));
  return { ...found, page, hasMore: skip + found.rows.length < found.counts[show] };
}

export const homeFigures = async (db: SupabaseClient, today: string): Promise<h.HomeFigures> =>
  parseRow(h.homeFigures, must(await db.rpc('home_figures', { p_today: today })));

export async function findReceipts(db: SupabaseClient, ask: Partial<Pick<h.BillsQuery, 'q' | 'month' | 'page'>>): Promise<h.ReceiptsFound & { page: number; hasMore: boolean }> {
  const page = ask.page ?? 1;
  // One more than a page shows: the count leaves the voided ones out, so it cannot tell.
  const found = parseRow(h.receiptsFound, must(await db.rpc('receipts_found', { p_q: ask.q ?? '', p_month: monthArg(ask.month), p_skip: (page - 1) * PAGE_SIZE, p_take: PAGE_SIZE + 1 })));
  return { ...found, rows: found.rows.slice(0, PAGE_SIZE), page, hasMore: found.rows.length > PAGE_SIZE };
}

/** Every customer with what it owes, by name or who owes most first. `today` decides what is late. */
export async function customerBalances(db: SupabaseClient, ask: Partial<h.CustomersQuery>, today: string, take = PAGE_SIZE): Promise<h.CustomerBalances & { page: number; hasMore: boolean }> {
  const { q = '', sort = 'name', page = 1 } = ask;
  const skip = (page - 1) * take;
  const found = parseRow(h.customerBalances, must(await db.rpc('customer_balances', { p_q: q, p_sort: sort, p_today: today, p_skip: skip, p_take: take })));
  return { ...found, page, hasMore: skip + found.rows.length < found.customers };
}

/** Challans of standing bills whose goods did not arrive yet, oldest first. */
export const goodsToSend = async (db: SupabaseClient): Promise<h.GoodsRow[]> => parseRow(z.array(h.goodsRow), must(await db.rpc('goods_to_send')));

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

/** The latest rate of every grade. (The view has no id.) */
export const latestRates = async (db: SupabaseClient): Promise<h.MetalRate[]> =>
  parseRow(z.array(h.metalRate), must(
    await db.from('latest_metal_rates').select('material_grade,rate_per_kg::text,previous_rate_per_kg::text,change_delta::text,recorded_at').order('material_grade'),
  ));

export const alertRules = async (db: SupabaseClient): Promise<h.AlertRule[]> =>
  parseRow(z.array(h.alertRule), must(await db.from('alert_rules').select('material_grade,threshold_rs_per_kg::text,is_active').order('material_grade')));

/** The months of the Excel books, newest first. The database refuses everybody but the owner. */
export const bookMonths = async (db: SupabaseClient): Promise<BookMonthRow[]> => parseRow(z.array(bookMonthRow), must(await db.rpc('book_months')));

/** The stored row for a validated product: a stud's formula weight is always computed, never typed. */
export function studRecord(input: z.output<typeof m.studItemInput>): Record<string, unknown> {
  const { manual_unit_weight_kg, ...rest } = input;
  return {
    ...rest,
    unit_weight_kg: manual_unit_weight_kg ?? (input.diameter_mm === null ? null : weightForPieces(input, 1)),
    unit_weight_is_manual: manual_unit_weight_kg !== null,
  };
}
