import { z } from 'zod';
import { body, mustAffect, parse, route } from '@/lib/api/http';
import { EXPENSE_COLUMNS } from '@/lib/data';
import { id } from '@/lib/schemas/common';
import { EXPENSE_PAYMENT_MODES, expenseRow } from '@/lib/schemas/expenses';

const patchSchema = z.object({
  payment_status: z.enum(['paid', 'unpaid']),
  payment_mode: z.enum(EXPENSE_PAYMENT_MODES).optional(),
});

export const PATCH = route<{ id: string }>(async ({ request, supabase, params }) => {
  const expenseId = parse(id, params.id);
  const input = await body(request, patchSchema);
  const row = mustAffect(
    await supabase
      .from('expenses')
      .update({
        payment_status: input.payment_status,
        ...(input.payment_mode ? { payment_mode: input.payment_mode } : {}),
      })
      .eq('id', expenseId)
      .select(EXPENSE_COLUMNS),
  );
  return expenseRow.parse(row);
});

export const DELETE = route<{ id: string }>(async ({ supabase, params }) => {
  const expenseId = parse(id, params.id);
  const row = mustAffect(await supabase.from('expenses').delete().eq('id', expenseId).select(EXPENSE_COLUMNS));
  return expenseRow.parse(row);
});
