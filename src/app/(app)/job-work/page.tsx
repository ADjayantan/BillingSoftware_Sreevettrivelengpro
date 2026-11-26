import { PageHead } from '@/components/page-head';
import { Pager, SearchBox } from '@/components/pager';
import { listLots } from '@/lib/data';
import { pageQuery } from '@/lib/page-query';
import { createClient } from '@/lib/supabase/server';
import { JobWorkView } from './view';

export default async function JobWorkPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { q, page } = await pageQuery(searchParams);
  const openNew = 'new' in (await searchParams);
  const { rows, hasMore } = await listLots(await createClient(), { q }, page);
  return (
    <>
      <PageHead title="Job work" note="Customer material that came in, and what is still here." />
      <JobWorkView key={openNew ? 'new' : 'list'} openNew={openNew} rows={rows} pager={<Pager path="/job-work" page={page} hasMore={hasMore} params={{ q }} />} search={<SearchBox path="/job-work" q={q} label="Find by party DC number" />} />
    </>
  );
}
