/** What the owner reads about a month's Excel book. Pure. */
import { formatTime } from './india';
import type { BookMonthRow } from './schemas/books';

export interface BookStatus {
  tone: 'good' | 'busy' | 'bad' | 'off';
  text: string;
  canRetry: boolean;
}

export function bookStatus(row: BookMonthRow, drive: boolean, now: number): BookStatus {
  if (!drive) return { tone: 'off', text: 'Google Drive is not connected. Open it here.', canRetry: false };
  if (row.waiting > 0 && row.last_error !== null) {
    const again = row.retry_at !== null && Date.parse(row.retry_at) > now ? `after ${formatTime(Date.parse(row.retry_at))}` : 'in a few minutes';
    return { tone: 'bad', text: `${row.last_error.replace(/\.$/, '')}. Tried again by itself ${again}.`, canRetry: !row.updating };
  }
  if (row.updating) return { tone: 'busy', text: 'Being updated…', canRetry: false };
  if (row.waiting > 0) return { tone: 'busy', text: 'Waiting to be updated', canRetry: true };
  return { tone: 'good', text: 'Up to date', canRetry: true };
}

/** '2027-03-01' -> '2026-27': April to March. */
function yearOf(month: string): string {
  const year = Number(month.slice(0, 4));
  const start = Number(month.slice(5, 7)) >= 4 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** Newest first, by financial year. */
export function byYear(rows: readonly BookMonthRow[]): [year: string, months: BookMonthRow[]][] {
  const years = new Map<string, BookMonthRow[]>();
  for (const row of [...rows].sort((a, b) => b.month.localeCompare(a.month))) {
    const year = yearOf(row.month);
    years.set(year, [...(years.get(year) ?? []), row]);
  }
  return [...years];
}
