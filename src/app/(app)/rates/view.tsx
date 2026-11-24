'use client';

import { useState, type FormEvent } from 'react';
import { Field, Notice } from '@/components/field';
import { api } from '@/lib/api-client';

export interface MetalRateItem {
  id?: string;
  material_grade: string;
  rate_per_kg: string;
  previous_rate_per_kg: string | null;
  change_delta: string | null;
  source?: string;
  recorded_at?: string;
}

export interface AlertRuleItem {
  id?: string;
  material_grade: string;
  threshold_rs_per_kg: string;
  telegram_chat_id: string;
  is_active: boolean;
}

interface ParseDealerReply {
  normalized_rates: Array<{
    material_grade: string;
    rate_per_kg: string;
    previous_rate_per_kg: string | null;
    change_delta: string | null;
    triggered: boolean;
  }>;
  parsed_json: {
    unpriced_mentions: Array<{ raw_fragment: string; reason: string }>;
  };
  should_notify: boolean;
  telegram_text: string | null;
}

const GRADE_ORDER = ['MS', 'EN8', 'EN19', 'SS 304', 'SS 316', 'BRASS'] as const;

export function RatesView({
  initialRates,
  initialRules,
}: {
  initialRates: MetalRateItem[];
  initialRules: AlertRuleItem[];
}) {
  const [rates, setRates] = useState<MetalRateItem[]>(initialRates);
  const [rules] = useState<AlertRuleItem[]>(initialRules);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<ParseDealerReply | null>(null);

  const rulesByGrade = new Map(rules.map((r) => [r.material_grade.toUpperCase(), r]));
  const ratesByGrade = new Map(rates.map((r) => [r.material_grade.toUpperCase(), r]));

  async function submitDealerMessage(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!message.trim() || busy) return;
    setBusy(true);
    setError(null);
    const res = await api<ParseDealerReply>('/api/metal-rates', 'POST', {
      raw_message: message.trim(),
      source_channel: 'manual',
    });
    if (!res.ok) {
      setBusy(false);
      setError(res.message);
      return;
    }
    setLastResult(res.data);
    setMessage('');
    const refreshed = await api<{ rates: MetalRateItem[]; rules: AlertRuleItem[] }>('/api/metal-rates');
    if (refreshed.ok) setRates(refreshed.data.rates);
    setBusy(false);
  }

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold">Rod metal rates &amp; spike alerts</h1>
        <p className="text-sm text-muted">Used by live Margin Watchdog on supply bills</p>
      </div>

      <section className="card grid gap-3" aria-label="Latest metal rates">
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-line text-sm text-muted">
                <th className="py-2 pr-3">Grade</th>
                <th className="py-2 pr-3 text-right">Today ₹/kg</th>
                <th className="py-2 pr-3 text-right">Previous ₹/kg</th>
                <th className="py-2 pr-3 text-right">Delta ₹/kg</th>
                <th className="py-2 text-right">Alert threshold</th>
              </tr>
            </thead>
            <tbody>
              {GRADE_ORDER.map((grade) => {
                const row = ratesByGrade.get(grade);
                const rule = rulesByGrade.get(grade);
                const delta = row?.change_delta ? Number(row.change_delta) : 0;
                const threshold = rule ? Number(rule.threshold_rs_per_kg) : null;
                const spiked = threshold !== null && Math.abs(delta) >= threshold && delta !== 0;
                return (
                  <tr key={grade} className="border-b border-line last:border-0">
                    <td className="py-2 pr-3 font-semibold">{grade === 'BRASS' ? 'Brass' : grade}</td>
                    <td className="num py-2 pr-3 text-right font-semibold">
                      {row ? `₹${Number(row.rate_per_kg).toFixed(2)}` : '—'}
                    </td>
                    <td className="num py-2 pr-3 text-right text-muted">
                      {row?.previous_rate_per_kg ? `₹${Number(row.previous_rate_per_kg).toFixed(2)}` : '—'}
                    </td>
                    <td className={`num py-2 pr-3 text-right font-semibold ${spiked ? 'text-warn' : ''}`}>
                      {row?.change_delta
                        ? `${delta > 0 ? '+' : ''}₹${delta.toFixed(2)}`
                        : '—'}
                    </td>
                    <td className="num py-2 text-right text-muted">
                      {rule && rule.is_active ? `±₹${Number(rule.threshold_rs_per_kg).toFixed(2)}` : 'Off'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <form onSubmit={(ev) => void submitDealerMessage(ev)} className="card grid gap-3" aria-label="Paste dealer rate message">
        <h2 className="text-lg font-bold">Paste dealer WhatsApp / Telegram rate message</h2>
        <Field label="Dealer message" hint="Handles Tanglish, Tamil, Rs/kg, Rs/MT, +₹/kg deltas, and unchanged grades">
          <textarea
            className="field min-h-28"
            placeholder="e.g. Vanakkam boss 19/11 rod basic, Rs/kg: M.S round 58.25 | EN-8 84.25 | EN 19 116.50 | s.s.304 211.75"
            value={message}
            onChange={(ev) => setMessage(ev.target.value)}
          />
        </Field>
        {error ? <Notice tone="warn">{error}</Notice> : null}
        <div className="flex justify-end">
          <button type="submit" className="btn btn-primary" disabled={busy || message.trim() === ''}>
            {busy ? 'Parsing…' : 'Parse & update rates'}
          </button>
        </div>
        {lastResult ? (
          <div role="status" className="grid gap-2 rounded-md border border-line bg-paper p-3 text-sm">
            <p className="font-semibold">
              Updated {lastResult.normalized_rates.length} grade(s).
              {lastResult.should_notify ? ' Spike threshold crossed — Telegram alert triggered.' : ' Within normal threshold.'}
            </p>
            {lastResult.telegram_text ? (
              <pre className="whitespace-pre-wrap rounded bg-card p-2 font-mono text-xs">{lastResult.telegram_text}</pre>
            ) : null}
            {lastResult.parsed_json.unpriced_mentions.length > 0 ? (
              <p className="text-muted">
                Held for review: {lastResult.parsed_json.unpriced_mentions.map((u) => `${u.raw_fragment} (${u.reason})`).join('; ')}
              </p>
            ) : null}
          </div>
        ) : null}
      </form>
    </div>
  );
}
