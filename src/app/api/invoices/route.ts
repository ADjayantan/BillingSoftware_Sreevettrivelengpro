import { query, route } from '@/lib/api/http';
import { findBills } from '@/lib/data';
import { istDate } from '@/lib/india';
import { billsQuery } from '@/lib/schemas/home';

export const GET = route(async ({ request, supabase }) => findBills(supabase, query(request, billsQuery), istDate(new Date())));
