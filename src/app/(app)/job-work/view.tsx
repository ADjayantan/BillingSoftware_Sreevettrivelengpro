'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent, type ReactNode } from 'react';
import { enterAdvances } from '@/components/enter-advance';
import { Field, Notice } from '@/components/field';
import { Icon } from '@/components/icon';
import { Typeahead } from '@/components/typeahead';
import { useAltN } from '@/components/use-alt-n';
import { api } from '@/lib/api-client';
import { searchCustomers } from '@/lib/master-search';
import { formatDate, istDate } from '@/lib/india';
import type { JobWorkLot } from '@/lib/schemas/masters';

export function JobWorkView({ rows, search, pager, openNew }: { rows: JobWorkLot[]; search: ReactNode; pager: ReactNode; openNew: boolean }) {
  const [editing, setEditing] = useState<JobWorkLot | 'new' | null>(openNew ? 'new' : null);
  useAltN(() => setEditing('new'));
  return (
    <>
      {editing ? <LotForm key={editing === 'new' ? 'new' : editing.id} lot={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
      <section className="card overflow-hidden p-0" aria-label="Customer material">
        <div className="flex flex-wrap gap-2 p-3">
          <div className="flex min-w-60 flex-1">{search}</div>
          <button className="btn btn-primary" type="button" onClick={() => setEditing('new')}><Icon name="plus" />Material came in<kbd className="kbd" data-alt-n>Alt N</kbd></button>
        </div>
        <div className="relative overflow-x-auto">
        <table className="grid-table">
          <thead><tr><th>Party DC</th><th>Date</th><th>Grade</th><th className="num">Came in kg</th><th className="num">Sent back kg</th><th className="num">Scrap kg</th><th className="num">Still here kg</th><th>State</th></tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td><button type="button" className="row-link" onClick={() => setEditing(row)}>{row.party_dc_no}</button></td>
                <td className="whitespace-nowrap">{formatDate(row.party_dc_date)}</td>
                <td>{row.material_grade}</td>
                <td className="num">{row.inward_weight_kg}</td>
                <td className="num">{row.outward_weight_kg}</td>
                <td className="num">{row.scrap_weight_kg}</td>
                <td className={`num font-semibold ${row.balance_weight_kg.startsWith('-') ? 'text-warn' : ''}`}>{row.balance_weight_kg}</td>
                <td>{row.status === 'open' ? 'Open' : `Closed${row.close_reason ? ` · ${row.close_reason}` : ''}`}</td>
              </tr>
            ))}
            {rows.length === 0 ? <tr><td colSpan={8} className="py-8 text-center text-muted">No customer material here yet.</td></tr> : null}
          </tbody>
        </table>
        </div>
        {pager}
      </section>
    </>
  );
}

function LotForm({ lot, onClose }: { lot: JobWorkLot | null; onClose: () => void }) {
  const router = useRouter();
  const [customerId, setCustomerId] = useState(lot?.customer_id ?? '');
  const [customerText, setCustomerText] = useState('');
  const [status, setStatus] = useState<JobWorkLot['status']>(lot?.status ?? 'open');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (name: string): string => String(form.get(name) ?? '').trim();
    if (!customerId) return setError('Pick the customer from the list');
    const body = {
      customer_id: customerId, party_dc_no: text('party_dc_no'), party_dc_date: text('party_dc_date'), material_grade: text('material_grade'),
      description: text('description'), inward_weight_kg: text('inward'), outward_weight_kg: text('outward') || '0', scrap_weight_kg: text('scrap') || '0',
      status, close_reason: status === 'closed' && text('close_reason') ? text('close_reason') : null, notes: lot?.notes ?? '',
    };
    setBusy(true);
    const result = await (lot ? api(`/api/job-work/${lot.id}`, 'PUT', body) : api('/api/job-work', 'POST', body));
    setBusy(false);
    if (!result.ok) return setError(result.message);
    onClose();
    router.refresh();
  }

  return (
    <form onSubmit={(event) => void save(event)} onKeyDown={enterAdvances} className="card mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label={lot ? 'Change material' : 'Material came in'}>
      {lot ? null : (
        <Field label="Customer" className="xl:col-span-2">
          <Typeahead inputLabel="Customer" autoFocus text={customerText} picked={customerId !== ''} onText={(value) => { setCustomerText(value); setCustomerId(''); }} search={searchCustomers}
            onPick={(option) => { setCustomerText(option.label); setCustomerId(option.value.id); }} />
        </Field>
      )}
      <Field label="Party DC number"><input className="field" name="party_dc_no" defaultValue={lot?.party_dc_no} required maxLength={40} /></Field>
      <Field label="Party DC date"><input className="field" name="party_dc_date" type="date" defaultValue={lot?.party_dc_date ?? istDate(new Date())} required /></Field>
      <Field label="Grade"><input className="field uppercase" name="material_grade" defaultValue={lot?.material_grade} required maxLength={30} /></Field>
      <Field label="Came in kg"><input className="field num" name="inward" inputMode="decimal" defaultValue={lot?.inward_weight_kg} required /></Field>
      {lot ? (
        <>
          <Field label="Sent back kg" hint="Bills add to this"><input className="field num" name="outward" inputMode="decimal" defaultValue={lot.outward_weight_kg} /></Field>
          <Field label="Scrap kg"><input className="field num" name="scrap" inputMode="decimal" defaultValue={lot.scrap_weight_kg} /></Field>
          <Field label="State">
            <select className="field" value={status} onChange={(event) => setStatus(event.target.value === 'closed' ? 'closed' : 'open')}>
              <option value="open">Open</option><option value="closed">Closed</option>
            </select>
          </Field>
          {status === 'closed' ? (
            <Field label="Reason" hint="Needed if more than 1% of what came in is left"><input className="field" name="close_reason" defaultValue={lot.close_reason ?? ''} maxLength={300} /></Field>
          ) : null}
        </>
      ) : null}
      <Field label="Material" className="sm:col-span-2"><input className="field" name="description" defaultValue={lot?.description ?? ''} maxLength={300} placeholder="12 mm rods, 3 m" /></Field>
      {error ? <div className="sm:col-span-2 xl:col-span-4"><Notice tone="warn">{error}</Notice></div> : null}
      <div className="flex gap-2 sm:col-span-2 xl:col-span-4">
        <button className="btn btn-primary" type="submit" disabled={busy}>Save</button>
        <button className="btn" type="button" onClick={onClose}>Close</button>
      </div>
    </form>
  );
}
