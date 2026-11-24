import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { ApiError, body, must, parse, parseRow, route, toApiError } from '@/lib/api/http';
import { buildSyncPayload, composeBill } from '@/lib/bill-draft';
import { findIssued } from '@/lib/data';
import { triggerInvoiceArchiveAsync } from '@/lib/drive-backup';
import { formatInr } from '@/lib/money';
import { billDraft, clientTempId, syncResult } from '@/lib/schemas/invoices';

const taxFacts = z.object({ state_code: z.string(), is_sez: z.boolean() });

async function issue(supabase: SupabaseClient, raw: unknown): Promise<z.output<typeof syncResult> | undefined> {
  const draft = parse(billDraft, raw);
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
  const issued = parseRow(z.array(syncResult).length(1), rows)[0];
  if (issued && !issued.replayed) {
    void triggerInvoiceArchiveAsync(supabase, issued.invoice_id);
  }
  return issued;
}

/**
 * Amounts are recomputed here from the draft; sync_invoice verifies them again in the DB.
 *
 * A queued bill may have been issued already, its reply lost with the connection. An exact
 * resend replays. But if anything changed since (the customer's state, our own code), the
 * resend fails for some other reason, and "fix it and save again" would bill it twice. So a
 * refusal is only passed on once we know this bill has no invoice yet.
 */
export const POST = route(async ({ request, supabase }) => {
  const raw = await body(request, z.unknown());
  try {
    return await issue(supabase, raw);
  } catch (error) {
    // A failure on our side (the database did not answer) proves nothing: the device resends the
    // same bill, and gets its number.
    if (toApiError(error).status >= 500) throw error;
    const known = z.object({ client_temp_id: clientTempId }).safeParse(raw);
    const issued = known.success ? await findIssued(supabase, known.data.client_temp_id) : null;
    if (issued === null) throw error;
    throw new ApiError(409, 'ALREADY_ISSUED', `This bill was already issued as ${issued.invoice_no}`, { issued });
  }
});
