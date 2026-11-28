import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { ApiError, body, must, parse, parseRow, route } from '@/lib/api/http';
import { buildSyncPayload, composeBill } from '@/lib/bill-draft';
import { getInvoice } from '@/lib/data';
import { triggerInvoiceArchiveAsync } from '@/lib/drive-backup';
import { formatInr } from '@/lib/money';
import { booksLater } from '@/lib/month-books';
import { id } from '@/lib/schemas/common';
import { editBillInput, syncResult, type BillDraft } from '@/lib/schemas/invoices';

const ARCHIVE_MS = 30_000;

function filesLater(supabase: SupabaseClient, invoiceId: string): void {
  booksLater({
    first: () =>
      Promise.race([
        triggerInvoiceArchiveAsync(supabase, invoiceId, { replaceExisting: true }),
        new Promise((resolve) => setTimeout(resolve, ARCHIVE_MS).unref()),
      ]),
  });
}

export const GET = route<{ id: string }>(async ({ supabase, params }) => getInvoice(supabase, parse(id, params.id)));

export const PUT = route<{ id: string }>(async ({ request, supabase, params }) => {
  const invoiceId = parse(id, params.id);
  const input = await body(request, editBillInput);
  const doc = await getInvoice(supabase, invoiceId);
  const { invoice, delivery } = doc;

  if (invoice.cancelled_at !== null) {
    throw new ApiError(422, 'INVALID', `Invoice ${invoice.invoice_no} is already cancelled; that cannot be changed`);
  }
  if (input.due_date < invoice.invoice_date) {
    throw new ApiError(400, 'INVALID', 'Due date is before the invoice date');
  }

  const bill = composeBill(
    {
      bill_type: invoice.bill_type,
      lines: input.lines,
      packing: input.packing,
      freight: input.freight,
      freight_paid_by: input.freight_paid_by,
      delivery_taxable: input.delivery_taxable,
      charges_gst_rate: input.charges_gst_rate,
    },
    { state_code: invoice.place_of_supply, is_sez: invoice.is_sez },
  );
  const total = bill.detail.amounts.grand_total_paise;
  if (total !== input.expected_total_paise) {
    throw new ApiError(409, 'TOTAL_CHANGED', `The total is now ${formatInr(total)}. Check the bill and save again.`);
  }

  const fullDraft: BillDraft = {
    client_temp_id: invoice.client_temp_id,
    bill_type: invoice.bill_type,
    customer_id: invoice.customer_id,
    invoice_date: invoice.invoice_date,
    due_date: input.due_date,
    po_no: input.po_no,
    po_date: input.po_date,
    notes: input.notes,
    lines: input.lines,
    packing: input.packing,
    freight: input.freight,
    freight_paid_by: input.freight_paid_by,
    delivery_taxable: input.delivery_taxable,
    charges_gst_rate: input.charges_gst_rate,
    delivery: {
      transport_mode: delivery?.transport_mode ?? 'own_vehicle',
      vehicle_no: delivery?.vehicle_no ?? null,
      driver_name: delivery?.driver_name ?? null,
      driver_phone: delivery?.driver_phone ?? null,
      lr_number: delivery?.lr_number ?? null,
      delivery_address: delivery?.delivery_address ?? null,
      status: delivery?.status ?? 'pending',
    },
    returns: [],
    paid_now: null,
    expected_total_paise: input.expected_total_paise,
  };

  const payload = {
    ...buildSyncPayload(fullDraft, bill),
    edit_invoice_id: invoiceId,
  };
  const rows = must(await supabase.rpc('sync_invoice', { p_payload: payload }));
  const updated = parseRow(z.array(syncResult).length(1), rows)[0];
  if (updated) {
    filesLater(supabase, updated.invoice_id);
  }
  return updated;
});
