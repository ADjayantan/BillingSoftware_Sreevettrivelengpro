'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { formatTime } from '@/lib/india';
import { decimalToPaise, formatInr } from '@/lib/money';
import { offlineEngine, type OfflineEngine } from '@/lib/offline';
import type { DraftRecord, QueueRecord, QueueSummary } from '@/lib/offline-db';
import { startServiceWorker } from '@/lib/service-worker';
import { useConnection } from './use-connection';

const STATUS: Record<QueueRecord['status'], string> = {
  pending: 'Waiting to sync', synced: 'Issued', conflict: 'Already issued: do not bill again', rejected: 'Needs a correction',
};

/** Silent while all is well. Otherwise: what is waiting on this PC, and what needs a person. */
export function OfflineBar() {
  const connection = useConnection();
  const [engine, setEngine] = useState<OfflineEngine | null>(null);
  const [queue, setQueue] = useState<QueueSummary>({ pending: 0, attention: 0, items: [] });
  const [drafts, setDrafts] = useState<DraftRecord[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let stops: (() => void)[] = [];
    let left = false;
    void offlineEngine().then((loaded) => {
      if (left) return;
      if (loaded) {
        setEngine(loaded);
        stops = [loaded.start(), loaded.watchQueue(setQueue), loaded.watchDrafts(setDrafts)];
      }
      void startServiceWorker();
    });
    return () => {
      left = true;
      for (const stop of stops) stop();
    };
  }, []);

  if (connection === 'online' && queue.pending === 0 && queue.attention === 0 && !open) return null;

  async function sync(): Promise<void> {
    if (!engine) return;
    setBusy(true);
    const result = await engine.syncNow().catch(() => null);
    setBusy(false);
    setNote(result && result.stopped !== 'done' ? result.message : null);
  }

  async function edit(item: { temp_id: string }, queued: boolean): Promise<void> {
    if (!engine) return;
    if (queued && !(await engine.reopen(item.temp_id))) return;
    await engine.flushDraft();
    // A full load, so the billing screen starts over from this PC's store, even offline.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign(`/billing?bill=${item.temp_id}`);
  }

  return (
    <aside aria-label="Sync status" className="sticky top-0 z-20 border-b border-line bg-card print:hidden">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2" role="status">
        {connection === 'offline' ? <span className="font-semibold">● Offline Mode<span className="font-normal text-muted"> · bills are kept on this PC</span></span> : null}
        {connection === 'signed_out' ? <span className="font-semibold text-warn">Signed out · <Link className="underline" href="/login?next=/billing">Sign in</Link></span> : null}
        {queue.pending > 0 ? <span className="font-semibold">Pending Sync ({queue.pending})</span> : null}
        {queue.attention > 0 ? <span className="font-semibold text-warn">{queue.attention} need{queue.attention === 1 ? 's' : ''} attention</span> : null}
        {note ? <span className="text-muted">{note}</span> : null}
        <span className="ml-auto flex gap-2">
          {queue.pending > 0 ? <button type="button" className="btn min-h-10 py-1" disabled={busy} onClick={() => void sync()}>{busy ? 'Syncing…' : 'Sync Now'}</button> : null}
          <button type="button" className="btn min-h-10 py-1" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Show bills'}</button>
        </span>
      </div>
      {open ? (
        <div className="mx-auto max-h-[60vh] max-w-7xl overflow-auto px-3 pb-3">
          <table className="grid-table">
            <thead><tr><th>Bill</th><th>Customer</th><th className="num">Total</th><th>Status</th><th /></tr></thead>
            <tbody>
              {queue.items.map((item) => (
                <tr key={item.seq}>
                  <td>{item.issued ? <Link className="font-semibold text-accent underline" href={`/invoices/${item.issued.invoice_id}`}>{item.issued.invoice_no}</Link> : <span className="text-muted">{formatTime(item.created_at)}</span>}</td>
                  <td>{item.customer}</td>
                  <td className="num">{formatInr(item.total_paise)}</td>
                  <td className={item.status === 'conflict' || item.status === 'rejected' ? 'text-warn' : ''}>
                    <span className="font-semibold">{STATUS[item.status]}</span>
                    {item.message && item.status !== 'synced' ? <span className="block text-sm">{item.message}</span> : null}
                    {item.status === 'conflict' && item.issued?.grand_total ? <span className="block text-sm">In the books: {formatInr(decimalToPaise(item.issued.grand_total))}</span> : null}
                  </td>
                  <td className="text-right">
                    {engine?.isReopenable(item) ? <button type="button" className="btn min-h-10 py-1" onClick={() => void edit(item, true)}>Edit</button> : null}
                    {item.status === 'synced' || item.status === 'conflict' ? <button type="button" className="btn min-h-10 py-1" onClick={() => void engine?.dismiss(item.temp_id)}>Dismiss</button> : null}
                  </td>
                </tr>
              ))}
              {drafts.map((draft) => (
                <tr key={draft.temp_id}>
                  <td className="text-muted">{formatTime(draft.updated_at)}</td>
                  <td>{draft.form.customerText || 'No customer yet'}</td>
                  <td />
                  <td>Still being typed</td>
                  <td className="text-right"><button type="button" className="btn min-h-10 py-1" onClick={() => void edit(draft, false)}>Open</button></td>
                </tr>
              ))}
              {queue.items.length + drafts.length === 0 ? <tr><td colSpan={5} className="text-muted">Nothing is waiting on this PC.</td></tr> : null}
            </tbody>
          </table>
        </div>
      ) : null}
    </aside>
  );
}
