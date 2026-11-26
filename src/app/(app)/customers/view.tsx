'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent, type ReactNode } from 'react';
import { enterAdvances } from '@/components/enter-advance';
import { Field, Notice } from '@/components/field';
import { Icon } from '@/components/icon';
import { useAltN } from '@/components/use-alt-n';
import { api } from '@/lib/api-client';
import { GST_STATES, daysBetween, isValidGstin, stateLabel } from '@/lib/india';
import { initials } from '@/lib/look';
import { decimalToPaise, formatRupees } from '@/lib/money';
import type { CustomerBalance } from '@/lib/schemas/home';
import type { Customer } from '@/lib/schemas/masters';

const rupees = (decimal: string): string => formatRupees(Math.abs(decimalToPaise(decimal)));

/** What a customer owes: on bills, of which late, and with the dues from before. A minus is what we owe them. */
function Balance({ row, today }: { row: CustomerBalance; today: string }) {
  const balance = decimalToPaise(row.balance);
  const before = decimalToPaise(row.opening_balance);
  const late = decimalToPaise(row.overdue);
  const href = `/invoices?customer=${row.id}${row.bills > 0 ? '&show=open' : ''}`;
  return (
    <Link href={href} prefetch={false} className="block hover:underline">
      <b className={`block font-semibold whitespace-nowrap ${balance === 0 ? 'font-normal text-muted' : ''}`}>{balance === 0 ? '—' : rupees(row.balance)}</b>
      {balance < 0 ? <small className="block text-[13px] text-paid">we owe them</small> : null}
      {before > 0 ? <small className="block text-[13px] text-muted">{decimalToPaise(row.on_bills) === 0 ? 'from before' : `${rupees(row.opening_balance)} of it from before`}</small> : null}
      {before < 0 && balance > 0 ? <small className="block text-[13px] text-muted">less {rupees(row.opening_balance)} we owe them</small> : null}
      {late > 0 ? <small className="block text-[13px] font-semibold text-warn lg:hidden">{rupees(row.overdue)} late</small> : null}
      {late > 0 && row.oldest ? <small className="block text-[13px] text-warn max-lg:hidden">oldest {daysBetween(row.oldest, today)} days</small> : null}
    </Link>
  );
}

export function CustomersView({ rows, today, search, order, pager, openNew }: {
  rows: CustomerBalance[];
  today: string;
  search: ReactNode;
  /** By name, or who owes most first. */
  order: ReactNode;
  pager: ReactNode;
  openNew: boolean;
}) {
  const [editing, setEditing] = useState<Customer | 'new' | null>(openNew ? 'new' : null);
  useAltN(() => setEditing('new'));
  return (
    <>
      {editing ? <CustomerForm key={editing === 'new' ? 'new' : editing.id} customer={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
      <section className="card overflow-hidden p-0" aria-label="Customers">
        <div className="flex flex-wrap gap-2 p-3">
          <div className="flex min-w-60 flex-1">{search}</div>
          {order}
          <button className="btn btn-primary" type="button" onClick={() => setEditing('new')}><Icon name="plus" />New customer<kbd className="kbd" data-alt-n>Alt N</kbd></button>
        </div>
        <div className="relative overflow-x-auto">
        <table className="grid-table">
          <thead className="max-lg:sr-only"><tr><th>Customer</th><th>GSTIN</th><th className="num">Bills to collect</th><th className="num">Late</th><th className="num">Balance</th></tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className={row.is_active ? '' : 'opacity-60'}>
                <td>
                  <span className="flex items-center gap-3">
                    <span className="face max-side:hidden" aria-hidden>{initials(row.name)}</span>
                    <span className="min-w-0">
                      <button type="button" className="row-link wrap-anywhere" onClick={() => setEditing(row)}>{row.name}</button>
                      <small className="block text-[13px] text-muted">
                        {[row.phone, row.is_active ? null : 'not in use'].filter(Boolean).join(' · ')}
                        <span className="max-lg:hidden">{row.phone ? ' · ' : ''}{stateLabel(row.state_code)} · {row.credit_days} days credit</span>
                        <span className="block lg:hidden">{row.gstin ?? 'No GSTIN'}</span>
                      </small>
                    </span>
                  </span>
                </td>
                <td className="whitespace-nowrap max-lg:hidden">{row.gstin ?? <span className="text-muted">No GSTIN</span>}{row.is_sez ? <span className="ml-2 rounded-[2px] border border-line-2 px-1 text-sm">SEZ</span> : null}</td>
                <td className="num whitespace-nowrap max-lg:hidden">{row.bills === 0 ? <span className="text-muted">—</span> : <Link href={`/invoices?customer=${row.id}&show=open`} prefetch={false} className="row-link font-normal">{row.bills} bill{row.bills === 1 ? '' : 's'}</Link>}</td>
                <td className="num whitespace-nowrap max-lg:hidden">{decimalToPaise(row.overdue) === 0 ? <span className="text-muted">—</span> : <b className="font-semibold text-warn">{rupees(row.overdue)}</b>}</td>
                <td className="num max-lg:text-right"><Balance row={row} today={today} /></td>
              </tr>
            ))}
            {rows.length === 0 ? <tr><td colSpan={5} className="py-8 text-center text-muted">No customers here yet.</td></tr> : null}
          </tbody>
        </table>
        </div>
        {pager}
      </section>
    </>
  );
}

function CustomerForm({ customer, onClose }: { customer: Customer | null; onClose: () => void }) {
  const router = useRouter();
  const [gstin, setGstin] = useState(customer?.gstin ?? '');
  const [state, setState] = useState(customer?.state_code ?? '33');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const gstinProblem =
    gstin === '' ? null
    : gstin.length < 15 ? (gstin.length === 0 ? null : `${15 - gstin.length} more characters`)
    : !isValidGstin(gstin) ? 'Not a valid GSTIN: check each character'
    : null;

  async function finish(result: Promise<{ ok: boolean; message?: string }>): Promise<void> {
    setBusy(true);
    const outcome = await result;
    setBusy(false);
    if (!outcome.ok) return setError(outcome.message ?? 'Could not save');
    onClose();
    router.refresh();
  }

  function save(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (name: string): string => String(form.get(name) ?? '');
    const body = {
      name: text('name'), gstin, phone: text('phone'), state_code: state, is_sez: form.has('is_sez'),
      credit_days: Number(text('credit_days')), address: text('address'), opening_balance: text('opening_balance') || '0', is_active: form.has('is_active'),
    };
    void finish(customer ? api(`/api/customers/${customer.id}`, 'PUT', body) : api('/api/customers', 'POST', body));
  }

  function remove(): void {
    if (!customer || !window.confirm(`Delete ${customer.name}? Customers with bills cannot be deleted.`)) return;
    void finish(api(`/api/customers/${customer.id}`, 'DELETE'));
  }

  return (
    <form onSubmit={save} onKeyDown={enterAdvances} className="card mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label={customer ? 'Edit customer' : 'New customer'}>
      <Field label="Name" className="xl:col-span-2"><input className="field" name="name" defaultValue={customer?.name} required maxLength={120} autoFocus /></Field>
      <Field label="GSTIN" error={gstinProblem} hint={gstin.length === 15 ? 'Correct' : 'Leave empty if there is none'}>
        <input
          className="field uppercase"
          value={gstin}
          maxLength={15}
          autoComplete="off"
          aria-invalid={gstinProblem !== null}
          onChange={(event) => {
            const value = event.target.value.toUpperCase().replace(/[^0-9A-Z]/g, '');
            setGstin(value);
            const code = value.slice(0, 2);
            if (code in GST_STATES) setState(code);
          }}
        />
      </Field>
      <Field label="State">
        <select className="field" value={state} onChange={(event) => setState(event.target.value)}>
          {Object.entries(GST_STATES).map(([code, name]) => <option key={code} value={code}>{code} · {name}</option>)}
        </select>
      </Field>
      <Field label="Phone"><input className="field" name="phone" type="tel" defaultValue={customer?.phone ?? ''} /></Field>
      <Field label="Credit days"><input className="field" name="credit_days" type="number" min={0} max={365} defaultValue={customer?.credit_days ?? 30} required /></Field>
      <Field label="Opening balance ₹" hint="Minus if we owe them"><input className="field num" name="opening_balance" inputMode="decimal" defaultValue={customer?.opening_balance ?? '0'} /></Field>
      <div className="flex flex-col justify-center gap-2">
        <label className="flex items-center gap-2"><input className="size-5" type="checkbox" name="is_sez" defaultChecked={customer?.is_sez} /> SEZ unit (IGST)</label>
        <label className="flex items-center gap-2"><input className="size-5" type="checkbox" name="is_active" defaultChecked={customer?.is_active ?? true} /> In use</label>
      </div>
      <Field label="Address" className="sm:col-span-2 xl:col-span-4"><textarea className="field" name="address" rows={2} maxLength={500} defaultValue={customer?.address ?? ''} /></Field>
      {error ? <div className="sm:col-span-2 xl:col-span-4"><Notice tone="warn">{error}</Notice></div> : null}
      <div className="flex flex-wrap gap-2 sm:col-span-2 xl:col-span-4">
        <button className="btn btn-primary" type="submit" disabled={busy || gstinProblem !== null}>Save customer</button>
        <button className="btn" type="button" onClick={onClose}>Close</button>
        {customer ? <button className="btn ml-auto text-warn" type="button" disabled={busy} onClick={remove}>Delete</button> : null}
      </div>
    </form>
  );
}
