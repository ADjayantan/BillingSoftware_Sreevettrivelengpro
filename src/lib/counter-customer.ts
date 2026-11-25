import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { ApiError, must, parseRow } from '@/lib/api/http';
import { lookAlikes, sameName } from '@/lib/customer-match';
import { CUSTOMER_COLUMNS } from '@/lib/data';
import { PAGE_ROWS, readAllRows } from '@/lib/read-all';
import { customerRow, type Customer, type customerInput } from '@/lib/schemas/masters';

const oneBy = async (db: SupabaseClient, column: 'id' | 'gstin', value: string): Promise<Customer | null> =>
  parseRow(z.array(customerRow), must(await db.from('customers').select(CUSTOMER_COLUMNS).eq(column, value).limit(1)))[0] ?? null;

/** One GSTIN is one business: never made twice, and never joined without the owner seeing it. */
const exists = (existing: Customer, name: string): ApiError =>
  new ApiError(409, 'CUSTOMER_EXISTS', `This GSTIN is already ${existing.name}`, { existing, same_name: sameName(existing.name, name) });

/**
 * A customer made inside a bill, online or after an outage. The id comes from the device, so
 * sending it twice (double click, lost reply) gives the same customer, untouched.
 */
export async function counterCustomer(db: SupabaseClient, id: string, input: z.output<typeof customerInput>, differentFrom: readonly string[]): Promise<Customer> {
  const known = await oneBy(db, 'id', id);
  if (known) return known;
  const holder = input.gstin === null ? null : await oneBy(db, 'gstin', input.gstin);
  if (holder) throw exists(holder, input.name);

  const everyone = parseRow(
    z.array(customerRow),
    await readAllRows<{ id: string }>((after) => {
      const page = db.from('customers').select(CUSTOMER_COLUMNS).eq('is_active', true).order('id').limit(PAGE_ROWS);
      return (after === null ? page : page.gt('id', after)).overrideTypes<{ id: string }[], { merge: false }>();
    }),
  );
  const candidates = lookAlikes(input, everyone, differentFrom);
  if (candidates.length > 0) throw new ApiError(409, 'CUSTOMER_SIMILAR', 'Is it one of these customers?', { candidates: candidates.slice(0, 10) });

  const { data, error } = await db.from('customers').insert({ id, ...input }).select(CUSTOMER_COLUMNS).single();
  if (!error) return parseRow(customerRow, data);
  if (error.code === '23505') {
    // Somebody was quicker: this very request a moment ago, or another device with the GSTIN.
    const again = await oneBy(db, 'id', id);
    if (again) return again;
    const other = input.gstin === null ? null : await oneBy(db, 'gstin', input.gstin);
    if (other) throw exists(other, input.name);
  }
  throw error;
}
