import { Pager, SearchBox } from '@/components/pager';
import { listCustomers } from '@/lib/data';
import { pageQuery } from '@/lib/page-query';
import { createClient } from '@/lib/supabase/server';
import { CustomersView } from './view';

export default async function CustomersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { q, page } = await pageQuery(searchParams);
  const { rows, hasMore } = await listCustomers(await createClient(), q, page);
  return (
    <>
      <h1 className="mb-3 text-2xl font-bold">Customers</h1>
      <CustomersView rows={rows} search={<SearchBox path="/customers" q={q} label="Find by name" />} />
      <Pager path="/customers" q={q} page={page} hasMore={hasMore} />
    </>
  );
}
