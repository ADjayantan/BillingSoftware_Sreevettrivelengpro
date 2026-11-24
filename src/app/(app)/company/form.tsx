'use client';

import { useState, type FormEvent } from 'react';
import { enterAdvances } from '@/components/enter-advance';
import { Field, Notice } from '@/components/field';
import { api } from '@/lib/api-client';
import type { Company } from '@/lib/schemas/masters';

const FIELDS = [
  ['legal_name', 'Legal name', 120], ['gstin', 'GSTIN', 15], ['phone', 'Phone', 16], ['email', 'Email', 120], ['bank_name', 'Bank', 80],
  ['bank_branch', 'Branch', 80], ['bank_account_no', 'Account number', 20], ['bank_ifsc', 'IFSC', 11],
] as const;

export function CompanyForm({ company }: { company: Company | null }) {
  const [message, setMessage] = useState<{ tone: 'info' | 'warn'; text: string } | null>(
    company ? null : { tone: 'warn', text: 'Fill this in before the first bill.' },
  );
  const [busy, setBusy] = useState(false);

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(event.currentTarget));
    setBusy(true);
    const result = await api('/api/company', 'PUT', body);
    setBusy(false);
    setMessage(result.ok ? { tone: 'info', text: 'Saved. New bills will show these details.' } : { tone: 'warn', text: result.message });
  }

  return (
    <form onSubmit={(event) => void save(event)} onKeyDown={enterAdvances} className="card grid gap-3 sm:grid-cols-2" aria-label="Company details">
      {FIELDS.map(([name, label, max]) => (
        <Field key={name} label={label}>
          <input className={`field ${name === 'gstin' || name === 'bank_ifsc' ? 'uppercase' : ''}`} name={name} maxLength={max} defaultValue={company?.[name] ?? ''} required={name === 'legal_name' || name === 'gstin'} />
        </Field>
      ))}
      <Field label="Address" className="sm:col-span-2"><textarea className="field" name="address" rows={2} maxLength={500} required defaultValue={company?.address ?? ''} /></Field>
      {message ? <div className="sm:col-span-2"><Notice tone={message.tone}>{message.text}</Notice></div> : null}
      <button className="btn btn-primary w-fit" type="submit" disabled={busy}>Save company</button>
    </form>
  );
}
