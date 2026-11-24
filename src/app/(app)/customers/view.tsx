'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent, type ReactNode } from 'react';
import { enterAdvances } from '@/components/enter-advance';
import { Field, Notice } from '@/components/field';
import { useAltN } from '@/components/use-alt-n';
import { api } from '@/lib/api-client';
import { GST_STATES, isValidGstin, stateLabel } from '@/lib/india';
import { decimalToPaise, formatInr } from '@/lib/money';
import type { Customer } from '@/lib/schemas/masters';

export function CustomersView({ rows, search }: { rows: Customer[]; search: ReactNode }) {
  const [editing, setEditing] = useState<Customer | 'new' | null>(null);
  useAltN(() => setEditing('new'));
  return (
    <>
      <div className="mb-3 flex flex-wrap items-start gap-3">
        <div className="min-w-64 flex-1">{search}</div>
        <button className="btn btn-primary" type="button" onClick={() => setEditing('new')}>New customer (Alt+N)</button>
      </div>
      {editing ? <CustomerForm key={editing === 'new' ? 'new' : editing.id} customer={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
      <div className="card overflow-x-auto p-0">
        <table className="grid-table">
          <thead><tr><th>Name</th><th>GSTIN</th><th>State</th><th className="num">Credit days</th><th className="num">Opening balance</th></tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className={row.is_active ? '' : 'opacity-60'}>
                <td>
                  <button type="button" className="cursor-pointer text-left font-semibold text-accent underline" onClick={() => setEditing(row)}>{row.name}</button>
                  {row.is_active ? null : <span className="ml-2 text-sm">inactive</span>}
                </td>
                <td>{row.gstin ?? 'Unregistered'}{row.is_sez ? <span className="ml-2 rounded border border-line px-1 text-sm">SEZ</span> : null}</td>
                <td>{stateLabel(row.state_code)}</td>
                <td className="num">{row.credit_days}</td>
                <td className="num">{formatInr(decimalToPaise(row.opening_balance))}</td>
              </tr>
            ))}
            {rows.length === 0 ? <tr><td colSpan={5} className="text-muted">No customers here yet.</td></tr> : null}
          </tbody>
        </table>
      </div>
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
    <form onSubmit={save} onKeyDown={enterAdvances} className="card mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label={customer ? 'Edit customer' : 'New customer'}>
      <Field label="Name" className="lg:col-span-2"><input className="field" name="name" defaultValue={customer?.name} required maxLength={120} autoFocus /></Field>
      <Field label="GSTIN" error={gstinProblem} hint={gstin.length === 15 ? 'Valid' : 'Leave empty if unregistered'}>
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
        <label className="flex items-center gap-2"><input className="size-5" type="checkbox" name="is_active" defaultChecked={customer?.is_active ?? true} /> Active</label>
      </div>
      <Field label="Address" className="sm:col-span-2 lg:col-span-4"><textarea className="field" name="address" rows={2} maxLength={500} defaultValue={customer?.address ?? ''} /></Field>
      {error ? <div className="sm:col-span-2 lg:col-span-4"><Notice tone="warn">{error}</Notice></div> : null}
      <div className="flex flex-wrap gap-2 sm:col-span-2 lg:col-span-4">
        <button className="btn btn-primary" type="submit" disabled={busy || gstinProblem !== null}>Save customer</button>
        <button className="btn" type="button" onClick={onClose}>Close</button>
        {customer ? <button className="btn ml-auto text-warn" type="button" disabled={busy} onClick={remove}>Delete</button> : null}
      </div>
    </form>
  );
}
