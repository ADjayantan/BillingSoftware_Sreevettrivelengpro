import { z } from 'zod';
import { body, must, parseRow, route } from '@/lib/api/http';
import { SUPPLIER_COLUMNS, listSuppliers } from '@/lib/data';
import { supplierInput, supplierRow } from '@/lib/schemas/expenses';

export const GET = route(async ({ supabase }) => listSuppliers(supabase));

export const POST = route(async ({ request, supabase }) => {
  const input = await body(request, supplierInput);
  const rows = must(await supabase.from('suppliers').insert(input).select(SUPPLIER_COLUMNS));
  const [created] = parseRow(z.array(supplierRow).length(1), rows);
  return created;
});
