import { PageHead } from '@/components/page-head';
import { listExpenses, listSuppliers } from '@/lib/data';
import { istDate } from '@/lib/india';
import { createClient } from '@/lib/supabase/server';
import { ExpensesScreen } from './screen';

export const dynamic = 'force-dynamic';

export default async function ExpensesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const db = await createClient();
  const today = istDate(new Date());
  const [expenses, suppliers, params] = await Promise.all([
    listExpenses(db),
    listSuppliers(db),
    searchParams,
  ]);
  const openNew = 'new' in params;

  return (
    <>
      <PageHead
        title="Expenses & Suppliers"
        note="Track raw material steel rod purchases, input GST, tooling, electricity, wages and supplier bills."
      />
      <ExpensesScreen
        initialExpenses={expenses}
        initialSuppliers={suppliers}
        today={today}
        startOpen={openNew}
      />
    </>
  );
}
