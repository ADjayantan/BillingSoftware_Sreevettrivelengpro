import { Pager, SearchBox } from '@/components/pager';
import { listStudItems } from '@/lib/data';
import { pageQuery } from '@/lib/page-query';
import { createClient } from '@/lib/supabase/server';
import { StudMasterView } from './view';

export default async function StudMasterPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { q, page } = await pageQuery(searchParams);
  const { rows, hasMore } = await listStudItems(await createClient(), q, page);
  return (
    <>
      <h1 className="mb-3 text-2xl font-bold">Stud master</h1>
      <StudMasterView rows={rows} search={<SearchBox path="/stud-master" q={q} label="Find by SKU" />} />
      <Pager path="/stud-master" q={q} page={page} hasMore={hasMore} />
    </>
  );
}
