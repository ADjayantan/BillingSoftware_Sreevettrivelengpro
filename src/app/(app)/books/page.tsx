import { PageHead } from '@/components/page-head';
import { toApiError } from '@/lib/api/http';
import { bookMonths } from '@/lib/data';
import { driveState } from '@/lib/drive-backup';
import { createClient } from '@/lib/supabase/server';
import { BooksView } from './view';

export const dynamic = 'force-dynamic';

export default async function BooksPage() {
  const db = await createClient();
  const [months, drive] = await Promise.all([
    bookMonths(db).catch((error: unknown) => {
      if (toApiError(error).status === 403) return null;
      throw error;
    }),
    driveState(db),
  ]);
  return (
    <>
      <PageHead title="Excel books" note="One book for each month, by the date on the bill. Bills and receipts go in by themselves." />
      {months === null ? (
        <p className="card">Only the owner can open the Excel books. Every bill is in them by itself.</p>
      ) : (
        <BooksView months={months} drive={drive !== 'off'} now={new Date().toISOString()} />
      )}
    </>
  );
}
