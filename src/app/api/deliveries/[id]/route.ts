import { z } from 'zod';
import { body, mustAffect, parse, parseRow, route } from '@/lib/api/http';
import { DELIVERY_COLUMNS } from '@/lib/data';
import { id } from '@/lib/schemas/common';
import { deliveryRow, deliveryUpdate } from '@/lib/schemas/invoices';

export const PATCH = route<{ id: string }>(async ({ request, supabase, params }) => {
  const sent = await body(request, z.record(z.string(), z.unknown()));
  // Only the keys that were sent: the schema's defaults must not overwrite the rest.
  const change = Object.fromEntries(Object.entries(parse(deliveryUpdate, sent)).filter(([key]) => key in sent));
  return parseRow(
    deliveryRow,
    mustAffect(await supabase.from('deliveries').update(change).eq('id', parse(id, params.id)).select(DELIVERY_COLUMNS)),
  );
});
