import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { processDealerMetalRateMessage } from '@/app/api/cron/metal-rates/route';
import { body, must, route } from '@/lib/api/http';

const PasteDealerMessageSchema = z.object({
  raw_message: z.string().trim().min(1, 'Paste the dealer rate message').max(4000),
  source_channel: z.enum(['whatsapp', 'telegram', 'manual']).default('manual'),
  source_conversation_id: z.string().trim().min(1).max(60).default('owner-dashboard'),
  source_message_id: z.string().trim().min(1).max(60).optional(),
});

export const GET = route(async ({ supabase }) => {
  const ratesRes = await supabase
    .from('latest_metal_rates')
    .select('id, material_grade, rate_per_kg, previous_rate_per_kg, change_delta, source, recorded_at')
    .order('material_grade');
  const rulesRes = await supabase
    .from('alert_rules')
    .select('id, material_grade, threshold_rs_per_kg, telegram_chat_id, is_active')
    .order('material_grade');

  return {
    rates: must(ratesRes),
    rules: must(rulesRes),
  };
});

export const POST = route(async ({ request, supabase }) => {
  const input = await body(request, PasteDealerMessageSchema);
  return processDealerMetalRateMessage({
    input: {
      source_channel: input.source_channel,
      source_conversation_id: input.source_conversation_id,
      source_message_id: input.source_message_id ?? randomUUID().slice(0, 12),
      raw_message: input.raw_message,
    },
    db: supabase,
  });
});
