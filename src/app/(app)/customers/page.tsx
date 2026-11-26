import Link from 'next/link';
import { PageHead } from '@/components/page-head';
import { Pager, SearchBox } from '@/components/pager';
import { customerBalances } from '@/lib/data';
import { istDate } from '@/lib/india';
import { decimalToPaise, formatRupees } from '@/lib/money';
import { customersQuery, type CustomersQuery } from '@/lib/schemas/home';
import { createClient } from '@/lib/supabase/server';
import { CustomersView } from './view';

const ORDER: [CustomersQuery['sort'], string][] = [['name', 'A–Z'], ['owes', 'Owes most']];

export default async function CustomersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  // The address bar is untrusted too: anything odd in it is the plain list.
  const asked = customersQuery.safeParse(params);
  const { q, sort, page } = asked.success ? asked.data : customersQuery.parse({});
  const openNew = 'new' in params;
  const today = istDate(new Date());
  const found = await customerBalances(await createClient(), { q, sort, page }, today);
  const keep = { q, sort: sort === 'name' ? '' : sort };
  const total = formatRupees(decimalToPaise(found.balance));
  const late = decimalToPaise(found.overdue);
  const note = found.owing === 0
    ? `${found.customers} customer${found.customers === 1 ? '' : 's'} · nobody owes you`
    : `${found.owing} of ${found.customers} owe you ${total}${late > 0 ? ` · ${formatRupees(late)} late` : ''}`;
  const order = (
    <nav aria-label="Order" className="inline-flex rounded-[3px] border border-line-2 p-[3px]">
      {ORDER.map(([one, words]) => {
        const search = new URLSearchParams(Object.entries({ q, sort: one === 'name' ? '' : one }).filter(([, value]) => value)).toString();
        return (
          <Link
            key={one} href={search ? `/customers?${search}` : '/customers'} prefetch={false} {...(one === sort ? { 'aria-current': 'page' as const } : {})}
            className={`flex min-h-9.5 items-center rounded-[2px] px-3.5 text-[13.5px] font-semibold tracking-[0.04em] whitespace-nowrap uppercase ${one === sort ? 'bg-slate text-white' : 'text-ink-2 hover:text-ink'}`}
          >
            {words}
          </Link>
        );
      })}
    </nav>
  );
  return (
    <>
      <PageHead title="Customers" note={note} />
      <CustomersView
        key={openNew ? 'new' : 'list'} openNew={openNew} rows={found.rows} today={today} order={order}
        pager={<Pager path="/customers" page={page} hasMore={found.hasMore} params={keep} />}
        search={<SearchBox path="/customers" q={q} label="Name, phone or GSTIN" keep={{ sort: keep.sort }} />}
      />
    </>
  );
}
