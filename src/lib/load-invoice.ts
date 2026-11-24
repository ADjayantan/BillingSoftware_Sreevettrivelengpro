import 'server-only';
import { cache } from 'react';
import { notFound } from 'next/navigation';
import { ApiError } from '@/lib/api/http';
import { getInvoice } from '@/lib/data';
import { outstandingPaise } from '@/lib/billing-math';
import { istDate } from '@/lib/india';
import { decimalToPaise } from '@/lib/money';
import { id as idSchema } from '@/lib/schemas/common';
import type { InvoiceDocument } from '@/lib/schemas/invoices';
import { createClient } from '@/lib/supabase/server';
import { whatsappDrafts, type WhatsappDraft } from '@/lib/whatsapp';

/** One read per request, shared by a page and its metadata. */
const readInvoice = cache(async (invoiceId: string): Promise<InvoiceDocument | null> => {
  try {
    return await getInvoice(await createClient(), invoiceId);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
});

/** For pages: a bad or unknown id is a 404 page. */
export async function loadInvoice(params: Promise<{ id: string }>): Promise<InvoiceDocument> {
  const parsed = idSchema.safeParse((await params).id);
  return (parsed.success ? await readInvoice(parsed.data) : null) ?? notFound();
}

/** Ready-to-send WhatsApp drafts; none once the bill is settled or cancelled. */
export function invoiceMessages({ invoice }: InvoiceDocument): WhatsappDraft[] {
  if (invoice.cancelled_at || invoice.payment_status === 'paid') return [];
  return whatsappDrafts(invoice.customer_snapshot.phone, istDate(new Date()), {
    recipientName: invoice.customer_snapshot.name,
    companyName: invoice.supplier_snapshot.legal_name,
    invoiceNo: invoice.invoice_no,
    invoiceDate: invoice.invoice_date,
    dueDate: invoice.due_date,
    balancePaise: outstandingPaise(decimalToPaise(invoice.grand_total), decimalToPaise(invoice.amount_paid)),
  });
}
