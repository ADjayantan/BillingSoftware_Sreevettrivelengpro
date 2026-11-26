import Link from 'next/link';
import { Icon } from '@/components/icon';
import { PageHead, Trail } from '@/components/page-head';
import { Pager } from '@/components/pager';
import { Pill } from '@/components/pill';
import { outstandingPaise } from '@/lib/billing-math';
import { billState } from '@/lib/bill-state';
import { findBills } from '@/lib/data';
import { formatDate, istDate, lastMonths, monthName } from '@/lib/india';
import { initials } from '@/lib/look';
import { decimalToPaise, formatRupees } from '@/lib/money';
import { BILL_TABS, billsQuery, type BillTab } from '@/lib/schemas/home';
import { createClient } from '@/lib/supabase/server';

const TAB: Record<BillTab, string> = { all: 'All', open: 'To collect', overdue: 'Overdue', paid: 'Paid', cancelled: 'Cancelled' };
const NOTHING: Record<BillTab, string> = {
  all: 'No bills here yet.', open: 'Nothing to collect here.', overdue: 'Nothing is late here.', paid: 'No paid bills here.', cancelled: 'No cancelled bills here.',
};

export default async function InvoicesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  // The address bar is untrusted too: anything odd in it is the plain list.
  const asked = billsQuery.safeParse(await searchParams);
  const ask = asked.success ? asked.data : billsQuery.parse({});
  const { q, show, month, page } = ask;
  const today = istDate(new Date());
  const { rows, counts, shown, hasMore } = await findBills(await createClient(), ask, today);
  const keep = { q, show: show === 'all' ? '' : show, month, customer: ask.customer };
  const link = (change: Partial<typeof keep>): string => {
    const params = new URLSearchParams(Object.entries({ ...keep, ...change }).filter(([, value]) => value));
    return params.size === 0 ? '/invoices' : `/invoices?${params.toString()}`;
  };
  const months = lastMonths(today, 24);
  const near = months.slice(0, 6);
  const here = { 'aria-current': 'page' as const };
  const ofMonth = (one: string) => (
    <li key={one || 'all'}><Link href={link({ month: one })} prefetch={false} className="refine-link" {...(one === month ? here : {})}>{one === '' ? 'All months' : monthName(`${one}-01`)}</Link></li>
  );
  // A list for one customer says whose it is: the name stands on each of its bills.
  const customer = ask.customer ? (rows[0]?.customer ?? 'One customer') : null;
  return (
    <>
      {customer ? <Trail steps={[['/home', 'Home'], ['/invoices', 'Bills']]} here={customer} /> : null}
      <PageHead title={customer ?? 'Bills'} note={`${shown.bills} bill${shown.bills === 1 ? '' : 's'} · ${formatRupees(decimalToPaise(shown.total))}${month ? ` · ${monthName(`${month}-01`)}` : ''}`}>
        {customer ? <Link href={link({ customer: '' })} prefetch={false} className="btn">All customers</Link> : null}
      </PageHead>
      <div className="xl:grid xl:grid-cols-[196px_minmax(0,1fr)] xl:gap-11">
        <aside className="max-xl:hidden" aria-label="Refine by">
          <h2 className="border-b border-line pb-3 text-[19px] font-bold" style={{ fontFamily: 'var(--font-serif)' }}>Refine by</h2>
          <nav className="refine" aria-label="Which bills">
            <p className="small-head mb-2">State</p>
            <ul>
              {BILL_TABS.map((tab) => (
                <li key={tab}>
                  <Link href={link({ show: tab === 'all' ? '' : tab })} prefetch={false} className="refine-link" {...(tab === show ? here : {})}>
                    {TAB[tab]}<span className="text-[13.5px] font-normal text-muted">({counts[tab]})</span>
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          <nav className="refine" aria-label="Which month">
            <p className="small-head mb-2">Month</p>
            <ul>{['', ...near].map(ofMonth)}</ul>
            <details className="mt-1" open={month !== '' && !near.includes(month)}>
              <summary className="more-link cursor-pointer list-none py-1">More months</summary>
              <ul>{months.slice(6).map(ofMonth)}</ul>
            </details>
          </nav>
        </aside>
        <section className="min-w-0" aria-label="Bills">
          <form action="/invoices" role="search" className="flex flex-wrap gap-2 border-y border-line bg-sunken p-2.5 max-side:-mx-4 max-side:px-4">
            {show === 'all' ? null : <input type="hidden" name="show" value={show} />}
            {ask.customer ? <input type="hidden" name="customer" value={ask.customer} /> : null}
            <input className="field min-w-52 flex-1" type="search" name="q" maxLength={60} defaultValue={q} placeholder="Bill number, customer or P.O." aria-label="Bill number, customer or P.O." />
            {/* From xl the months stand at the left; this box is then hidden, and what it holds still goes along. */}
            <select className="field w-auto max-side:flex-1 xl:hidden" name="month" defaultValue={month} aria-label="Month">
              <option value="">All months</option>
              {months.map((one) => <option key={one} value={one}>{monthName(`${one}-01`)}</option>)}
            </select>
            <button className="btn" type="submit"><Icon name="search" />Find</button>
          </form>
          <nav className="tabs max-side:-mx-4 xl:hidden" aria-label="Which bills">
            {BILL_TABS.map((tab) => (
              <Link key={tab} href={link({ show: tab === 'all' ? '' : tab })} prefetch={false} className="tab" {...(tab === show ? here : {})}>
                {TAB[tab]}<span className="tab-count">{counts[tab]}</span>
              </Link>
            ))}
          </nav>
          <div className="relative overflow-x-auto max-side:-mx-4">
            <table className="grid-table">
              <thead className="max-lg:sr-only"><tr><th>Customer</th><th>Bill</th><th>Date</th><th className="num">Total</th><th className="num">To collect</th><th>State</th><th><span className="sr-only">Print</span></th></tr></thead>
              <tbody>
                {rows.map((row) => {
                  const state = billState(row, today);
                  const owed = row.cancelled || row.payment_status === 'paid' ? 0 : outstandingPaise(decimalToPaise(row.grand_total), decimalToPaise(row.amount_paid));
                  return (
                    <tr key={row.id} className={row.cancelled ? 'text-muted' : ''}>
                      <td>
                        <Link href={`/invoices/${row.id}`} prefetch={false} className="flex min-w-0 items-center gap-3">
                          <span className="face max-side:hidden" aria-hidden>{initials(row.customer)}</span>
                          <span className="min-w-0">
                            <b className="block font-semibold wrap-anywhere">{row.customer}</b>
                            <small className="block text-[13px] text-muted wrap-anywhere">
                              <span className="lg:hidden">{row.invoice_no} · {formatDate(row.invoice_date)}</span>
                              {[row.bill_type === 'job_work' ? 'Job work' : null, row.po_no ? `P.O. ${row.po_no}` : null].filter(Boolean).map((note) => <span key={note} className="max-lg:block">{note} </span>)}
                            </small>
                          </span>
                        </Link>
                      </td>
                      <td className="whitespace-nowrap max-lg:hidden"><Link href={`/invoices/${row.id}`} prefetch={false} className="row-link">{row.invoice_no}</Link></td>
                      <td className="whitespace-nowrap max-lg:hidden">{formatDate(row.invoice_date)}</td>
                      <td className={`num font-semibold whitespace-nowrap max-lg:hidden ${row.cancelled ? 'line-through' : ''}`}>{formatRupees(decimalToPaise(row.grand_total))}</td>
                      <td className="num whitespace-nowrap max-lg:hidden">{owed === 0 ? '—' : formatRupees(owed)}</td>
                      <td className="max-lg:text-right">
                        <b className={`mb-1 block whitespace-nowrap lg:hidden ${row.cancelled ? 'line-through' : ''}`}>{formatRupees(decimalToPaise(row.grand_total))}</b>
                        <Pill kind={state.kind}>{state.text}</Pill>
                      </td>
                      <td className="max-lg:hidden"><Link href={`/invoices/${row.id}/print?paper=a4`} prefetch={false} className="grid size-9 place-items-center rounded-full text-muted hover:bg-soft hover:text-accent" aria-label={`Print ${row.invoice_no}`}><Icon name="print" /></Link></td>
                    </tr>
                  );
                })}
                {rows.length === 0 ? <tr><td colSpan={7} className="py-10 text-center text-muted">{q ? `Nothing found for “${q}”.` : NOTHING[show]}</td></tr> : null}
              </tbody>
            </table>
          </div>
          {shown.bills > 0 && decimalToPaise(shown.balance) > 0 ? <p className="border-t border-line px-5 py-3.5 text-[14.5px] text-ink-2 max-side:px-0">To collect on these bills: <b className="text-ink">{formatRupees(decimalToPaise(shown.balance))}</b></p> : null}
          <Pager path="/invoices" page={page} hasMore={hasMore} params={keep} />
        </section>
      </div>
    </>
  );
}
