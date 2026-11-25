import { must, route } from '@/lib/api/http';
import { isDriveConfigured } from '@/lib/drive-backup';
import { booksLater } from '@/lib/month-books';

/** Asked by any open device every few minutes: what could not be written before is tried again. */
export const POST = route(async ({ supabase }) => {
  const due: unknown = must(await supabase.rpc('book_due'));
  if (!isDriveConfigured()) return { state: 'off' };
  if (due !== true) return { state: 'nothing' };
  booksLater();
  return { state: 'started' };
});
