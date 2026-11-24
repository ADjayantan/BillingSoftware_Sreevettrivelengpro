import { Pager, SearchBox } from '@/components/pager';
import { listLots } from '@/lib/data';
import { pageQuery } from '@/lib/page-query';
import { createClient } from '@/lib/supabase/server';
import { JobWorkView } from './view';

export default async function JobWorkPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { q, page } = await pageQuery(searchParams);
  const { rows, hasMore } = await listLots(await createClient(), { q }, page);
  return (
    <>
      <h1 className="mb-3 text-2xl font-bold">Job-work lots</h1>
      <JobWorkView rows={rows} search={<SearchBox path="/job-work" q={q} label="Find by party DC number" />} />
      <Pager path="/job-work" q={q} page={page} hasMore={hasMore} />
    </>
  );
}
