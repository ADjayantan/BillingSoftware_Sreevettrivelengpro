import { body, must, mustAffect, parseRow, route } from '@/lib/api/http';
import { COMPANY_COLUMNS, getCompany } from '@/lib/data';
import { companyInput, companyRow } from '@/lib/schemas/masters';

export const GET = route(async ({ supabase }) => getCompany(supabase));

export const PUT = route(async ({ request, supabase }) => {
  const input = await body(request, companyInput);
  if ((await getCompany(supabase)) === null) {
    return parseRow(companyRow, must(await supabase.from('company_profile').insert(input).select(COMPANY_COLUMNS).single()));
  }
  return parseRow(companyRow, mustAffect(await supabase.from('company_profile').update(input).eq('singleton', true).select(COMPANY_COLUMNS)));
});
