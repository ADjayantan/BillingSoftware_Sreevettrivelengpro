import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { must, parseRow } from '@/lib/api/http';
import { CHARGE_LINE } from '@/lib/bill-draft';
import { sumPaise } from '@/lib/billing-math';
import { STUD_COLUMNS, findBills } from '@/lib/data';
import { decimalToPaise, paiseToDecimal, trimZeros } from '@/lib/money';
import type { CustomerGlance } from '@/lib/schemas/home';
import { studItemRow, type StudItem } from '@/lib/schemas/masters';

const CHARGES: readonly string[] = Object.values(CHARGE_LINE);

const openingRow = z.object({ opening_balance: z.string() });
const billRow = z.object({ id: z.uuid(), invoice_no: z.string(), invoice_date: z.string(), grand_total: z.string() });
const itemRow = z.object({
  stud_item_id: z.uuid().nullable(), description: z.string(), hsn_sac: z.string(), qty_pieces: z.number().nullable(),
  total_weight_kg: z.string().nullable(), billing_unit: z.enum(['pcs', 'kg']), unit_rate: z.string(),
});

/** What a new bill for a customer can begin with: what is still owed, and the goods of the last bill of the kind. */
export async function customerGlance(db: SupabaseClient, customerId: string, type: 'supply' | 'job_work', today: string): Promise<CustomerGlance> {
  const [owed, customer, bills] = await Promise.all([
    findBills(db, { customer: customerId, show: 'open' }, today, 1),
    db.from('customers').select('opening_balance::text').eq('id', customerId),
    db.from('invoices').select('id,invoice_no,invoice_date,grand_total::text').eq('customer_id', customerId).eq('bill_type', type).is('cancelled_at', null)
      .order('invoice_date', { ascending: false }).order('invoice_seq', { ascending: false }).limit(1),
  ]);
  const [party] = parseRow(z.array(openingRow), must(customer));
  const balance = paiseToDecimal(sumPaise([party ? decimalToPaise(party.opening_balance) : 0, decimalToPaise(owed.shown.balance)]));
  const [last] = parseRow(z.array(billRow), must(bills));
  if (last === undefined) return { bills: owed.shown.bills, balance, last: null };

  const items = parseRow(z.array(itemRow), must(
    await db.from('invoice_items').select('stud_item_id,description,hsn_sac,qty_pieces,total_weight_kg::text,billing_unit,unit_rate::text').eq('invoice_id', last.id).order('line_no'),
  )).filter((item) => !CHARGES.includes(item.description));
  const ids = [...new Set(items.flatMap((item) => item.stud_item_id ?? []))];
  // Only what is still in use: a product switched off must not come back through an old bill.
  const studs: StudItem[] = ids.length === 0 ? [] : parseRow(z.array(studItemRow), must(await db.from('stud_items').select(STUD_COLUMNS).in('id', ids).eq('is_active', true)));
  return {
    bills: owed.shown.bills,
    balance,
    last: {
      invoice_no: last.invoice_no,
      invoice_date: last.invoice_date,
      grand_total: last.grand_total,
      lines: items.map((item) => ({
        stud: studs.find((stud) => stud.id === item.stud_item_id) ?? null,
        description: item.description,
        hsn_sac: item.hsn_sac,
        billing_unit: item.billing_unit,
        quantity: item.billing_unit === 'pcs' ? String(item.qty_pieces ?? '') : trimZeros(item.total_weight_kg ?? ''),
        rate: trimZeros(item.unit_rate),
      })),
    },
  };
}
