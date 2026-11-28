import { PageHead } from '@/components/page-head';
import { getCompany, listQuotes } from '@/lib/data';
import { addDays, istDate } from '@/lib/india';
import { createClient } from '@/lib/supabase/server';
import { QuotesScreen } from './screen';

export const dynamic = 'force-dynamic';

export default async function QuotesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const db = await createClient();
  const today = istDate(new Date());
  const [quotes, company, params] = await Promise.all([listQuotes(db), getCompany(db), searchParams]);
  const openNew = 'new' in params;

  return (
    <>
      <PageHead
        title="Quotations"
        note="Send a price quote to a customer first, then turn it into a tax invoice and delivery challan in one click."
      />
      <QuotesScreen
        initialQuotes={quotes}
        today={today}
        defaultValidUntil={addDays(today, 15)}
        companyName={company?.legal_name ?? 'StudFlow'}
        startOpen={openNew}
      />
    </>
  );
}
