'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react';
import { enterAdvances } from '@/components/enter-advance';
import { Field, Notice } from '@/components/field';
import { Icon } from '@/components/icon';
import { MoneyFields, type MoneyForm } from '@/components/money-fields';
import { Typeahead } from '@/components/typeahead';
import { api, type ApiResult } from '@/lib/api-client';
import { distinctRates } from '@/lib/bill-draft';
import * as f from '@/lib/bill-form';
import { formatDate, formatTime, istDate } from '@/lib/india';
import { searchStuds } from '@/lib/master-search';
import { decimalToPaise, formatInr, formatPaise, paiseToDecimal, rupeesInWords } from '@/lib/money';
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

/** Edits an issued bill in place while keeping its original number, date and customer intact. */
export function EditBill({ doc }: { doc: InvoiceDocument }) {
  const box = useRef<HTMLDialogElement>(null);
  const { busy, error, send } = useSend();
  const [form, setForm] = useState<f.BillForm>(() => f.formFromInvoice(doc));
  const [chargesOpen, setChargesOpen] = useState<boolean>(() => doc.invoice.packing_charge !== '0.00' || doc.invoice.delivery_charge !== '0.00');
  const [localError, setLocalError] = useState<string | null>(null);

  function open(): void {
    const fresh = f.formFromInvoice(doc);
    setForm(fresh);
    setChargesOpen(fresh.packing !== '' || fresh.freight !== '');
    setLocalError(null);
    box.current?.showModal();
  }

  const patch = (change: Partial<f.BillForm>): void => setForm((old) => ({ ...old, ...change }));
  const patchLine = (key: number, change: (line: f.FormLine) => f.FormLine): void =>
    setForm((old) => ({ ...old, lines: f.withTrailingBlank(old.lines.map((line) => (line.key === key ? change(line) : line)), old.type) }));

  const preview = f.previewBill(form);
  const bill = preview.bill ?? null;
  const amounts = bill?.detail.amounts ?? null;
  const typedLines = form.lines.filter((line) => !f.isBlank(line));
  const mixedRates = distinctRates(typedLines.filter((line) => line.gst !== '').map((line) => ({ gst_rate: line.gst })));
  const buyerPays = form.freightPaidBy === 'buyer_to_pay';

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    if ('problem' in preview || !bill) {
      setLocalError('problem' in preview ? preview.problem : 'Check the bill');
      return;
    }
    setLocalError(null);
    const saved = await send(api(`/api/invoices/${doc.invoice.id}`, 'PUT', f.toEditDraft(form, bill)));
    if (saved) box.current?.close();
  }

  return (
    <>
      <button type="button" className="btn" onClick={open}>Edit bill</button>
      <dialog ref={box} className="card w-[min(920px,96vw)] max-w-none" aria-label={`Edit ${doc.invoice.invoice_no}`}>
        <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <h2 className="card-title text-[22px]">Edit {doc.invoice.invoice_no}</h2>
            <p className="text-[13.5px] text-muted">{doc.invoice.customer_snapshot.name} · Date {formatDate(doc.invoice.invoice_date)} (kept unchanged)</p>
          </div>
          <button type="button" className="btn btn-small ml-auto" onClick={() => box.current?.close()}>Close</button>
        </div>
        <form onSubmit={(event) => void save(event)} onKeyDown={enterAdvances} className="grid gap-4 p-5" aria-label="Edit bill">
          <section aria-label="Edit items" className="grid gap-2">
            <div className="flex items-center justify-between">
              <h3 className="card-title text-base">Items</h3>
              <small className="text-[13px] text-muted">Total recalculates automatically</small>
            </div>
            {form.lines.map((line, i) => {
              const position = typedLines.indexOf(line);
              const computed = position >= 0 ? bill?.detail.lines[position] : undefined;
              const blank = f.isBlank(line);
              const named = (name: string): string => `${name}, edit line ${i + 1}`;
              return (
                <div key={line.key} className="grid grid-cols-6 items-start gap-2 border-t border-line pt-2.5 sm:grid-cols-[minmax(0,1fr)_5.2rem_4.4rem_6rem_5.6rem_4.6rem_6.4rem_2.2rem]">
                  <div className="col-span-5 sm:col-span-1">
                    <span className="mb-1 block text-[12.5px] font-semibold text-muted sm:hidden">Product</span>
                    <Typeahead
                      inputLabel={named('Product or ID')}
                      placeholder={i === 0 ? 'Product name, ID or code' : 'Add another item'}
                      text={line.text}
                      search={searchStuds}
                      onText={(text) => patchLine(line.key, (old) => f.typeText(old, text, form.type))}
                      onPick={(option) => patchLine(line.key, (old) => f.pickStud(old, option.value, form.type))}
                    />
                  </div>
                  <div className="col-span-2 sm:col-span-1">
                    <span className="mb-1 block text-[12.5px] font-semibold text-muted sm:hidden">Qty</span>
                    <input aria-label={named('Qty')} placeholder="Qty" className="field num px-2" inputMode="decimal" value={line.quantity} onChange={(event) => patchLine(line.key, (old) => ({ ...old, quantity: event.target.value.trim() }))} />
                  </div>
                  <div className="col-span-2 sm:col-span-1">
                    <span className="mb-1 block text-[12.5px] font-semibold text-muted sm:hidden">Unit</span>
                    <select aria-label={named('Unit')} data-enter-skip className="field px-1.5" value={line.unit} onChange={(event) => patchLine(line.key, (old) => f.changeUnit(old, event.target.value === 'kg' ? 'kg' : 'pcs', form.type))}>
                      <option value="pcs">pcs</option><option value="kg">kg</option>
                    </select>
                  </div>
                  <div className="col-span-2 sm:col-span-1">
                    <span className="mb-1 block text-[12.5px] font-semibold text-muted sm:hidden">Rate ₹</span>
                    <input aria-label={named('Rate ₹')} placeholder="Rate" className="field num px-2" inputMode="decimal" value={line.rate} onChange={(event) => patchLine(line.key, (old) => ({ ...old, rate: event.target.value.trim() }))} />
                  </div>
                  <div className="col-span-2 sm:col-span-1">
                    <span className="mb-1 block text-[12.5px] font-semibold text-muted sm:hidden">HSN</span>
                    <input aria-label={named('HSN/SAC')} data-enter-skip placeholder="HSN" className="field px-2" inputMode="numeric" value={line.hsn} onChange={(event) => patchLine(line.key, (old) => ({ ...old, hsn: event.target.value.trim() }))} />
                  </div>
                  <div className="col-span-2 sm:col-span-1">
                    <span className="mb-1 block text-[12.5px] font-semibold text-muted sm:hidden">GST %</span>
                    <input aria-label={named('GST %')} placeholder="GST %" className="field num px-2" inputMode="decimal" value={line.gst} onChange={(event) => patchLine(line.key, (old) => f.typeGst(old, event.target.value))} />
                  </div>
                  <div className="col-span-2 flex min-h-11.5 items-center justify-end sm:col-span-1">
                    <output aria-label={named('Amount')} className="num text-[16px] font-semibold">{computed ? formatPaise(computed.line_total_paise) : ''}</output>
                  </div>
                  <div className="col-start-6 row-start-1 sm:col-start-8">
                    {blank ? null : (
                      <button type="button" aria-label={`Remove edit line ${i + 1}`} className="grid min-h-11.5 w-full cursor-pointer place-items-center rounded-lg text-muted hover:bg-warn-bg hover:text-warn" onClick={() => setForm((old) => ({ ...old, lines: f.withTrailingBlank(old.lines.filter((other_) => other_.key !== line.key), old.type) }))}>✕</button>
                    )}
                  </div>
                </div>
              );
            })}
          </section>

          <section aria-label="Optional packing and delivery" className="border-t border-line pt-3">
            {chargesOpen ? (
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Packing ₹" hint="Optional · ₹0 if left blank"><input className="field num" inputMode="decimal" placeholder="0" value={form.packing} onChange={(event) => patch({ packing: event.target.value })} /></Field>
                <Field label="Freight ₹" hint={buyerPays ? 'Optional · ₹0 if left blank (on challan only)' : 'Optional · ₹0 if left blank'}><input className="field num" inputMode="decimal" placeholder="0" value={form.freight} onChange={(event) => patch({ freight: event.target.value })} /></Field>
                <Field label="Who pays the freight">
                  <select className="field" value={form.freightPaidBy} onChange={(event) => patch({ freightPaidBy: event.target.value === 'buyer_to_pay' ? 'buyer_to_pay' : 'seller' })}>
                    <option value="seller">We pay, add to bill</option><option value="buyer_to_pay">Customer pays the driver</option>
                  </select>
                </Field>
                {buyerPays || form.freight.trim() === '' ? null : (
                  <label className="flex items-center gap-2.5"><input className="size-5 accent-accent" type="checkbox" checked={form.deliveryTaxable} onChange={(event) => patch({ deliveryTaxable: event.target.checked })} /> GST on freight</label>
                )}
                {mixedRates.length > 1 ? (
                  <Field label="GST on charges">
                    <select className="field" value={form.chargesRate} onChange={(event) => patch({ chargesRate: event.target.value })}>
                      <option value="">Highest on the bill</option>
                      {mixedRates.map((rate) => <option key={rate} value={rate}>{rate}%</option>)}
                    </select>
                  </Field>
                ) : null}
              </div>
            ) : (
              <button type="button" className="btn btn-small" onClick={() => setChargesOpen(true)}>+ Packing or delivery charge (optional · ₹0 now)</button>
            )}
          </section>

          <div className="grid gap-3 border-t border-line pt-3 sm:grid-cols-3">
            <Field label="Due date"><input className="field" type="date" required min={form.invoiceDate} value={f.dueDateOf(form)} onChange={(event) => patch({ dueDate: event.target.value || null })} /></Field>
            <Field label="P.O. No."><input className="field" maxLength={40} placeholder="If there is one" value={form.poNo} onChange={(event) => patch({ poNo: event.target.value })} /></Field>
            <Field label="Note on bill"><input className="field" maxLength={1000} value={form.notes} onChange={(event) => patch({ notes: event.target.value })} /></Field>
          </div>

          <div className="rounded-[3px] border border-line bg-sunken p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <p className="small-head">New bill total</p>
                <p className="text-[13px] text-muted">{amounts ? rupeesInWords(amounts.grand_total_paise) : 'problem' in preview ? preview.problem : ''}</p>
              </div>
              <output aria-label="Edited bill total" className="text-[28px] leading-tight font-semibold" style={{ fontFamily: 'var(--font-display)' }}>{amounts ? formatInr(amounts.grand_total_paise) : '₹ —'}</output>
            </div>
            {amounts ? (
              <div className="mt-2.5 flex flex-wrap gap-x-5 gap-y-1 text-[14px] text-ink-2">
                <span>Items: <b className="tabular-nums">{formatPaise(amounts.subtotal_paise)}</b></span>
                {amounts.taxable_value_paise !== amounts.subtotal_paise ? <span>With charges: <b className="tabular-nums">{formatPaise(amounts.taxable_value_paise)}</b></span> : null}
                {amounts.igst_paise > 0 ? <span>IGST: <b className="tabular-nums">{formatPaise(amounts.igst_paise)}</b></span> : <><span>CGST: <b className="tabular-nums">{formatPaise(amounts.cgst_paise)}</b></span><span>SGST: <b className="tabular-nums">{formatPaise(amounts.sgst_paise)}</b></span></>}
                {amounts.round_off_paise !== 0 ? <span>Round-off: <b className="tabular-nums">{formatPaise(amounts.round_off_paise)}</b></span> : null}
              </div>
            ) : null}
          </div>

          {localError || error ? <Notice tone="warn">{localError ?? error}</Notice> : null}
          <button className="btn btn-primary min-h-13" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save bill changes'}</button>
        </form>
      </dialog>
    </>
  );
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
