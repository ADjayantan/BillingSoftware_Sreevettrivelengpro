import { FindBox } from '@/components/frame/find-box';
import { toApiError } from '@/lib/api/http';
import { bookStatus } from '@/lib/book-status';
import { bookMonths, findBills, goodsToSend, homeFigures, latestRates } from '@/lib/data';
import { isDriveConfigured } from '@/lib/drive-backup';
import { formatTime, istDate, monthName } from '@/lib/india';
import { greeting, longDate } from '@/lib/look';
import { rateText } from '@/lib/money';
import { createClient } from '@/lib/supabase/server';
import { DeviceLine } from './device-line';
import { CollectFirst, Doings, Figures, Safe, SafeLine, Sales, ToSend, bills } from './parts';

export const dynamic = 'force-dynamic';

/** The change of a rate, said by its sign: never a computed amount. */
function rateNote(delta: string | null): string {
  if (delta === null || !/[1-9]/.test(delta)) return 'Same as the rate before';
  return `${delta.startsWith('-') ? 'Down' : 'Up'} ₹${rateText(delta.replace('-', ''))} from the rate before`;
}

export default async function HomePage() {
  const now = new Date();
  const today = istDate(now);
  const db = await createClient();
  const [figures, open, goods, rates, months] = await Promise.all([
    homeFigures(db, today),
    findBills(db, { show: 'open' }, today, 5),
    goodsToSend(db),
    latestRates(db),
    bookMonths(db).catch((error: unknown) => {
      if (toApiError(error).status === 403) return null; // the books are the owner's
      throw error;
    }),
  ]);
  // A new book: nothing sold in six months and nothing owed.
  const fresh = figures.to_collect.bills === 0 && figures.months.every(({ total }) => !/[1-9]/.test(total));
  const drive = isDriveConfigured();
  const book = months?.[0];
  const status = book ? bookStatus(book, drive, now.getTime()) : null;
  const rate = [...rates].sort((a, b) => b.recorded_at.localeCompare(a.recorded_at))[0];
  return (
    <>
      <div className="grid items-center gap-x-8 gap-y-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.75fr)]">
        <div>
          <h1 className="page-title text-[36px] max-side:text-[29px]">{greeting(now)}</h1>
          <p className="mt-1 text-muted">{longDate(now)}</p>
        </div>
        <FindBox className="side:hidden" />
        <Doings toCollect={figures.to_collect.bills} toSend={figures.to_send} />
      </div>
      <Figures figures={figures} today={today} />
      <div className="grid gap-x-14 gap-y-9 xl:grid-cols-[minmax(0,1.85fr)_minmax(0,1fr)]">
        <CollectFirst rows={open.rows} today={today} fresh={fresh} />
        <ToSend goods={goods.filter((row) => row.status === 'pending' || row.status === 'packed').slice(0, 5)} waiting={figures.to_send} fresh={fresh} />
        <Sales months={figures.months} />
        <Safe>
          {book && status ? (
            <SafeLine icon="sheet" good={status.tone === 'good'} title={`Excel book, ${monthName(book.month)}`} note={status.tone === 'good' && book.written_at ? `Updated ${formatTime(Date.parse(book.written_at))}` : status.text} />
          ) : null}
          <SafeLine
            icon="drive" good={drive && figures.not_on_drive === 0} title="Google Drive"
            note={!drive ? 'Not connected' : figures.not_on_drive === 0 ? 'Every bill is kept there' : `${bills(figures.not_on_drive)} not there yet`}
          />
          <DeviceLine />
          {rate ? <SafeLine icon="trend" title={`${rate.material_grade} · ₹${rateText(rate.rate_per_kg)} a kg`} note={rateNote(rate.change_delta)} /> : null}
        </Safe>
      </div>
    </>
  );
}
