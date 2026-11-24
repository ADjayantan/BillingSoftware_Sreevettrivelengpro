import { z } from 'zod';
import { ApiError, body, must, parseRow, route } from '@/lib/api/http';
import { buildSyncPayload, composeBill } from '@/lib/bill-draft';
import { formatInr } from '@/lib/money';
import { billDraft, syncResult } from '@/lib/schemas/invoices';

const taxFacts = z.object({ state_code: z.string(), is_sez: z.boolean() });

/** Amounts are recomputed here from the draft; sync_invoice verifies them again in the DB. */
export const POST = route(async ({ request, supabase }) => {
  const draft = await body(request, billDraft);
  const customer = parseRow(
    taxFacts,
    must(await supabase.from('customers').select('state_code,is_sez').eq('id', draft.customer_id).single()),
  );
  const bill = composeBill(draft, customer);
  const total = bill.detail.amounts.grand_total_paise;
  if (total !== draft.expected_total_paise) {
    throw new ApiError(409, 'TOTAL_CHANGED', `The total is now ${formatInr(total)}. Check the bill and save again.`);
  }
  const rows = must(await supabase.rpc('sync_invoice', { p_payload: buildSyncPayload(draft, bill) }));
  return parseRow(z.array(syncResult).length(1), rows)[0];
});
