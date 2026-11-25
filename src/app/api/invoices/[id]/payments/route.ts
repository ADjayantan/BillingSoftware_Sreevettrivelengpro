import { z } from 'zod';
import { body, must, parse, parseRow, route } from '@/lib/api/http';
import { booksLater } from '@/lib/month-books';
import { id } from '@/lib/schemas/common';
import { paymentInput, paymentResult } from '@/lib/schemas/invoices';

export const POST = route<{ id: string }>(async ({ request, supabase, params }) => {
  const input = await body(request, paymentInput);
  const p_payload = { ...input, invoice_id: parse(id, params.id) };
  const rows = must(await supabase.rpc('record_payment', { p_payload }));
  booksLater();
  return parseRow(z.array(paymentResult).length(1), rows)[0];
});
