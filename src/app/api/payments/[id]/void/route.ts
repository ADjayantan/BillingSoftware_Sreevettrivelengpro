import { z } from 'zod';
import { body, must, parse, parseRow, route } from '@/lib/api/http';
import { booksLater } from '@/lib/month-books';
import { id } from '@/lib/schemas/common';
import { paymentResult, voidInput } from '@/lib/schemas/invoices';

export const POST = route<{ id: string }>(async ({ request, supabase, params }) => {
  const { reason } = await body(request, voidInput);
  const rows = must(await supabase.rpc('void_payment', { p_payment_id: parse(id, params.id), p_reason: reason }));
  booksLater();
  return parseRow(z.array(paymentResult).length(1), rows)[0];
});
