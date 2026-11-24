import { z } from 'zod';
import { query, route } from '@/lib/api/http';
import { listMasters } from '@/lib/data';
import { id } from '@/lib/schemas/common';

const cacheQuery = z.object({
  kind: z.enum(['customers', 'stud_items', 'lots']),
  since: z.iso.datetime().optional(),
  after: id.optional(),
});

/** Feeds the device's small copy of the masters, a page at a time. RLS applies as everywhere. */
export const GET = route(async ({ request, supabase }) => {
  const { kind, since, after } = query(request, cacheQuery);
  return listMasters(supabase, kind, since ?? null, after ?? null);
});
