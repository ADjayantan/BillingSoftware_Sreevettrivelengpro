import { z } from 'zod';
import { must, parse, parseRow, route } from '@/lib/api/http';
import { isDriveConfigured } from '@/lib/drive-backup';
import { id } from '@/lib/schemas/common';

/** Is this bill, with its latest receipt, in the month's workbook on Drive? */
export const GET = route<{ id: string }>(async ({ supabase, params }) => {
  const state = parseRow(z.enum(['waiting', 'updated']), must(await supabase.rpc('bill_in_book', { p_invoice_id: parse(id, params.id) })));
  return { state: isDriveConfigured() ? state : 'off' };
});
