-- =============================================================================
-- StudFlow AI · 007_own_bill.sql
-- -----------------------------------------------------------------------------
-- specs/own-bill.md: what the owner's own bill says and the database did not know.
--   1 the lines at the head of the bill (Company page, copied onto every bill at issue)
--   2 the buyer's order (P.O. number and date) on an invoice
-- Issued bills, RLS, grants and the edit log stay as they are, and the app version before
-- this one keeps working with it.
-- =============================================================================


-- =============================================================================
-- 1. Head of the bill
-- =============================================================================
-- sync_invoice copies every column of the company onto the bill, so these travel by themselves.
alter table public.company_profile
  add column tagline         text check (char_length(btrim(tagline)) between 1 and 160),
  add column factory_address text check (char_length(btrim(factory_address)) between 1 and 500),
  -- As it stands on the bill: '0422 - 1234567', two numbers with a stroke between them.
  add column office_phone    text check (office_phone ~ '^[0-9+()/, -]{6,40}$' and office_phone ~ '[0-9]{4}');
comment on column public.company_profile.tagline is 'The line under the name, e.g. "Mfrs : MS and SS studs".';


-- =============================================================================
-- 2. The buyer's order
-- =============================================================================
-- Frozen like the rest of an issued bill: invoices_guard_issued lists what may change.
alter table public.invoices
  add column po_no   text check (char_length(btrim(po_no)) between 1 and 40),
  add column po_date date check (po_date between date '2000-01-01' and date '2100-12-31'),
  add constraint invoices_po_date_needs_no check (po_no is not null or po_date is null);

-- The function of 002 with po_no and po_date: nothing else differs. The fingerprint is taken of
-- the payload as it comes, so a bill without an order must be sent without these keys.
create or replace function public.sync_invoice(p_payload jsonb)
returns table (invoice_id uuid, invoice_no text, dc_no text, replayed boolean)
language plpgsql
volatile
security definer
set search_path = ''
set default_transaction_isolation = 'read committed'
as $$
#variable_conflict use_column
declare
  v_client_temp_id text;
  v_fingerprint    text;
  v_existing       public.invoices%rowtype;
  v_customer       public.customers%rowtype;
  v_supplier       jsonb;
  v_bill_type      public.bill_type;
  v_items          jsonb;
  v_lines          record;
  v_delivery       jsonb;
  v_returns        jsonb;
  v_return         record;
  v_lot            public.job_work_ledger%rowtype;
  v_balance        numeric;
  v_return_no      integer := 0;
  v_today          date;
  v_invoice_date   date;
  v_po_date        date;
  v_fiscal_year    text;
  v_invoice_seq    integer;
  v_dc_seq         integer;
  v_invoice_id     uuid;
  v_invoice_no     text;
  v_delivery_id    uuid;
  v_dc_no          text;
  v_field          text;
  v_subtotal       numeric;
  v_charges        numeric;
  v_cgst           numeric;
  v_sgst           numeric;
  v_igst           numeric;
  v_charges_cgst   numeric;
  v_charges_sgst   numeric;
  v_charges_igst   numeric;
  v_charges_tax    numeric;
  v_tax            numeric;
  v_tolerance      numeric;
  v_amount_paid    numeric;
begin
  -- 0. Authorization and isolation (see 001).
  if not private.is_staff() then
    raise exception 'sync_invoice: caller is not an active StudFlow user' using errcode = '42501';
  end if;
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'sync_invoice must run under read committed, not %', current_setting('transaction_isolation')
      using errcode = '25001';
  end if;

  -- 1. Shape.
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'sync_invoice: payload must be a JSON object' using errcode = '22023';
  end if;
  v_client_temp_id := p_payload ->> 'client_temp_id';
  if v_client_temp_id is null
     or v_client_temp_id !~ '^OFFLINE-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'sync_invoice: client_temp_id must be OFFLINE-<lowercase uuid>' using errcode = '22023';
  end if;
  v_fingerprint := encode(sha256(convert_to(p_payload::text, 'UTF8')), 'hex');

  -- 2. Serialize concurrent syncs of the SAME bill.
  perform pg_advisory_xact_lock(hashtextextended('studflow.sync_invoice:' || v_client_temp_id, 0));

  -- 3. Idempotent replay, checked under the lock.
  select i.* into v_existing from public.invoices as i where i.client_temp_id = v_client_temp_id;
  if found then
    if v_existing.sync_fingerprint <> v_fingerprint then
      raise exception 'sync_invoice: this bill was already issued as % with different content', v_existing.invoice_no
        using errcode = '23505',
              hint = 'The issued invoice stands. Show it to the user; cancel it and bill again if the edit is needed.';
    end if;
    return query
      select v_existing.id,
             v_existing.invoice_no,
             (select d.dc_no from public.deliveries as d
               where d.invoice_id = v_existing.id
               order by d.created_at, d.dc_date, d.dc_seq limit 1),
             true;
    return;
  end if;

  -- 4. Dates.
  if coalesce(p_payload ->> 'invoice_date', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
     or coalesce(p_payload ->> 'due_date', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    raise exception 'sync_invoice: invoice_date and due_date must be YYYY-MM-DD' using errcode = '22023';
  end if;
  v_invoice_date := (p_payload ->> 'invoice_date')::date;
  v_today := private.today_ist();
  if v_invoice_date > v_today then
    raise exception 'sync_invoice: invoice_date % is after today (% IST)', v_invoice_date, v_today
      using errcode = '22023';
  end if;
  if v_invoice_date < v_today - 31 then
    raise exception 'sync_invoice: invoice_date % is more than 31 days old; check the device clock or re-date the bill',
      v_invoice_date using errcode = '22023';
  end if;

  if coalesce(p_payload ->> 'po_date', '2000-01-01') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    raise exception 'sync_invoice: po_date must be YYYY-MM-DD' using errcode = '22023';
  end if;
  v_po_date := (p_payload ->> 'po_date')::date;

  -- 5. Precision: the DB must never round what billing-math.ts sent.
  foreach v_field in array array['subtotal', 'packing_charge', 'delivery_charge', 'cgst', 'sgst', 'igst', 'round_off',
                                 'grand_total', 'amount_paid', 'charges_cgst', 'charges_sgst', 'charges_igst'] loop
    if (p_payload ->> v_field)::numeric <> round((p_payload ->> v_field)::numeric, 2) then
      raise exception 'sync_invoice: % has more than 2 decimal places', v_field using errcode = '22023';
    end if;
  end loop;

  v_items := p_payload -> 'items';
  if v_items is null or jsonb_typeof(v_items) <> 'array' then
    raise exception 'sync_invoice: items must be a JSON array' using errcode = '22023';
  end if;
  if jsonb_array_length(v_items) not between 1 and 500 then
    raise exception 'sync_invoice: a bill needs 1 to 500 line items' using errcode = '22023';
  end if;
  if exists (
    select 1
    from jsonb_to_recordset(v_items)
           as x(total_weight_kg numeric, unit_rate numeric, tax_rate_percent numeric, line_total numeric,
                cgst_amount numeric, sgst_amount numeric, igst_amount numeric)
    where x.line_total       <> round(x.line_total, 2)
       or x.unit_rate        <> round(x.unit_rate, 6)
       or x.total_weight_kg  <> round(x.total_weight_kg, 6)
       or x.tax_rate_percent <> round(x.tax_rate_percent, 2)
       or x.cgst_amount      <> round(x.cgst_amount, 2)
       or x.sgst_amount      <> round(x.sgst_amount, 2)
       or x.igst_amount      <> round(x.igst_amount, 2)
  ) then
    raise exception 'sync_invoice: a line item has more decimal places than its column allows'
      using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_to_recordset(v_items) as x(cgst_amount numeric, sgst_amount numeric, igst_amount numeric)
              where x.cgst_amount is null or x.sgst_amount is null or x.igst_amount is null) then
    raise exception 'sync_invoice: every line needs its GST amounts' using errcode = '22023';
  end if;

  v_delivery := p_payload -> 'delivery';
  if v_delivery is null or jsonb_typeof(v_delivery) = 'null' then
    v_delivery := '{}'::jsonb;
  elsif jsonb_typeof(v_delivery) <> 'object' then
    raise exception 'sync_invoice: delivery must be a JSON object' using errcode = '22023';
  end if;
  if (v_delivery ->> 'freight_amount')::numeric <> round((v_delivery ->> 'freight_amount')::numeric, 2) then
    raise exception 'sync_invoice: freight_amount has more than 2 decimal places' using errcode = '22023';
  end if;

  v_bill_type := (p_payload ->> 'bill_type')::public.bill_type;
  v_returns := p_payload -> 'job_work_returns';
  if v_returns is null or jsonb_typeof(v_returns) = 'null' then
    v_returns := '[]'::jsonb;
  elsif jsonb_typeof(v_returns) <> 'array' or jsonb_array_length(v_returns) > 50 then
    raise exception 'sync_invoice: job_work_returns must be an array of at most 50 lots' using errcode = '22023';
  end if;
  if jsonb_array_length(v_returns) > 0 and v_bill_type is distinct from 'job_work' then
    raise exception 'sync_invoice: only a job-work bill can return customer material' using errcode = '23514';
  end if;
  if exists (
    select 1 from jsonb_to_recordset(v_returns)
             as x(returned_weight_kg numeric, scrap_weight_kg numeric, declared_value numeric)
     where x.returned_weight_kg <> round(x.returned_weight_kg, 3)
        or x.scrap_weight_kg    <> round(x.scrap_weight_kg, 3)
        or x.declared_value     <> round(x.declared_value, 2)
  ) then
    raise exception 'sync_invoice: a returned lot has more decimal places than its column allows' using errcode = '22023';
  end if;

  -- 6. Customer and supplier, snapshotted from the DB (never trusted from the device).
  select c.* into v_customer from public.customers as c where c.id = (p_payload ->> 'customer_id')::uuid;
  if not found then
    raise exception 'sync_invoice: customer % not found', p_payload ->> 'customer_id' using errcode = '23503';
  end if;
  select to_jsonb(p) - array['id', 'singleton', 'created_at', 'updated_at'] into v_supplier
    from public.company_profile as p;
  if v_supplier is null then
    raise exception 'sync_invoice: fill in the company profile before billing (GST Rule 46)' using errcode = '55000';
  end if;

  -- 7. Cross-row identities a CHECK cannot express.
  select count(*) as n, sum(x.line_total) as total, sum(x.line_total * x.tax_rate_percent / 100) as tax,
         min(x.tax_rate_percent) as min_rate, max(x.tax_rate_percent) as max_rate,
         sum(x.cgst_amount) as cgst, sum(x.sgst_amount) as sgst, sum(x.igst_amount) as igst
    into v_lines
    from jsonb_to_recordset(v_items) as x(line_total numeric, tax_rate_percent numeric,
                                          cgst_amount numeric, sgst_amount numeric, igst_amount numeric);

  v_subtotal := (p_payload ->> 'subtotal')::numeric;
  if v_lines.total is distinct from v_subtotal then
    raise exception 'sync_invoice: subtotal % does not equal the sum of line totals %', v_subtotal, v_lines.total
      using errcode = '23514';
  end if;

  -- Packing is always part of the taxable value; delivery only when flagged.
  v_charges := coalesce((p_payload ->> 'packing_charge')::numeric, 0)
             + case when coalesce((p_payload ->> 'delivery_taxable')::boolean, true)
                    then coalesce((p_payload ->> 'delivery_charge')::numeric, 0) else 0 end;
  v_cgst := coalesce((p_payload ->> 'cgst')::numeric, 0);
  v_sgst := coalesce((p_payload ->> 'sgst')::numeric, 0);
  v_igst := coalesce((p_payload ->> 'igst')::numeric, 0);
  v_tax  := v_cgst + v_sgst + v_igst;
  v_tolerance := 0.01 * (v_lines.n + 1);
  if v_tax < v_lines.tax + v_charges * v_lines.min_rate / 100 - v_tolerance
     or v_tax > v_lines.tax + v_charges * v_lines.max_rate / 100 + v_tolerance then
    raise exception 'sync_invoice: GST of % does not match the line rates', v_tax using errcode = '23514';
  end if;

  -- The stored breakdown must be the header, split: exactly in total, within the paisa that
  -- per-bucket rounding can move per line.
  v_charges_cgst := coalesce((p_payload ->> 'charges_cgst')::numeric, 0);
  v_charges_sgst := coalesce((p_payload ->> 'charges_sgst')::numeric, 0);
  v_charges_igst := coalesce((p_payload ->> 'charges_igst')::numeric, 0);
  v_charges_tax  := v_charges_cgst + v_charges_sgst + v_charges_igst;
  if (v_lines.cgst + v_charges_cgst, v_lines.sgst + v_charges_sgst, v_lines.igst + v_charges_igst)
     is distinct from (v_cgst, v_sgst, v_igst) then
    raise exception 'sync_invoice: GST per line and on charges does not add up to the invoice GST' using errcode = '23514';
  end if;
  if exists (
    select 1
    from jsonb_to_recordset(v_items) as x(line_total numeric, tax_rate_percent numeric,
                                            cgst_amount numeric, sgst_amount numeric, igst_amount numeric)
    where abs(x.cgst_amount + x.sgst_amount + x.igst_amount - x.line_total * x.tax_rate_percent / 100) > 0.03
  ) or v_charges_tax < v_charges * v_lines.min_rate / 100 - 0.03
    or v_charges_tax > v_charges * v_lines.max_rate / 100 + 0.03 then
    raise exception 'sync_invoice: the GST on a line or charge does not match its rate' using errcode = '23514';
  end if;

  -- GST Rule 46(e): from Rs 50,000 an unregistered buyer's address is mandatory too.
  if v_customer.address is null and v_subtotal + v_charges >= 50000 then
    raise exception 'sync_invoice: add an address for % before billing Rs 50,000 or more', v_customer.name
      using errcode = '22023';
  end if;

  -- 8. Allocate the gapless invoice number and write the invoice.
  v_fiscal_year := private.fiscal_year_of(v_invoice_date);
  v_invoice_seq := private.next_document_seq('INV', v_fiscal_year);
  v_amount_paid := coalesce((p_payload ->> 'amount_paid')::numeric, 0);

  insert into public.invoices as inv (
    invoice_no, fiscal_year, invoice_seq, client_temp_id, sync_fingerprint, bill_type, customer_id,
    invoice_date, place_of_supply, is_sez, customer_snapshot, supplier_snapshot,
    subtotal, packing_charge, delivery_charge, delivery_taxable,
    cgst, sgst, igst, charges_cgst, charges_sgst, charges_igst, round_off, grand_total,
    amount_paid, payment_status, due_date, notes, po_no, po_date
  ) values (
    private.format_document_no('INV', v_fiscal_year, v_invoice_seq), v_fiscal_year, v_invoice_seq,
    v_client_temp_id, v_fingerprint, v_bill_type, v_customer.id,
    v_invoice_date, v_customer.state_code, v_customer.is_sez,
    jsonb_build_object('name', v_customer.name, 'gstin', v_customer.gstin, 'address', v_customer.address,
                       'state_code', v_customer.state_code, 'phone', v_customer.phone, 'is_sez', v_customer.is_sez),
    v_supplier,
    v_subtotal,
    coalesce((p_payload ->> 'packing_charge')::numeric, 0),
    coalesce((p_payload ->> 'delivery_charge')::numeric, 0),
    coalesce((p_payload ->> 'delivery_taxable')::boolean, true),
    v_cgst, v_sgst, v_igst, v_charges_cgst, v_charges_sgst, v_charges_igst,
    coalesce((p_payload ->> 'round_off')::numeric, 0),
    (p_payload ->> 'grand_total')::numeric,
    v_amount_paid,
    coalesce((p_payload ->> 'payment_status')::public.payment_status, 'unpaid'),
    (p_payload ->> 'due_date')::date,
    nullif(btrim(p_payload ->> 'notes'), ''),
    nullif(btrim(p_payload ->> 'po_no'), ''),
    v_po_date
  )
  returning inv.id, inv.invoice_no into v_invoice_id, v_invoice_no;

  insert into public.invoice_items (
    invoice_id, line_no, stud_item_id, description, hsn_sac, qty_pieces, total_weight_kg,
    billing_unit, unit_rate, tax_rate_percent, line_total, cgst_amount, sgst_amount, igst_amount
  )
  select v_invoice_id, x.line_no, x.stud_item_id, x.description, x.hsn_sac, x.qty_pieces, x.total_weight_kg,
         x.billing_unit, x.unit_rate, x.tax_rate_percent, x.line_total, x.cgst_amount, x.sgst_amount, x.igst_amount
  from jsonb_to_recordset(v_items) as x(
         line_no smallint, stud_item_id uuid, description text, hsn_sac text, qty_pieces integer,
         total_weight_kg numeric, billing_unit public.billing_unit, unit_rate numeric,
         tax_rate_percent numeric, line_total numeric, cgst_amount numeric, sgst_amount numeric, igst_amount numeric);

  -- Money taken with the bill is a receipt like any other: amount_paid = sum of receipts.
  if v_amount_paid > 0 then
    insert into public.payments (invoice_id, client_receipt_id, amount, received_on, mode, settles_invoice)
    values (v_invoice_id, substr(v_client_temp_id, 9)::uuid, v_amount_paid, v_invoice_date,
            coalesce((p_payload ->> 'payment_mode')::public.payment_mode, 'cash'),
            coalesce(p_payload ->> 'payment_status', 'unpaid') = 'paid');
  end if;

  -- 9. Delivery challan (every bill links to a DC), dated with the invoice.
  v_dc_seq := private.next_document_seq('DC', v_fiscal_year);

  insert into public.deliveries as d (
    invoice_id, dc_no, fiscal_year, dc_seq, dc_date,
    transport_mode, vehicle_no, driver_name, driver_phone, lr_number,
    freight_paid_by, freight_amount, delivery_address, status
  ) values (
    v_invoice_id, private.format_document_no('DC', v_fiscal_year, v_dc_seq), v_fiscal_year, v_dc_seq, v_invoice_date,
    coalesce((v_delivery ->> 'transport_mode')::public.transport_mode, 'own_vehicle'),
    v_delivery ->> 'vehicle_no',
    nullif(btrim(v_delivery ->> 'driver_name'), ''),
    v_delivery ->> 'driver_phone',
    nullif(btrim(v_delivery ->> 'lr_number'), ''),
    coalesce((v_delivery ->> 'freight_paid_by')::public.freight_payer, 'seller'),
    coalesce((v_delivery ->> 'freight_amount')::numeric, 0),
    coalesce(nullif(btrim(v_delivery ->> 'delivery_address'), ''), v_customer.address),
    coalesce((v_delivery ->> 'status')::public.delivery_status, 'pending')
  )
  returning d.id, d.dc_no into v_delivery_id, v_dc_no;

  -- 10. Job work: move the returned weight out of its lots, under their row locks.
  for v_return in
    select x.* from jsonb_to_recordset(v_returns) as x(
      lot_id uuid, goods_description text, goods_hsn text, pieces integer, returned_weight_kg numeric,
      scrap_weight_kg numeric, declared_value numeric, close boolean, close_reason text)
    order by x.lot_id
  loop
    v_return_no := v_return_no + 1;
    select l.* into v_lot from public.job_work_ledger as l where l.id = v_return.lot_id for update;
    if not found or v_lot.customer_id <> v_customer.id then
      raise exception 'sync_invoice: a returned lot does not belong to %', v_customer.name using errcode = '23503';
    end if;
    if v_lot.status = 'closed' then
      raise exception 'sync_invoice: lot % is closed', v_lot.party_dc_no using errcode = '23514';
    end if;

    update public.job_work_ledger as l
       set outward_weight_kg = l.outward_weight_kg + coalesce(v_return.returned_weight_kg, 0),
           scrap_weight_kg   = l.scrap_weight_kg + coalesce(v_return.scrap_weight_kg, 0),
           status            = case when coalesce(v_return.close, false) then 'closed' else l.status end,
           close_reason      = nullif(btrim(v_return.close_reason), '')
     where l.id = v_lot.id
    returning l.balance_weight_kg into v_balance;
    if v_balance < -0.01 * v_lot.inward_weight_kg then
      raise exception 'sync_invoice: lot % would return more than was received (balance % kg)', v_lot.party_dc_no, v_balance
        using errcode = '23514';
    end if;

    insert into public.job_work_returns (
      ledger_id, invoice_id, delivery_id, line_no, party_dc_no, party_dc_date, material_grade,
      goods_description, goods_hsn, pieces, returned_weight_kg, scrap_weight_kg, inward_weight_kg,
      balance_after_kg, declared_value
    ) values (
      v_lot.id, v_invoice_id, v_delivery_id, v_return_no, v_lot.party_dc_no, v_lot.party_dc_date, v_lot.material_grade,
      coalesce(nullif(btrim(v_return.goods_description), ''), v_lot.description, v_lot.material_grade || ' studs'),
      coalesce(v_return.goods_hsn, '7318'), v_return.pieces, coalesce(v_return.returned_weight_kg, 0),
      coalesce(v_return.scrap_weight_kg, 0), v_lot.inward_weight_kg, v_balance, v_return.declared_value
    );
  end loop;

  return query select v_invoice_id, v_invoice_no, v_dc_no, false;
end;
$$;

notify pgrst, 'reload schema';
