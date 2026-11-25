import { ApiError, parse, route } from '@/lib/api/http';
import { bookMonths } from '@/lib/data';
import { monthName } from '@/lib/india';
import { readMonth } from '@/lib/month-data';
import { monthWorkbook } from '@/lib/month-workbook';
import { monthParam } from '@/lib/schemas/books';

/** The book of this moment, made from the database: it opens even when Google Drive does not. */
export const GET = route<{ month: string }>(async ({ supabase, params }) => {
  const month = parse(monthParam, params.month);
  const months = await bookMonths(supabase); // refuses everybody but the owner
  if (!months.some((one) => one.month === month)) throw new ApiError(400, 'INVALID', `There are no bills or receipts in ${monthName(month)}`);
  const bytes = monthWorkbook(await readMonth(supabase, month), new Date().toISOString());
  return new Response(Buffer.from(bytes), {
    headers: {
      'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': `attachment; filename="Billing_${month.slice(0, 7)}.xlsx"`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
});
