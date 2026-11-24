import { must, route } from '@/lib/api/http';

/** "Can this PC reach the books?": session, network and database, in one cheap read. */
export const GET = route(async ({ supabase }) => {
  must(await supabase.from('company_profile').select('legal_name').limit(1));
  return { ok: true };
});
