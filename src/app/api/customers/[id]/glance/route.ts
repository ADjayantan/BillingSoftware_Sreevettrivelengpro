import { z } from 'zod';
import { parse, query, route } from '@/lib/api/http';
import { customerGlance } from '@/lib/customer-glance';
import { istDate } from '@/lib/india';
import { id } from '@/lib/schemas/common';

const kind = z.object({ type: z.enum(['supply', 'job_work']).default('supply') });

export const GET = route<{ id: string }>(async ({ request, supabase, params }) =>
  customerGlance(supabase, parse(id, params.id), query(request, kind).type, istDate(new Date())),
);
