import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { must, parseRow } from '@/lib/api/http';
import type { MonthData } from '@/lib/month-workbook';
import { PAGE_ROWS, readAllRows } from '@/lib/read-all';
import * as b from '@/lib/schemas/books';

/* Everything one month's book is made of: issued snapshots and posted records, nothing else. */

const INVOICE =
  'id,invoice_no,invoice_seq,bill_type,invoice_date,due_date,place_of_supply,is_sez,customer_snapshot,subtotal::text,packing_charge::text,delivery_charge::text,cgst::text,sgst::text,igst::text,round_off::text,grand_total::text,amount_paid::text,payment_status,po_no,po_date,notes,cancelled_at,cancellation_reason';
const ITEM =
  'id,invoice_id,line_no,stud_item_id,description,hsn_sac,material_grade,size_text,qty_pieces,total_weight_kg::text,billing_unit,unit_rate::text,tax_rate_percent::text,line_total::text,cgst_amount::text,sgst_amount::text,igst_amount::text';
const DELIVERY =
  'id,invoice_id,dc_no,dc_seq,dc_date,transport_mode,vehicle_no,driver_name,driver_phone,lr_number,freight_paid_by,freight_amount::text,delivery_address,status,dispatched_at,delivered_at';
const RETURN =
  'id,invoice_id,delivery_id,line_no,party_dc_no,party_dc_date,material_grade,goods_description,goods_hsn,pieces,returned_weight_kg::text,scrap_weight_kg::text,balance_after_kg::text,declared_value::text,reversed_at';
const PAYMENT = 'id,invoice_id,amount::text,received_on,mode,reference,settles_invoice,voided_at,void_reason,created_at';

const page = (db: SupabaseClient, table: string, columns: string) => db.from(table).select(columns).order('id').limit(PAGE_ROWS);
type Page = ReturnType<typeof page>;

async function read<S extends z.ZodType>(db: SupabaseClient, table: string, columns: string, schema: S, narrow: (query: Page) => Page): Promise<z.output<S>[]> {
  const rows = await readAllRows<{ id: string }>((after) => {
    const query = narrow(page(db, table, columns));
    return (after === null ? query : query.gt('id', after)).overrideTypes<{ id: string }[], { merge: false }>();
  });
  return parseRow(z.array(schema), rows);
}

/** As many ids as fit comfortably into one address. */
const IDS = 100;

async function readFor<S extends z.ZodType>(db: SupabaseClient, table: string, columns: string, schema: S, column: string, ids: readonly string[]): Promise<z.output<S>[]> {
  const found: z.output<S>[] = [];
  const all = [...new Set(ids)];
  for (let i = 0; i < all.length; i += IDS) found.push(...(await read(db, table, columns, schema, (query) => query.in(column, all.slice(i, i + IDS)))));
  return found;
}

/** The last day of the month that starts on `month` (YYYY-MM-01). */
function lastDay(month: string): string {
  const next = new Date(`${month}T00:00:00Z`);
  next.setUTCMonth(next.getUTCMonth() + 1, 0);
  return next.toISOString().slice(0, 10);
}

/**
 * Parents before children: what a bill is made of is written with it and never changes, so
 * every bill that was seen has all its lines. What changes later marks the month again.
 */
export async function readMonth(db: SupabaseClient, month: string): Promise<MonthData> {
  const last = lastDay(month);
  const during = (column: string) => (query: Page): Page => query.gte(column, month).lte(column, last);
  const invoices = await read(db, 'invoices', INVOICE, b.bookInvoice, during('invoice_date'));
  const ids = invoices.map((invoice) => invoice.id);
  const [items, own, sentNow, payments, company] = [
    await readFor(db, 'invoice_items', ITEM, b.bookItem, 'invoice_id', ids),
    await readFor(db, 'deliveries', DELIVERY, b.bookDelivery, 'invoice_id', ids),
    await read(db, 'deliveries', DELIVERY, b.bookDelivery, during('dc_date')),
    await read(db, 'payments', PAYMENT, b.bookPayment, during('received_on')),
    must(await db.from('company_profile').select('legal_name').limit(1)),
  ];
  const returns = await readFor(db, 'job_work_returns', RETURN, b.bookReturn, 'delivery_id', sentNow.map((delivery) => delivery.id));
  // Bills of other months, for the receipts and challans of this one.
  const known = new Set(ids);
  const others = [...sentNow, ...payments].map((row) => row.invoice_id).filter((id) => !known.has(id));
  const elsewhere = await readFor(db, 'invoices', INVOICE, b.bookInvoice, 'id', others);
  return {
    month, company: parseRow(z.array(z.object({ legal_name: z.string() })), company)[0]?.legal_name ?? null,
    invoices, elsewhere, items, deliveries: own, sentNow, returns, payments,
  };
}
