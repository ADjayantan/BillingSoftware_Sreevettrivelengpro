import { z } from 'zod';
import { body, must, parse, parseRow, query, route } from '@/lib/api/http';
import { counterCustomer } from '@/lib/counter-customer';
import { CUSTOMER_COLUMNS, listCustomers } from '@/lib/data';
import { id, listQuery } from '@/lib/schemas/common';
import { customerInput, customerRow } from '@/lib/schemas/masters';

/** Sent by the bill, not by the Customers page: the device's own id, and who it is known not to be. */
const atTheCounter = z.object({ id: id.optional(), different_from: z.array(id).max(200).default([]) });

export const GET = route(async ({ request, supabase }) => {
  const { q, page } = query(request, listQuery);
  return listCustomers(supabase, q, page);
});

export const POST = route(async ({ request, supabase }) => {
  const sent = await body(request, z.record(z.string(), z.unknown()));
  const input = parse(customerInput, sent);
  const counter = parse(atTheCounter, sent);
  if (counter.id !== undefined) return counterCustomer(supabase, counter.id, input, counter.different_from);
  return parseRow(customerRow, must(await supabase.from('customers').insert(input).select(CUSTOMER_COLUMNS).single()));
});
