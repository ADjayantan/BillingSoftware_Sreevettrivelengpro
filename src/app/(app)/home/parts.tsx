import Link from 'next/link';
import type { ReactNode } from 'react';
import { Icon, type IconName } from '@/components/icon';
import { Pill } from '@/components/pill';
import { outstandingPaise } from '@/lib/billing-math';
import { billState } from '@/lib/bill-state';
import { STEP } from '@/lib/goods-steps';
import { daysBetween, monthName } from '@/lib/india';
import { initials, salesBars } from '@/lib/look';
import { decimalToPaise, formatRupees } from '@/lib/money';
import type { FoundBill, GoodsRow, HomeFigures } from '@/lib/schemas/home';
import { whatsappDrafts } from '@/lib/whatsapp';

export const bills = (count: number): string => `${count} bill${count === 1 ? '' : 's'}`;
const rupees = (decimal: string): string => formatRupees(decimalToPaise(decimal));

/** The four things done every day. */
export function Doings({ toCollect, toSend }: { toCollect: number; toSend: number }) {
  const doing = (href: string, icon: IconName, title: string, note: string, main = false) => (
    <Link
      key={href} href={href}
      className={`flex min-h-28 flex-col items-center justify-center gap-1 rounded-[3px] border px-2 py-3 text-center max-side:min-h-0 ${main ? 'border-accent bg-accent text-white hover:bg-accent-2 max-side:col-span-3 max-side:flex-row max-side:gap-3 max-side:py-4' : 'border-line bg-card hover:border-slate'}`}
    >
      <Icon name={icon} className={`size-7 ${main ? '' : 'text-accent'}`} />
      <b className="mt-1 text-[13px] leading-tight font-semibold tracking-[0.06em] uppercase max-side:mt-0">{title}</b>
      <small className={`text-[12.5px] leading-tight ${main ? 'text-[#f6ead0]' : 'text-muted max-side:hidden'}`}>{note}</small>
    </Link>
  );
  return (
    <nav aria-label="What do you want to do" className="grid grid-cols-3 gap-2.5 side:grid-cols-4 side:gap-3.5">
      {doing('/billing', 'plus', 'New bill', 'Sale or job work', true)}
      {doing('/money', 'wallet', 'Money received', `${bills(toCollect)} to collect`)}
      {doing('/dispatch', 'truck', 'Send goods', toSend === 0 ? 'Nothing waiting' : `${toSend} waiting`)}
      {doing('/invoices', 'print', 'Find and print', 'By name or number')}
    </nav>
  );
}

function Figure({ label, value, note, href, late = false }: { label: string; value: string; note: ReactNode; href: string; late?: boolean }) {
  return (
    <Link href={href} prefetch={false} className="block min-w-0 px-5 py-4 hover:bg-sunken max-side:px-4">
      <span className={`small-head ${late ? 'text-warn' : ''}`}>{label}</span>
      <b className={`mt-1.5 block text-[27px] leading-tight font-semibold wrap-anywhere max-side:text-[21px] ${late ? 'text-warn' : ''}`} style={{ fontFamily: 'var(--font-display)' }}>{value}</b>
      <small className="block text-[13.5px] text-muted">{note}</small>
    </Link>
  );
}

export function Figures({ figures, today }: { figures: HomeFigures; today: string }) {
  const { to_collect, overdue } = figures;
  const lastMonth = figures.months.at(-2)?.month ?? today;
  return (
    <section aria-label="Figures" className="my-7 grid grid-cols-2 border-y border-line *:border-line max-side:my-5 max-lg:[&>*:nth-child(even)]:border-l max-lg:[&>*:nth-child(n+3)]:border-t lg:grid-cols-4 lg:divide-x lg:divide-line">
      <Figure label="Today" value={rupees(figures.today.total)} note={bills(figures.today.bills)} href={`/invoices?month=${today.slice(0, 7)}`} />
      <Figure
        label="This month" value={rupees(figures.month.total)} href={`/invoices?month=${today.slice(0, 7)}`}
        note={`${bills(figures.month.bills)} · ${monthName(lastMonth).split(' ')[0] ?? ''} ${rupees(figures.last_month.total)}`}
      />
      <Figure label="To collect" value={rupees(to_collect.total)} note={bills(to_collect.bills)} href="/invoices?show=open" />
      <Figure
        label="Overdue" value={rupees(overdue.total)} href="/invoices?show=overdue" late={overdue.bills > 0}
        note={overdue.oldest === null ? 'Nothing is late' : `${bills(overdue.bills)}, oldest ${daysBetween(overdue.oldest, today)} days`}
      />
    </section>
  );
}

function Head({ title, note, all }: { title: string; note: string; all?: string }) {
  return (
    <div className="plain-head">
      <h2 className="card-title">{title}</h2>
      <small className="text-[13.5px] text-muted">{note}</small>
      {all ? <Link href={all} prefetch={false} className="more-link ml-auto">All</Link> : null}
    </div>
  );
}

export function CollectFirst({ rows, today, fresh }: { rows: readonly FoundBill[]; today: string; fresh: boolean }) {
  return (
    <section aria-label="Collect first">
      <Head title="Collect first" note="oldest on top" all="/invoices?show=open" />
      {rows.length === 0 ? <p className="py-6 text-muted">{fresh ? 'No bills yet. Start with New bill.' : 'Nothing to collect. Every bill is paid.'}</p> : (
        <ul className="*:min-w-0">
          {rows.map((row) => {
            const state = billState(row, today);
            const balance = outstandingPaise(decimalToPaise(row.grand_total), decimalToPaise(row.amount_paid));
            const [draft] = whatsappDrafts(row.phone, today, { recipientName: row.customer, companyName: row.supplier, invoiceNo: row.invoice_no, invoiceDate: row.invoice_date, dueDate: row.due_date, balancePaise: balance });
            return (
              <li key={row.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 border-b border-line py-3 lg:grid-cols-[minmax(0,1fr)_9rem_7.5rem_7.4rem]">
                <Link href={`/invoices/${row.id}`} prefetch={false} className="flex min-w-0 items-center gap-3">
                  <span className="face max-[22.5rem]:hidden" aria-hidden>{initials(row.customer)}</span>
                  <span className="min-w-0">
                    <b className="block leading-snug font-semibold wrap-anywhere">{row.customer}</b>
                    <small className="block text-[13px] text-muted">{row.invoice_no}</small>
                  </span>
                </Link>
                <span className="max-lg:justify-self-end"><Pill kind={state.kind}>{state.text}</Pill></span>
                <b className="num font-semibold max-lg:pl-[48px] max-lg:text-left max-[22.5rem]:pl-0">{formatRupees(balance)}</b>
                <span className="justify-self-end">
                  {draft ? <a className="btn btn-small" href={draft.href} target="_blank" rel="noopener noreferrer"><Icon name="chat" />Remind</a> : <small className="text-[13px] text-muted">No phone</small>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function ToSend({ goods, waiting, fresh }: { goods: readonly GoodsRow[]; waiting: number; fresh: boolean }) {
  return (
    <section aria-label="To send">
      <Head title="To send" note={`${waiting} waiting`} all="/dispatch" />
      {goods.length === 0 ? <p className="py-6 text-muted">{fresh ? 'The goods of your bills come here.' : 'All goods are sent.'}</p> : (
        <ul className="*:min-w-0">
          {goods.map((row) => (
            <li key={row.id} className="flex items-center gap-3 border-b border-line py-3">
              <span className="spot max-[22.5rem]:hidden"><Icon name="truck" /></span>
              <Link href={`/invoices/${row.invoice_id}`} prefetch={false} className="min-w-0 flex-1">
                <b className="line-clamp-2 leading-snug font-semibold wrap-anywhere">{row.customer}</b>
                <small className="block text-[13px] text-muted">{row.dc_no} · {row.items} item{row.items === 1 ? '' : 's'}</small>
              </Link>
              <Pill kind={STEP[row.status].kind} icon={STEP[row.status].icon}>{STEP[row.status].text}</Pill>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const TALL = 188;
const FOOT = 28;
const RISE = TALL - FOOT - 18;

/** Boxes and not a drawing: on a phone a drawing would shrink its words too. */
export function Sales({ months }: { months: HomeFigures['months'] }) {
  const { ticks, bars, label } = salesBars(months);
  return (
    <section aria-label="Sales by month">
      <Head title="Sales by month" note="with GST" />
      <div role="img" aria-label={label} className="relative mt-4 text-[13px] leading-none text-muted" style={{ height: TALL }}>
        {ticks.map(({ at, text }) => (
          <div key={at} className="absolute inset-x-0 border-t border-line" style={{ bottom: FOOT + at * RISE }}>
            <span className="absolute left-0 -translate-y-1/2 bg-card pr-2">{text}</span>
          </div>
        ))}
        <div className="absolute inset-y-0 right-0 left-16 flex">
          {bars.map(({ name, share, text, title }, i) => {
            const last = i === bars.length - 1;
            return (
              <div key={title} title={title} className="relative flex-1">
                {share > 0 ? <i className={`absolute left-1/2 w-6 -translate-x-1/2 rounded-t-sm forced-color-adjust-none ${last ? 'bg-slate' : 'bg-[#8494a4]'}`} style={{ bottom: FOOT, height: share * RISE }} /> : null}
                {last && share > 0 ? <b className="absolute left-1/2 -translate-x-1/2 font-bold whitespace-nowrap text-ink" style={{ bottom: FOOT + share * RISE + 5 }}>{text}</b> : null}
                <span className="absolute inset-x-0 bottom-1.5 text-center">{name}</span>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

export function Safe({ children }: { children: ReactNode }) {
  return (
    <section aria-label="Safe and in order">
      <Head title="Safe and in order" note="checked just now" />
      <ul>{children}</ul>
    </section>
  );
}

export function SafeLine({ icon, title, note, good = true }: { icon: IconName; title: ReactNode; note: ReactNode; good?: boolean }) {
  return (
    <li className="flex items-center gap-3.5 border-b border-line py-3">
      <Icon name={good ? icon : 'clock'} className={`size-6 ${good ? 'text-accent' : 'text-due'}`} />
      <span className="min-w-0">
        <b className="block font-semibold">{title}</b>
        <small className="block text-[13.5px] text-muted">{note}</small>
      </span>
    </li>
  );
}
