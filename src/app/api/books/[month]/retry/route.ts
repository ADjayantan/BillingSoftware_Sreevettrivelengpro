import { parse, route } from '@/lib/api/http';
import { driveState } from '@/lib/drive-backup';
import { booksLater } from '@/lib/month-books';
import { monthParam } from '@/lib/schemas/books';

/** Now, although it is resting; and again, although nothing has changed. The owner's. */
export const POST = route<{ month: string }>(async ({ supabase, params }) => {
  const month = parse(monthParam, params.month);
  const { error } = await supabase.rpc('book_retry', { p_month: month });
  if (error) throw error;
  if ((await driveState(supabase)) === 'off') return { state: 'off' };
  booksLater({ month, force: true });
  return { state: 'started' };
});
