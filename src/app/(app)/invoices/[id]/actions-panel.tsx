'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState, type FormEvent } from 'react';
import { enterAdvances } from '@/components/enter-advance';
import { Field, Notice } from '@/components/field';
import { api, type ApiResult } from '@/lib/api-client';
import { formatDate, istDate } from '@/lib/india';
import { decimalToPaise, formatInr } from '@/lib/money';
import type { InvoiceDocument } from '@/lib/schemas/invoices';
import { TransportFields, type Transport } from '../../billing/transport-fields';

const MODES = [['cash', 'Cash'], ['upi', 'UPI'], ['bank_transfer', 'Bank transfer'], ['cheque', 'Cheque'], ['tds', 'TDS'], ['other', 'Other']] as const;
const modeLabel = (mode: string): string => MODES.find(([key]) => key === mode)?.[1] ?? mode;

export function InvoiceActions({ invoiceId, cancelled, settled, delivery, payments }: {
  invoiceId: string;
  cancelled: boolean;
  settled: boolean;
  delivery: InvoiceDocument['delivery'];
  payments: InvoiceDocument['payments'];
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Kept until a receipt is saved, so a retry after a lost reply cannot record it twice.
  const receiptId = useRef<string | null>(null);
  const [transport, setTransport] = useState<Transport>({
    transport_mode: delivery?.transport_mode ?? 'own_vehicle', vehicle_no: delivery?.vehicle_no ?? '', driver_name: delivery?.driver_name ?? '',
    driver_phone: delivery?.driver_phone ?? '', lr_number: delivery?.lr_number ?? '', delivery_address: delivery?.delivery_address ?? '', status: delivery?.status ?? 'pending',
  });

  async function run(request: Promise<ApiResult<unknown>>): Promise<boolean> {
    setBusy(true);
    setError(null);
    const result = await request;
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return false;
    }
    router.refresh();
    return true;
  }

  async function receive(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const element = event.currentTarget;
    const form = new FormData(element);
    receiptId.current ??= crypto.randomUUID();
    const saved = await run(api(`/api/invoices/${invoiceId}/payments`, 'POST', {
      client_receipt_id: receiptId.current, amount: String(form.get('amount') ?? '').trim(), received_on: form.get('received_on'), mode: form.get('mode'),
      reference: form.get('reference'), settles_invoice: form.has('settles_invoice'),
    }));
    if (saved) {
      receiptId.current = null;
      element.reset();
    }
  }

  function ask(question: string, path: string): void {
    const reason = window.prompt(question);
    if (reason?.trim()) void run(api(path, 'POST', { reason }));
  }

  return (
    <div className="mt-4 grid gap-4 lg:grid-cols-2">
      {error ? <div className="lg:col-span-2"><Notice tone="warn">{error}</Notice></div> : null}
      <section className="card grid content-start gap-3" aria-label="Receipts">
        <h2 className="text-lg font-bold">Receipts</h2>
        {payments.length === 0 ? <p className="text-muted">Nothing received yet.</p> : null}
        <ul className="grid gap-1">
          {payments.map((payment) => (
            <li key={payment.id} className={`flex flex-wrap items-center gap-2 ${payment.voided_at ? 'line-through opacity-60' : ''}`}>
              <span className="font-semibold tabular-nums">{formatInr(decimalToPaise(payment.amount))}</span>
              <span>{modeLabel(payment.mode)} · {formatDate(payment.received_on)}{payment.reference ? ` · ${payment.reference}` : ''}{payment.settles_invoice ? ' · full settlement' : ''}</span>
              {payment.voided_at || cancelled ? null : <button type="button" className="ml-auto cursor-pointer px-2 text-warn underline" disabled={busy} onClick={() => ask('Why is this receipt wrong?', `/api/payments/${payment.id}/void`)}>Void</button>}
            </li>
          ))}
        </ul>
        {cancelled || settled ? null : (
          <form onSubmit={(event) => void receive(event)} onKeyDown={enterAdvances} className="grid gap-3 sm:grid-cols-2" aria-label="Record a receipt">
            <Field label="Amount ₹"><input className="field num" name="amount" inputMode="decimal" required /></Field>
            <Field label="Mode"><select className="field" name="mode" defaultValue="upi">{MODES.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></Field>
            <Field label="Date"><input className="field" name="received_on" type="date" required max={istDate(new Date())} defaultValue={istDate(new Date())} suppressHydrationWarning /></Field>
            <Field label="Reference"><input className="field" name="reference" maxLength={80} /></Field>
            <label className="flex items-center gap-2 sm:col-span-2"><input className="size-5" type="checkbox" name="settles_invoice" /> Accept as full settlement</label>
            <button className="btn btn-primary" type="submit" disabled={busy}>Record receipt</button>
          </form>
        )}
      </section>

      {delivery ? (
        <form
          className="card grid content-start gap-3 sm:grid-cols-2" aria-label="Dispatch" onKeyDown={enterAdvances}
          onSubmit={(event) => {
            event.preventDefault();
            void run(api(`/api/deliveries/${delivery.id}`, 'PATCH', transport));
          }}
        >
          <h2 className="text-lg font-bold sm:col-span-2">Dispatch · {delivery.dc_no}</h2>
          <TransportFields value={transport} onChange={setTransport} />
          <button className="btn btn-primary w-fit" type="submit" disabled={busy || cancelled}>Save dispatch</button>
        </form>
      ) : null}

      {cancelled ? null : (
        <button type="button" className="btn w-fit text-warn" disabled={busy} onClick={() => ask('Invoices are never deleted. Why cancel this one?', `/api/invoices/${invoiceId}/cancel`)}>Cancel invoice</button>
      )}
    </div>
  );
}
