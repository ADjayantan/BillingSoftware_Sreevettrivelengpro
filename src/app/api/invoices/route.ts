import { query, route } from '@/lib/api/http';
import { listInvoices } from '@/lib/data';
import { listQuery } from '@/lib/schemas/common';

export const GET = route(async ({ request, supabase }) => {
  const { q, page } = query(request, listQuery);
  return listInvoices(supabase, q, page);
});
