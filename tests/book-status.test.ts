// What the owner reads about a month's Excel book. Pure.
import { describe, expect, it } from 'vitest';
import { bookStatus, byYear } from '@/lib/book-status';
import type { BookMonthRow } from '@/lib/schemas/books';

const NOW = Date.parse('2026-11-25T05:00:00Z'); // 10:30 am in India
const row = (over: Partial<BookMonthRow> = {}): BookMonthRow => ({
  month: '2026-11-01', bills: 12, waiting: 0, waiting_since: null, written_at: '2026-11-25T04:55:00+00:00', drive_link: 'https://drive.google.com/file/d/x/view', retry_at: null, last_error: null, updating: false, ...over,
});

describe('the status of a month', () => {
  it.each<[string, Partial<BookMonthRow>, boolean, { tone: string; text: string; canRetry: boolean }]>([
    ['everything is in it', {}, true, { tone: 'good', text: 'Up to date', canRetry: true }],
    ['a worker is on it', { waiting: 2, updating: true, waiting_since: '2026-11-25T04:59:00+00:00' }, true, { tone: 'busy', text: 'Being updated…', canRetry: false }],
    ['just changed', { waiting: 1, waiting_since: '2026-11-25T04:59:30+00:00' }, true, { tone: 'busy', text: 'Waiting to be updated', canRetry: true }],
    ['failed, and resting', { waiting: 1, last_error: 'Google Drive did not answer', retry_at: '2026-11-25T05:04:00+00:00' }, true, { tone: 'bad', text: 'Google Drive did not answer. Tried again by itself after 25 Nov, 10:34 am.', canRetry: true }],
    ['failed, and due', { waiting: 1, last_error: 'Google Drive did not answer', retry_at: '2026-11-25T04:59:00+00:00' }, true, { tone: 'bad', text: 'Google Drive did not answer. Tried again by itself in a few minutes.', canRetry: true }],
    ['its sentence has a full stop already', { waiting: 1, last_error: 'Permission has expired. Run it again.', retry_at: null }, true, { tone: 'bad', text: 'Permission has expired. Run it again. Tried again by itself in a few minutes.', canRetry: true }],
    ['unknown whether an upload arrived', { waiting: 1, updating: true, last_error: 'Google Drive did not say whether the workbook arrived', retry_at: '2026-11-25T05:03:00+00:00' }, true, { tone: 'bad', text: 'Google Drive did not say whether the workbook arrived. Tried again by itself after 25 Nov, 10:33 am.', canRetry: false }],
    ['no Drive', { waiting: 3, written_at: null, drive_link: null }, false, { tone: 'off', text: 'Google Drive is not connected. Open it here.', canRetry: false }],
  ])('%s', (_, over, drive, expected) => {
    expect(bookStatus(row(over), drive, NOW)).toEqual(expected);
  });
});

describe('the list', () => {
  it('is by Indian financial year, newest first', () => {
    const months = ['2027-04-01', '2027-03-01', '2026-11-01', '2026-04-01', '2026-03-01'].map((month) => row({ month }));
    expect(byYear(months).map(([year, rows]) => [year, rows.map((one) => one.month.slice(0, 7))])).toEqual([
      ['2027-28', ['2027-04']], ['2026-27', ['2027-03', '2026-11', '2026-04']], ['2025-26', ['2026-03']],
    ]);
  });
});
