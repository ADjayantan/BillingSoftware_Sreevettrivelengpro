'use client';

import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import { formatTime } from '@/lib/india';
import { decimalToPaise, formatInr } from '@/lib/money';
import { offlineEngine, type OfflineEngine } from '@/lib/offline';
import type { DraftRecord, NewCustomerRecord, QueueRecord, QueueSummary } from '@/lib/offline-db';
import { startServiceWorker } from '@/lib/service-worker';
import { CustomerChoice } from './customer-choice';
import { useConnection } from './use-connection';

const STATUS: Record<QueueRecord['status'], string> = {
  pending: 'Saved on this device, waiting to be issued', synced: 'Invoice issued', conflict: 'Already issued: do not bill again', rejected: 'Needs a correction', review: 'Which customer?',
};

/** One bill of the list: a row on a wide screen, a small card on a phone. */
function Entry({ bill, customer, total, action, children }: { bill: ReactNode; customer: string; total?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <li className="grid grid-cols-[1fr_auto] items-start gap-x-4 gap-y-1 border-b border-line py-2 last:border-0 md:grid-cols-[10rem_minmax(0,1fr)_8rem_minmax(0,2fr)_auto]">
      <span className="text-muted">{bill}</span>
      <span className="order-first col-span-2 font-semibold md:order-none md:col-span-1">{customer}</span>
      <span className="num">{total ?? ''}</span>
      <div className="col-span-2 md:col-span-1">{children}</div>
      <span className="col-span-2 flex gap-2 md:col-span-1 md:justify-end">{action}</span>
    </li>
  );
}

/** The owner's answer about a new customer; everything that waited for it goes on by itself. */
function Which({ customer, engine }: { customer: NewCustomerRecord | undefined; engine: OfflineEngine | null }) {
  if (!customer || !engine) return null;
  return (
    <CustomerChoice
      name={customer.form.name} reason={customer.reason} candidates={customer.candidates} message={customer.message}
      onUse={(chosen) => engine.chooseExisting(customer.id, chosen)} onDifferent={() => engine.chooseDifferent(customer.id)}
    />
  );
}

/** Silent while all is well. Otherwise: what is waiting on this PC, and what needs a person. */
export function OfflineBar() {
  const connection = useConnection();
  const [engine, setEngine] = useState<OfflineEngine | null>(null);
  const [queue, setQueue] = useState<QueueSummary>({ pending: 0, attention: 0, items: [], reviews: [] });
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
        {connection === 'offline' ? <span className="font-semibold">● Offline Mode<span className="font-normal text-muted"> · bills are kept on this device</span></span> : null}
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
          <ul>
            {queue.reviews.filter((one) => !queue.items.some((item) => item.status === 'review' && item.draft?.customer_id === one.id)).map((one) => (
              <Entry
                key={one.id} bill={formatTime(one.created_at)} customer={one.form.name}
                action={drafts.some(({ form }) => form.customer?.id === one.id || form.newCustomer?.id === one.id) ? null : <button type="button" className="btn min-h-10 py-1" onClick={() => void engine?.dropNewCustomer(one.id)}>Remove</button>}
              >
                <div className="text-warn"><span className="font-semibold">New customer: not in the books yet</span><Which customer={one} engine={engine} /></div>
              </Entry>
            ))}
            {queue.items.map((item) => (
              <Entry
                key={item.seq} customer={item.customer} total={formatInr(item.total_paise)}
                bill={item.issued ? <Link className="font-semibold text-accent underline" href={`/invoices/${item.issued.invoice_id}`}>{item.issued.invoice_no}</Link> : formatTime(item.created_at)}
                action={<>
                  {engine?.isReopenable(item) ? <button type="button" className="btn min-h-10 py-1" onClick={() => void edit(item, true)}>Edit</button> : null}
                  {item.status === 'synced' || item.status === 'conflict' ? <button type="button" className="btn min-h-10 py-1" onClick={() => void engine?.dismiss(item.temp_id)}>Dismiss</button> : null}
                </>}
              >
                <div className={item.status === 'conflict' || item.status === 'rejected' || item.status === 'review' ? 'text-warn' : ''}>
                  <span className="font-semibold">{STATUS[item.status]}</span>
                  {item.message && item.status !== 'review' ? <span className="block text-sm">{item.message}</span> : null}
                  {item.status === 'review' ? <Which customer={queue.reviews.find((one) => one.id === item.draft?.customer_id)} engine={engine} /> : null}
                  {item.status === 'conflict' && item.issued?.grand_total ? <span className="block text-sm">In the books: {formatInr(decimalToPaise(item.issued.grand_total))}</span> : null}
                </div>
              </Entry>
            ))}
            {drafts.map((draft) => (
              <Entry
                key={draft.temp_id} bill={formatTime(draft.updated_at)} customer={draft.form.customerText || 'No customer yet'}
                action={<button type="button" className="btn min-h-10 py-1" onClick={() => void edit(draft, false)}>Open</button>}
              >
                Still being typed
              </Entry>
            ))}
            {queue.items.length + queue.reviews.length + drafts.length === 0 ? <li className="py-2 text-muted">Nothing is waiting on this device.</li> : null}
          </ul>
        </div>
      ) : null}
    </aside>
  );
}
