import Link from 'next/link';
import { formatDate, stateLabel } from '@/lib/india';
import { invoiceMessages, loadInvoice } from '@/lib/load-invoice';
import { outstandingPaise } from '@/lib/billing-math';
import { decimalToPaise, formatInr, formatPaise, trimZeros } from '@/lib/money';
import { InvoiceActions } from './actions-panel';

export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const doc = await loadInvoice(params);
  const { invoice, items, delivery, payments, returns } = doc;
  const balance = outstandingPaise(decimalToPaise(invoice.grand_total), decimalToPaise(invoice.amount_paid));
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold">{invoice.invoice_no}</h1>
        {invoice.cancelled_at ? <span className="rounded border border-warn px-2 font-semibold text-warn">Cancelled · {invoice.cancellation_reason}</span> : null}
        <div className="ml-auto flex flex-wrap gap-2">
          <Link className="btn btn-primary" href={`/invoices/${invoice.id}/print?paper=a4`}>Print A4</Link>
          <Link className="btn" href={`/invoices/${invoice.id}/print?paper=a5`}>Print A5</Link>
          {invoiceMessages(doc).map((draft) => <a key={draft.label} className="btn" href={draft.href} target="_blank" rel="noopener noreferrer">{draft.label}</a>)}
        </div>
      </div>
      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <section className="card overflow-x-auto">
          <p className="font-semibold">{invoice.customer_snapshot.name}</p>
          <p className="mb-3 text-muted">{invoice.customer_snapshot.gstin ?? 'Unregistered'} · {stateLabel(invoice.place_of_supply)} · {formatDate(invoice.invoice_date)}, due {formatDate(invoice.due_date)}{delivery ? ` · ${delivery.dc_no}` : ''}{invoice.po_no ? ` · P.O. ${invoice.po_no}${invoice.po_date ? ` (${formatDate(invoice.po_date)})` : ''}` : ''}</p>
          <table className="grid-table">
            <thead><tr><th>Item</th><th className="num">Qty</th><th className="num">Rate</th><th className="num">Amount</th></tr></thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.line_no}>
                  <td>{item.description}<span className="block text-sm text-muted">{item.hsn_sac} · {trimZeros(item.tax_rate_percent)}%</span></td>
                  <td className="num">{item.billing_unit === 'pcs' ? `${item.qty_pieces ?? 0} pcs` : `${trimZeros(item.total_weight_kg ?? '0')} kg`}</td>
                  <td className="num">{trimZeros(item.unit_rate)}</td>
                  <td className="num">{formatPaise(decimalToPaise(item.line_total))}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {returns.length > 0 ? (
            <ul className="mt-3 text-muted">
              {returns.map((lot) => <li key={lot.line_no}>Party DC {lot.party_dc_no}: returned {lot.returned_weight_kg} kg, scrap {lot.scrap_weight_kg} kg, balance {lot.balance_after_kg} kg</li>)}
            </ul>
          ) : null}
        </section>
        <section className="card grid content-start gap-1">
          {([['Subtotal', invoice.subtotal], ['Packing', invoice.packing_charge], ['Delivery', invoice.delivery_charge], ['CGST', invoice.cgst], ['SGST', invoice.sgst], ['IGST', invoice.igst], ['Round-off', invoice.round_off]] as const)
            .filter(([label, value]) => label === 'Subtotal' || decimalToPaise(value) !== 0)
            .map(([label, value]) => <div key={label} className="flex justify-between"><span>{label}</span><span className="tabular-nums">{formatPaise(decimalToPaise(value))}</span></div>)}
          <div className="flex justify-between border-t border-line pt-2 text-xl font-bold"><span>Total</span><span className="tabular-nums">{formatInr(decimalToPaise(invoice.grand_total))}</span></div>
          <div className="flex justify-between"><span>Received</span><span className="tabular-nums">{formatInr(decimalToPaise(invoice.amount_paid))}</span></div>
          {invoice.cancelled_at || invoice.payment_status === 'paid' ? <p className="font-semibold text-accent">{invoice.cancelled_at ? '' : 'Settled'}</p> : <div className="flex justify-between font-semibold"><span>Balance</span><span className="tabular-nums">{formatInr(balance)}</span></div>}
        </section>
      </div>
      <InvoiceActions
        key={`${invoice.amount_paid}-${invoice.payment_status}-${delivery?.status ?? ''}`}
        invoiceId={invoice.id} cancelled={invoice.cancelled_at !== null} settled={invoice.payment_status === 'paid'} delivery={delivery} payments={payments}
      />
    </>
  );
}
