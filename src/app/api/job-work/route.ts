import { z } from 'zod';
import { body, must, parseRow, query, route } from '@/lib/api/http';
import { LOT_COLUMNS, listLots } from '@/lib/data';
import { id, listQuery } from '@/lib/schemas/common';
import { jobWorkInput, jobWorkRow } from '@/lib/schemas/masters';

const lotQuery = listQuery.extend({ customer_id: id.optional(), open: z.enum(['true', 'false']).default('false') });

export const GET = route(async ({ request, supabase }) => {
  const { q, page, customer_id, open } = query(request, lotQuery);
  return listLots(supabase, { customerId: customer_id, openOnly: open === 'true', q }, page);
});

export const POST = route(async ({ request, supabase }) => {
  const input = await body(request, jobWorkInput);
  return parseRow(jobWorkRow, must(await supabase.from('job_work_ledger').insert(input).select(LOT_COLUMNS).single()));
});
