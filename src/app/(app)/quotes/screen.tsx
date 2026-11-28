'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { enterAdvances } from '@/components/enter-advance';
import { Field, Notice } from '@/components/field';
import { Icon } from '@/components/icon';
import { Pill } from '@/components/pill';
import { Typeahead } from '@/components/typeahead';
import { useAltN } from '@/components/use-alt-n';
import { api } from '@/lib/api-client';
import * as f from '@/lib/bill-form';
import { formatDate, stateLabel } from '@/lib/india';
import { searchCustomers, searchStuds } from '@/lib/master-search';
import { decimalToPaise, formatInr, formatPaise, rupeesInWords } from '@/lib/money';
import { quoteCode, type QuoteRow } from '@/lib/schemas/quotes';
import { whatsappLink } from '@/lib/whatsapp';

const QUOTE_TEMP_ID = 'OFFLINE-00000000-0000-4000-8000-000000000000';

function buildQuoteWhatsApp(quote: QuoteRow, companyName: string): string {
  const code = quoteCode(quote.quote_no);
  const itemLines = quote.lines
    .map((l, i) => `${i + 1}. ${l.description} — ${l.quantity} ${l.billing_unit} @ Rs.${l.rate}/${l.billing_unit}`)
    .join('\n');
  const message = [
    `Quotation ${code} from ${companyName}`,
    `Customer: ${quote.customer_snapshot.name}`,
    `Date: ${formatDate(quote.quote_date)} (Valid until ${formatDate(quote.valid_until)})`,
    '',
    'Items:',
    itemLines,
    '',
    `Total (incl. GST): ${formatInr(decimalToPaise(quote.grand_total))}`,
    quote.notes ? `Note: ${quote.notes}` : null,
  ]
    .filter(Boolean)
    .join('\n');
  return whatsappLink(quote.customer_snapshot.phone, message) ?? `https://wa.me/?text=${encodeURIComponent(message)}`;
}

export function QuotesScreen({
  initialQuotes,
  today,
  defaultValidUntil,
  companyName,
  startOpen,
}: {
  initialQuotes: QuoteRow[];
  today: string;
  defaultValidUntil: string;
  companyName: string;
  startOpen: boolean;
}) {
  const router = useRouter();
  const [quotes, setQuotes] = useState<QuoteRow[]>(initialQuotes);
  const [openForm, setOpenForm] = useState<boolean>(startOpen || initialQuotes.length === 0);
  const [filter, setFilter] = useState<'open' | 'converted' | 'cancelled' | 'all'>('all');
  const [form, setForm] = useState<f.BillForm>(() => f.newBill(QUOTE_TEMP_ID, today));
  const [validUntil, setValidUntil] = useState<string>(defaultValidUntil);
  const [chargesOpen, setChargesOpen] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(false);
  const [convertingId, setConvertingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);

  useAltN(() => {
    setOpenForm(true);
    setError(null);
  });

  const patch = (change: Partial<f.BillForm>): void => setForm((old) => ({ ...old, ...change }));
  const patchLine = (key: number, change: (line: f.FormLine) => f.FormLine): void =>
    setForm((old) => ({
      ...old,
      lines: f.withTrailingBlank(
        old.lines.map((line) => (line.key === key ? change(line) : line)),
        old.type,
      ),
    }));

  const preview = f.previewBill(form);
  const bill = preview.bill ?? null;
  const amounts = bill?.detail.amounts ?? null;
  const typedLines = form.lines.filter((line) => !f.isBlank(line));

  async function saveQuote(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    if (!form.customer) {
      setError('Pick an existing customer first');
      return;
    }
    if ('problem' in preview || !bill) {
      setError('problem' in preview ? preview.problem : 'Check the quotation items');
      return;
    }
    setBusy(true);
    setError(null);
    setBanner(null);
    const editPayload = f.toEditDraft(form, bill);
    const res = await api<QuoteRow>('/api/quotes', 'POST', {
      bill_type: form.type,
      customer_id: form.customer.id,
      quote_date: form.invoiceDate,
      valid_until: validUntil,
      notes: editPayload.notes,
      lines: editPayload.lines,
      packing: editPayload.packing,
      freight: editPayload.freight,
      freight_paid_by: editPayload.freight_paid_by,
      delivery_taxable: editPayload.delivery_taxable,
      charges_gst_rate: editPayload.charges_gst_rate,
      expected_total_paise: editPayload.expected_total_paise,
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setQuotes((old) => [res.data, ...old]);
    setForm(f.newBill(QUOTE_TEMP_ID, today));
    setChargesOpen(false);
    setOpenForm(false);
    setBanner(`Quotation ${quoteCode(res.data.quote_no)} for ${res.data.customer_snapshot.name} is saved.`);
    router.refresh();
  }

  async function convertOneClick(quote: QuoteRow): Promise<void> {
    if (convertingId) return;
    setConvertingId(quote.id);
    setError(null);
    setBanner(null);
    const res = await api<{ invoice_id: string; invoice_no: string; dc_no: string | null }>(
      `/api/quotes/${quote.id}/convert`,
      'POST',
      {},
    );
    setConvertingId(null);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setQuotes((old) =>
      old.map((q) =>
        q.id === quote.id
          ? {
              ...q,
              status: 'converted',
              converted_invoice_id: res.data.invoice_id,
              converted_invoice_no: res.data.invoice_no,
            }
          : q,
      ),
    );
    setBanner(
      `Quotation ${quoteCode(quote.quote_no)} converted to tax invoice ${res.data.invoice_no}${res.data.dc_no ? ` and challan ${res.data.dc_no}` : ''}.`,
    );
    router.refresh();
  }

  async function cancelQuote(quote: QuoteRow): Promise<void> {
    setError(null);
    const res = await api<QuoteRow>(`/api/quotes/${quote.id}`, 'PATCH', { status: 'cancelled' });
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setQuotes((old) => old.map((q) => (q.id === quote.id ? res.data : q)));
    router.refresh();
  }

  const openCount = quotes.filter((q) => q.status === 'open').length;
  const openTotalPaise = quotes
    .filter((q) => q.status === 'open')
    .reduce((acc, q) => acc + decimalToPaise(q.grand_total), 0);
  const convertedCount = quotes.filter((q) => q.status === 'converted').length;
  const shown = filter === 'all' ? quotes : quotes.filter((q) => q.status === filter);

  return (
    <div className="grid gap-6">
      <section aria-label="Quotation figures" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="card p-4">
          <p className="small-head">Open quotes</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">{openCount}</p>
          <p className="mt-0.5 text-[13.5px] text-muted">Waiting for approval</p>
        </div>
        <div className="card p-4">
          <p className="small-head">Open value</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">{formatInr(openTotalPaise)}</p>
          <p className="mt-0.5 text-[13.5px] text-muted">Ready for 1-click billing</p>
        </div>
        <div className="card p-4">
          <p className="small-head">Converted to bills</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">{convertedCount}</p>
          <p className="mt-0.5 text-[13.5px] text-muted">Issued as tax invoices</p>
        </div>
        <div className="card flex items-center justify-center p-4">
          <button
            type="button"
            className="btn btn-primary w-full"
            onClick={() => {
              setOpenForm((v) => !v);
              setError(null);
            }}
          >
            <Icon name="plus" />
            {openForm ? 'Hide form' : 'New quotation'}
          </button>
        </div>
      </section>

      {banner ? <Notice tone="info">{banner}</Notice> : null}
      {error ? <Notice tone="warn">{error}</Notice> : null}

      {openForm ? (
        <form
          onSubmit={(e) => void saveQuote(e)}
          onKeyDown={enterAdvances}
          aria-label="New quotation"
          className="card grid gap-4 p-5"
        >
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-3">
            <h2 className="card-title text-xl">New quotation</h2>
            <div role="group" aria-label="Kind of quotation" className="inline-flex rounded-[3px] border border-line-2 p-[3px]">
              {(
                [
                  ['supply', 'Sale'],
                  ['job_work', 'Job work'],
                ] as const
              ).map(([type, label]) => (
                <button
                  key={type}
                  type="button"
                  aria-pressed={form.type === type}
                  onClick={() => setForm((old) => f.changeType(old, type))}
                  className={`min-h-9 cursor-pointer rounded-[2px] px-4 text-[13px] font-semibold tracking-[0.06em] uppercase ${
                    form.type === type ? 'bg-slate text-white' : 'text-ink-2 hover:text-ink'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="grid gap-3.5 sm:grid-cols-[minmax(0,1fr)_10.5rem_10.5rem]">
            <div>
              <Field label="Customer">
                <Typeahead
                  inputLabel="Customer for quote"
                  placeholder="Type customer name, phone or GSTIN"
                  text={form.customerText}
                  search={searchCustomers}
                  onText={(text) => patch({ customerText: text, customer: null })}
                  onPick={(option) => patch({ customer: option.value, customerText: option.value.name, newCustomer: null })}
                />
              </Field>
              {form.customer ? (
                <p className="mt-1 text-[13.5px] text-muted">
                  {[form.customer.gstin ?? 'Unregistered', stateLabel(form.customer.state_code), form.customer.phone]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              ) : null}
            </div>
            <Field label="Quote date">
              <input
                className="field"
                type="date"
                required
                value={form.invoiceDate}
                onChange={(e) => patch({ invoiceDate: e.target.value })}
              />
            </Field>
            <Field label="Valid until">
              <input
                className="field"
                type="date"
                required
                min={form.invoiceDate}
                value={validUntil}
                onChange={(e) => setValidUntil(e.target.value)}
              />
            </Field>
          </div>

          <div className="grid gap-2 border-t border-line pt-3">
            <div className="flex items-center justify-between">
              <h3 className="card-title text-base">Items</h3>
              <small className="text-[13px] text-muted">Pick a product or type a custom description</small>
            </div>
            {form.lines.map((line, i) => {
              const position = typedLines.indexOf(line);
              const computed = position >= 0 ? bill?.detail.lines[position] : undefined;
              const blank = f.isBlank(line);
              const named = (name: string): string => `${name}, quote line ${i + 1}`;
              return (
                <div
                  key={line.key}
                  className="grid grid-cols-6 items-start gap-2 border-t border-line pt-2.5 sm:grid-cols-[minmax(0,1fr)_5.2rem_4.4rem_6rem_5.6rem_4.6rem_6.4rem_2.2rem]"
                >
                  <div className="col-span-5 sm:col-span-1">
                    <Typeahead
                      inputLabel={named('Product or ID')}
                      placeholder={i === 0 ? 'Product name, ID or code' : 'Add another item'}
                      text={line.text}
                      search={searchStuds}
                      onText={(text) => patchLine(line.key, (old) => f.typeText(old, text, form.type))}
                      onPick={(option) => patchLine(line.key, (old) => f.pickStud(old, option.value, form.type))}
                    />
                  </div>
                  <div className="col-span-2 sm:col-span-1">
                    <input
                      aria-label={named('Qty')}
                      placeholder="Qty"
                      className="field num px-2"
                      inputMode="decimal"
                      value={line.quantity}
                      onChange={(e) => patchLine(line.key, (old) => ({ ...old, quantity: e.target.value.trim() }))}
                    />
                  </div>
                  <div className="col-span-2 sm:col-span-1">
                    <select
                      aria-label={named('Unit')}
                      data-enter-skip
                      className="field px-1.5"
                      value={line.unit}
                      onChange={(e) =>
                        patchLine(line.key, (old) => f.changeUnit(old, e.target.value === 'kg' ? 'kg' : 'pcs', form.type))
                      }
                    >
                      <option value="pcs">pcs</option>
                      <option value="kg">kg</option>
                    </select>
                  </div>
                  <div className="col-span-2 sm:col-span-1">
                    <input
                      aria-label={named('Rate ₹')}
                      placeholder="Rate"
                      className="field num px-2"
                      inputMode="decimal"
                      value={line.rate}
                      onChange={(e) => patchLine(line.key, (old) => ({ ...old, rate: e.target.value.trim() }))}
                    />
                  </div>
                  <div className="col-span-2 sm:col-span-1">
                    <input
                      aria-label={named('HSN/SAC')}
                      data-enter-skip
                      placeholder="HSN"
                      className="field px-2"
                      inputMode="numeric"
                      value={line.hsn}
                      onChange={(e) => patchLine(line.key, (old) => ({ ...old, hsn: e.target.value.trim() }))}
                    />
                  </div>
                  <div className="col-span-2 sm:col-span-1">
                    <input
                      aria-label={named('GST %')}
                      placeholder="GST %"
                      className="field num px-2"
                      inputMode="decimal"
                      value={line.gst}
                      onChange={(e) => patchLine(line.key, (old) => f.typeGst(old, e.target.value))}
                    />
                  </div>
                  <div className="col-span-2 flex min-h-11.5 items-center justify-end sm:col-span-1">
                    <output aria-label={named('Amount')} className="num text-[16px] font-semibold">
                      {computed ? formatPaise(computed.line_total_paise) : ''}
                    </output>
                  </div>
                  <div className="col-start-6 row-start-1 sm:col-start-8">
                    {blank ? null : (
                      <button
                        type="button"
                        aria-label={`Remove quote line ${i + 1}`}
                        className="grid min-h-11.5 w-full cursor-pointer place-items-center rounded-lg text-muted hover:bg-warn-bg hover:text-warn"
                        onClick={() =>
                          setForm((old) => ({
                            ...old,
                            lines: f.withTrailingBlank(
                              old.lines.filter((other) => other.key !== line.key),
                              old.type,
                            ),
                          }))
                        }
                      >
                        ✕
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="grid gap-3 border-t border-line pt-3 sm:grid-cols-3">
            {chargesOpen ? (
              <>
                <Field label="Packing ₹" hint="Optional · ₹0 by default">
                  <input
                    className="field num"
                    inputMode="decimal"
                    placeholder="0"
                    value={form.packing}
                    onChange={(e) => patch({ packing: e.target.value })}
                  />
                </Field>
                <Field label="Freight ₹" hint="Optional · ₹0 by default">
                  <input
                    className="field num"
                    inputMode="decimal"
                    placeholder="0"
                    value={form.freight}
                    onChange={(e) => patch({ freight: e.target.value })}
                  />
                </Field>
              </>
            ) : (
              <div className="flex items-end">
                <button type="button" className="btn btn-small" onClick={() => setChargesOpen(true)}>
                  + Packing or freight charge (optional · ₹0 now)
                </button>
              </div>
            )}
            <Field label="Terms / note on quote">
              <input
                className="field"
                maxLength={1000}
                placeholder="Delivery in 3 days, ex-works Coimbatore"
                value={form.notes}
                onChange={(e) => patch({ notes: e.target.value })}
              />
            </Field>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-4 rounded-[3px] border border-line bg-sunken p-4">
            <div>
              <p className="small-head">Quoted total (incl. GST)</p>
              <p className="text-[13.5px] text-muted">
                {amounts ? rupeesInWords(amounts.grand_total_paise) : 'problem' in preview ? preview.problem : ''}
              </p>
            </div>
            <div className="flex items-center gap-4">
              <output
                aria-label="Quotation total"
                className="text-[28px] leading-tight font-semibold"
                style={{ fontFamily: 'var(--font-display)' }}
              >
                {amounts ? formatInr(amounts.grand_total_paise) : '₹ —'}
              </output>
              <button type="submit" className="btn btn-primary" disabled={busy}>
                {busy ? 'Saving…' : 'Save quotation'}
              </button>
            </div>
          </div>
        </form>
      ) : null}

      <section aria-label="Quotations list" className="grid gap-3">
        <div className="flex flex-wrap items-center gap-2 border-b border-line pb-2.5">
          {(
            [
              ['all', `All (${quotes.length})`],
              ['open', `Open (${openCount})`],
              ['converted', `Converted (${convertedCount})`],
              ['cancelled', `Cancelled (${quotes.filter((q) => q.status === 'cancelled').length})`],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setFilter(key)}
              className={`min-h-9 cursor-pointer rounded-[3px] px-3.5 text-[13.5px] font-semibold ${
                filter === key ? 'bg-slate text-white' : 'text-ink-2 hover:bg-soft'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {shown.length === 0 ? (
          <p className="card p-6 text-muted">No quotations in this list yet.</p>
        ) : (
          <ul className="grid gap-3">
            {shown.map((quote) => {
              const code = quoteCode(quote.quote_no);
              const totalPaise = decimalToPaise(quote.grand_total);
              const pillKind = quote.status === 'converted' ? 'paid' : quote.status === 'cancelled' ? 'off' : 'due';
              const pillText =
                quote.status === 'converted'
                  ? `Billed · ${quote.converted_invoice_no ?? 'Issued'}`
                  : quote.status === 'cancelled'
                    ? 'Cancelled'
                    : `Valid until ${formatDate(quote.valid_until)}`;
              return (
                <li
                  key={quote.id}
                  className="card grid items-center gap-4 p-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1.3fr)_auto]"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2.5">
                      <span className="font-semibold text-accent">{code}</span>
                      <b className="text-[17px]">{quote.customer_snapshot.name}</b>
                      <Pill kind={pillKind}>{pillText}</Pill>
                    </div>
                    <p className="mt-1 text-[13.5px] text-muted">
                      {[
                        formatDate(quote.quote_date),
                        quote.bill_type === 'job_work' ? 'Job work' : 'Sale',
                        quote.customer_snapshot.gstin ?? 'Unregistered',
                        stateLabel(quote.place_of_supply),
                      ].join(' · ')}
                    </p>
                    {quote.notes ? <p className="mt-1 text-[13.5px] text-ink-2">{quote.notes}</p> : null}
                  </div>

                  <div className="min-w-0 text-[14px] text-ink-2">
                    <ul className="grid gap-0.5">
                      {quote.lines.map((line, idx) => (
                        <li key={idx} className="truncate">
                          <b>{line.description}</b> · {line.quantity} {line.billing_unit} × ₹{line.rate} ({line.gst_rate}% GST)
                        </li>
                      ))}
                    </ul>
                  </div>

                  <div className="flex flex-wrap items-center justify-end gap-2.5">
                    <span className="mr-2 text-xl font-semibold tabular-nums">{formatInr(totalPaise)}</span>
                    {quote.status === 'open' ? (
                      <>
                        <button
                          type="button"
                          className="btn btn-primary"
                          disabled={convertingId === quote.id}
                          onClick={() => void convertOneClick(quote)}
                        >
                          <Icon name="bill" />
                          {convertingId === quote.id ? 'Creating bill…' : 'Make bill (1 click)'}
                        </button>
                        <a
                          className="btn btn-small"
                          href={buildQuoteWhatsApp(quote, companyName)}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          <Icon name="chat" />
                          WhatsApp
                        </a>
                        <button
                          type="button"
                          className="btn btn-small text-muted hover:text-warn"
                          onClick={() => void cancelQuote(quote)}
                        >
                          Cancel
                        </button>
                      </>
                    ) : quote.status === 'converted' && quote.converted_invoice_id ? (
                      <Link className="btn btn-primary" href={`/invoices/${quote.converted_invoice_id}`}>
                        <Icon name="bill" />
                        Open {quote.converted_invoice_no ?? 'bill'}
                      </Link>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
