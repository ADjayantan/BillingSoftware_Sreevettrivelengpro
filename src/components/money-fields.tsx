'use client';

import { formatInr, parseRupees } from '@/lib/money';
import { istDate } from '@/lib/india';
import { PAY_WAYS, type PayWay } from '@/lib/pay-ways';
import { Field } from './field';

export interface MoneyForm {
  amount: string;
  mode: PayWay;
  receivedOn: string;
  reference: string;
  settles: boolean;
}

/** What is written down about money that came in, for one bill. */
export function MoneyFields({ value, onChange, balancePaise }: { value: MoneyForm; onChange: (value: MoneyForm) => void; balancePaise: number }) {
  const set = (change: Partial<MoneyForm>): void => onChange({ ...value, ...change });
  const typed = parseRupees(value.amount);
  const short = typed !== null && typed > 0 && typed < balancePaise;
  return (
    <>
      {/* On a phone the way it came stands right below the amount. */}
      <div className="grid items-start gap-4 sm:grid-cols-[1.25fr_1fr_1.25fr] sm:gap-3">
        <Field label="Amount ₹" hint={`To collect on this bill: ${formatInr(balancePaise)}`} error={typed !== null && typed > balancePaise ? `More than this bill needs (${formatInr(balancePaise)})` : null}>
          <input
            className="field min-h-15.5 text-[27px] font-bold" name="amount" inputMode="decimal" required autoComplete="off" autoFocus value={value.amount}
            onFocus={(event) => event.target.select()} onChange={(event) => set({ amount: event.target.value.replace(/[₹,\s]/g, '') })}
          />
        </Field>
        <Field label="Date" className="max-sm:order-2"><input className="field sm:min-h-15.5" data-enter-skip type="date" required max={istDate(new Date())} value={value.receivedOn} onChange={(event) => set({ receivedOn: event.target.value })} suppressHydrationWarning /></Field>
        <Field label="Note" hint="UTR, cheque number, if there is one" className="max-sm:order-2"><input className="field sm:min-h-15.5" data-enter-skip maxLength={80} autoComplete="off" value={value.reference} onChange={(event) => set({ reference: event.target.value })} /></Field>
        <fieldset className="max-sm:order-1 sm:col-span-3">
          <legend className="mb-1 text-[13.5px] text-ink-2">How it came</legend>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
            {PAY_WAYS.map(([key, words]) => (
              <button
                key={key} type="button" aria-pressed={value.mode === key} onClick={() => set({ mode: key })}
                className={`min-h-12 cursor-pointer rounded-[3px] border font-semibold ${value.mode === key ? 'border-slate bg-slate text-white' : 'border-line-2 bg-card hover:border-slate'}`}
              >
                {words}
              </button>
            ))}
          </div>
        </fieldset>
      </div>
      {short || value.settles ? (
        <label className="flex items-center gap-2.5"><input className="size-5" type="checkbox" checked={value.settles} onChange={(event) => set({ settles: event.target.checked })} /> This settles the bill in full (TDS or discount)</label>
      ) : null}
    </>
  );
}
