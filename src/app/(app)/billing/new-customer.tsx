'use client';

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { CustomerChoice } from '@/components/customer-choice';
import { Field, Notice } from '@/components/field';
import { addCustomer, type Match } from '@/lib/add-customer';
import * as c from '@/lib/customer-form';
import { GST_STATES, isValidGstin, stateLabel } from '@/lib/india';
import { searchCustomers } from '@/lib/master-search';
import type { OfflineEngine } from '@/lib/offline';
import type { Customer } from '@/lib/schemas/masters';

const FIELDS = 'input, select, textarea, button[data-save]';

/** By name: typing its first letter finds a state. */
const STATES = Object.entries(GST_STATES).sort(([, a], [, b]) => a.localeCompare(b));

/**
 * A new customer, made without leaving the bill. Not a <form>: it lives inside the bill's own,
 * and Enter and Ctrl+Enter in here are about the customer, not about the bill.
 */
export function NewCustomer({ value, engine, onChange, onUse, onCancel }: {
  value: c.CustomerForm;
  engine: OfflineEngine | null;
  onChange: (value: c.CustomerForm) => void;
  /** `here`: only on this device so far. */
  onUse: (customer: Customer, here: boolean) => void;
  onCancel: () => void;
}) {
  const box = useRef<HTMLElement>(null);
  const working = useRef(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ field: c.CustomerField | null; message: string } | null>(null);
  const [match, setMatch] = useState<(Match & { asked: boolean }) | null>(null);
  // A new object each time, so the same box can be asked for again.
  const [cursor, setCursor] = useState<{ at: c.CustomerField }>(() => ({ at: c.firstField(value) }));
  const goTo = (at: c.CustomerField): void => setCursor({ at });

  // After a render, so a box that has just appeared can take the cursor too.
  useEffect(() => {
    const field = box.current?.querySelector<HTMLElement>(`[data-field="${cursor.at}"]`);
    field?.focus();
    if (field instanceof HTMLInputElement) field.select();
  }, [cursor]);

  // As soon as the GSTIN is complete: no need to type an address for somebody who is there already.
  const gstin = value.registered && isValidGstin(value.gstin) ? value.gstin : null;
  useEffect(() => {
    if (gstin === null) return;
    let left = false;
    void searchCustomers(gstin).then((found) => {
      const holder = found.find(({ value: one }) => one.gstin === gstin && one.id !== value.id);
      if (!left && holder) setMatch({ reason: 'gstin', candidates: [holder.value], asked: false });
    });
    return () => {
      left = true;
    };
  }, [gstin, value.id]);

  function set(change: Partial<c.CustomerForm>): void {
    setProblem(null);
    setMatch(null);
    onChange({ ...value, ...change });
  }

  async function save(typed: c.CustomerForm = value): Promise<void> {
    if (working.current) return;
    const wrong = c.customerProblem(typed);
    if (wrong) {
      setProblem(wrong);
      const hidden = wrong.field === 'creditDays' || wrong.field === 'openingBalance' || (wrong.field === 'address' && !typed.registered);
      if (hidden && !typed.more) onChange({ ...typed, more: true });
      return goTo(wrong.field);
    }
    working.current = true; // a second click must not start a second save
    setBusy(true);
    setProblem(null);
    setMatch(null);
    try {
      const added = await addCustomer(typed, engine);
      if ('customer' in added) return onUse(added.customer, added.here);
      if ('match' in added) setMatch({ ...added.match, asked: true });
      else setProblem({ field: null, message: added.problem });
    } catch {
      setProblem({ field: null, message: 'The customer could not be kept on this device. Try again.' });
    } finally {
      working.current = false;
      setBusy(false);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (event.key !== 'Enter') return;
    event.stopPropagation(); // not the bill's Enter
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      void save();
      return;
    }
    const target = event.target;
    if (event.shiftKey || event.altKey || !(target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement)) return;
    event.preventDefault();
    const fields = [...(box.current?.querySelectorAll<HTMLElement>(FIELDS) ?? [])].filter((field) => field.offsetParent !== null);
    fields[fields.indexOf(target) + 1]?.focus();
  }

  const wrongAt = (field: c.CustomerField): string | null => (problem?.field === field ? problem.message : null);
  const address = (
    <Field label={value.registered ? 'Address' : 'Address, if you have it'} error={wrongAt('address')} className="sm:col-span-2">
      <textarea data-field="address" className="field" rows={2} maxLength={500} autoComplete="off" value={value.address} onChange={(event) => set({ address: event.target.value })} />
    </Field>
  );

  return (
    <section ref={box} aria-label="New customer" onKeyDown={onKeyDown} className="card grid gap-3 border-accent sm:grid-cols-2">
      <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
        <h2 className="card-title">New customer</h2>
        <div className="flex gap-1" role="group" aria-label="GST registration">
          {([[false, 'No GSTIN'], [true, 'Has GSTIN']] as const).map(([registered, label]) => (
            <button
              key={label} type="button" aria-pressed={value.registered === registered} className={`btn ${value.registered === registered ? 'btn-primary' : ''}`}
              onClick={() => {
                set({ registered });
                goTo(registered ? 'gstin' : 'state');
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <Field label="Name" error={wrongAt('name')} className="sm:col-span-2">
        <input data-field="name" className="field" maxLength={120} autoComplete="off" value={value.name} onChange={(event) => set({ name: event.target.value })} />
      </Field>
      {value.registered ? (
        <Field label="GSTIN" error={wrongAt('gstin')} hint={gstin ? `State: ${stateLabel(c.stateOf(value))}, from the GSTIN` : (c.gstinHint(value.gstin) ?? '15 characters')}>
          <input data-field="gstin" className="field uppercase" autoComplete="off" value={value.gstin} onChange={(event) => set({ gstin: c.cleanGstin(event.target.value) })} />
        </Field>
      ) : (
        <Field label="State" hint="Decides the GST on the bill">
          <select data-field="state" className="field" value={value.state} onChange={(event) => set({ state: event.target.value })}>
            {STATES.map(([code]) => <option key={code} value={code}>{stateLabel(code)}</option>)}
          </select>
        </Field>
      )}
      <Field label="Phone" error={wrongAt('phone')}>
        <input data-field="phone" className="field" type="tel" maxLength={20} autoComplete="off" value={value.phone} onChange={(event) => set({ phone: event.target.value })} />
      </Field>
      {value.registered ? address : null}
      {value.more ? (
        <>
          {value.registered ? null : address}
          <Field label="Credit days" error={wrongAt('creditDays')}>
            <input data-field="creditDays" className="field num" inputMode="numeric" value={value.creditDays} onChange={(event) => set({ creditDays: event.target.value.trim() })} />
          </Field>
          <Field label="Opening balance ₹" error={wrongAt('openingBalance')} hint="Minus if we owe them">
            <input data-field="openingBalance" className="field num" inputMode="text" value={value.openingBalance} onChange={(event) => set({ openingBalance: event.target.value.trim() })} />
          </Field>
          {value.registered ? (
            <label className="flex items-center gap-2 self-center"><input className="size-5" type="checkbox" checked={value.isSez} onChange={(event) => set({ isSez: event.target.checked })} /> SEZ unit (IGST)</label>
          ) : null}
        </>
      ) : null}
      {match ? (
        <div className="sm:col-span-2">
          <CustomerChoice
            name={value.name} reason={match.reason} candidates={match.candidates} takeFocus={match.asked}
            onUse={async (customer) => {
              await engine?.chooseExisting(value.id, customer); // other bills that wait for this new customer
              onUse(customer, false);
            }}
            onDifferent={() => {
              const typed = { ...value, differentFrom: [...new Set([...value.differentFrom, ...match.candidates.map((one) => one.id)])] };
              onChange(typed);
              return save(typed);
            }}
            onFix={match.reason === 'gstin' ? () => {
              setMatch(null);
              goTo('gstin');
            } : undefined}
          />
        </div>
      ) : null}
      {problem?.field === null ? <div className="sm:col-span-2"><Notice tone="warn">{problem.message}</Notice></div> : null}
      <div className="flex flex-wrap gap-2 sm:col-span-2">
        <button data-save type="button" className="btn btn-primary" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save and use in this bill'}</button>
        <button type="button" className="btn" aria-expanded={value.more} onClick={() => set({ more: !value.more })}>{value.more ? 'Fewer details' : 'More details'}</button>
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </section>
  );
}
