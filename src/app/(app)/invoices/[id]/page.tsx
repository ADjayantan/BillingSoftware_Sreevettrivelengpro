import Link from 'next/link';
import { Icon } from '@/components/icon';
import { Trail } from '@/components/page-head';
import { Pill } from '@/components/pill';
import { Sheets } from '@/components/sheets';
import { billSheets } from '@/lib/bill-sheets';
import { billState } from '@/lib/bill-state';
import { outstandingPaise } from '@/lib/billing-math';
import { formatDate, istDate, stateLabel } from '@/lib/india';
import { invoiceMessages, loadInvoice } from '@/lib/load-invoice';
import { decimalToPaise, formatInr } from '@/lib/money';
import { buildDocuments } from '@/lib/print-documents';
import { CancelBill, Dispatch, Happened, RecordMoney } from './actions-panel';

export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const doc = await loadInvoice(params);
  const { invoice, delivery, payments, returns } = doc;
  const total = decimalToPaise(invoice.grand_total);
  const received = decimalToPaise(invoice.amount_paid);
  const cancelled = invoice.cancelled_at !== null;
  const settled = invoice.payment_status === 'paid';
  const balance = cancelled || settled ? 0 : outstandingPaise(total, received);
  const state = billState({ due_date: invoice.due_date, payment_status: invoice.payment_status, cancelled }, istDate(new Date()));
  const share = total === 0 ? 1 : Math.min(1, received / total);
  return (
    <>
      <Trail steps={[['/home', 'Home'], ['/invoices', 'Bills']]} here={invoice.invoice_no} />
      <div className="grid items-start gap-x-12 gap-y-6 lg:grid-cols-[minmax(0,1fr)_330px] xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="min-w-0 border border-line bg-white max-lg:order-last [&_svg]:block [&_svg]:h-auto [&_svg]:w-full">
          <Sheets sheets={billSheets(buildDocuments(doc, { documents: 'invoice', copies: 'original' }))} paper="a4" />
        </div>
        <div className="grid min-w-0 gap-7">
          <div>
            <p className="text-[15px] font-semibold tracking-[0.05em] text-accent uppercase wrap-anywhere">{invoice.customer_snapshot.name}</p>
            <h1 className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[27px] leading-tight font-normal wrap-anywhere">{invoice.invoice_no}<Pill kind={state.kind}>{state.text}</Pill></h1>
            <p className="mt-1 text-[14.5px] text-muted wrap-anywhere">{[formatDate(invoice.invoice_date), invoice.po_no ? `P.O. ${invoice.po_no}` : null, stateLabel(invoice.place_of_supply)].filter(Boolean).join(' · ')}</p>
          </div>
          <section className="border-y border-line py-4.5" aria-label="Money">
            <p className="small-head">{cancelled ? 'Cancelled bill of' : 'To collect'}</p>
            <p className="mt-1 text-[34px] leading-tight font-semibold wrap-anywhere" style={{ fontFamily: 'var(--font-display)' }}>{formatInr(cancelled ? total : balance)}</p>
            {cancelled ? null : (
              <>
                <div className="mt-2.5 mb-2 h-1.5 overflow-hidden rounded-full bg-off-bg" role="img" aria-label={`${formatInr(received)} of ${formatInr(total)} received`}><span className="block h-full rounded-full bg-paid" style={{ width: `${(settled ? 1 : share) * 100}%` }} /></div>
                <p className="text-[14.5px] text-ink-2">{settled && received < total ? `Settled with ${formatInr(received)} of ${formatInr(total)}` : `${formatInr(received)} received of ${formatInr(total)}`}</p>
                {settled ? null : <p className="text-[14.5px] text-muted">Due {formatDate(invoice.due_date)}</p>}
              </>
            )}
          </section>
          <div className="grid grid-cols-2 gap-2.5">
            {balance > 0 ? <RecordMoney key={invoice.amount_paid} invoiceId={invoice.id} invoiceNo={invoice.invoice_no} balancePaise={balance} /> : null}
            <span className="flex max-[26rem]:col-span-2">
              <Link className="btn flex-1 rounded-r-none border-r-0 px-3 whitespace-nowrap" href={`/invoices/${invoice.id}/print?paper=a4`}><Icon name="print" />Print A4</Link>
              <Link className="btn rounded-l-none px-3" href={`/invoices/${invoice.id}/print?paper=a5`}>A5</Link>
            </span>
            {invoiceMessages(doc).map((draft) => <a key={draft.label} className="btn max-[26rem]:col-span-2" href={draft.href} target="_blank" rel="noopener noreferrer"><Icon name="chat" />{draft.label}</a>)}
          </div>
          {delivery ? <Dispatch key={`${delivery.status}-${delivery.vehicle_no ?? ''}`} delivery={delivery} cancelled={cancelled} /> : null}
          {returns.length > 0 ? (
            <section aria-label="Customer material">
              <div className="plain-head"><h2 className="card-title">Customer material sent back</h2></div>
              <ul className="mt-3 grid gap-1.5 text-[14.5px] text-ink-2">
                {returns.map((lot) => <li key={lot.line_no}>Party DC {lot.party_dc_no}: {lot.returned_weight_kg} kg sent, {lot.scrap_weight_kg} kg scrap, {lot.balance_after_kg} kg still here</li>)}
              </ul>
            </section>
          ) : null}
          <Happened payments={payments} invoiceDate={invoice.invoice_date} cancelled={cancelled ? (invoice.cancellation_reason ?? '') : null} />
          {cancelled ? null : <CancelBill invoiceId={invoice.id} />}
        </div>
      </div>
    </>
  );
}
