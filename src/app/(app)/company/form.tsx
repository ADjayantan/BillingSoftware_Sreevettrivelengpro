'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { enterAdvances } from '@/components/enter-advance';
import { Field, Notice } from '@/components/field';
import { api } from '@/lib/api-client';
import { keepCompanyName } from '@/lib/company-name';
import type { Company } from '@/lib/schemas/masters';

interface Box {
  name: keyof Company;
  label: string;
  max: number;
  hint?: string;
  required?: true;
  /** An address, on lines of its own. */
  wide?: true;
  upper?: true;
}

/** In the order in which they stand on the bill. */
const HEAD: readonly Box[] = [
  { name: 'legal_name', label: 'Company name', max: 120, required: true },
  { name: 'tagline', label: 'Line under the name', max: 160, hint: 'For example: Mfrs : MS and SS studs, pump spares' },
  { name: 'address', label: 'Office address', max: 500, required: true, wide: true },
  { name: 'factory_address', label: 'Factory address', max: 500, hint: 'Leave empty if it is the same place', wide: true },
  { name: 'office_phone', label: 'Office phone', max: 40, hint: 'As it should stand on the bill: 0422 - 1234567' },
  { name: 'phone', label: 'Mobile', max: 16 },
  { name: 'email', label: 'E-mail', max: 120 },
  { name: 'gstin', label: 'GSTIN', max: 15, hint: '15 letters and digits; the 14th is the letter Z', required: true, upper: true },
];
const BANK: readonly Box[] = [
  { name: 'bank_name', label: 'Bank', max: 80 },
  { name: 'bank_branch', label: 'Branch', max: 80 },
  { name: 'bank_account_no', label: 'Account number', max: 20 },
  { name: 'bank_ifsc', label: 'IFSC', max: 11, upper: true },
];

export function CompanyForm({ company }: { company: Company | null }) {
  const router = useRouter();
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
    if (!result.ok) return;
    keepCompanyName(String(body.legal_name ?? '').trim()); // in the menu
    router.refresh(); // the sample below
  }

  const box = ({ name, label, max, hint, required, wide, upper }: Box) => {
    const shared = { className: `field ${upper ? 'uppercase' : ''}`, name, maxLength: max, defaultValue: company?.[name] ?? '', required };
    return (
      <Field key={name} label={label} hint={hint} className={wide ? 'sm:col-span-2' : ''}>
        {wide ? <textarea rows={2} {...shared} /> : <input {...shared} />}
      </Field>
    );
  };

  return (
    <form onSubmit={(event) => void save(event)} onKeyDown={enterAdvances} className="card grid gap-3 sm:grid-cols-2" aria-label="Company details">
      <h2 className="card-title sm:col-span-2">Top of the bill</h2>
      {HEAD.map(box)}
      <h2 className="card-title mt-2 sm:col-span-2">Bank on the bill</h2>
      {BANK.map(box)}
      {message ? <div className="sm:col-span-2"><Notice tone={message.tone}>{message.text}</Notice></div> : null}
      <button className="btn btn-primary w-fit" type="submit" disabled={busy}>Save company</button>
    </form>
  );
}
