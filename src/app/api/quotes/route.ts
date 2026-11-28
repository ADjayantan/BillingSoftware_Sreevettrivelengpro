import { z } from 'zod';
import { ApiError, body, must, parseRow, route } from '@/lib/api/http';
import { composeBill } from '@/lib/bill-draft';
import { CUSTOMER_COLUMNS, QUOTE_COLUMNS, listQuotes } from '@/lib/data';
import { formatInr, paiseToDecimal } from '@/lib/money';
import { customerRow } from '@/lib/schemas/masters';
import { quoteInput, quoteRow } from '@/lib/schemas/quotes';

export const GET = route(async ({ supabase }) => listQuotes(supabase));

export const POST = route(async ({ request, supabase }) => {
  const input = await body(request, quoteInput);
  const custRows = must(await supabase.from('customers').select(CUSTOMER_COLUMNS).eq('id', input.customer_id).limit(1));
  const [customer] = parseRow(z.array(customerRow), custRows);
  if (!customer) throw new ApiError(404, 'NOT_FOUND', 'Customer not found');

  const bill = composeBill(
    {
      bill_type: input.bill_type,
      lines: input.lines,
      packing: input.packing,
      freight: input.freight,
      freight_paid_by: input.freight_paid_by,
      delivery_taxable: input.delivery_taxable,
      charges_gst_rate: input.charges_gst_rate,
    },
    { state_code: customer.state_code, is_sez: customer.is_sez },
  );
  const total = bill.detail.amounts.grand_total_paise;
  if (total !== input.expected_total_paise) {
    throw new ApiError(409, 'TOTAL_CHANGED', `The total is now ${formatInr(total)}. Check the quote and save again.`);
  }

  const amounts = bill.detail.amounts;
  const billed = bill.input.freight_paid_by === 'seller';
  const inserted = must(
    await supabase
      .from('quotes')
      .insert({
        bill_type: input.bill_type,
        customer_id: customer.id,
        quote_date: input.quote_date,
        valid_until: input.valid_until,
        place_of_supply: customer.state_code,
        is_sez: customer.is_sez,
        customer_snapshot: {
          name: customer.name,
          gstin: customer.gstin,
          address: customer.address,
          state_code: customer.state_code,
          phone: customer.phone,
          is_sez: customer.is_sez,
        },
        lines: input.lines,
        packing_charge: paiseToDecimal(billed ? bill.input.packing_charge_paise : 0),
        delivery_charge: paiseToDecimal(billed ? bill.input.delivery_charge_paise : 0),
        freight_paid_by: input.freight_paid_by,
        delivery_taxable: input.delivery_taxable,
        charges_gst_rate: input.charges_gst_rate,
        subtotal: paiseToDecimal(amounts.subtotal_paise),
        cgst: paiseToDecimal(amounts.cgst_paise),
        sgst: paiseToDecimal(amounts.sgst_paise),
        igst: paiseToDecimal(amounts.igst_paise),
        round_off: paiseToDecimal(amounts.round_off_paise),
        grand_total: paiseToDecimal(amounts.grand_total_paise),
        notes: input.notes ?? null,
        status: 'open',
      })
      .select(QUOTE_COLUMNS),
  );
  const [created] = parseRow(z.array(quoteRow).length(1), inserted);
  return created;
});
