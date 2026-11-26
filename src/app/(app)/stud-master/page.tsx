import { PageHead } from '@/components/page-head';
import { Pager, SearchBox } from '@/components/pager';
import { listStudItems } from '@/lib/data';
import { pageQuery } from '@/lib/page-query';
import { createClient } from '@/lib/supabase/server';
import { ProductsView } from './view';

/** The product list. The address keeps its old name: PCs and bookmarks know it. */
export default async function ProductsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { q, page } = await pageQuery(searchParams);
  const openNew = 'new' in (await searchParams);
  const { rows, hasMore } = await listStudItems(await createClient(), q, page);
  return (
    <>
      <PageHead title="Products" note="Everything you sell, with its ID, GST and rate." />
      <ProductsView key={openNew ? 'new' : 'list'} openNew={openNew} rows={rows} pager={<Pager path="/stud-master" page={page} hasMore={hasMore} params={{ q }} />} search={<SearchBox path="/stud-master" q={q} label="Find by ID, name, code or size" />} />
    </>
  );
}
