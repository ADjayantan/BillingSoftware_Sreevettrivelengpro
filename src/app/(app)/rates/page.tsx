import { createClient } from '@/lib/supabase/server';
import { RatesView, type AlertRuleItem, type MetalRateItem } from './view';

export default async function RatesPage() {
  const supabase = await createClient();
  const [ratesRes, rulesRes] = await Promise.all([
    supabase
      .from('latest_metal_rates')
      .select('id, material_grade, rate_per_kg, previous_rate_per_kg, change_delta, source, recorded_at')
      .order('material_grade'),
    supabase
      .from('alert_rules')
      .select('id, material_grade, threshold_rs_per_kg, telegram_chat_id, is_active')
      .order('material_grade'),
  ]);

  return (
    <RatesView
      initialRates={(ratesRes.data ?? []) as MetalRateItem[]}
      initialRules={(rulesRes.data ?? []) as AlertRuleItem[]}
    />
  );
}
