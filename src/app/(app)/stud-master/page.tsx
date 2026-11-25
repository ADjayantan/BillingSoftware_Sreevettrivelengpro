import { Pager, SearchBox } from '@/components/pager';
import { listStudItems } from '@/lib/data';
import { pageQuery } from '@/lib/page-query';
import { createClient } from '@/lib/supabase/server';
import { ProductsView } from './view';

/** The product list. The address keeps its old name: PCs and bookmarks know it. */
export default async function ProductsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { q, page } = await pageQuery(searchParams);
  const { rows, hasMore } = await listStudItems(await createClient(), q, page);
  return (
    <>
      <h1 className="mb-3 text-2xl font-bold">Products</h1>
      <ProductsView rows={rows} search={<SearchBox path="/stud-master" q={q} label="Find by ID, name, code or size" />} />
      <Pager path="/stud-master" q={q} page={page} hasMore={hasMore} />
    </>
  );
}
