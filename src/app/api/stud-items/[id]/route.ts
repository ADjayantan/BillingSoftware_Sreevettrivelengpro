import { body, must, mustAffect, parse, parseRow, route } from '@/lib/api/http';
import { STUD_COLUMNS, studRecord } from '@/lib/data';
import { id } from '@/lib/schemas/common';
import { studItemInput, studItemRow } from '@/lib/schemas/masters';

export const GET = route<{ id: string }>(async ({ supabase, params }) =>
  parseRow(studItemRow, must(await supabase.from('stud_items').select(STUD_COLUMNS).eq('id', parse(id, params.id)).single())),
);

export const PUT = route<{ id: string }>(async ({ request, supabase, params }) => {
  const record = studRecord(await body(request, studItemInput));
  return parseRow(studItemRow, mustAffect(await supabase.from('stud_items').update(record).eq('id', parse(id, params.id)).select(STUD_COLUMNS)));
});

export const DELETE = route<{ id: string }>(async ({ supabase, params }) => {
  mustAffect(await supabase.from('stud_items').delete().eq('id', parse(id, params.id)).select('id'));
  return { deleted: true };
});
