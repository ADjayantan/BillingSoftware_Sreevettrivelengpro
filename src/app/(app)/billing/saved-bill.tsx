'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { CustomerChoice } from '@/components/customer-choice';
import { Notice } from '@/components/field';
import { useConnection } from '@/components/use-connection';
import { api } from '@/lib/api-client';
import type { CustomerForm } from '@/lib/customer-form';
import { decimalToPaise, formatInr } from '@/lib/money';
import type { OfflineEngine } from '@/lib/offline';
import type { NewCustomerRecord, QueueRecord } from '@/lib/offline-db';

function Step({ done, children }: { done: boolean; children: ReactNode }) {
  return (
    <li className={done ? 'font-semibold' : 'text-muted'}>
      <span aria-hidden className="mr-2 inline-block w-5 text-center">{done ? '✓' : '…'}</span>
      <span className="sr-only">{done ? 'Done: ' : 'Not yet: '}</span>
      {children}
    </li>
  );
}

const LOOK_AFTER = [2000, 3000, 5000, 10_000, 15_000, 25_000, 60_000, 120_000];

/** Is the bill in the month's Excel book yet? Asked a few times, then left to happen by itself. */
function useBook(invoiceId: string | null): 'waiting' | 'updated' | 'off' | 'slow' {
  const [state, setState] = useState<'waiting' | 'updated' | 'off' | 'slow'>('waiting');
  useEffect(() => {
    if (invoiceId === null) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let left = false;
    const look = async (round: number): Promise<void> => {
      const reply = await api<{ state: 'waiting' | 'updated' | 'off' }>(`/api/invoices/${invoiceId}/book`);
      if (left) return;
      if (reply.ok && reply.data.state !== 'waiting') return setState(reply.data.state);
      if (round >= 5) setState('slow');
      const next = LOOK_AFTER[round + 1];
      if (next !== undefined) timer = setTimeout(() => void look(round + 1), next);
    };
    timer = setTimeout(() => void look(0), LOOK_AFTER[0]);
    return () => {
      left = true;
      clearTimeout(timer);
    };
  }, [invoiceId]);
  return state;
}

/** After Save: the bill is safe on this device; its number appears when the books give it, then its line in the Excel book. */
export function SavedBill({ tempId, engine, issued, total, onNew, onRejected, onFixCustomer }: {
  tempId: string;
  engine: OfflineEngine | null;
  /** Set when it was sent directly, without this PC's store. */
  issued: { invoice_id: string; invoice_no: string; dc_no: string } | null;
  total: number | null;
  onNew: () => void;
  onRejected: (message: string) => void;
  onFixCustomer: (customer: CustomerForm, message: string) => void;
}) {
  const [item, setItem] = useState<QueueRecord | null>(null);
  const [customer, setCustomer] = useState<NewCustomerRecord | null>(null);
  const connection = useConnection();
  const printLink = useRef<HTMLAnchorElement>(null);
  const newButton = useRef<HTMLButtonElement>(null);
  const rejected = useRef(onRejected);
  useEffect(() => {
    rejected.current = onRejected;
  });

  useEffect(() => {
    if (!engine || issued) return;
    return engine.watchBill(tempId, (next, waitingFor) => {
      if (next?.status === 'rejected') return rejected.current(next.message ?? 'Check the bill');
      if (next) setItem(next);
      setCustomer(waitingFor ?? null);
    });
  }, [engine, issued, tempId]);

  const number = issued ?? (item?.status === 'synced' ? item.issued : null);
  const conflict = item?.status === 'conflict' ? item.issued : null;
  const book = useBook(number?.invoice_id ?? null);
  const review = item?.status === 'review' ? customer : null;
  const waiting = item?.status === 'pending' && (item.message !== null || connection !== 'online');
  useEffect(() => {
    if (number) printLink.current?.focus();
    else if (waiting) newButton.current?.focus();
  }, [number, waiting]);

  // Sent directly, when this browser has no store: there was nothing to keep here.
  const kept = issued === null;
  const steps = (
    <ol aria-label="Where this bill is" className="mx-auto grid gap-1 text-left">
      {kept ? <Step done>Saved on this device</Step> : null}
      <Step done={number !== null}>
        {number ? `Bill number: ${number.invoice_no}` : review ? 'Bill number: waits for the customer' : waiting ? 'Bill number: not yet' : 'Bill number: on its way'}
      </Step>
      <Step done={book === 'updated'}>
        {book === 'updated' ? 'Excel updated' : !number ? 'Excel: after the bill number' : book === 'off' ? 'Excel: Google Drive is not connected' : book === 'slow' ? 'Excel: updated by itself, a little later' : 'Excel: being updated'}
      </Step>
    </ol>
  );

  return (
    <section className="card mx-auto grid max-w-2xl gap-4 text-center" aria-live="polite">
      {conflict ? (
        <>
          <p className="text-lg font-semibold text-warn">Already issued: do not bill it again</p>
          <p className="text-4xl font-bold wrap-anywhere">{conflict.invoice_no}</p>
          <Notice tone="warn">
            This bill was already saved before the internet stopped. {conflict.invoice_no} stands{conflict.grand_total ? ` at ${formatInr(decimalToPaise(conflict.grand_total))}` : ''}
            {total === null ? '' : `; this device shows ${formatInr(total)}`}. If it is wrong, open it and cancel it.
          </Notice>
          <div className="flex flex-wrap justify-center gap-3">
            <Link className="btn btn-primary" href={`/invoices/${conflict.invoice_id}`}>Open {conflict.invoice_no}</Link>
            <button className="btn" type="button" onClick={onNew}>New bill<kbd className="kbd">Alt N</kbd></button>
          </div>
        </>
      ) : number ? (
        <>
          <p className="text-lg text-muted">Bill saved</p>
          <p className="text-4xl font-bold wrap-anywhere">{number.invoice_no}</p>
          <p className="text-xl">Delivery challan {number.dc_no}</p>
          {item?.note ? <p className="font-semibold">{item.note}</p> : null}
          {steps}
          <div className="flex flex-wrap justify-center gap-3">
            <Link ref={printLink} className="btn btn-primary" href={`/invoices/${number.invoice_id}/print?paper=a4`}>Print A4</Link>
            <Link className="btn" href={`/invoices/${number.invoice_id}/print?paper=a5`}>Print A5</Link>
            <Link className="btn" href={`/invoices/${number.invoice_id}`}>Open bill</Link>
            <button className="btn" type="button" onClick={onNew}>New bill<kbd className="kbd">Alt N</kbd></button>
          </div>
        </>
      ) : review ? (
        <>
          <p className="text-lg text-muted">The bill is safe. One question first:</p>
          <p className="text-4xl font-bold tabular-nums">{total === null ? '' : formatInr(total)}</p>
          <CustomerChoice
            name={review.form.name} reason={review.reason} candidates={review.candidates} message={review.message} takeFocus
            onUse={(chosen) => engine?.chooseExisting(review.id, chosen)}
            onDifferent={() => engine?.chooseDifferent(review.id)}
            onFix={() => onFixCustomer(review.form, review.message ?? 'Check the customer')}
          />
          {steps}
          <div className="flex flex-wrap justify-center gap-3">
            <button className="btn" type="button" onClick={onNew}>New bill<kbd className="kbd">Alt N</kbd></button>
          </div>
        </>
      ) : (
        <>
          <p className="text-lg text-muted">{waiting ? 'Saved on this device' : 'Saving…'}</p>
          <p className="text-4xl font-bold tabular-nums">{total === null ? '' : formatInr(total)}</p>
          <p className="text-xl">
            {waiting ? (connection === 'signed_out' ? 'Sign in again to get its bill number.' : 'It gets its number by itself when the internet is back.') : 'Getting the bill number'}
          </p>
          {item ? steps : null}
          <div className="flex flex-wrap justify-center gap-3">
            <button ref={newButton} className="btn btn-primary" type="button" onClick={onNew}>New bill<kbd className="kbd">Alt N</kbd></button>
          </div>
        </>
      )}
    </section>
  );
}
