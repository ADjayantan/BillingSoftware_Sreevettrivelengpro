import Link from 'next/link';
import { Icon } from '@/components/icon';
import { PageHead } from '@/components/page-head';
import { Pager } from '@/components/pager';
import { findReceipts } from '@/lib/data';
import { formatDate, istDate, lastMonths, monthName } from '@/lib/india';
import { decimalToPaise, formatRupees } from '@/lib/money';
import { payWay } from '@/lib/pay-ways';
import { receiptsQuery } from '@/lib/schemas/home';
import { createClient } from '@/lib/supabase/server';
import { TakeMoney } from './take-money';

export default async function MoneyPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const asked = receiptsQuery.safeParse(await searchParams);
  const { q, month, page } = asked.success ? asked.data : receiptsQuery.parse({});
  const today = istDate(new Date());
  const found = await findReceipts(await createClient(), { q, month, page });
  return (
    <>
      <PageHead title="Money received" note="Write it down when it comes: cash, UPI, bank or cheque." />
      <TakeMoney />
      <section className="card overflow-hidden p-0" aria-label="What came in">
        <div className="card-head"><h2 className="card-title">What came in</h2><small className="text-[13.5px] text-muted">{found.receipts} time{found.receipts === 1 ? '' : 's'} · {formatRupees(decimalToPaise(found.total))}{month ? ` · ${monthName(`${month}-01`)}` : ''}</small></div>
        <form action="/money" role="search" className="flex flex-wrap gap-2 px-3 pb-3">
          <input className="field min-w-52 flex-1" type="search" name="q" maxLength={60} defaultValue={q} placeholder="Customer, bill number or note" aria-label="Customer, bill number or note" />
          <select className="field w-auto max-side:flex-1" name="month" defaultValue={month} aria-label="Month">
            <option value="">All months</option>
            {lastMonths(today, 24).map((one) => <option key={one} value={one}>{monthName(`${one}-01`)}</option>)}
          </select>
          <button className="btn" type="submit"><Icon name="search" />Find</button>
        </form>
        <div className="relative overflow-x-auto">
          <table className="grid-table">
            <thead className="max-lg:sr-only"><tr><th>Date</th><th>Customer</th><th>Bill</th><th>How</th><th className="num">Amount</th></tr></thead>
            <tbody>
              {found.rows.map((row) => (
                <tr key={row.id} className={row.voided ? 'text-muted' : ''}>
                  <td className="whitespace-nowrap max-lg:hidden">{formatDate(row.received_on)}</td>
                  <td className="max-lg:pl-4.5">
                    <b className="font-semibold wrap-anywhere">{row.customer}</b>
                    <small className="block text-[13px] text-muted lg:hidden">{row.invoice_no} · {formatDate(row.received_on)} · {payWay(row.mode)}</small>
                  </td>
                  <td className="whitespace-nowrap max-lg:hidden"><Link href={`/invoices/${row.invoice_id}`} prefetch={false} className="row-link">{row.invoice_no}</Link></td>
                  <td className="max-lg:hidden">{[payWay(row.mode), row.reference, row.settles_invoice ? 'full settlement' : null].filter(Boolean).join(' · ')}</td>
                  <td className="num whitespace-nowrap"><b className={`font-semibold ${row.voided ? 'line-through' : ''}`}>{formatRupees(decimalToPaise(row.amount))}</b>{row.voided ? <small className="block text-[13px]">not counted</small> : null}</td>
                </tr>
              ))}
              {found.rows.length === 0 ? <tr><td colSpan={5} className="py-8 text-center text-muted">{q || month ? 'Nothing found.' : 'Nothing came in yet.'}</td></tr> : null}
            </tbody>
          </table>
        </div>
        <Pager path="/money" page={found.page} hasMore={found.hasMore} params={{ q, month }} />
      </section>
    </>
  );
}
