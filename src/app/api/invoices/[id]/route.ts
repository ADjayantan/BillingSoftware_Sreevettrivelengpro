import { parse, route } from '@/lib/api/http';
import { getInvoice } from '@/lib/data';
import { id } from '@/lib/schemas/common';

export const GET = route<{ id: string }>(async ({ supabase, params }) => getInvoice(supabase, parse(id, params.id)));
