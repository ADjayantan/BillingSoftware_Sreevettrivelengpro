import { body, must, mustAffect, parse, parseRow, route } from '@/lib/api/http';
import { CUSTOMER_COLUMNS } from '@/lib/data';
import { id } from '@/lib/schemas/common';
import { customerInput, customerRow } from '@/lib/schemas/masters';

export const GET = route<{ id: string }>(async ({ supabase, params }) =>
  parseRow(customerRow, must(await supabase.from('customers').select(CUSTOMER_COLUMNS).eq('id', parse(id, params.id)).single())),
);

export const PUT = route<{ id: string }>(async ({ request, supabase, params }) => {
  const input = await body(request, customerInput);
  return parseRow(customerRow, mustAffect(await supabase.from('customers').update(input).eq('id', parse(id, params.id)).select(CUSTOMER_COLUMNS)));
});

export const DELETE = route<{ id: string }>(async ({ supabase, params }) => {
  mustAffect(await supabase.from('customers').delete().eq('id', parse(id, params.id)).select('id'));
  return { deleted: true };
});
