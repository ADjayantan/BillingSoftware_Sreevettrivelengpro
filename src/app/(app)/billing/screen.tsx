'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { searchCustomers } from '@/components/customer-search';
import { enterAdvances } from '@/components/enter-advance';
import { Field, Notice } from '@/components/field';
import { Typeahead, type Option } from '@/components/typeahead';
import { useAltN } from '@/components/use-alt-n';
import { api } from '@/lib/api-client';
import { distinctRates } from '@/lib/bill-draft';
import * as f from '@/lib/bill-form';
import { addDays, istDate, stateLabel } from '@/lib/india';
import { formatInr, formatPaise, trimZeros } from '@/lib/money';
import type { Customer, JobWorkLot, StudItem } from '@/lib/schemas/masters';
import { TransportFields } from './transport-fields';

const mintId = (): string => `OFFLINE-${crypto.randomUUID()}`;

async function searchStuds(q: string): Promise<Option<StudItem>[]> {
  if (q.trim() === '') return [];
  const result = await api<{ rows: StudItem[] }>(`/api/stud-items?${new URLSearchParams({ q }).toString()}`);
  if (!result.ok) return [];
  return result.data.rows
    .filter((row) => row.is_active)
    .slice(0, 12)
    .map((row) => ({
      key: row.id, label: row.sku_code, value: row,
      detail: `${trimZeros(row.diameter_mm)} × ${trimZeros(row.length_mm)} mm · ${row.material_grade} · ₹${row.default_rate_per_piece ? `${trimZeros(row.default_rate_per_piece)}/pc` : row.default_rate_per_kg ? `${trimZeros(row.default_rate_per_kg)}/kg` : 'no rate'}`,
    }));
}

interface Issued {
  invoice_id: string;
  invoice_no: string;
  dc_no: string;
}

export function BillingScreen({ today }: { today: string }) {
  // The id is minted on first save, not on render, so server and browser HTML agree.
  const [form, setForm] = useState<f.BillForm>(() => f.newBill('', today));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<Issued | null>(null);
  const printLink = useRef<HTMLAnchorElement>(null);
  const afterLines = useRef<HTMLDivElement>(null);
  const lotRequest = useRef(0);

  useEffect(() => {
    if (issued) printLink.current?.focus();
  }, [issued]);

  const patch = (change: Partial<f.BillForm>): void => setForm((old) => ({ ...old, ...change }));
  const patchLine = (key: number, change: (line: f.FormLine) => f.FormLine): void =>
    setForm((old) => ({ ...old, lines: f.withTrailingBlank(old.lines.map((line) => (line.key === key ? change(line) : line)), old.type) }));
  const patchReturn = (lotId: string, change: Partial<f.FormReturn>): void =>
    setForm((old) => ({ ...old, returns: { ...old.returns, [lotId]: { ...f.blankReturn, ...old.returns[lotId], ...change } } }));

  async function loadLots(customer: Customer | null): Promise<void> {
    const ticket = ++lotRequest.current;
    patch({ lots: [], returns: {} });
    if (!customer) return;
    const result = await api<{ rows: JobWorkLot[] }>(`/api/job-work?customer_id=${customer.id}&open=true`);
    if (ticket === lotRequest.current && result.ok) patch({ lots: result.data.rows });
  }

  function pickCustomer(customer: Customer): void {
    patch({ customer, customerText: customer.name, dueDate: null });
    void loadLots(customer);
  }

  function startNew(): void {
    lotRequest.current += 1;
    setForm(f.newBill('', istDate(new Date()), form.type));
    setIssued(null);
    setError(null);
  }

  function clear(): void {
    if (form.lines.every(f.isBlank) || window.confirm('Clear this bill? It has not been saved.')) startNew();
  }

  useAltN(() => (issued ? startNew() : clear()));

  const preview = f.previewBill(form);
  const bill = 'bill' in preview ? preview.bill : null;
  const amounts = bill?.detail.amounts ?? null;
  const typedLines = form.lines.filter((line) => !f.isBlank(line));
  const mixedRates = distinctRates(typedLines.map((line) => ({ gst_rate: line.gst || '0' })));
  const buyerPays = form.freightPaidBy === 'buyer_to_pay';

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (busy || issued) return;
    if (!bill) return setError('problem' in preview ? preview.problem : 'Check the bill');
    // One id per bill, kept across retries, so a lost reply can never issue it twice.
    const tempId = form.tempId || mintId();
    const ready = { ...form, tempId };
    setForm(ready);
    setBusy(true);
    setError(null);
    const result = await api<Issued>('/api/invoices/sync', 'POST', f.toDraft(ready, bill));
    setBusy(false);
    if (result.ok) setIssued(result.data);
    else setError(result.message);
  }

  if (issued) {
    return (
      <section className="card mx-auto grid max-w-2xl gap-4 text-center" aria-live="polite">
        <p className="text-lg text-muted">Bill saved</p>
        <p className="text-4xl font-bold">{issued.invoice_no}</p>
        <p className="text-xl">Delivery challan {issued.dc_no}</p>
        <div className="flex flex-wrap justify-center gap-3">
          <Link ref={printLink} className="btn btn-primary" href={`/invoices/${issued.invoice_id}/print?paper=a4`}>Print A4</Link>
          <Link className="btn" href={`/invoices/${issued.invoice_id}/print?paper=a5`}>Print A5</Link>
          <Link className="btn" href={`/invoices/${issued.invoice_id}`}>Open bill</Link>
          <button className="btn" type="button" onClick={startNew}>New bill (Alt+N)</button>
        </div>
      </section>
    );
  }

  return (
    <form onSubmit={(event) => void save(event)} onKeyDown={enterAdvances} aria-label="New bill" className="grid gap-4 pb-28">
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
