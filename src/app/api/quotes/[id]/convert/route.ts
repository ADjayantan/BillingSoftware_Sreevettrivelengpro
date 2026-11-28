import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { ApiError, must, parse, parseRow, route } from '@/lib/api/http';
import { buildSyncPayload, composeBill } from '@/lib/bill-draft';
import { CUSTOMER_COLUMNS, getQuote } from '@/lib/data';
import { triggerInvoiceArchiveAsync } from '@/lib/drive-backup';
import { addDays, istDate } from '@/lib/india';
import { decimalToPaise } from '@/lib/money';
import { booksLater } from '@/lib/month-books';
import { id } from '@/lib/schemas/common';
import { syncResult, type BillDraft } from '@/lib/schemas/invoices';
import { customerRow } from '@/lib/schemas/masters';
import { quoteCode } from '@/lib/schemas/quotes';

const ARCHIVE_MS = 30_000;

function filesLater(supabase: SupabaseClient, invoiceId: string): void {
  booksLater({
    first: () =>
      Promise.race([
        triggerInvoiceArchiveAsync(supabase, invoiceId),
        new Promise((resolve) => setTimeout(resolve, ARCHIVE_MS).unref()),
      ]),
  });
}

/**
 * 1-Click Quotation -> Tax Invoice & Delivery Challan conversion.
 * Idempotent on `client_temp_id = 'OFFLINE-' + quote.id`: clicking twice never issues a duplicate bill.
 */
export const POST = route<{ id: string }>(async ({ supabase, params }) => {
  const quoteId = parse(id, params.id);
  const quote = await getQuote(supabase, quoteId);

  if (quote.status === 'cancelled') {
    throw new ApiError(422, 'INVALID', `Quotation ${quoteCode(quote.quote_no)} is cancelled and cannot be converted`);
  }
  if (quote.status === 'converted' && quote.converted_invoice_id && quote.converted_invoice_no) {
    return {
      invoice_id: quote.converted_invoice_id,
      invoice_no: quote.converted_invoice_no,
      dc_no: null,
      replayed: true,
    };
  }

  const custRows = must(await supabase.from('customers').select(CUSTOMER_COLUMNS).eq('id', quote.customer_id).limit(1));
  const [customer] = parseRow(z.array(customerRow), custRows);
  if (!customer) throw new ApiError(404, 'NOT_FOUND', 'Customer not found');

  const today = istDate(new Date());
  const oldestAllowed = addDays(today, -30);
  const invoiceDate = quote.quote_date >= oldestAllowed && quote.quote_date <= today ? quote.quote_date : today;
  const dueDate = addDays(invoiceDate, customer.credit_days);

  const draft: BillDraft = {
    client_temp_id: `OFFLINE-${quote.id}`,
    bill_type: quote.bill_type,
    customer_id: quote.customer_id,
    invoice_date: invoiceDate,
    due_date: dueDate,
    po_no: null,
    po_date: null,
    notes: quote.notes ? `${quote.notes} (From ${quoteCode(quote.quote_no)})` : `From quotation ${quoteCode(quote.quote_no)}`,
    lines: quote.lines,
    packing: quote.packing_charge,
    freight: quote.delivery_charge,
    freight_paid_by: quote.freight_paid_by,
    delivery_taxable: quote.delivery_taxable,
    charges_gst_rate: quote.charges_gst_rate,
    delivery: {
      transport_mode: 'own_vehicle',
      vehicle_no: null,
      driver_name: null,
      driver_phone: null,
      lr_number: null,
      delivery_address: customer.address,
      status: 'pending',
    },
    returns: [],
    paid_now: null,
    expected_total_paise: decimalToPaise(quote.grand_total),
  };

  const bill = composeBill(draft, { state_code: customer.state_code, is_sez: customer.is_sez });
  const payload = buildSyncPayload(draft, bill);
  const rows = must(await supabase.rpc('sync_invoice', { p_payload: payload }));
  const issued = parseRow(z.array(syncResult).length(1), rows)[0]!;

  must(
    await supabase
      .from('quotes')
      .update({
        status: 'converted',
        converted_invoice_id: issued.invoice_id,
        converted_invoice_no: issued.invoice_no,
      })
      .eq('id', quoteId),
  );

  filesLater(supabase, issued.invoice_id);
  return issued;
});
