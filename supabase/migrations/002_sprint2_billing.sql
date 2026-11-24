-- =============================================================================
-- StudFlow AI · 002_sprint2_billing.sql
-- -----------------------------------------------------------------------------
-- The six owner-approved Sprint 2 decisions (CLAUDE.md):
--   a SEZ customers get IGST          b packing is always taxable
--   c company profile frozen on bills d GST stored per line
--   e job-work returns tied to lots   f receipts through one atomic RPC
-- Apply before the first bill: the new NOT NULL invoice columns have no honest backfill.
-- =============================================================================


-- =============================================================================
-- 1. Small extensions of 001
-- =============================================================================
-- Real thread descriptions run past 40 characters ("ISO metric RH, 1.25 mm pitch, ...").
alter table public.stud_items drop constraint stud_items_thread_type_check;
alter table public.stud_items add constraint stud_items_thread_type_check
  check (char_length(btrim(thread_type)) between 1 and 80);

create type public.payment_mode as enum ('cash', 'upi', 'bank_transfer', 'cheque', 'tds', 'other');


-- =============================================================================
-- 2. (a) SEZ customers  (c) company profile  (d) per-line GST
-- =============================================================================
alter table public.customers add column is_sez boolean not null default false;
comment on column public.customers.is_sez is
  'SEZ unit/developer: inter-State supply (IGST Act s.7(5)(b)) even inside Tamil Nadu.';

create table public.company_profile (
  id              uuid primary key default gen_random_uuid(),
  singleton       boolean not null default true unique check (singleton),
  legal_name      text not null check (char_length(btrim(legal_name)) between 1 and 120),
  gstin           text not null check (private.is_valid_gstin(gstin) and left(gstin, 2) = '33'),
  address         text not null check (char_length(btrim(address)) between 1 and 500),
  state_code      text not null default '33' check (state_code = '33'),
  phone           text check (phone ~ '^\+?[0-9]{10,15}$'),
  email           text check (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and char_length(email) <= 120),
  bank_name       text check (char_length(btrim(bank_name)) between 1 and 80),
  bank_branch     text check (char_length(btrim(bank_branch)) between 1 and 80),
  bank_account_no text check (bank_account_no ~ '^[0-9]{6,20}$'),
  bank_ifsc       text check (bank_ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
comment on table public.company_profile is
  'The supplier (one row). Copied onto every invoice at issue: GST Rule 46(a).';

alter table public.invoices
  add column is_sez            boolean not null default false,
  add column supplier_snapshot jsonb not null check (jsonb_typeof(supplier_snapshot) = 'object'),
  -- GST on header packing/delivery, so that lines + charges add up to the header exactly.
  add column charges_cgst      numeric(14,2) not null default 0 check (charges_cgst >= 0 and charges_cgst < 'Infinity'),
  add column charges_sgst      numeric(14,2) not null default 0 check (charges_sgst >= 0 and charges_sgst < 'Infinity'),
  add column charges_igst      numeric(14,2) not null default 0 check (charges_igst >= 0 and charges_igst < 'Infinity'),
  add constraint invoices_charges_gst_halves check (charges_cgst = charges_sgst);
comment on column public.invoices.delivery_taxable is
  'true -> delivery_charge is part of the taxable value. Packing always is (CGST s.15(2)(c)).';

alter table public.invoices drop constraint invoices_gst_regime;
alter table public.invoices add constraint invoices_gst_regime
  check (case when place_of_supply = '33' and not is_sez then igst = 0
              else cgst = 0 and sgst = 0 end);

alter table public.invoice_items
  add column cgst_amount numeric(14,2) not null check (cgst_amount >= 0 and cgst_amount < 'Infinity'),
  add column sgst_amount numeric(14,2) not null check (sgst_amount >= 0 and sgst_amount < 'Infinity'),
  add column igst_amount numeric(14,2) not null check (igst_amount >= 0 and igst_amount < 'Infinity'),
  add constraint invoice_items_gst_halves check (cgst_amount = sgst_amount);


-- =============================================================================
-- 3. (e) Job-work returns
-- =============================================================================
alter table public.job_work_ledger
  add column close_reason text check (char_length(btrim(close_reason)) between 3 and 300),
  add column closed_at    timestamptz,
  add constraint job_work_ledger_close_rule check (
    status = 'open'
    or abs(inward_weight_kg - outward_weight_kg - scrap_weight_kg) <= inward_weight_kg * 0.01
    or close_reason is not null);

-- One row per lot movement on a job-work bill's challan: the challan-wise trail the
-- principal needs for ITC-04. Lot details are copied so a reprint never changes.
create table public.job_work_returns (
  id                 uuid primary key default gen_random_uuid(),
  ledger_id          uuid not null references public.job_work_ledger (id),
  invoice_id         uuid not null references public.invoices (id),
  delivery_id        uuid not null references public.deliveries (id),
  line_no            smallint not null check (line_no between 1 and 50),
  party_dc_no        text not null,
  party_dc_date      date not null,
  material_grade     text not null,
  goods_description  text not null check (char_length(btrim(goods_description)) between 1 and 300),
  goods_hsn          text not null check (goods_hsn ~ '^([0-9]{4}|[0-9]{6}|[0-9]{8})$'),
  pieces             integer check (pieces > 0),
  returned_weight_kg numeric(12,3) not null check (returned_weight_kg >= 0 and returned_weight_kg < 'Infinity'),
  scrap_weight_kg    numeric(12,3) not null default 0 check (scrap_weight_kg >= 0 and scrap_weight_kg < 'Infinity'),
  inward_weight_kg   numeric(12,3) not null check (inward_weight_kg > 0 and inward_weight_kg < 'Infinity'),
  balance_after_kg   numeric(12,3) not null check (balance_after_kg < 'Infinity'),
  declared_value     numeric(14,2) check (declared_value >= 0 and declared_value < 'Infinity'),
  reversed_at        timestamptz,   -- set when the bill is cancelled; the lot gets the weight back
  created_at         timestamptz not null default now(),
  constraint job_work_returns_line_key unique (invoice_id, line_no),
  constraint job_work_returns_moves    check (returned_weight_kg + scrap_weight_kg > 0)
);
create index job_work_returns_ledger_idx   on public.job_work_returns (ledger_id);
create index job_work_returns_delivery_idx on public.job_work_returns (delivery_id);

create function private.job_work_ledger_before_write()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_moved record;
begin
  if tg_op = 'UPDATE' then
    select count(*) as n, coalesce(sum(r.returned_weight_kg), 0) as returned, coalesce(sum(r.scrap_weight_kg), 0) as scrap
      into v_moved
      from public.job_work_returns as r
     where r.ledger_id = old.id and r.reversed_at is null;
    if new.outward_weight_kg < v_moved.returned or new.scrap_weight_kg < v_moved.scrap then
      raise exception 'Lot % already has % kg returned and % kg scrap on issued challans', old.party_dc_no,
        v_moved.returned, v_moved.scrap using errcode = '23514';
    end if;
    if v_moved.n > 0
       and (new.customer_id, new.party_dc_no, new.party_dc_date, new.material_grade)
           is distinct from (old.customer_id, old.party_dc_no, old.party_dc_date, old.material_grade) then
      raise exception 'Lot % is on issued challans; its party, DC and grade cannot change', old.party_dc_no
        using errcode = '23514';
    end if;
  end if;

  if new.status = 'open' then
    new.closed_at := null;
    new.close_reason := null;
  elsif tg_op = 'INSERT' or old.status = 'open' then
    new.closed_at := now();
  end if;
  return new;
end;
$$;

create trigger job_work_ledger_before_write
  before insert or update on public.job_work_ledger
  for each row execute function private.job_work_ledger_before_write();

-- "Cancel it and bill again" is the correction path, so cancelling frees the lot.
create function private.reverse_job_work_returns()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_return record;
begin
  for v_return in
    select r.id, r.ledger_id, r.returned_weight_kg, r.scrap_weight_kg
      from public.job_work_returns as r
     where r.invoice_id = new.id and r.reversed_at is null
     order by r.ledger_id, r.line_no
  loop
    update public.job_work_returns set reversed_at = now() where id = v_return.id;
    update public.job_work_ledger
       set outward_weight_kg = outward_weight_kg - v_return.returned_weight_kg,
           scrap_weight_kg = scrap_weight_kg - v_return.scrap_weight_kg,
           status = 'open'
     where id = v_return.ledger_id;
  end loop;
  return null;
end;
$$;

create trigger invoices_reverse_returns
  after update of cancelled_at on public.invoices
  for each row when (old.cancelled_at is null and new.cancelled_at is not null)
  execute function private.reverse_job_work_returns();


-- =============================================================================
-- 4. (f) Receipts
-- =============================================================================
create table public.payments (
  id                uuid primary key default gen_random_uuid(),
  invoice_id        uuid not null references public.invoices (id),
  client_receipt_id uuid not null unique,   -- minted by the device: a retry cannot post twice
  amount            numeric(14,2) not null check (amount > 0 and amount < 'Infinity'),
  received_on       date not null,
  mode              public.payment_mode not null,
  reference         text check (char_length(reference) <= 80),
  settles_invoice   boolean not null default false,
  voided_at         timestamptz,
  void_reason       text check (char_length(btrim(void_reason)) between 3 and 300),
  created_by        uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint payments_void_pair check ((voided_at is null) = (void_reason is null))
);
create index payments_invoice_idx on public.payments (invoice_id);

-- Replaces 001's guard: receipts move only through the RPCs below, whose definer is the
-- table owner; over the Data API current_user is the API role.
create or replace function private.invoices_guard_issued()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  -- An allowlist: every other column, including ones added later, is frozen once issued.
  c_editable constant text[] := array['amount_paid', 'payment_status', 'pdf_drive_url',
                                      'cancelled_at', 'cancellation_reason', 'updated_at'];
begin
  if to_jsonb(new) - c_editable is distinct from to_jsonb(old) - c_editable then
    raise exception 'Invoice % is issued and cannot be edited; cancel it and bill again', old.invoice_no
      using errcode = '23514';
  end if;
  if (new.amount_paid, new.payment_status) is distinct from (old.amount_paid, old.payment_status)
     and current_user in ('anon', 'authenticated', 'service_role') then
    raise exception 'Record receipts with record_payment, so two devices cannot overwrite each other'
      using errcode = '23514';
  end if;

  -- Cancellation is one-way, and dated by the server so it cannot land in a filed GST period.
  if old.cancelled_at is not null then
    if (new.cancelled_at, new.cancellation_reason)
       is distinct from (old.cancelled_at, old.cancellation_reason) then
      raise exception 'Invoice % is already cancelled; that cannot be changed', old.invoice_no
        using errcode = '23514';
    end if;
  elsif new.cancelled_at is not null then
    if new.amount_paid > 0 then
      raise exception 'Invoice % has receipts; void them before cancelling', old.invoice_no
        using errcode = '23514';
    end if;
    new.cancelled_at := now();
  end if;
  return new;
end;
$$;

create function public.record_payment(p_payload jsonb)
returns table (payment_id uuid, amount_paid text, payment_status public.payment_status, replayed boolean)
language plpgsql
volatile
security definer
set search_path = ''
set default_transaction_isolation = 'read committed'
as $$
#variable_conflict use_column
declare
  v_invoice  public.invoices%rowtype;
  v_existing public.payments%rowtype;
  v_receipt  uuid;
  v_amount   numeric;
  v_date     date;
  v_settles  boolean;
  v_payment  uuid;
begin
  if not private.is_staff() then
    raise exception 'record_payment: caller is not an active StudFlow user' using errcode = '42501';
  end if;
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'record_payment must run under read committed' using errcode = '25001';
  end if;

  v_receipt := (p_payload ->> 'client_receipt_id')::uuid;
  v_amount  := (p_payload ->> 'amount')::numeric;
  v_settles := coalesce((p_payload ->> 'settles_invoice')::boolean, false);
  if v_receipt is null or v_amount is null or v_amount <> round(v_amount, 2) then
    raise exception 'record_payment: a receipt needs an id and an amount with at most 2 decimals' using errcode = '22023';
  end if;
  if coalesce(p_payload ->> 'received_on', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    raise exception 'record_payment: received_on must be YYYY-MM-DD' using errcode = '22023';
  end if;
  v_date := (p_payload ->> 'received_on')::date;
  if v_date > private.today_ist() then
    raise exception 'record_payment: received_on cannot be in the future' using errcode = '22023';
  end if;

  -- The row lock makes concurrent receipts queue; each adds to the total it then sees.
  select i.* into v_invoice from public.invoices as i
   where i.id = (p_payload ->> 'invoice_id')::uuid for update;
  if not found then
    raise exception 'record_payment: invoice not found' using errcode = '23503';
  end if;

  select p.* into v_existing from public.payments as p where p.client_receipt_id = v_receipt;
  if found then
    if (v_existing.invoice_id, v_existing.amount, v_existing.received_on, v_existing.mode, v_existing.settles_invoice)
       is distinct from
       (v_invoice.id, v_amount, v_date, (p_payload ->> 'mode')::public.payment_mode, v_settles) then
      raise exception 'record_payment: this receipt was already recorded with different details' using errcode = '23505';
    end if;
    return query select v_existing.id, v_invoice.amount_paid::text, v_invoice.payment_status, true;
    return;
  end if;

  if v_invoice.cancelled_at is not null then
    raise exception 'record_payment: invoice % is cancelled', v_invoice.invoice_no using errcode = '23514';
  end if;
  if v_invoice.amount_paid + v_amount > v_invoice.grand_total then
    raise exception 'record_payment: only % is due on %', v_invoice.grand_total - v_invoice.amount_paid,
      v_invoice.invoice_no using errcode = '23514';
  end if;

  insert into public.payments as p (invoice_id, client_receipt_id, amount, received_on, mode, reference, settles_invoice)
  values (v_invoice.id, v_receipt, v_amount, v_date, (p_payload ->> 'mode')::public.payment_mode,
          nullif(btrim(p_payload ->> 'reference'), ''), v_settles)
  returning p.id into v_payment;

  return query
    update public.invoices as i
       set amount_paid = i.amount_paid + v_amount,
           payment_status = case when v_settles or i.amount_paid + v_amount = i.grand_total
                                 then 'paid' else 'partial' end::public.payment_status
     where i.id = v_invoice.id
    returning v_payment, i.amount_paid::text, i.payment_status, false;
end;
$$;

create function public.void_payment(p_payment_id uuid, p_reason text)
returns table (payment_id uuid, amount_paid text, payment_status public.payment_status)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_payment public.payments%rowtype;
begin
  if not private.is_owner() then
    raise exception 'void_payment: only the owner can void a receipt' using errcode = '42501';
  end if;
  -- Invoice first, then receipt: the same order record_payment takes.
  perform 1 from public.invoices as i
    where i.id = (select p.invoice_id from public.payments as p where p.id = p_payment_id) for update;
  select p.* into v_payment from public.payments as p where p.id = p_payment_id for update;
  if not found then
    raise exception 'void_payment: receipt not found' using errcode = '23503';
  end if;
  if v_payment.voided_at is not null then
    raise exception 'void_payment: this receipt is already void' using errcode = '23514';
  end if;
  update public.payments as p set voided_at = now(), void_reason = p_reason where p.id = p_payment_id;

  return query
    update public.invoices as i
       set amount_paid = i.amount_paid - v_payment.amount,
           payment_status = case
             when i.amount_paid - v_payment.amount = 0 then 'unpaid'
             when exists (select 1 from public.payments as p
                           where p.invoice_id = i.id and p.voided_at is null and p.settles_invoice) then 'paid'
             else 'partial' end::public.payment_status
     where i.id = v_payment.invoice_id
    returning p_payment_id, i.amount_paid::text, i.payment_status;
end;
$$;


-- =============================================================================
-- 5. sync_invoice, extended (same signature and guarantees as 001)
-- =============================================================================
-- New in the payload: per-line cgst/sgst/igst_amount, charges_cgst/sgst/igst, job_work_returns
-- and payment_mode. Lock order: INV counter, DC counter, then lots by id.
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
    amount_paid, payment_status, due_date, notes
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
    nullif(btrim(p_payload ->> 'notes'), '')
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


-- =============================================================================
-- 6. Triggers, RLS and privileges for the new tables (CLAUDE.md checklist)
-- =============================================================================
create trigger company_profile_stamp  before insert or update on public.company_profile for each row execute function private.stamp_row();
create trigger payments_stamp         before insert or update on public.payments        for each row execute function private.stamp_row();
create trigger payments_stamp_creator before insert or update on public.payments        for each row execute function private.stamp_creator();

create trigger company_profile_log  after update or delete on public.company_profile  for each row execute function private.log_change();
create trigger payments_log         after update or delete on public.payments         for each row execute function private.log_change();
create trigger job_work_returns_log after update or delete on public.job_work_returns for each row execute function private.log_change();

create trigger payments_permanent         before delete or truncate on public.payments         for each statement execute function private.reject_change();
create trigger job_work_returns_permanent before delete or truncate on public.job_work_returns for each statement execute function private.reject_change();

alter table public.company_profile  enable row level security;
alter table public.payments         enable row level security;
alter table public.job_work_returns enable row level security;

create policy company_profile_select on public.company_profile for select to authenticated
  using ((select private.is_staff()));
create policy company_profile_insert on public.company_profile for insert to authenticated
  with check ((select private.is_owner()));
create policy company_profile_update on public.company_profile for update to authenticated
  using ((select private.is_owner())) with check ((select private.is_owner()));
create policy payments_select on public.payments for select to authenticated
  using ((select private.is_staff()));
create policy job_work_returns_select on public.job_work_returns for select to authenticated
  using ((select private.is_staff()));

revoke all on table public.company_profile, public.payments, public.job_work_returns
  from anon, authenticated, service_role;
grant select, insert, update on table public.company_profile to authenticated;
grant select on table public.payments, public.job_work_returns to authenticated;
grant select on table public.company_profile, public.payments, public.job_work_returns to service_role;

revoke all on function private.job_work_ledger_before_write(), private.reverse_job_work_returns() from public;
revoke all on function public.record_payment(jsonb), public.void_payment(uuid, text)
  from public, anon, service_role;
grant execute on function public.record_payment(jsonb), public.void_payment(uuid, text) to authenticated;
