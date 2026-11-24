import { body, must, parseRow, query, route } from '@/lib/api/http';
import { STUD_COLUMNS, listStudItems, studRecord } from '@/lib/data';
import { listQuery } from '@/lib/schemas/common';
import { studItemInput, studItemRow } from '@/lib/schemas/masters';

export const GET = route(async ({ request, supabase }) => {
  const { q, page } = query(request, listQuery);
  return listStudItems(supabase, q, page);
});

export const POST = route(async ({ request, supabase }) => {
  const record = studRecord(await body(request, studItemInput));
  return parseRow(studItemRow, must(await supabase.from('stud_items').insert(record).select(STUD_COLUMNS).single()));
});
