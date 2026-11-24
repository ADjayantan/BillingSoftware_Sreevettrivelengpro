import { body, must, mustAffect, parse, parseRow, route } from '@/lib/api/http';
import { LOT_COLUMNS } from '@/lib/data';
import { id } from '@/lib/schemas/common';
import { jobWorkInput, jobWorkRow } from '@/lib/schemas/masters';

export const GET = route<{ id: string }>(async ({ supabase, params }) =>
  parseRow(jobWorkRow, must(await supabase.from('job_work_ledger').select(LOT_COLUMNS).eq('id', parse(id, params.id)).single())),
);

export const PUT = route<{ id: string }>(async ({ request, supabase, params }) => {
  const input = await body(request, jobWorkInput);
  return parseRow(jobWorkRow, mustAffect(await supabase.from('job_work_ledger').update(input).eq('id', parse(id, params.id)).select(LOT_COLUMNS)));
});

export const DELETE = route<{ id: string }>(async ({ supabase, params }) => {
  mustAffect(await supabase.from('job_work_ledger').delete().eq('id', parse(id, params.id)).select('id'));
  return { deleted: true };
});
