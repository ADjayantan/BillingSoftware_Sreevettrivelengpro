'use client';

import { useState, type FormEvent } from 'react';
import { Field, Notice } from '@/components/field';
import { api } from '@/lib/api-client';
import { formatTime } from '@/lib/india';
import { rateText } from '@/lib/money';
import type { AlertRule, MetalRate } from '@/lib/schemas/home';

interface ParseDealerReply {
  normalized_rates: { material_grade: string }[];
  parsed_json: { unpriced_mentions: { raw_fragment: string; reason: string }[] };
  should_notify: boolean;
  telegram_text: string | null;
}

/** These stand in the list even before their first rate. */
const GRADES = ['MS', 'EN8', 'EN19', 'SS 304', 'SS 316', 'BRASS'] as const;
const name = (grade: string): string => (grade === 'BRASS' ? 'Brass' : grade);

export function RatesView({ initialRates, rules }: { initialRates: readonly MetalRate[]; rules: readonly AlertRule[] }) {
  const [rates, setRates] = useState(initialRates);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ParseDealerReply | null>(null);

  const grades = [...new Set<string>([...GRADES, ...rates.map((rate) => rate.material_grade)])];

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!message.trim() || busy) return;
    setBusy(true);
    setError(null);
    const reply = await api<ParseDealerReply>('/api/metal-rates', 'POST', { raw_message: message.trim(), source_channel: 'manual' });
    if (!reply.ok) {
      setBusy(false);
      return setError(reply.message);
    }
    setResult(reply.data);
    setMessage('');
    const fresh = await api<{ rates: MetalRate[] }>('/api/metal-rates');
    if (fresh.ok) setRates(fresh.data.rates);
    setBusy(false);
  }

  return (
    <div className="grid gap-4">
      <section className="card relative overflow-x-auto p-0" aria-label="Rates">
        <table className="grid-table">
          <thead><tr><th>Grade</th><th className="num">Rate ₹ a kg</th><th className="num max-side:hidden">Before</th><th className="num">Change</th><th className="num max-side:hidden">Tell me from</th><th className="max-side:hidden">Since</th></tr></thead>
          <tbody>
            {grades.map((grade) => {
              const rate = rates.find((one) => one.material_grade === grade);
              const rule = rules.find((one) => one.material_grade === grade && one.is_active);
              const change = rate?.change_delta && /[1-9]/.test(rate.change_delta) ? rate.change_delta : null;
              const big = change !== null && rule !== undefined && Math.abs(Number(change)) >= Number(rule.threshold_rs_per_kg);
              return (
                <tr key={grade}>
                  <td className="font-semibold">{name(grade)}</td>
                  <td className="num font-semibold">{rate ? rateText(rate.rate_per_kg) : '—'}</td>
                  <td className="num text-muted max-side:hidden">{rate?.previous_rate_per_kg ? rateText(rate.previous_rate_per_kg) : '—'}</td>
                  <td className={`num ${big ? 'font-semibold text-warn' : ''}`}>{change === null ? '—' : `${change.startsWith('-') ? 'down' : 'up'} ${rateText(change.replace('-', ''))}`}</td>
                  <td className="num text-muted max-side:hidden">{rule ? rateText(rule.threshold_rs_per_kg) : 'off'}</td>
                  <td className="whitespace-nowrap text-muted max-side:hidden">{rate ? formatTime(Date.parse(rate.recorded_at)) : ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <form onSubmit={(event) => void submit(event)} className="card grid gap-3" aria-label="New rates">
        <h2 className="card-title">New rates</h2>
        <Field label="Message from the dealer" hint="Paste the WhatsApp message as it is. The rates are read out of it.">
          <textarea className="field min-h-28" placeholder={'Rod rates today, Rs/kg\nMS round 58.25 | EN8 84.25 | EN19 116.50 | SS 304 211.75'} value={message} onChange={(event) => setMessage(event.target.value)} />
        </Field>
        {error ? <Notice tone="warn">{error}</Notice> : null}
        <button type="submit" className="btn btn-primary w-fit" disabled={busy || message.trim() === ''}>{busy ? 'Reading…' : 'Read the rates'}</button>
        {result ? (
          <div role="status" className="grid gap-2 rounded-[10px] border border-line bg-sunken p-3 text-[15px]">
            <p className="font-semibold">{result.normalized_rates.length === 0 ? 'No new rate was found.' : `${result.normalized_rates.map((rate) => name(rate.material_grade)).join(', ')} updated.`}{result.should_notify ? ' The change is over your limit.' : ''}</p>
            {result.telegram_text ? <pre className="rounded-lg bg-card p-2.5 text-sm whitespace-pre-wrap">{result.telegram_text}</pre> : null}
            {result.parsed_json.unpriced_mentions.length > 0 ? <p className="text-muted">Not used, the rate was not clear: {result.parsed_json.unpriced_mentions.map((one) => one.raw_fragment).join('; ')}</p> : null}
          </div>
        ) : null}
      </form>
    </div>
  );
}
