import { body, mustAffect, parse, route } from '@/lib/api/http';
import { id } from '@/lib/schemas/common';
import { cancelInput } from '@/lib/schemas/invoices';

/** One-way. The guard trigger dates it, and refuses while receipts are attached. */
export const POST = route<{ id: string }>(async ({ request, supabase, params }) => {
  const { reason } = await body(request, cancelInput);
  mustAffect(
    await supabase
      .from('invoices')
      .update({ cancelled_at: new Date().toISOString(), cancellation_reason: reason })
      .eq('id', parse(id, params.id))
      .select('id'),
  );
  return { cancelled: true };
});
