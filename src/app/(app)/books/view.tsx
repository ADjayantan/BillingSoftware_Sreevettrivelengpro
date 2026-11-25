'use client';

import { useEffect, useState } from 'react';
import { Notice } from '@/components/field';
import { api } from '@/lib/api-client';
import { bookStatus, byYear } from '@/lib/book-status';
import { formatTime, monthName } from '@/lib/india';
import type { BookMonthRow } from '@/lib/schemas/books';

interface Books {
  months: BookMonthRow[];
  drive: boolean;
}

const LOOK_EVERY = 4000;
/** Then it is left alone: the page says when it is tried again. */
const LOOKS = 30;

/** Makes the book now and hands it to the device. Null, or what went wrong. */
async function openBook(month: string): Promise<string | null> {
  const name = month.slice(0, 7);
  try {
    const response = await fetch(`/api/books/${name}`, { cache: 'no-store' });
    if (!response.ok) {
      const reply = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
      return reply?.error?.message ?? 'The book could not be made. Try again.';
    }
    const address = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = address;
    link.download = `Billing_${name}.xlsx`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(address), 60_000); // a phone may still be reading it
    return null;
  } catch {
    return 'No connection. Try again when the internet is back.';
  }
}

export function BooksView({ months, drive, now }: Books & { now: string }) {
  const [books, setBooks] = useState<Books>({ months, drive });
  const [clock, setClock] = useState(() => Date.parse(now));
  const [looks, setLooks] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const unsettled = books.drive && books.months.some((row) => row.waiting > 0 || row.updating);
  useEffect(() => {
    if (!unsettled || looks >= LOOKS) return;
    const timer = setTimeout(() => {
      void api<Books>('/api/books').then((reply) => {
        if (reply.ok) setBooks(reply.data);
        setClock(Date.now());
        setLooks((count) => count + 1);
      });
    }, LOOK_EVERY);
    return () => clearTimeout(timer);
  }, [unsettled, looks]);

  async function open(month: string): Promise<void> {
    setBusy(month);
    setProblem(await openBook(month));
    setBusy(null);
  }

  async function retry(month: string): Promise<void> {
    setBusy(month);
    const reply = await api(`/api/books/${month.slice(0, 7)}/retry`, 'POST', {});
    setProblem(reply.ok ? null : reply.message);
    const fresh = reply.ok ? await api<Books>('/api/books') : null;
    if (fresh?.ok) setBooks(fresh.data);
    setClock(Date.now());
    setLooks(0);
    setBusy(null);
  }

  if (books.months.length === 0) return <p className="card text-muted">No bills yet. The first one starts this month’s book.</p>;
  return (
    <div className="grid gap-4">
      {problem ? <Notice tone="warn">{problem}</Notice> : null}
      {byYear(books.months).map(([year, rows]) => (
        <section key={year} className="card grid gap-3" aria-label={`Financial year ${year}`}>
          <h2 className="text-lg font-bold">Financial year {year}</h2>
          {rows.map((row) => {
            const status = bookStatus(row, books.drive, clock);
            return (
              <div key={row.month} className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line pt-3">
                <div className="min-w-56 flex-1">
                  <p className="text-lg font-semibold">{monthName(row.month)} <span className="font-normal text-muted">· {row.bills} bill{row.bills === 1 ? '' : 's'}</span></p>
                  <p className={status.tone === 'bad' ? 'font-semibold text-warn' : status.tone === 'good' ? 'text-accent' : 'text-muted'}>{status.text}</p>
                  <p className="text-sm text-muted">{row.written_at ? `Google Drive copy last updated ${formatTime(Date.parse(row.written_at))}` : 'Not on Google Drive yet'}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button type="button" className="btn btn-primary" disabled={busy === row.month} onClick={() => void open(row.month)}>Open monthly Excel</button>
                  {row.drive_link ? <a className="btn" href={row.drive_link} target="_blank" rel="noopener noreferrer">On Google Drive</a> : null}
                  {status.canRetry ? <button type="button" className="btn" disabled={busy === row.month} onClick={() => void retry(row.month)}>{status.tone === 'good' ? 'Make again' : 'Retry now'}</button> : null}
                </div>
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
}
