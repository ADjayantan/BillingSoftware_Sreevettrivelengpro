import { z } from 'zod';
import { ApiError, body, mustAffect, parse, route } from '@/lib/api/http';
import { QUOTE_COLUMNS, getQuote } from '@/lib/data';
import { id } from '@/lib/schemas/common';
import { quoteRow } from '@/lib/schemas/quotes';

export const GET = route<{ id: string }>(async ({ supabase, params }) => getQuote(supabase, parse(id, params.id)));

const patchInput = z.object({ status: z.literal('cancelled') });

export const PATCH = route<{ id: string }>(async ({ request, supabase, params }) => {
  const quoteId = parse(id, params.id);
  await body(request, patchInput);
  const quote = await getQuote(supabase, quoteId);
  if (quote.status === 'converted') {
    throw new ApiError(409, 'CONFLICT', `Quotation was already converted to bill ${quote.converted_invoice_no ?? ''}`);
  }
  const row = mustAffect(
    await supabase.from('quotes').update({ status: 'cancelled' }).eq('id', quoteId).select(QUOTE_COLUMNS),
  );
  return quoteRow.parse(row);
});
