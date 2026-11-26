'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { enterAdvances } from '@/components/enter-advance';
import { Notice } from '@/components/field';
import { Icon } from '@/components/icon';
import { Pill } from '@/components/pill';
import { api } from '@/lib/api-client';
import { STEP } from '@/lib/goods-steps';
import { formatDate } from '@/lib/india';
import type { GoodsRow } from '@/lib/schemas/home';
import { TransportFields, type Transport } from '../billing/transport-fields';

const transportOf = (row: GoodsRow): Transport => ({
  transport_mode: row.transport_mode, vehicle_no: row.vehicle_no ?? '', driver_name: row.driver_name ?? '', driver_phone: row.driver_phone ?? '',
  lr_number: row.lr_number ?? '', delivery_address: row.delivery_address ?? '', status: 'dispatched',
});

/** Everything that did not arrive yet, with one button for the next step. */
export function GoodsList({ rows }: { rows: readonly GoodsRow[] }) {
  const router = useRouter();
  const box = useRef<HTMLDialogElement>(null);
  const [sending, setSending] = useState<{ row: GoodsRow; transport: Transport } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function change(row: GoodsRow, what: Partial<Transport>): Promise<boolean> {
    setBusy(row.id);
    setError(null);
    const reply = await api(`/api/deliveries/${row.id}`, 'PATCH', what);
    setBusy(null);
    if (!reply.ok) {
      setError(reply.message);
      return false;
    }
    router.refresh();
    return true;
  }

  function send(row: GoodsRow): void {
    setError(null);
    setSending({ row, transport: transportOf(row) });
    box.current?.showModal();
  }

  if (rows.length === 0) return <p className="card text-muted">Nothing to send. New bills come here by themselves.</p>;
  return (
    <>
      {error && !sending ? <div className="mb-3"><Notice tone="warn">{error}</Notice></div> : null}
      <ul className="card grid grid-cols-[minmax(0,1fr)] gap-0 p-0" aria-label="Goods to send">
        {rows.map((row) => {
          const step = STEP[row.status];
          const carrier = [row.vehicle_no, row.driver_name, row.lr_number ? `LR ${row.lr_number}` : null].filter(Boolean).join(' · ');
          return (
            <li key={row.id} className="flex flex-wrap items-center gap-x-4 gap-y-2.5 border-b border-line px-5 py-3.5 last:border-0">
              <span className="spot"><Icon name="truck" /></span>
              <span className="min-w-48 flex-1 basis-60">
                <b className="block font-semibold wrap-anywhere">{row.customer}</b>
                <small className="block text-[13.5px] text-muted">
                  <Link href={`/invoices/${row.invoice_id}`} prefetch={false} className="underline decoration-line-2 underline-offset-4">{row.invoice_no}</Link> · {row.dc_no} · {formatDate(row.dc_date)} · {row.items} item{row.items === 1 ? '' : 's'}
                </small>
                {row.status === 'dispatched' && carrier ? <small className="block text-[13.5px] text-muted">{carrier}</small> : null}
              </span>
              <Pill kind={step.kind} icon={step.icon}>{step.text}</Pill>
              <span className="flex gap-2">
                <Link className="btn btn-small" href={`/invoices/${row.invoice_id}/print?paper=a4&docs=dc`} prefetch={false}><Icon name="print" />Challan</Link>
                {row.status === 'pending' ? <button type="button" className="btn btn-small" disabled={busy === row.id} onClick={() => void change(row, { status: 'packed' })}>Packed</button> : null}
                {row.status === 'dispatched'
                  ? <button type="button" className="btn btn-primary btn-small" disabled={busy === row.id} onClick={() => void change(row, { status: 'delivered' })}>Delivered</button>
                  : <button type="button" className="btn btn-primary btn-small" disabled={busy === row.id} onClick={() => send(row)}>Send</button>}
              </span>
            </li>
          );
        })}
      </ul>
      <dialog ref={box} className="card" aria-label="Send goods" onClose={() => setSending(null)}>
        {sending ? (
          <form
            className="grid gap-3 p-5 sm:grid-cols-2" aria-label="Send goods" onKeyDown={enterAdvances}
            onSubmit={(event) => {
              event.preventDefault();
              void change(sending.row, sending.transport).then((done) => (done ? box.current?.close() : undefined));
            }}
          >
            <div className="flex items-start gap-3 sm:col-span-2">
              <div className="min-w-0"><h2 className="card-title text-[22px]">Send goods</h2><p className="text-muted">{sending.row.customer} · {sending.row.dc_no}</p></div>
              <button type="button" className="btn btn-small ml-auto" onClick={() => box.current?.close()}>Close</button>
            </div>
            <TransportFields value={sending.transport} onChange={(transport) => setSending({ row: sending.row, transport })} withStatus={false} />
            {error ? <div className="sm:col-span-2"><Notice tone="warn">{error}</Notice></div> : null}
            <button className="btn btn-primary min-h-13 sm:col-span-2" type="submit" disabled={busy !== null}><Icon name="truck" />{busy ? 'Saving…' : 'Goods are sent'}</button>
          </form>
        ) : null}
      </dialog>
    </>
  );
}
