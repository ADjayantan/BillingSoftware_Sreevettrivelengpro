'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import { enterAdvances } from '@/components/enter-advance';
import { Field, Notice } from '@/components/field';
import { Icon } from '@/components/icon';
import { Typeahead } from '@/components/typeahead';
import { useAltN } from '@/components/use-alt-n';
import { addressSaved } from '@/lib/add-customer';
import { api } from '@/lib/api-client';
import { autosave } from '@/lib/autosave';
import { distinctRates } from '@/lib/bill-draft';
import * as f from '@/lib/bill-form';
import { connection, onConnection } from '@/lib/connection';
import { newCustomerFrom } from '@/lib/customer-form';
import { VOICE_FAILED, VOICE_IN_PC_APP, desktopBridge } from '@/lib/desktop';
import { addDays, formatDate, formatTime, istDate } from '@/lib/india';
import { customerDetail, onlyStudByCode, openLots, searchCustomers, searchStuds } from '@/lib/master-search';
import { decimalToPaise, formatInr, formatPaise, formatRupees, rupeesInWords, trimZeros } from '@/lib/money';
import { offlineEngine, type OfflineEngine } from '@/lib/offline';
import { productCode } from '@/lib/products';
import type { CustomerGlance } from '@/lib/schemas/home';
import type { Customer, StudItem } from '@/lib/schemas/masters';
import { NewCustomer } from './new-customer';
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
  margin_alerts: Array<{ code: 'LOW_MARGIN'; line: number }>;
  warnings: Array<{ code: string; line: number }>;
}

function parseNumericRateFromMention(mention: string | null, blocked: boolean): string {
  if (!mention || blocked) return '';
  if (/\bThousand\b/i.test(mention)) return '';
  const m = /\b(\d+(?:\.\d{1,4})?)\b/.exec(mention.replace(/,/g, ''));
  return m?.[1] ? trimZeros(m[1]) : '';
}

/** The program only warns; the rate stays the owner's to decide. */
const LOW_RATE = 'This rate looks too low for today’s steel rate';

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

  if (!opened) return <><h1 className="page-title">New bill</h1><p className="text-muted" role="status">Opening…</p></>;
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
  /** The new customer of this bill is, so far, on this device only. */
  const [onlyHere, setOnlyHere] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [noCompany, setNoCompany] = useState(false);
  const [aiText, setAiText] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiStatus, setAiStatus] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const [marginState, setMarginState] = useState<{ sig: string; alerts: Record<number, string> }>({ sig: '', alerts: {} });
  const conn = useSyncExternalStore(onConnection, connection, connection);
  const isOffline = conn === 'offline';
  const page = useRef<HTMLFormElement>(null);
  const lotRequest = useRef(0);
  const latest = useRef(form);
  useEffect(() => {
    latest.current = form;
  });

  // Moved after the render, so a box that has just appeared can take it. A new object each
  // time: the same place can be asked for twice.
  const [cursor, setCursor] = useState<{ at: f.Place } | null>(null);
  const putCursor = (at: f.Place): void => setCursor({ at });
  useEffect(() => {
    if (!cursor) return;
    const { at } = cursor;
    const found = page.current?.querySelector<HTMLElement>(
      at.place === 'line' ? `[data-line="${at.key}"] [data-box="${at.box}"]`
      : at.place === 'customer' && latest.current.newCustomer ? '[data-save]'
      : `[data-place="${at.place}"]`,
    );
    const target = found?.matches('input, textarea, button') ? found : found?.querySelector<HTMLElement>('input, textarea');
    target?.focus();
    if (target instanceof HTMLInputElement) target.select();
  }, [cursor]);

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
    setOnlyHere(null);
    setForm((old) => f.takeCustomer(old, customer));
    void loadLots(customer);
  }

  /** From the form inside the bill: the cursor goes to what is still missing. */
  function takeNew(customer: Customer, here: boolean): void {
    const next = f.takeCustomer(latest.current, customer);
    pickCustomer(customer);
    setOnlyHere(here ? customer.id : null);
    setError(null);
    putCursor(f.firstUnfinished(next));
  }

  function openNew(typed: string): void {
    setError(null);
    patch({ customer: null, newCustomer: newCustomerFrom(crypto.randomUUID(), typed) });
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

  // What this customer owes and bought last: a help, asked for beside the bill and never waited for.
  const asked = form.customer && onlyHere !== form.customer.id && !isOffline ? `${form.customer.id}?type=${form.type}` : null;
  const [seen, setSeen] = useState<{ of: string; glance: CustomerGlance } | null>(null);
  const glance = seen !== null && seen.of === asked ? seen.glance : null;
  useEffect(() => {
    if (asked === null) return;
    let left = false;
    void api<CustomerGlance>(`/api/customers/${asked.replace('?', '/glance?')}`).then((reply) => {
      if (!left && reply.ok) setSeen({ of: asked, glance: reply.data });
    });
    return () => {
      left = true;
    };
  }, [asked]);

  function sameAgain(): void {
    const last = glance?.last;
    if (!last) return;
    const next = f.repeatGoods(latest.current, last.lines);
    setForm(next);
    putCursor(f.firstUnfinished(next).place === 'line' ? f.firstUnfinished(next) : { place: 'line', key: next.lines[0]?.key ?? 1, box: 'quantity' });
  }

  const preview = f.previewBill(form);
  const bill = preview.bill ?? null;
  const amounts = bill?.detail.amounts ?? null;
  const typedLines = form.lines.filter((line) => !f.isBlank(line));
  const mixedRates = distinctRates(typedLines.filter((line) => line.gst !== '').map((line) => ({ gst_rate: line.gst })));
  const buyerPays = form.freightPaidBy === 'buyer_to_pay';
  const needsAddress = 'problem' in preview && preview.place === 'address';
  const showMore = moreOpen || f.hasDispatchDetails(form);

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
          if (target) next[target.line.key] = LOW_RATE;
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
        resolvedStud = await onlyStudByCode(item.item_query);
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

    const hasCustomerInNote = resolvedCustomer !== null || Boolean(parsed.customer_query);
    if (hasCustomerInNote) setOnlyHere(null);
    setForm((old) => ({
      ...f.changeType(old, parsed.bill_type),
      customer: hasCustomerInNote ? resolvedCustomer : old.customer,
      customerText: resolvedCustomer?.name ?? parsed.customer_query ?? old.customerText,
      newCustomer: hasCustomerInNote ? null : old.newCustomer,
      dueDate: hasCustomerInNote ? null : old.dueDate,
      lines: f.withTrailingBlank(builtLines.length > 0 ? builtLines : old.lines, parsed.bill_type),
      packing: parsed.delivery.packing_charge ? trimZeros(parsed.delivery.packing_charge.amount_inr) : old.packing,
      freight: parsed.delivery.delivery_charge ? trimZeros(parsed.delivery.delivery_charge.amount_inr) : old.freight,
      freightPaidBy: parsed.delivery.freight_paid_by ?? old.freightPaidBy,
      transport: {
        ...old.transport,
        vehicle_no: parsed.delivery.vehicle_no ?? old.transport.vehicle_no,
      },
    }));
    if (hasCustomerInNote) void loadLots(resolvedCustomer);
    setAiBusy(false);
    setAiStatus(parsed.warnings.length > 0 ? 'Filled, but something was not clear. Check every box before you save.' : 'Filled. Check every box before you save.');
  }

  function startVoiceMic(): void {
    if (isOffline || listening) return;
    // The PC app has no speech service of its own (specs/desktop-app.md, "Voice").
    if (desktopBridge() !== null) {
      setAiStatus(VOICE_IN_PC_APP);
      return;
    }
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
      setAiStatus('This browser cannot listen. Type it here instead.');
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
    rec.onerror = () => {
      setListening(false);
      setAiStatus(VOICE_FAILED);
    };
    rec.onend = () => setListening(false);
    rec.start();
  }

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (busy || saved) return;
    if (form.newCustomer) {
      setError('Finish the new customer first: Save and use in this bill');
      return putCursor({ place: 'customer' });
    }
    if ('problem' in preview || !bill) {
      setError('problem' in preview ? preview.problem : 'Check the bill');
      return putCursor(f.firstUnfinished(form));
    }
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
        onFixCustomer={async (customer, message) => {
          await engine?.reopen(form.tempId);
          onReopen({ ...form, customer: null, customerText: customer.name, newCustomer: customer }, message);
        }}
      />
    );
  }

  return (
    <form ref={page} data-billing onSubmit={(event) => void save(event)} onKeyDown={enterAdvances} aria-label="New bill" className="pb-24 lg:pb-0">
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="min-w-0">
          <h1 className="page-title">New bill</h1>
          <p className="mt-0.5 text-[14.5px] text-muted">{engine ? 'Kept on this device while you type' : 'Not kept on this device'}</p>
        </div>
        <div role="group" aria-label="Kind of bill" className="ml-auto inline-flex rounded-[3px] border border-line-2 p-[3px]">
          {([['supply', 'Sale'], ['job_work', 'Job work']] as const).map(([type, label]) => (
            <button
              key={type} type="button" aria-pressed={form.type === type} onClick={() => setForm((old) => f.changeType(old, type))}
              className={`min-h-10 cursor-pointer rounded-[2px] px-4.5 text-[13.5px] font-semibold tracking-[0.06em] uppercase ${form.type === type ? 'bg-slate text-white' : 'text-ink-2 hover:text-ink'}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="grid gap-2.5 *:last:mb-3.5 empty:hidden">
        {engine ? null : <Notice tone="warn">This browser cannot keep bills. If the PC stops, an unsaved bill is lost. Use a normal window, not a private one.</Notice>}
        {noCompany ? <Notice tone="warn">Bills carry your company details. <Link className="underline" href="/company">Fill them in first</Link>.</Notice> : null}
        {restored ? (
          <p role="status" className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-[3px] border-l-[3px] border-paid bg-paid-bg px-3.5 py-2.5 text-paid">
            <span className="font-semibold">Here is the bill you did not finish{restoredAt ? ` (${formatTime(restoredAt)})` : ''}.</span>
            <button type="button" className="cursor-pointer font-semibold underline" onClick={() => setRestored(false)}>Go on</button>
            <button type="button" className="cursor-pointer font-semibold underline" onClick={clear}>Start a new one</button>
          </p>
        ) : null}
      </div>
      <section className={`mb-4.5 ${isOffline ? 'max-sm:hidden' : ''}`} aria-label="Say or type the bill">
        <div className="find-box h-auto gap-1.5 py-1 pr-1.5 pl-1.5">
          <button type="button" className="grid size-10 flex-none cursor-pointer place-items-center rounded-full text-slate hover:bg-soft disabled:opacity-40" disabled={isOffline || aiBusy || listening} onClick={startVoiceMic} aria-label="Speak the bill"><Icon name="mic" /></button>
          <input
            aria-label="Say or type the bill" data-enter-skip className="min-h-10 min-w-0 flex-1 bg-transparent text-[15.5px] outline-none placeholder:text-muted" disabled={isOffline || aiBusy} value={aiText}
            placeholder={isOffline ? 'This needs internet. Type the bill below.' : listening ? 'Listening…' : 'Say or type it: Murugan, M8 x 45 MS stud, 200 pieces, 3.10 each'}
            onChange={(event) => setAiText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              void applyAiQuickFill();
            }}
          />
          <button type="button" className="btn btn-small rounded-full" disabled={isOffline || aiBusy || aiText.trim() === ''} onClick={() => void applyAiQuickFill()}>{aiBusy ? 'Filling…' : 'Fill bill'}</button>
        </div>
        {aiStatus && !isOffline ? <p role="status" className="px-4 pt-1.5 text-sm text-muted">{aiStatus}</p> : null}
      </section>

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_310px] xl:grid-cols-[minmax(0,1fr)_336px]">
        <div className="card divide-y divide-line p-0">
          <section className="px-5 pt-4.5 pb-5" aria-label="Customer">
            <Step no={1} done={form.customer !== null}>Customer</Step>
            <div data-place="customer">
              {form.newCustomer ? (
                <Field label="Customer" hint="Fill in the new customer below">
                  <input className="field" data-enter-skip readOnly tabIndex={-1} value={form.newCustomer.name || form.customerText} />
                </Field>
              ) : (
                <Field label="Customer" hint={form.customer ? `${customerDetail(form.customer)}${onlyHere === form.customer.id ? ' · new, saved on this device' : ''}` : 'Type a name, phone or GSTIN'}>
                  <Typeahead
                    inputLabel="Customer" autoFocus text={form.customerText} picked={form.customer !== null} search={searchCustomers}
                    add={form.customer ? undefined : { label: addLabel, onAdd: openNew }}
                    onText={(customerText) => {
                      if (form.customer) void loadLots(null);
                      patch({ customerText, customer: null });
                    }}
                    onPick={(option) => pickCustomer(option.value)}
                  />
                </Field>
              )}
              {form.customer || form.newCustomer || form.customerText.trim() === '' ? null : (
                <button type="button" className="btn mt-2 text-left text-accent" onClick={() => openNew(form.customerText)}>{addLabel(form.customerText.trim())}</button>
              )}
            </div>
            <div className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(min(9.6rem,100%),1fr))] gap-3">
              <Field label="Date"><input className="field" data-enter-skip type="date" required min={addDays(form.today, -31)} max={form.today} value={form.invoiceDate} onChange={(event) => patch({ invoiceDate: event.target.value || form.today })} /></Field>
              <Field label="Due"><input className="field" data-enter-skip type="date" required min={form.invoiceDate} value={f.dueDateOf(form)} onChange={(event) => patch({ dueDate: event.target.value || null })} /></Field>
              <Field label="P.O. No."><input className="field" data-enter-skip maxLength={40} placeholder="If there is one" value={form.poNo} onChange={(event) => patch({ poNo: event.target.value })} /></Field>
              {form.poNo.trim() === '' ? null : (
                <Field label="P.O. date"><input className="field" data-enter-skip={form.poDate === '' ? undefined : true} type="date" max={form.today} value={form.poDate} onChange={(event) => patch({ poDate: event.target.value })} /></Field>
              )}
            </div>
            {form.customer && needsAddress ? (
              <AddressBox
                key={form.customer.id} customer={form.customer} engine={engine}
                onSaved={(customer) => {
                  const next = { ...latest.current, customer };
                  patch({ customer });
                  setError(null);
                  putCursor(f.firstUnfinished(next));
                }}
              />
            ) : null}
            {form.newCustomer ? (
              <div className="mt-3">
                <NewCustomer
                  key={form.newCustomer.id} value={form.newCustomer} engine={engine}
                  onChange={(newCustomer) => patch({ newCustomer })} onUse={takeNew}
                  onCancel={() => {
                    setError(null);
                    patch({ newCustomer: null });
                    putCursor({ place: 'customer' });
                  }}
                />
              </div>
            ) : null}
          </section>

          <section className="px-5 pt-4.5 pb-5" aria-label="Items">
            <Step no={2} done={amounts !== null} note="Enter goes on">Items</Step>
            {glance?.last && glance.last.lines.length > 0 && typedLines.length === 0 ? (
              <p className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[3px] border border-[#ece2c9] bg-soft py-2 pr-2 pl-3.5 text-[15px] text-ink-2">
                <span className="min-w-0 flex-1">Last bill, {formatDate(glance.last.invoice_date)}: <b>{glance.last.lines.length} item{glance.last.lines.length === 1 ? '' : 's'}, {formatRupees(decimalToPaise(glance.last.grand_total))}</b></span>
                <button type="button" className="btn btn-small" onClick={sameAgain}>Same items again</button>
              </p>
            ) : null}
            <div aria-hidden className={`mb-1.5 hidden gap-2 text-[13px] font-semibold text-muted lg:grid ${LINE_COLUMNS}`}>
              <span>Product</span><span className="num">Qty</span><span>Unit</span><span className="num">Rate ₹</span><span className="num">Amount ₹</span><span />
            </div>
            {form.lines.map((line, i) => {
              const other = f.supporting(line);
              const position = typedLines.indexOf(line);
              const computed = position >= 0 ? bill?.detail.lines[position] : undefined;
              const about = [
                line.stud && line.stud.product_no > 0 ? productCode(line.stud.product_no) : null,
                other.weightKg ? `${trimZeros(Number(other.weightKg).toFixed(3))} kg` : other.pieces ? `about ${other.pieces} pcs` : null,
              ].filter(Boolean).join(' · ');
              const named = (name: string): string => `${name}, line ${i + 1}`;
              const blank = f.isBlank(line);
              return (
                <div key={line.key} data-line={line.key} className={`grid grid-cols-6 items-start gap-x-2 gap-y-1.5 border-t border-line py-2.5 md:grid-cols-[6rem_5.4rem_7rem_minmax(0,1fr)_2.6rem] ${LINE_COLUMNS}`}>
                  <Cell name="Product" box="text" className="col-span-5 md:col-span-4 lg:col-span-1">
                    <Typeahead
                      inputLabel={named('Product or ID')} placeholder={i === 0 ? 'Product name, ID or code' : 'Next item, or Enter to finish'} text={line.text} search={searchStuds}
                      onText={(text) => patchLine(line.key, (old) => f.typeText(old, text, form.type))}
                      onPick={(option) => patchLine(line.key, (old) => f.pickStud(old, option.value, form.type))}
                      onEmptyEnter={() => {
                        if (!blank || i === 0) return false;
                        putCursor({ place: 'packing' });
                        return true;
                      }}
                    />
                  </Cell>
                  <Cell name="Qty" box="quantity" className="col-span-2 md:col-span-1 md:row-start-2 lg:col-start-2 lg:row-start-1">
                    <input aria-label={named('Qty')} placeholder="Qty" className="field num px-2.5" inputMode="decimal" value={line.quantity} onChange={(event) => patchLine(line.key, (old) => ({ ...old, quantity: event.target.value.trim() }))} />
                  </Cell>
                  <Cell name="Unit" className="col-span-2 md:col-span-1 md:row-start-2 lg:col-start-3 lg:row-start-1">
                    <select aria-label={named('Unit')} data-enter-skip className="field px-2" value={line.unit} onChange={(event) => patchLine(line.key, (old) => f.changeUnit(old, event.target.value === 'kg' ? 'kg' : 'pcs', form.type))}>
                      <option value="pcs">pcs</option><option value="kg">kg</option>
                    </select>
                  </Cell>
                  <Cell name="Rate ₹" box="rate" className="col-span-2 md:col-span-1 md:row-start-2 lg:col-start-4 lg:row-start-1">
                    <input aria-label={named('Rate ₹')} placeholder="Rate" className="field num px-2.5" inputMode="decimal" value={line.rate} onChange={(event) => patchLine(line.key, (old) => ({ ...old, rate: event.target.value.trim() }))} />
                  </Cell>
                  <div className={`col-span-6 flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-muted md:col-span-full md:row-start-3 lg:row-start-2 ${blank && i > 0 ? 'hidden' : 'flex'}`}>
                    {about ? <span>{about}</span> : null}
                    <label className="flex items-center gap-1.5">HSN
                      <input aria-label={named('HSN/SAC')} data-enter-skip className="field min-h-9 w-[6.4rem] px-2 py-1 text-[15px]" inputMode="numeric" value={line.hsn} onChange={(event) => patchLine(line.key, (old) => ({ ...old, hsn: event.target.value.trim() }))} />
                    </label>
                    <label data-box="gst" className={`flex items-center gap-1.5 ${line.gst === '' && !blank ? 'font-semibold text-due' : ''}`}>GST %
                      {/* Enter stops here only while it is empty: a person has to type it. */}
                      <input aria-label={named('GST %')} data-enter-skip={line.gst === '' ? undefined : true} className={`field num min-h-9 w-[4.2rem] px-2 py-1 text-[15px] ${line.gst === '' && !blank ? 'border-due bg-due-bg' : ''}`} inputMode="decimal" value={line.gst} onChange={(event) => patchLine(line.key, (old) => f.typeGst(old, event.target.value))} />
                    </label>
                    {marginAlerts[line.key] ? <span role="status" className="flex items-center gap-1.5 font-semibold text-due"><Icon name="alert" className="size-4" />{marginAlerts[line.key]}</span> : null}
                  </div>
                  <Cell name="Amount ₹" className={`col-span-6 max-md:items-baseline max-md:justify-between ${blank ? 'max-md:hidden' : 'max-md:flex'} md:col-span-1 md:col-start-4 md:row-start-2 lg:col-start-5 lg:row-start-1`}>
                    <output aria-label={named('Amount')} className="num flex min-h-11.5 items-center justify-end text-[17px] font-semibold max-md:min-h-0">{computed ? formatPaise(computed.line_total_paise) : ''}</output>
                  </Cell>
                  <div className="col-start-6 row-start-1 max-md:pt-6 md:col-start-5 lg:col-start-6">
                    {blank ? null : (
                      <button type="button" aria-label={`Remove line ${i + 1}`} className="grid min-h-11.5 w-full cursor-pointer place-items-center rounded-lg text-muted hover:bg-warn-bg hover:text-warn" onClick={() => setForm((old) => ({ ...old, lines: f.withTrailingBlank(old.lines.filter((other_) => other_.key !== line.key), old.type) }))}>✕</button>
                    )}
                  </div>
                </div>
              );
            })}
          </section>

          {form.type === 'job_work' ? <Lots form={form} onChange={patchReturn} /> : null}

          <section data-place="packing" className="px-5 pt-4.5 pb-5" aria-label="Packing and delivery">
            <Step no={3} done={amounts !== null} note="Optional · ₹0 by default">Packing and delivery</Step>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="Packing ₹" hint="Optional · ₹0 if left blank"><input className="field num" inputMode="decimal" placeholder="0" value={form.packing} onChange={(event) => patch({ packing: event.target.value })} /></Field>
              <Field label="Freight ₹" hint={buyerPays ? 'Optional · ₹0 if left blank (on challan only)' : 'Optional · ₹0 if left blank'}><input className="field num" inputMode="decimal" placeholder="0" value={form.freight} onChange={(event) => patch({ freight: event.target.value })} /></Field>
              <Field label="Who pays the freight">
                <select className="field" value={form.freightPaidBy} onChange={(event) => patch({ freightPaidBy: event.target.value === 'buyer_to_pay' ? 'buyer_to_pay' : 'seller' })}>
                  <option value="seller">We pay, add to bill</option><option value="buyer_to_pay">Customer pays the driver</option>
                </select>
              </Field>
              {buyerPays || form.freight.trim() === '' ? null : (
                <label className="flex items-center gap-2.5"><input className="size-5 accent-accent" type="checkbox" checked={form.deliveryTaxable} onChange={(event) => patch({ deliveryTaxable: event.target.checked })} /> GST on freight</label>
              )}
              {mixedRates.length > 1 ? (
                <Field label="GST on charges">
                  <select className="field" value={form.chargesRate} onChange={(event) => patch({ chargesRate: event.target.value })}>
                    <option value="">Highest on the bill</option>
                    {mixedRates.map((rate) => <option key={rate} value={rate}>{rate}%</option>)}
                  </select>
                </Field>
              ) : null}
              {showMore ? (
                <>
                  <TransportFields value={f.transportOf(form)} onChange={(transport) => setForm((old) => f.changeTransport(old, transport))} />
                  <Field label="Note on bill" className="sm:col-span-2"><input className="field" maxLength={1000} value={form.notes} onChange={(event) => patch({ notes: event.target.value })} /></Field>
                </>
              ) : (
                <button type="button" className="btn sm:col-span-2 lg:col-span-3" aria-expanded={false} onClick={() => setMoreOpen(true)}>Vehicle, driver, LR, note</button>
              )}
            </div>
          </section>
        </div>

        <aside className="card bill-total overflow-hidden bg-sunken p-0" aria-label="Total">
          <div className="border-b border-line bg-card px-5 pt-4 pb-4.5">
            <p className="small-head">Bill total</p>
            <output aria-label="Bill total" aria-live="polite" className="mt-1 mb-0.5 block text-[36px] leading-tight font-semibold wrap-anywhere" style={{ fontFamily: 'var(--font-display)' }}>{amounts ? formatInr(amounts.grand_total_paise) : '₹ —'}</output>
            <p className="text-[13.5px] text-muted">{amounts ? rupeesInWords(amounts.grand_total_paise) : 'problem' in preview ? preview.problem : ''}</p>
          </div>
          <div className="grid gap-3.5 p-5">
            {amounts ? (
              <div className="grid gap-1.5 text-[15.5px]">
                <Sum label="Items" paise={amounts.subtotal_paise} />
                {amounts.taxable_value_paise === amounts.subtotal_paise ? null : <Sum label="With charges" paise={amounts.taxable_value_paise} />}
                {amounts.igst_paise > 0 ? <Sum label="IGST" paise={amounts.igst_paise} /> : <><Sum label="CGST" paise={amounts.cgst_paise} /><Sum label="SGST" paise={amounts.sgst_paise} /></>}
                {amounts.round_off_paise === 0 ? null : <Sum label="Round-off" paise={amounts.round_off_paise} />}
                {amounts.dc_to_pay_paise > 0 ? <Sum label="Customer pays the driver" paise={amounts.dc_to_pay_paise} /> : null}
              </div>
            ) : null}
            {amounts && 'problem' in preview ? <p className="font-semibold text-warn">{preview.problem}</p> : null}
            {(() => {
              const oldBalancePaise = glance ? decimalToPaise(glance.balance) : form.customer ? decimalToPaise(form.customer.opening_balance) : 0;
              return oldBalancePaise > 0 ? (
                <p className="flex items-center gap-2 rounded-[3px] border-l-[3px] border-due bg-due-bg px-3 py-2 text-sm font-semibold text-due"><Icon name="clock" className="size-[18px]" />Old balance of this customer {formatRupees(oldBalancePaise)}</p>
              ) : null;
            })()}
            <div className="flex items-end gap-2">
              <Field label="Received now ₹" className="flex-1"><input className="field num" inputMode="decimal" value={form.paid} onChange={(event) => patch({ paid: event.target.value })} /></Field>
              {form.paid.trim() === '' ? null : (
                <select aria-label="How it came" className="field w-auto" value={form.paidMode} onChange={(event) => patch({ paidMode: event.target.value })}>
                  <option value="cash">Cash</option><option value="upi">UPI</option><option value="bank_transfer">Bank</option><option value="cheque">Cheque</option>
                </select>
              )}
            </div>
            {error ? <Notice tone="warn">{error}</Notice> : null}
            <button className="btn btn-primary min-h-13 max-lg:hidden" type="submit" disabled={busy}>{busy ? 'Saving…' : <>Save bill<kbd className="kbd">Ctrl Enter</kbd></>}</button>
            <button className="more-link mx-auto cursor-pointer py-1 text-muted hover:text-warn" type="button" onClick={clear}>Clear</button>
          </div>
        </aside>
      </div>

      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-card px-4 py-2.5 side:px-7 lg:hidden">
        {error ? <div className="mb-2"><Notice tone="warn">{error}</Notice></div> : null}
        <div className="flex items-center gap-3">
          <b className="min-w-0 flex-1 text-[26px] leading-tight font-semibold wrap-anywhere" style={{ fontFamily: 'var(--font-display)' }}>{amounts ? formatInr(amounts.grand_total_paise) : '₹ —'}</b>
          <button className="btn btn-primary min-h-12 px-6" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save bill'}</button>
        </div>
      </div>
    </form>
  );
}

const LINE_COLUMNS = 'lg:grid-cols-[minmax(0,1fr)_5.2rem_4.4rem_6rem_6.6rem_2.2rem]';

function Step({ no, done = false, note, children }: { no: number; done?: boolean; note?: string; children: ReactNode }) {
  return (
    <div className="mb-2.5 flex items-center gap-2.5">
      <span aria-hidden className={`grid size-6.5 flex-none place-items-center rounded-full border text-[12.5px] font-bold ${done ? 'border-slate bg-slate text-white' : 'border-slate text-slate'}`}>{done ? '✓' : no}</span>
      <h2 className="card-title text-[19px]">{children}</h2>
      {note ? <small className="ml-auto text-[13.5px] text-muted max-side:hidden">{note}</small> : null}
    </div>
  );
}

const addLabel = (typed: string): string => `+ Add ‘${typed}’ as new customer`;

/** Rule 46, where it is needed: the bill stays as it is, and the customer gets the address for good. */
function AddressBox({ customer, engine, onSaved }: { customer: Customer; engine: OfflineEngine | null; onSaved: (customer: Customer) => void }) {
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function save(): Promise<void> {
    if (busy) return;
    if (address.trim() === '') return setProblem('Type the address');
    setBusy(true);
    const result = await addressSaved(customer, address, engine).catch(() => ({ problem: 'The address could not be kept. Try again.' }));
    setBusy(false);
    if ('customer' in result) onSaved(result.customer);
    else setProblem(result.problem);
  }

  return (
    <div
      className="mt-3 flex flex-wrap items-end gap-2"
      onKeyDown={(event) => {
        if (event.key !== 'Enter' || event.shiftKey) return;
        event.preventDefault();
        event.stopPropagation();
        void save();
      }}
    >
      <Field label={`Address of ${customer.name}`} hint="Needed on a bill of ₹50,000 or more" error={problem} className="min-w-64 flex-1">
        <textarea data-place="address" data-enter-skip className="field" rows={2} maxLength={500} value={address} onChange={(event) => setAddress(event.target.value)} />
      </Field>
      <button type="button" className="btn mb-7" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save address'}</button>
    </div>
  );
}

/** A named box of a bill line. On a wide screen the names stand once, above the first line. */
function Cell({ name, box, className = '', children }: { name: string; box?: f.LineBox; className?: string; children: ReactNode }) {
  return (
    <div className={`min-w-0 ${className}`} data-box={box}>
      <span aria-hidden className="mb-1 block text-[13px] font-semibold text-muted lg:hidden">{name}</span>
      {children}
    </div>
  );
}

function Sum({ label, paise }: { label: string; paise: number }) {
  return <div className="flex justify-between gap-3"><span>{label}</span><span className="tabular-nums">{formatPaise(paise)}</span></div>;
}

function Lots({ form, onChange }: { form: f.BillForm; onChange: (lotId: string, change: Partial<f.FormReturn>) => void }) {
  if (!form.customer) return null;
  return (
    <section className="grid gap-3 px-4.5 pt-4 pb-4.5" aria-label="Customer material going back">
      <h2 className="card-title text-base">Material going back</h2>
      {form.lots.length === 0 ? (
        <p className="text-muted">No material of this customer is here. <Link className="underline" href="/job-work?new">Material came in</Link></p>
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
