import { PageHead } from '@/components/page-head';
import { alertRules, latestRates } from '@/lib/data';
import { createClient } from '@/lib/supabase/server';
import { RatesView } from './view';

export default async function RatesPage() {
  const db = await createClient();
  const [rates, rules] = await Promise.all([latestRates(db), alertRules(db)]);
  return (
    <>
      <PageHead title="Metal rates" note="Rod rates from your dealer. New bill warns when a rate looks too low." />
      <RatesView initialRates={rates} rules={rules} />
    </>
  );
}
