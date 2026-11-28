import { z } from 'zod';
import { body, must, parseRow, query, route } from '@/lib/api/http';
import { EXPENSE_COLUMNS, listExpenses } from '@/lib/data';
import { decimalToPaise, paiseToDecimal } from '@/lib/money';
import { expenseInput, expenseRow } from '@/lib/schemas/expenses';

const askSchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
    .optional(),
});

export const GET = route(async ({ request, supabase }) => {
  const ask = query(request, askSchema);
  return listExpenses(supabase, ask.month);
});

export const POST = route(async ({ request, supabase }) => {
  const input = await body(request, expenseInput);
  const taxablePaise = decimalToPaise(input.taxable_amount);
  const gstPaise = decimalToPaise(input.gst_amount);
  const totalPaise = taxablePaise + gstPaise;

  const rows = must(
    await supabase
      .from('expenses')
      .insert({
        expense_date: input.expense_date,
        category: input.category,
        supplier_id: input.supplier_id,
        supplier_name: input.supplier_name,
        bill_no: input.bill_no,
        description: input.description,
        material_grade: input.material_grade,
        weight_kg: input.weight_kg,
        taxable_amount: paiseToDecimal(taxablePaise),
        gst_amount: paiseToDecimal(gstPaise),
        total_amount: paiseToDecimal(totalPaise),
        payment_mode: input.payment_mode,
        payment_status: input.payment_status,
      })
      .select(EXPENSE_COLUMNS),
  );
  const [created] = parseRow(z.array(expenseRow).length(1), rows);
  return created;
});
