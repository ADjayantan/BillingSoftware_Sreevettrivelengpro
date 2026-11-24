import Link from 'next/link';
import { Pager, SearchBox } from '@/components/pager';
import { listInvoices } from '@/lib/data';
import { formatDate } from '@/lib/india';
import { decimalToPaise, formatInr } from '@/lib/money';
import { pageQuery } from '@/lib/page-query';
import { createClient } from '@/lib/supabase/server';

const STATUS = { unpaid: 'Unpaid', partial: 'Part paid', paid: 'Paid' } as const;

export default async function InvoicesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { q, page } = await pageQuery(searchParams);
  const { rows, hasMore } = await listInvoices(await createClient(), q, page);
  return (
    <>
      <h1 className="mb-3 text-2xl font-bold">Bills</h1>
      <div className="mb-3"><SearchBox path="/invoices" q={q} label="Find by invoice number" /></div>
      <div className="card overflow-x-auto p-0">
        <table className="grid-table">
          <thead><tr><th>Invoice</th><th>Date</th><th>Customer</th><th>Due</th><th className="num">Total</th><th>Status</th></tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className={row.cancelled_at ? 'opacity-60' : ''}>
                <td><Link prefetch={false} className="font-semibold text-accent underline" href={`/invoices/${row.id}`}>{row.invoice_no}</Link></td>
                <td>{formatDate(row.invoice_date)}</td>
                <td>{row.customer_snapshot.name}{row.bill_type === 'job_work' ? <span className="ml-2 text-sm text-muted">job work</span> : null}</td>
                <td>{formatDate(row.due_date)}</td>
                <td className="num">{formatInr(decimalToPaise(row.grand_total))}</td>
                <td>{row.cancelled_at ? 'Cancelled' : STATUS[row.payment_status]}</td>
              </tr>
            ))}
            {rows.length === 0 ? <tr><td colSpan={6} className="text-muted">No bills here yet.</td></tr> : null}
          </tbody>
        </table>
      </div>
      <Pager path="/invoices" q={q} page={page} hasMore={hasMore} />
    </>
  );
}
