'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState, type FormEvent } from 'react';
import { enterAdvances } from '@/components/enter-advance';
import { Field, Notice } from '@/components/field';
import { Icon } from '@/components/icon';
import { MoneyFields, type MoneyForm } from '@/components/money-fields';
import { Pill } from '@/components/pill';
import { Typeahead } from '@/components/typeahead';
import { api } from '@/lib/api-client';
import { billState } from '@/lib/bill-state';
import { outstandingPaise } from '@/lib/billing-math';
import { istDate } from '@/lib/india';
import { searchCustomers } from '@/lib/master-search';
import { decimalToPaise, formatInr, formatRupees, paiseToDecimal, parseRupees } from '@/lib/money';
import type { BillsFound, FoundBill } from '@/lib/schemas/home';

const owed = (bill: FoundBill): number => outstandingPaise(decimalToPaise(bill.grand_total), decimalToPaise(bill.amount_paid));

/** Money that came in: whose, for which bill, how much. The oldest bill comes first by itself. */
export function TakeMoney() {
  const router = useRouter();
  const [text, setText] = useState('');
  const [bills, setBills] = useState<{ rows: FoundBill[]; more: boolean } | null>(null);
  const [chosen, setChosen] = useState<FoundBill | null>(null);
  const [form, setForm] = useState<MoneyForm | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  const asked = useRef(0);
  // Kept until a receipt is saved, so a retry after a lost reply cannot record it twice.
  const receiptId = useRef<string | null>(null);

  function choose(bill: FoundBill): void {
    receiptId.current = null; // another bill is another receipt
    setChosen(bill);
    setForm({ amount: paiseToDecimal(owed(bill)), mode: form?.mode ?? 'upi', receivedOn: istDate(new Date()), reference: '', settles: false });
    setError(null);
  }

  function clear(): void {
    asked.current += 1;
    receiptId.current = null;
    setBills(null);
    setChosen(null);
    setForm(null);
    setError(null);
  }

  async function open(customerId: string): Promise<void> {
    clear();
    setSaved(null);
    const ticket = asked.current;
    const reply = await api<BillsFound & { hasMore: boolean }>(`/api/invoices?${new URLSearchParams({ show: 'open', customer: customerId }).toString()}`);
    if (ticket !== asked.current) return; // another customer was picked meanwhile
    if (!reply.ok) return setError(reply.message);
    setBills({ rows: reply.data.rows, more: reply.data.hasMore });
    const [oldest] = reply.data.rows;
    if (oldest) choose(oldest);
  }

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!chosen || !form || busy) return;
    const typed = parseRupees(form.amount);
    if (typed === null || typed === 0) return setError('Type the amount, like 1500 or 1500.50');
    if (typed > owed(chosen)) return setError(`This bill needs ${formatInr(owed(chosen))}. Write down the rest on another bill.`);
    setBusy(true);
    setError(null);
    receiptId.current ??= crypto.randomUUID();
    const reply = await api(`/api/invoices/${chosen.id}/payments`, 'POST', {
      client_receipt_id: receiptId.current, amount: form.amount.trim(), received_on: form.receivedOn, mode: form.mode, reference: form.reference, settles_invoice: form.settles,
    });
    setBusy(false);
    if (!reply.ok) return setError(reply.message);
    setSaved(`${formatInr(typed)} from ${chosen.customer} for ${chosen.invoice_no} is saved`);
    setText('');
    clear();
    setRound((count) => count + 1);
    router.refresh();
  }

  const today = istDate(new Date());
  return (
    <form onSubmit={(event) => void save(event)} onKeyDown={enterAdvances} className="card mb-4 grid gap-4" aria-label="Write down money">
      {saved ? <Notice>{saved}</Notice> : null}
      <Field label="Who paid">
        <Typeahead
          key={round} inputLabel="Who paid" autoFocus placeholder="Customer name, phone or GSTIN" text={text} search={searchCustomers}
          onText={(value) => {
            setText(value);
            clear();
          }}
          onPick={(option) => {
            setText(option.label);
            void open(option.value.id);
          }}
        />
      </Field>
      {bills && bills.rows.length === 0 ? <p className="text-muted">{text} owes nothing. Every bill is paid.</p> : null}
      {bills && bills.rows.length > 0 ? (
        <fieldset>
          <legend className="mb-1 text-[13.5px] font-semibold text-ink-2">For which bill</legend>
          <div className="max-h-80 overflow-y-auto rounded-[3px] border border-line">
            {bills.rows.map((bill) => {
              const state = billState(bill, today);
              return (
                <label key={bill.id} className={`flex cursor-pointer items-center gap-3 border-b border-line px-3.5 py-2.5 last:border-0 ${chosen?.id === bill.id ? 'bg-soft shadow-[inset_3px_0_0_var(--accent)]' : 'hover:bg-sunken'}`}>
                  <input type="radio" name="bill" data-enter-skip className="size-5 accent-accent" checked={chosen?.id === bill.id} onChange={() => choose(bill)} />
                  <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-0.5"><b className="font-semibold">{bill.invoice_no}</b><Pill kind={state.kind}>{state.text}</Pill></span>
                  <b className="font-bold whitespace-nowrap">{formatRupees(owed(bill))}</b>
                </label>
              );
            })}
          </div>
          {bills.more ? <p className="mt-1 text-sm text-muted">Only the oldest bills are shown. Find others in Bills.</p> : null}
        </fieldset>
      ) : null}
      {chosen && form ? <MoneyFields key={chosen.id} value={form} onChange={setForm} balancePaise={owed(chosen)} /> : null}
      {error ? <Notice tone="warn">{error}</Notice> : null}
      {chosen && form ? <button className="btn btn-primary min-h-13" type="submit" disabled={busy}><Icon name="check" />{busy ? 'Saving…' : 'Save'}</button> : null}
    </form>
  );
}
