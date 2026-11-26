'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react';
import { enterAdvances } from '@/components/enter-advance';
import { Field, Notice } from '@/components/field';
import { Icon } from '@/components/icon';
import { MoneyFields, type MoneyForm } from '@/components/money-fields';
import { api, type ApiResult } from '@/lib/api-client';
import { formatDate, formatTime, istDate } from '@/lib/india';
import { decimalToPaise, formatInr, paiseToDecimal } from '@/lib/money';
import { payWay } from '@/lib/pay-ways';
import type { InvoiceDocument } from '@/lib/schemas/invoices';
import { TransportFields, type Transport } from '../../billing/transport-fields';

/** Sends one change, says what went wrong, and shows the page as it is now. */
function useSend(): { busy: boolean; error: string | null; send: (request: Promise<ApiResult<unknown>>) => Promise<boolean> } {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return {
    busy,
    error,
    send: async (request) => {
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
    },
  };
}

function Box({ title, box, children }: { title: string; box: RefObject<HTMLDialogElement | null>; children: ReactNode }) {
  return (
    <dialog ref={box} className="card" aria-label={title}>
      <div className="flex items-center gap-3 border-b border-line px-5 py-4">
        <h2 className="card-title text-[22px]">{title}</h2>
        <button type="button" className="btn btn-small ml-auto" onClick={() => box.current?.close()}>Close</button>
      </div>
      <div className="p-5">{children}</div>
    </dialog>
  );
}

export function RecordMoney({ invoiceId, invoiceNo, balancePaise }: { invoiceId: string; invoiceNo: string; balancePaise: number }) {
  const box = useRef<HTMLDialogElement>(null);
  const { busy, error, send } = useSend();
  // Kept until a receipt is saved, so a retry after a lost reply cannot record it twice.
  const receiptId = useRef<string | null>(null);
  const [form, setForm] = useState<MoneyForm | null>(null);

  function open(): void {
    setForm({ amount: paiseToDecimal(balancePaise), mode: 'upi', receivedOn: istDate(new Date()), reference: '', settles: false });
    box.current?.showModal();
  }

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!form || busy) return;
    receiptId.current ??= crypto.randomUUID();
    const saved = await send(api(`/api/invoices/${invoiceId}/payments`, 'POST', {
      client_receipt_id: receiptId.current, amount: form.amount.trim(), received_on: form.receivedOn, mode: form.mode, reference: form.reference, settles_invoice: form.settles,
    }));
    if (!saved) return;
    receiptId.current = null;
    box.current?.close();
  }

  return (
    <>
      <button type="button" className="btn btn-primary col-span-2 min-h-13" onClick={open}><Icon name="wallet" />Record money</button>
      <Box title={`Money for ${invoiceNo}`} box={box}>
        {form ? (
          <form onSubmit={(event) => void save(event)} onKeyDown={enterAdvances} className="grid gap-4" aria-label="Record money">
            <MoneyFields value={form} onChange={setForm} balancePaise={balancePaise} />
            {error ? <Notice tone="warn">{error}</Notice> : null}
            <button className="btn btn-primary min-h-13" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
          </form>
        ) : null}
      </Box>
    </>
  );
}

/** A change that needs a reason: it stays in the books with the reason. */
function Reason({ label, title, question, path, icon, className }: { label: string; title: string; question: string; path: string; icon?: 'alert'; className: string }) {
  const box = useRef<HTMLDialogElement>(null);
  const { busy, error, send } = useSend();
  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const reason = String(new FormData(event.currentTarget).get('reason') ?? '').trim();
    if (await send(api(path, 'POST', { reason }))) box.current?.close();
  }
  return (
    <>
      <button type="button" className={className} onClick={() => box.current?.showModal()}>{icon ? <Icon name={icon} /> : null}{label}</button>
      <Box title={title} box={box}>
        <form onSubmit={(event) => void save(event)} className="grid gap-4">
          <Field label={question}><input className="field" name="reason" required minLength={3} maxLength={300} autoComplete="off" /></Field>
          {error ? <Notice tone="warn">{error}</Notice> : null}
          <button className="btn border-warn text-warn" type="submit" disabled={busy}>{busy ? 'Saving…' : title}</button>
        </form>
      </Box>
    </>
  );
}

export function CancelBill({ invoiceId }: { invoiceId: string }) {
  return <Reason label="Cancel bill" title="Cancel this bill" question="A bill is never deleted. Why is this one cancelled?" path={`/api/invoices/${invoiceId}/cancel`} icon="alert" className="btn justify-self-start text-warn" />;
}

const STEPS = [['packed', 'Packed'], ['dispatched', 'On the way'], ['delivered', 'Delivered']] as const;
const ORDER = ['pending', 'packed', 'dispatched', 'delivered'] as const;

/** Where the goods are, and one button for the next step. */
export function Dispatch({ delivery, cancelled }: { delivery: NonNullable<InvoiceDocument['delivery']>; cancelled: boolean }) {
  const box = useRef<HTMLDialogElement>(null);
  const { busy, error, send } = useSend();
  const [transport, setTransport] = useState<Transport>(() => ({
    transport_mode: delivery.transport_mode, vehicle_no: delivery.vehicle_no ?? '', driver_name: delivery.driver_name ?? '', driver_phone: delivery.driver_phone ?? '',
    lr_number: delivery.lr_number ?? '', delivery_address: delivery.delivery_address ?? '', status: delivery.status,
  }));
  const at = ORDER.indexOf(delivery.status);
  const next = STEPS[at];
  const carrier = [delivery.vehicle_no, delivery.driver_name, delivery.driver_phone, delivery.lr_number ? `LR ${delivery.lr_number}` : null].filter(Boolean).join(' · ');
  const when: Record<string, string | null> = {
    dispatched: delivery.dispatched_at ? formatTime(Date.parse(delivery.dispatched_at)) : null,
    delivered: delivery.delivered_at ? formatTime(Date.parse(delivery.delivered_at)) : null,
  };
  return (
    <section aria-label="Goods">
      <div className="plain-head">
        <h2 className="card-title">Goods</h2>
        <small className="text-[13.5px] text-muted">{delivery.dc_no}</small>
        {cancelled ? null : <button type="button" className="more-link ml-auto cursor-pointer" onClick={() => box.current?.showModal()}>Change</button>}
      </div>
      <ol className="mt-4 grid gap-0">
        {STEPS.map(([key, words], i) => {
          const done = i < at;
          return (
            <li key={key} className="relative flex gap-3 pb-3 last:pb-0">
              <span aria-hidden className={`z-[1] mt-1 size-3 flex-none rounded-full ${done ? 'bg-paid ring-4 ring-paid-bg' : 'border border-muted bg-card'}`} />
              {i < STEPS.length - 1 ? <span aria-hidden className="absolute top-5 bottom-0 left-[5px] w-0.5 bg-line" /> : null}
              <span className={done ? '' : 'text-muted'}>
                <span className="sr-only">{done ? 'Done: ' : 'Not yet: '}</span>
                <b className="font-semibold">{words}</b>
                <small className="block text-[13.5px] text-muted">{[when[key], key === 'dispatched' ? carrier : null].filter(Boolean).join(' · ')}</small>
              </span>
            </li>
          );
        })}
      </ol>
      {next && !cancelled ? (
        <div className="mt-3">
          {error ? <div className="mb-2"><Notice tone="warn">{error}</Notice></div> : null}
          <button type="button" className="btn w-full" disabled={busy} onClick={() => void send(api(`/api/deliveries/${delivery.id}`, 'PATCH', { status: next[0] }))}>Mark: {next[1].toLowerCase()}</button>
        </div>
      ) : null}
      <Box title={`Goods · ${delivery.dc_no}`} box={box}>
        <form
          className="grid gap-3 sm:grid-cols-2" aria-label="Goods" onKeyDown={enterAdvances}
          onSubmit={(event) => {
            event.preventDefault();
            void send(api(`/api/deliveries/${delivery.id}`, 'PATCH', transport)).then((saved) => (saved ? box.current?.close() : undefined));
          }}
        >
          <TransportFields value={transport} onChange={setTransport} />
          {error ? <div className="sm:col-span-2"><Notice tone="warn">{error}</Notice></div> : null}
          <button className="btn btn-primary sm:col-span-2" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </form>
      </Box>
    </section>
  );
}

/** Newest first: what came in, and when the bill was made. */
export function Happened({ payments, invoiceDate, cancelled }: { payments: InvoiceDocument['payments']; invoiceDate: string; cancelled: string | null }) {
  const dot = (good: boolean): ReactNode => <span aria-hidden className={`mt-1 size-3 flex-none rounded-full ${good ? 'bg-paid ring-4 ring-paid-bg' : 'bg-muted ring-4 ring-off-bg'}`} />;
  return (
    <section aria-label="What happened">
      <div className="plain-head"><h2 className="card-title">What happened</h2></div>
      <ul className="mt-4 grid gap-3.5">
        {cancelled ? <li className="flex gap-3">{dot(false)}<span><b className="font-semibold">Cancelled</b><small className="block text-[13.5px] text-muted">{cancelled}</small></span></li> : null}
        {[...payments].reverse().map((payment) => (
          <li key={payment.id} className="flex gap-3">
            {dot(payment.voided_at === null)}
            <span className="min-w-0 flex-1">
              <b className={`font-semibold ${payment.voided_at ? 'line-through' : ''}`}>{formatInr(decimalToPaise(payment.amount))} received</b>
              <small className="block text-[13.5px] wrap-anywhere text-muted">
                {[payWay(payment.mode), formatDate(payment.received_on), payment.reference, payment.settles_invoice ? 'full settlement' : null, payment.voided_at ? `not counted: ${payment.void_reason ?? ''}` : null].filter(Boolean).join(' · ')}
              </small>
            </span>
            {payment.voided_at || cancelled !== null ? null : (
              <Reason label="Undo" title="Undo this receipt" question="Why is it wrong?" path={`/api/payments/${payment.id}/void`} className="cursor-pointer self-start text-[13px] font-semibold tracking-[0.06em] text-warn uppercase" />
            )}
          </li>
        ))}
        <li className="flex gap-3">{dot(true)}<span><b className="font-semibold">Bill made</b><small className="block text-[13.5px] text-muted">{formatDate(invoiceDate)}</small></span></li>
      </ul>
    </section>
  );
}
