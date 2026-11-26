import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { FindBox } from '@/components/frame/find-box';
import { Icon } from '@/components/icon';
import { PageHead } from '@/components/page-head';
import { Pill } from '@/components/pill';
import { billState } from '@/lib/bill-state';
import { findBills, listCustomers, listStudItems } from '@/lib/data';
import { formatDate, istDate, stateLabel } from '@/lib/india';
import { initials } from '@/lib/look';
import { decimalToPaise, formatRupees } from '@/lib/money';
import { productDetail, productLabel } from '@/lib/products';
import { listQuery } from '@/lib/schemas/common';
import { createClient } from '@/lib/supabase/server';

const SHOWN = 8;
const ROW = 'flex items-center gap-3 border-b border-line px-5 py-3 last:border-0 hover:bg-sunken';

function Found({ title, more, children }: { title: string; more: string | null; children: ReactNode }) {
  return (
    <section className="card overflow-hidden p-0" aria-label={title}>
      <div className="card-head border-b border-line">
        <h2 className="card-title">{title}</h2>
        {more ? <Link href={more} prefetch={false} className="more-link ml-auto">All</Link> : null}
      </div>
      <ul>{children}</ul>
    </section>
  );
}

export default async function FindPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const parsed = listQuery.safeParse(await searchParams);
  const q = parsed.success ? parsed.data.q : '';
  const today = istDate(new Date());
  const db = await createClient();
  const found = q === '' ? null : await Promise.all([findBills(db, { q }, today, SHOWN), listCustomers(db, q, 1), listStudItems(db, q, 1)]);
  const [bills, customers, products] = found ?? [null, null, null];
  // The whole number of one bill was typed: that bill is what is wanted.
  const exact = bills?.rows.find((row) => row.invoice_no.toLowerCase() === q.toLowerCase());
  if (exact) redirect(`/invoices/${exact.id}`);
  const nothing = found !== null && found.every(({ rows }) => rows.length === 0);
  const search = new URLSearchParams({ q }).toString();
  return (
    <>
      <PageHead title="Find" note={q === '' ? 'Type a bill number, a customer, a P.O. or a product.' : nothing ? `Nothing found for “${q}”.` : `Found for “${q}”`} />
      <FindBox className={`mb-4 ${q === '' || nothing ? '' : 'side:hidden'}`} />
      <div className="grid gap-4">
        {bills && bills.rows.length > 0 ? (
          <Found title="Bills" more={bills.hasMore ? `/invoices?${search}` : null}>
            {bills.rows.map((row) => {
              const state = billState(row, today);
              return (
                <li key={row.id}>
                  <Link href={`/invoices/${row.id}`} prefetch={false} className={ROW}>
                    <span className="spot max-[22.5rem]:hidden"><Icon name="bill" /></span>
                    <span className="min-w-0 flex-1">
                      <b className="block font-semibold wrap-anywhere">{row.customer}</b>
                      <small className="block text-[13.5px] text-muted wrap-anywhere">{row.invoice_no} · {formatDate(row.invoice_date)}{row.po_no ? ` · P.O. ${row.po_no}` : ''}</small>
                    </span>
                    <span className="grid justify-items-end gap-1"><b className="font-semibold">{formatRupees(decimalToPaise(row.grand_total))}</b><Pill kind={state.kind}>{state.text}</Pill></span>
                  </Link>
                </li>
              );
            })}
          </Found>
        ) : null}
        {customers && customers.rows.length > 0 ? (
          <Found title="Customers" more={customers.rows.length > SHOWN || customers.hasMore ? `/customers?${search}` : null}>
            {customers.rows.slice(0, SHOWN).map((row) => (
              <li key={row.id}>
                <Link href={`/invoices?customer=${row.id}`} prefetch={false} className={ROW}>
                  <span className="face max-[22.5rem]:hidden" aria-hidden>{initials(row.name)}</span>
                  <span className="min-w-0 flex-1">
                    <b className="block font-semibold wrap-anywhere">{row.name}</b>
                    <small className="block text-[13.5px] text-muted wrap-anywhere">{[row.gstin ?? 'No GSTIN', stateLabel(row.state_code), row.phone].filter(Boolean).join(' · ')}</small>
                  </span>
                  <span className="more-link">Bills</span>
                </Link>
              </li>
            ))}
          </Found>
        ) : null}
        {products && products.rows.length > 0 ? (
          <Found title="Products" more={products.rows.length > SHOWN || products.hasMore ? `/stud-master?${search}` : null}>
            {products.rows.slice(0, SHOWN).map((row) => (
              <li key={row.id}>
                <Link href={`/stud-master?${new URLSearchParams({ q: row.sku_code }).toString()}`} prefetch={false} className={ROW}>
                  <span className="spot max-[22.5rem]:hidden"><Icon name="box" /></span>
                  <span className="min-w-0 flex-1">
                    <b className="block font-semibold wrap-anywhere">{productLabel(row)}</b>
                    <small className="block text-[13.5px] text-muted wrap-anywhere">{productDetail(row)}</small>
                  </span>
                </Link>
              </li>
            ))}
          </Found>
        ) : null}
      </div>
    </>
  );
}
