import { body, must, parseRow, query, route } from '@/lib/api/http';
import { CUSTOMER_COLUMNS, listCustomers } from '@/lib/data';
import { listQuery } from '@/lib/schemas/common';
import { customerInput, customerRow } from '@/lib/schemas/masters';

export const GET = route(async ({ request, supabase }) => {
  const { q, page } = query(request, listQuery);
  return listCustomers(supabase, q, page);
});

export const POST = route(async ({ request, supabase }) => {
  const input = await body(request, customerInput);
  return parseRow(customerRow, must(await supabase.from('customers').insert(input).select(CUSTOMER_COLUMNS).single()));
});
