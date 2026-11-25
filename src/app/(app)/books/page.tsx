import { toApiError } from '@/lib/api/http';
import { bookMonths } from '@/lib/data';
import { isDriveConfigured } from '@/lib/drive-backup';
import { createClient } from '@/lib/supabase/server';
import { BooksView } from './view';

export const dynamic = 'force-dynamic';

export default async function BooksPage() {
  const months = await createClient()
    .then(bookMonths)
    .catch((error: unknown) => {
      if (toApiError(error).status === 403) return null;
      throw error;
    });
  return (
    <>
      <h1 className="mb-1 text-2xl font-bold">Excel books</h1>
      {months === null ? (
        <p className="card">Only the owner can open the Excel books. Every bill is in them by itself.</p>
      ) : (
        <>
          <p className="mb-3 text-muted">One book per month, by the date on the bill. Bills and receipts go in by themselves; there is nothing to save or export.</p>
          <BooksView months={months} drive={isDriveConfigured()} now={new Date().toISOString()} />
        </>
      )}
    </>
  );
}
