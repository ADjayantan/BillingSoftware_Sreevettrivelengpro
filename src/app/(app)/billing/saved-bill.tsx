'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Notice } from '@/components/field';
import { useConnection } from '@/components/use-connection';
import { decimalToPaise, formatInr } from '@/lib/money';
import type { OfflineEngine } from '@/lib/offline';
import type { QueueRecord } from '@/lib/offline-db';

/** After Save: the bill is safe on this PC; its number appears when the cloud gives it. */
export function SavedBill({ tempId, engine, issued, total, onNew, onRejected }: {
  tempId: string;
  engine: OfflineEngine | null;
  /** Set when it was sent directly, without this PC's store. */
  issued: { invoice_id: string; invoice_no: string; dc_no: string } | null;
  total: number | null;
  onNew: () => void;
  onRejected: (message: string) => void;
}) {
  const [item, setItem] = useState<QueueRecord | null>(null);
  const connection = useConnection();
  const printLink = useRef<HTMLAnchorElement>(null);
  const newButton = useRef<HTMLButtonElement>(null);
  const rejected = useRef(onRejected);
  useEffect(() => {
    rejected.current = onRejected;
  });

  useEffect(() => {
    if (!engine || issued) return;
    return engine.watchBill(tempId, (next) => {
      if (next?.status === 'rejected') rejected.current(next.message ?? 'Check the bill');
      else if (next) setItem(next);
    });
  }, [engine, issued, tempId]);

  const number = issued ?? (item?.status === 'synced' ? item.issued : null);
  const conflict = item?.status === 'conflict' ? item.issued : null;
  const waiting = item?.status === 'pending' && (item.message !== null || connection !== 'online');
  useEffect(() => {
    if (number) printLink.current?.focus();
    else if (waiting) newButton.current?.focus();
  }, [number, waiting]);

  return (
    <section className="card mx-auto grid max-w-2xl gap-4 text-center" aria-live="polite">
      {conflict ? (
        <>
          <p className="text-lg font-semibold text-warn">Already issued: do not bill it again</p>
          <p className="text-4xl font-bold">{conflict.invoice_no}</p>
          <Notice tone="warn">
            This bill reached the books before the connection dropped. {conflict.invoice_no} stands{conflict.grand_total ? ` at ${formatInr(decimalToPaise(conflict.grand_total))}` : ''}
            {total === null ? '' : `; this PC shows ${formatInr(total)}`}. If it is wrong, open it and cancel it.
          </Notice>
          <div className="flex flex-wrap justify-center gap-3">
            <Link className="btn btn-primary" href={`/invoices/${conflict.invoice_id}`}>Open {conflict.invoice_no}</Link>
            <button className="btn" type="button" onClick={onNew}>New bill (Alt+N)</button>
          </div>
        </>
      ) : number ? (
        <>
          <p className="text-lg text-muted">Bill saved</p>
          <p className="text-4xl font-bold">{number.invoice_no}</p>
          <p className="text-xl">Delivery challan {number.dc_no}</p>
          <div className="flex flex-wrap justify-center gap-3">
            <Link ref={printLink} className="btn btn-primary" href={`/invoices/${number.invoice_id}/print?paper=a4`}>Print A4</Link>
            <Link className="btn" href={`/invoices/${number.invoice_id}/print?paper=a5`}>Print A5</Link>
            <Link className="btn" href={`/invoices/${number.invoice_id}`}>Open bill</Link>
            <button className="btn" type="button" onClick={onNew}>New bill (Alt+N)</button>
          </div>
        </>
      ) : (
        <>
          <p className="text-lg text-muted">{waiting ? 'Saved on this PC' : 'Saving…'}</p>
          <p className="text-4xl font-bold tabular-nums">{total === null ? '' : formatInr(total)}</p>
          <p className="text-xl">
            {waiting ? (connection === 'signed_out' ? 'Sign in again to get its invoice number.' : 'It gets its invoice number by itself when the internet is back.') : 'Getting the invoice number'}
          </p>
          <div className="flex flex-wrap justify-center gap-3">
            <button ref={newButton} className="btn btn-primary" type="button" onClick={onNew}>New bill (Alt+N)</button>
          </div>
        </>
      )}
    </section>
  );
}
