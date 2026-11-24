'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { enterAdvances } from '@/components/enter-advance';
import { Field, Notice } from '@/components/field';
import { Typeahead } from '@/components/typeahead';
import { useAltN } from '@/components/use-alt-n';
import { api } from '@/lib/api-client';
import { autosave } from '@/lib/autosave';
import { distinctRates } from '@/lib/bill-draft';
import * as f from '@/lib/bill-form';
import { connection, onConnection } from '@/lib/connection';
import { addDays, formatTime, istDate, stateLabel } from '@/lib/india';
import { openLots, searchCustomers, searchStuds } from '@/lib/master-search';
import { formatInr, formatPaise, trimZeros } from '@/lib/money';
import { offlineEngine, type OfflineEngine } from '@/lib/offline';
import type { Customer, StudItem } from '@/lib/schemas/masters';
import { SavedBill } from './saved-bill';
import { TransportFields } from './transport-fields';

interface ParsedDraftReply {
  bill_type: f.BillType;
  customer_query: string | null;
  customer_id: string | null;
  items: Array<{
    item_query: string;
    stud_item_id: string | null;
    quantity: string | null;
    billing_unit: 'pcs' | 'kg' | null;
    rate_mention: string | null;
  }>;
  party_dc_no: string | null;
  delivery: {
    transport_mention: string | null;
    vehicle_no: string | null;
    freight_paid_by: 'seller' | 'buyer_to_pay' | null;
    delivery_charge: { mention: string; amount_inr: string } | null;
    packing_charge: { mention: string; amount_inr: string } | null;
  };
  warnings: Array<{ code: string; path: string }>;
}

interface MarginCheckReply {
  margin_alerts: Array<{ code: 'LOW_MARGIN'; line: number; warning_tanglish: string }>;
  warnings: Array<{ code: string; line: number }>;
}

function parseNumericRateFromMention(mention: string | null, blocked: boolean): string {
  if (!mention || blocked) return '';
  if (/\bThousand\b/i.test(mention)) return '';
  const m = /\b(\d+(?:\.\d{1,4})?)\b/.exec(mention.replace(/,/g, ''));
  return m?.[1] ? trimZeros(m[1]) : '';
}

/** One id per bill, from the first moment, kept through crashes, retries and edits. */
const mintId = (): string => `OFFLINE-${crypto.randomUUID()}`;
const mintForm = (type: f.BillType = 'supply'): f.BillForm => f.newBill(mintId(), istDate(new Date()), type);

interface Issued {
  invoice_id: string;
  invoice_no: string;
  dc_no: string;
}

interface Opened {
  /** Remounts the editor: a bill refused twice must not keep its first attempt's state. */
  turn: number;
  form: f.BillForm;
  engine: OfflineEngine | null;
  /** When the restored draft was last typed into; null for a new bill. */
  restoredAt: number | null;
  error?: string;
}

/**
 * Rendered only in the browser, once this PC's store has been read: the page itself is static,
 * so it opens with no cloud and no internet.
 */
export function BillingScreen() {
  const [opened, setOpened] = useState<Opened | null>(null);
  const release = useRef<() => void>(() => undefined);

  useEffect(() => {
    let left = false;
    void (async () => {
      const wanted = new URLSearchParams(window.location.search).get('bill');
      const engine = await offlineEngine();
      const fresh = mintForm();
      let form: f.BillForm | null = null;
      let restoredAt: number | null = null;
      if (engine) {
        const draft = await engine.openDraft(wanted, fresh.tempId).catch(() => null);
        if (left) return draft?.release();
        if (draft) release.current = draft.release;
        form = draft?.record ? f.reviveForm(draft.record.form, fresh.today) : null;
        restoredAt = form ? (draft?.record?.updated_at ?? null) : null;
      }
      if (left) return;
      if (wanted) window.history.replaceState(null, '', '/billing');
      setOpened({ turn: 0, form: form ?? fresh, engine, restoredAt });
    })();
    return () => {
      left = true;
      release.current();
      release.current = () => undefined;
    };
  }, []);

  async function show(form: f.BillForm, error?: string): Promise<void> {
    release.current();
    release.current = opened?.engine ? await opened.engine.newDraftLock(form.tempId) : () => undefined;
    setOpened((old) => ({ turn: (old?.turn ?? 0) + 1, form, engine: old?.engine ?? null, restoredAt: null, ...(error ? { error } : {}) }));
  }

  if (!opened) return <p className="text-muted" role="status">Opening…</p>;
  return <BillEditor key={opened.turn} opened={opened} onNew={(type) => void show(mintForm(type))} onReopen={(form, error) => void show(form, error)} />;
}

function BillEditor({ opened, onNew, onReopen }: {
  opened: Opened;
  onNew: (type: f.BillType) => void;
  /** A refused bill comes back to the form, under its own id. */
  onReopen: (form: f.BillForm, error: string) => void;
}) {
  const { engine, restoredAt } = opened;
  const [form, setForm] = useState<f.BillForm>(opened.form);
  const [error, setError] = useState<string | null>(opened.error ?? null);
  const [busy, setBusy] = useState(false);
  const [restored, setRestored] = useState(restoredAt !== null);
  const [saved, setSaved] = useState<{ issued: Issued | null } | null>(null);
  const [noCompany, setNoCompany] = useState(false);
  const [aiText, setAiText] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiStatus, setAiStatus] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const [marginState, setMarginState] = useState<{ sig: string; alerts: Record<number, string> }>({ sig: '', alerts: {} });
  const conn = useSyncExternalStore(onConnection, connection, connection);
  const isOffline = conn === 'offline';
  const afterLines = useRef<HTMLDivElement>(null);
  const lotRequest = useRef(0);

  // Every change goes to disk, the first one at once. An emptied form leaves no draft behind.
  const [saver] = useState(() =>
    autosave<f.BillForm>(async (value) => {
      if (!engine) return;
      await (f.isEmptyForm(value) ? engine.deleteDraft(value.tempId) : engine.saveDraft(value));
    }),
  );
  const untouched = useRef(opened.form);
  useEffect(() => {
    if (form !== untouched.current) saver.push(form);
  }, [form, saver]);
  useEffect(() => {
    engine?.setActiveSaver(saver);
    return () => {
      engine?.setActiveSaver(null);
      void saver.flush();
    };
  }, [engine, saver]);

  const patch = (change: Partial<f.BillForm>): void => setForm((old) => ({ ...old, ...change }));
  const patchLine = (key: number, change: (line: f.FormLine) => f.FormLine): void =>
    setForm((old) => ({ ...old, lines: f.withTrailingBlank(old.lines.map((line) => (line.key === key ? change(line) : line)), old.type) }));
  const patchReturn = (lotId: string, change: Partial<f.FormReturn>): void =>
    setForm((old) => ({ ...old, returns: { ...old.returns, [lotId]: { ...f.blankReturn, ...old.returns[lotId], ...change } } }));

  async function loadLots(customer: Customer | null): Promise<void> {
    const ticket = ++lotRequest.current;
    patch({ lots: [], returns: {} });
    if (!customer) return;
    const lots = await openLots(customer.id);
    if (ticket === lotRequest.current) patch({ lots });
  }

  // A restored bill may be days old: take today's tax facts and open lots, keep what was typed.
  const restoredCustomer = restoredAt === null && !opened.error ? null : opened.form.customer;
  useEffect(() => {
    let left = false;
    void (async () => {
      const company = await api<unknown>('/api/company');
      if (!left && company.ok) setNoCompany(company.data === null);
      if (!restoredCustomer) return;
      const [fresh, lots] = await Promise.all([api<Customer>(`/api/customers/${restoredCustomer.id}`), openLots(restoredCustomer.id)]);
      if (left) return;
      setForm((old) => {
        if (old.customer?.id !== restoredCustomer.id) return old;
        const kept = old.lots.filter((lot) => old.returns[lot.id] && !lots.some((now) => now.id === lot.id));
        return { ...old, customer: fresh.ok ? fresh.data : old.customer, lots: [...lots, ...kept] };
      });
    })();
    return () => {
      left = true;
    };
  }, [restoredCustomer]);

  function pickCustomer(customer: Customer): void {
    patch({ customer, customerText: customer.name, dueDate: null });
    void loadLots(customer);
  }

  async function startNew(): Promise<void> {
    lotRequest.current += 1;
    await saver.stop();
    if (!saved) await engine?.deleteDraft(form.tempId);
    onNew(form.type);
  }

  function clear(): void {
    if (f.isEmptyForm(form) || window.confirm('Clear this bill? It has not been saved.')) void startNew();
  }

  useAltN(() => (saved ? void startNew() : clear()));

  const preview = f.previewBill(form);
  const bill = 'bill' in preview ? preview.bill : null;
  const amounts = bill?.detail.amounts ?? null;
  const typedLines = form.lines.filter((line) => !f.isBlank(line));
  const mixedRates = distinctRates(typedLines.map((line) => ({ gst_rate: line.gst || '0' })));
  const buyerPays = form.freightPaidBy === 'buyer_to_pay';

  // Non-blocking margin watchdog: checks confirmed rates on supply lines when online.
  const marginSignature =
    isOffline || form.type !== 'supply'
      ? ''
      : form.lines
          .map((l) => `${l.key}:${l.stud?.id ?? ''}:${l.unit}:${l.rate}`)
          .join('|');
  const marginAlerts = marginState.sig === marginSignature ? marginState.alerts : {};
  useEffect(() => {
    if (!marginSignature) return;
    const candidates = form.lines.map((line, idx) => ({ line, idx })).filter(({ line }) => !f.isBlank(line));
    if (!candidates.some(({ line }) => line.stud && /^\d+(\.\d{1,4})?$/.test(line.rate))) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        const res = await api<MarginCheckReply>('/api/ai/margin-check', 'POST', {
          bill_type: form.type,
          items: candidates.map(({ line }) => ({
            stud_item_id: line.stud?.id ?? null,
            billing_unit: line.unit,
            confirmed_rate: /^\d+(\.\d{1,4})?$/.test(line.rate)
              ? { amount_inr: line.rate, per_unit: line.unit, per_quantity: '1' }
              : null,
          })),
        });
        if (cancelled || !res.ok) return;
        const next: Record<number, string> = {};
        for (const alert of res.data.margin_alerts) {
          const target = candidates[alert.line];
          if (target) next[target.line.key] = alert.warning_tanglish;
        }
        setMarginState({ sig: marginSignature, alerts: next });
      })();
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [marginSignature, form.type, form.lines]);

  async function applyAiQuickFill(): Promise<void> {
    const text = aiText.trim();
    if (!text || aiBusy || isOffline) return;
    setAiBusy(true);
    setAiStatus(null);
    const res = await api<ParsedDraftReply>('/api/ai/parse-bill', 'POST', { text });
    if (!res.ok) {
      setAiBusy(false);
      setAiStatus(res.message);
      return;
    }
    const parsed = res.data;
    let resolvedCustomer: Customer | null = null;
    if (parsed.customer_id) {
      const cRes = await api<Customer>(`/api/customers/${parsed.customer_id}`);
      if (cRes.ok) resolvedCustomer = cRes.data;
    } else if (parsed.customer_query) {
      const found = await searchCustomers(parsed.customer_query);
      if (found.length === 1) resolvedCustomer = found[0]!.value;
    }

    const builtLines: f.FormLine[] = [];
    for (let idx = 0; idx < parsed.items.length; idx += 1) {
      const item = parsed.items[idx]!;
      let baseLine = f.blankLine(idx + 1, parsed.bill_type);
      let resolvedStud: StudItem | null = null;
      if (item.stud_item_id) {
        const sRes = await api<StudItem>(`/api/stud-items/${item.stud_item_id}`);
        if (sRes.ok) resolvedStud = sRes.data;
      } else if (item.item_query) {
        const foundStuds = await searchStuds(item.item_query);
        if (foundStuds.length === 1) resolvedStud = foundStuds[0]!.value;
      }
      if (resolvedStud) {
        baseLine = f.pickStud(baseLine, resolvedStud, parsed.bill_type);
      } else {
        baseLine = { ...baseLine, text: item.item_query };
      }
      if (item.billing_unit) {
        baseLine = f.changeUnit(baseLine, item.billing_unit, parsed.bill_type);
      }
      const rateBlocked = parsed.warnings.some(
        (w) =>
          w.path === `items[${idx}].rate_mention` &&
          (w.code === 'RATE_AMBIGUOUS' || w.code === 'RATE_MISSING' || w.code === 'RATE_UNIT_MISMATCH'),
      );
      const parsedRate = parseNumericRateFromMention(item.rate_mention, rateBlocked);
      baseLine = {
        ...baseLine,
        quantity: item.quantity ?? '',
        rate: parsedRate || baseLine.rate,
      };
      builtLines.push(baseLine);
    }

    setForm((old) => ({
      ...f.changeType(old, parsed.bill_type),
      customer: resolvedCustomer ?? old.customer,
      customerText: resolvedCustomer?.name ?? parsed.customer_query ?? old.customerText,
      dueDate: resolvedCustomer ? null : old.dueDate,
      lines: f.withTrailingBlank(builtLines.length > 0 ? builtLines : old.lines, parsed.bill_type),
      packing: parsed.delivery.packing_charge ? trimZeros(parsed.delivery.packing_charge.amount_inr) : old.packing,
      freight: parsed.delivery.delivery_charge ? trimZeros(parsed.delivery.delivery_charge.amount_inr) : old.freight,
      freightPaidBy: parsed.delivery.freight_paid_by ?? old.freightPaidBy,
      transport: {
        ...old.transport,
        vehicle_no: parsed.delivery.vehicle_no ?? old.transport.vehicle_no,
      },
    }));
    if (resolvedCustomer) void loadLots(resolvedCustomer);
    setAiBusy(false);
    setAiStatus(
      parsed.warnings.length > 0
        ? `Draft filled (${parsed.warnings.map((w) => w.code).join(', ')}) — verify totals below.`
        : 'Draft filled from Tanglish note — verify fields before saving.',
    );
  }

  function startVoiceMic(): void {
    if (isOffline || listening) return;
    const SpeechCtor = (
      window as unknown as {
        SpeechRecognition?: new () => {
          lang: string;
          interimResults: boolean;
          onresult: ((ev: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
          onerror: (() => void) | null;
          onend: (() => void) | null;
          start: () => void;
        };
        webkitSpeechRecognition?: new () => {
          lang: string;
          interimResults: boolean;
          onresult: ((ev: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
          onerror: (() => void) | null;
          onend: (() => void) | null;
          start: () => void;
        };
      }
    ).SpeechRecognition ??
      (
        window as unknown as {
          webkitSpeechRecognition?: new () => {
            lang: string;
            interimResults: boolean;
            onresult: ((ev: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
            onerror: (() => void) | null;
            onend: (() => void) | null;
            start: () => void;
          };
        }
      ).webkitSpeechRecognition;

    if (!SpeechCtor) {
      setAiStatus('Voice dictation is not supported in this browser; type Tanglish directly.');
      return;
    }
    const rec = new SpeechCtor();
    rec.lang = 'ta-IN';
    rec.interimResults = false;
    setListening(true);
    rec.onresult = (ev) => {
      const transcript = ev.results[0]?.[0]?.transcript ?? '';
      if (transcript) setAiText((prev) => (prev ? `${prev} ${transcript}` : transcript));
    };
    rec.onerror = () => setListening(false);
    rec.onend = () => setListening(false);
    rec.start();
  }

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (busy || saved) return;
    if (!bill) return setError('problem' in preview ? preview.problem : 'Check the bill');
    setBusy(true);
    setError(null);
    const draft = f.toDraft(form, bill);
    if (engine) {
      try {
        await saver.stop();
        await engine.enqueue({ form, draft, customer: form.customer?.name ?? '', total_paise: bill.detail.amounts.grand_total_paise });
        setSaved({ issued: null });
        void engine.syncNow();
        return;
      } catch {
        // Disk full or store broken: fall through and send it straight away.
      }
    }
    const result = await api<Issued>('/api/invoices/sync', 'POST', draft);
    setBusy(false);
    if (result.ok) setSaved({ issued: result.data });
    else setError(result.message);
  }

  if (saved) {
    return (
      <SavedBill
        tempId={form.tempId} engine={engine} issued={saved.issued} total={amounts?.grand_total_paise ?? null} onNew={() => void startNew()}
        onRejected={async (message) => {
          await engine?.reopen(form.tempId);
          onReopen(form, message);
        }}
      />
    );
  }

  return (
    <form onSubmit={(event) => void save(event)} onKeyDown={enterAdvances} aria-label="New bill" className="grid gap-4 pb-28">
      {engine ? null : <Notice tone="warn">This browser cannot store bills: an unsaved bill is lost if the PC stops. Use a normal window, not a private one.</Notice>}
      {noCompany ? <Notice tone="warn">Bills carry your company details. <Link className="underline" href="/company">Fill them in first</Link>.</Notice> : null}
      {restored ? (
        <p role="status" className="flex flex-wrap items-center gap-3 rounded-md border border-accent px-3 py-2">
          <span className="font-semibold">Restored the bill you were typing{restoredAt ? ` (${formatTime(restoredAt)})` : ''}.</span>
          <button type="button" className="underline" onClick={() => setRestored(false)}>OK</button>
          <button type="button" className="underline" onClick={clear}>Start fresh</button>
        </p>
      ) : null}
      <section className="card grid gap-2" aria-label="Tanglish voice or text quick-fill">
        <div className="flex flex-wrap items-center gap-2">
          <input
            aria-label="Tanglish quick-fill transcript"
            data-enter-skip
            className="field min-w-0 flex-1"
            placeholder={
              isOffline
                ? 'Offline mode: Voice/AI quick-fill is paused; manual billing works offline'
                : 'Tanglish / voice note (e.g. Vellaru-ku MS M8 x 45 mm full thread, 200 pcs, piece-ku 3.10)…'
            }
            disabled={isOffline || aiBusy}
            value={aiText}
            onChange={(event) => setAiText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void applyAiQuickFill();
              }
            }}
          />
          <button
            type="button"
            className="btn"
            disabled={isOffline || aiBusy || listening}
            onClick={startVoiceMic}
            aria-label="Dictate Tanglish bill"
          >
            {listening ? 'Listening…' : 'Mic'}
          </button>
          <button
            type="button"
            className="btn"
            disabled={isOffline || aiBusy || aiText.trim() === ''}
            onClick={() => void applyAiQuickFill()}
          >
            {aiBusy ? 'Filling…' : 'Fill draft'}
          </button>
        </div>
        {isOffline ? (
          <p className="text-sm text-muted">Voice/AI quick-fill needs internet; manual billing and offline queue work normally.</p>
        ) : aiStatus ? (
          <p role="status" className="text-sm text-muted">{aiStatus}</p>
        ) : null}
      </section>
      <section className="card grid gap-3 sm:grid-cols-2 lg:grid-cols-[auto_2fr_1fr_1fr]">
        <fieldset>
          <legend className="mb-1 text-sm font-semibold">Bill</legend>
          <div className="flex gap-1">
            {(['supply', 'job_work'] as const).map((type) => (
              <button key={type} type="button" aria-pressed={form.type === type} className={`btn ${form.type === type ? 'btn-primary' : ''}`} onClick={() => setForm((old) => f.changeType(old, type))}>
                {type === 'supply' ? 'Supply' : 'Job work'}
              </button>
            ))}
          </div>
        </fieldset>
        <Field label="Customer" hint={form.customer ? `${form.customer.gstin ?? 'Unregistered'} · ${stateLabel(form.customer.state_code)}${form.customer.is_sez ? ' · SEZ' : ''}` : 'Type a name'}>
          <Typeahead
            inputLabel="Customer" autoFocus text={form.customerText} search={searchCustomers}
            onText={(customerText) => {
              if (form.customer) void loadLots(null);
              patch({ customerText, customer: null });
            }}
            onPick={(option) => pickCustomer(option.value)}
          />
        </Field>
        <Field label="Date"><input className="field" data-enter-skip type="date" required min={addDays(form.today, -31)} max={form.today} value={form.invoiceDate} onChange={(event) => patch({ invoiceDate: event.target.value || form.today })} /></Field>
        <Field label="Due"><input className="field" data-enter-skip type="date" required min={form.invoiceDate} value={f.dueDateOf(form)} onChange={(event) => patch({ dueDate: event.target.value || null })} /></Field>
      </section>

      <section className="card grid gap-3" aria-label="Lines">
        {form.lines.map((line, i) => {
          const other = f.supporting(line);
          const position = typedLines.indexOf(line);
          const computed = position >= 0 ? bill?.detail.lines[position] : undefined;
          return (
            <div key={line.key} className="grid grid-cols-6 items-start gap-2 border-b border-line pb-3 last:border-0 last:pb-0 md:grid-cols-[6rem_5.5rem_7rem_6.5rem_4.5rem_minmax(0,1fr)_3rem] xl:grid-cols-[minmax(0,1fr)_6rem_5.5rem_7rem_6.5rem_4.5rem_8rem_3rem]">
              <div className="col-span-6 md:col-span-7 xl:col-span-1">
                <Typeahead
                  inputLabel={`Line ${i + 1} item`} placeholder={i === 0 ? 'SKU or description' : 'Next item, or Enter to finish'} text={line.text} search={searchStuds}
                  onText={(text) => patchLine(line.key, (old) => ({ ...old, text, stud: text === '' ? null : old.stud }))}
                  onPick={(option) => patchLine(line.key, (old) => f.pickStud(old, option.value, form.type))}
                  onEmptyEnter={() => {
                    if (!f.isBlank(line) || i === 0) return false;
                    afterLines.current?.querySelector('input')?.focus();
                    return true;
                  }}
                />
                {other.weightKg ? <p className="mt-1 text-sm text-muted">{other.weightKg} kg</p> : other.pieces ? <p className="mt-1 text-sm text-muted">≈ {other.pieces} pcs</p> : null}
                {marginAlerts[line.key] ? (
                  <p role="status" className="mt-1 text-sm font-semibold text-warn">{marginAlerts[line.key]}</p>
                ) : null}
              </div>
              <input aria-label={`Line ${i + 1} quantity`} placeholder="Qty" className="field num col-span-2 md:col-span-1" inputMode="decimal" value={line.quantity} onChange={(event) => patchLine(line.key, (old) => ({ ...old, quantity: event.target.value.trim() }))} />
              <select aria-label={`Line ${i + 1} unit`} data-enter-skip className="field col-span-2 md:col-span-1" value={line.unit} onChange={(event) => patchLine(line.key, (old) => f.changeUnit(old, event.target.value === 'kg' ? 'kg' : 'pcs', form.type))}>
                <option value="pcs">pcs</option><option value="kg">kg</option>
              </select>
              <input aria-label={`Line ${i + 1} rate`} placeholder="Rate ₹" className="field num col-span-2 md:col-span-1" inputMode="decimal" value={line.rate} onChange={(event) => patchLine(line.key, (old) => ({ ...old, rate: event.target.value.trim() }))} />
              <input aria-label={`Line ${i + 1} HSN or SAC`} data-enter-skip className="field col-span-2 md:col-span-1" inputMode="numeric" value={line.hsn} onChange={(event) => patchLine(line.key, (old) => ({ ...old, hsn: event.target.value.trim() }))} />
              <input aria-label={`Line ${i + 1} GST percent`} data-enter-skip className="field num col-span-1" inputMode="decimal" value={line.gst} onChange={(event) => patchLine(line.key, (old) => ({ ...old, gst: event.target.value.trim() }))} />
              <output aria-label={`Line ${i + 1} amount`} className="num col-span-2 self-center text-lg font-semibold md:col-span-1">{computed ? formatPaise(computed.line_total_paise) : ''}</output>
              {f.isBlank(line) ? <span /> : (
                <button type="button" aria-label={`Remove line ${i + 1}`} className="btn px-2" onClick={() => setForm((old) => ({ ...old, lines: f.withTrailingBlank(old.lines.filter((other_) => other_.key !== line.key), old.type) }))}>✕</button>
              )}
            </div>
          );
        })}
      </section>

      <div ref={afterLines} className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        {form.type === 'job_work' ? <Lots form={form} onChange={patchReturn} /> : null}
        <section className="card grid content-start gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label="Charges, dispatch and transport">
          <h2 className="text-lg font-bold sm:col-span-2 lg:col-span-3">Delivery challan &amp; transport</h2>
          <Field label="Packing ₹"><input className="field num" inputMode="decimal" value={form.packing} onChange={(event) => patch({ packing: event.target.value })} /></Field>
          <Field label="Freight ₹"><input className="field num" inputMode="decimal" value={form.freight} onChange={(event) => patch({ freight: event.target.value })} /></Field>
          <Field label="Freight paid by" hint={buyerPays ? 'Shown on the challan, not billed' : undefined}>
            <select className="field" value={form.freightPaidBy} onChange={(event) => patch({ freightPaidBy: event.target.value === 'buyer_to_pay' ? 'buyer_to_pay' : 'seller' })}>
              <option value="seller">Us, billed</option><option value="buyer_to_pay">Buyer, To-Pay</option>
            </select>
          </Field>
          {buyerPays ? null : (
            <label className="flex items-center gap-2"><input className="size-5" type="checkbox" checked={form.deliveryTaxable} onChange={(event) => patch({ deliveryTaxable: event.target.checked })} /> GST on freight</label>
          )}
          {mixedRates.length > 1 ? (
            <Field label="GST on charges">
              <select className="field" value={form.chargesRate} onChange={(event) => patch({ chargesRate: event.target.value })}>
                <option value="">Highest on the bill</option>
                {mixedRates.map((rate) => <option key={rate} value={rate}>{rate}%</option>)}
              </select>
            </Field>
          ) : null}
          <TransportFields value={form.transport} onChange={(transport) => patch({ transport })} />
          <Field label="Received now ₹"><input className="field num" inputMode="decimal" value={form.paid} onChange={(event) => patch({ paid: event.target.value })} /></Field>
          {form.paid.trim() === '' ? null : (
            <Field label="Received by">
              <select className="field" value={form.paidMode} onChange={(event) => patch({ paidMode: event.target.value })}>
                <option value="cash">Cash</option><option value="upi">UPI</option><option value="bank_transfer">Bank transfer</option><option value="cheque">Cheque</option>
              </select>
            </Field>
          )}
          <Field label="Note on bill" className="sm:col-span-2"><input className="field" maxLength={1000} value={form.notes} onChange={(event) => patch({ notes: event.target.value })} /></Field>
        </section>

        <section className="card grid content-start gap-1" aria-label="Totals">
          {amounts ? (
            <>
              <Sum label="Items and listed charges" paise={amounts.subtotal_paise} />
              <Sum label="Taxable value" paise={amounts.taxable_value_paise} />
              {amounts.igst_paise > 0 ? <Sum label="IGST" paise={amounts.igst_paise} /> : (
                <><Sum label="CGST" paise={amounts.cgst_paise} /><Sum label="SGST" paise={amounts.sgst_paise} /></>
              )}
              <Sum label="Round-off" paise={amounts.round_off_paise} />
              {amounts.dc_to_pay_paise > 0 ? <Sum label="Buyer pays transporter" paise={amounts.dc_to_pay_paise} /> : null}
            </>
          ) : <p className="text-muted">{'problem' in preview ? preview.problem : ''}</p>}
        </section>
      </div>

      <div className="fixed inset-x-0 bottom-0 z-10 border-t border-line bg-card">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-3 py-3">
          <output aria-label="Invoice total" aria-live="polite" className="text-3xl font-bold tabular-nums">{amounts ? formatInr(amounts.grand_total_paise) : '₹ —'}</output>
          <div className="min-w-0 flex-1">{error ? <Notice tone="warn">{error}</Notice> : null}</div>
          <button className="btn" type="button" onClick={clear}>Clear</button>
          <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? 'Saving…' : <>Save bill<span className="hidden whitespace-pre sm:inline"> (Ctrl+Enter)</span></>}</button>
        </div>
      </div>
    </form>
  );
}

function Sum({ label, paise }: { label: string; paise: number }) {
  return <div className="flex justify-between gap-3"><span>{label}</span><span className="tabular-nums">{formatPaise(paise)}</span></div>;
}

function Lots({ form, onChange }: { form: f.BillForm; onChange: (lotId: string, change: Partial<f.FormReturn>) => void }) {
  if (!form.customer) return null;
  return (
    <section className="card grid gap-3 lg:col-span-2" aria-label="Customer material going back">
      <h2 className="text-lg font-bold">Material going back</h2>
      {form.lots.length === 0 ? (
        <p className="text-muted">No open lots for this customer. <Link className="underline" href="/job-work">Receive material</Link></p>
      ) : null}
      {form.lots.map((lot) => {
        const entry = form.returns[lot.id] ?? f.blankReturn;
        const after = f.returnBalance(lot, entry);
        const touched = entry.returned !== '' || entry.scrap !== '';
        return (
          <div key={lot.id} className="grid grid-cols-2 items-end gap-2 border-b border-line pb-3 last:border-0 last:pb-0 sm:grid-cols-3 lg:grid-cols-[2fr_1fr_1fr_1fr_1fr_1fr]">
            <div className="col-span-2 self-center sm:col-span-3 lg:col-span-1">
              <p className="font-semibold">Party DC {lot.party_dc_no} · {lot.material_grade}</p>
              <p className="text-sm text-muted">Holding {lot.balance_weight_kg} of {lot.inward_weight_kg} kg</p>
            </div>
            <Field label="Return kg"><input className="field num" inputMode="decimal" aria-label={`Return kg for ${lot.party_dc_no}`} value={entry.returned} onChange={(event) => onChange(lot.id, { returned: event.target.value.trim() })} /></Field>
            <Field label="Scrap kg"><input className="field num" inputMode="decimal" aria-label={`Scrap kg for ${lot.party_dc_no}`} value={entry.scrap} onChange={(event) => onChange(lot.id, { scrap: event.target.value.trim() })} /></Field>
            <Field label="Pieces"><input className="field num" data-enter-skip inputMode="numeric" aria-label={`Pieces for ${lot.party_dc_no}`} value={entry.pieces} onChange={(event) => onChange(lot.id, { pieces: event.target.value.replace(/\D/g, '') })} /></Field>
            <Field label="Goods value ₹"><input className="field num" data-enter-skip inputMode="decimal" aria-label={`Goods value for ${lot.party_dc_no}`} value={entry.value} onChange={(event) => onChange(lot.id, { value: event.target.value.trim() })} /></Field>
            <label className="flex min-h-12 items-center gap-2">
              <input className="size-5" data-enter-skip type="checkbox" checked={entry.close} disabled={!touched} onChange={(event) => onChange(lot.id, { close: event.target.checked })} /> Close lot
            </label>
            {touched ? (
              <p className={`col-span-2 text-sm sm:col-span-3 lg:col-span-6 ${after?.over_returned ? 'font-semibold text-warn' : 'text-muted'}`}>
                {after === null ? 'Check the weights' : after.over_returned ? `${after.balance_kg} kg: more than came in` : `Balance after this challan: ${after.balance_kg} kg`}
              </p>
            ) : null}
            {entry.close && after && !after.within_tolerance ? (
              <Field label="Why close with this balance?" className="col-span-2 sm:col-span-3 lg:col-span-6"><input className="field" required minLength={3} maxLength={300} value={entry.reason} onChange={(event) => onChange(lot.id, { reason: event.target.value })} /></Field>
            ) : null}
          </div>
        );
      })}
    </section>
  );
}
