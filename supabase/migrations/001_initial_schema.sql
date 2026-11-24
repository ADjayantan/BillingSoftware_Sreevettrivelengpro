-- =============================================================================
-- StudFlow AI · 001_initial_schema.sql
-- -----------------------------------------------------------------------------
-- Target   Supabase Postgres 15+  (`npm run db:verify` runs it on PGlite)
-- Sections 0 schemas · 1 types · 2 pure helpers · 3 access, counters, edit log
--          4 core tables (8) · 5 triggers · 6 sync_invoice RPC · 7 views
--          8 row level security · 9 privileges · 10 Data API gate
-- Rules    * Money, GST, weights and totals are computed ONLY in src/lib/billing-math.ts.
--            This schema VERIFIES those figures; it never rounds or derives a billed amount.
--          * Every numeric column needs an upper bound (`< 'Infinity'` at least). Postgres
--            sorts NaN above all numbers, so `>= 0` alone lets NaN into the books.
-- =============================================================================


-- =============================================================================
-- 0. Schemas
-- =============================================================================
-- `private` is not exposed by the Supabase Data API (only `public` is), so helper
-- functions and internal tables living here cannot be called or read over REST.
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;


-- =============================================================================
-- 1. Types
-- =============================================================================
create type public.bill_type       as enum ('supply', 'job_work');
create type public.payment_status  as enum ('unpaid', 'partial', 'paid');
create type public.billing_unit    as enum ('pcs', 'kg');
create type public.freight_payer   as enum ('seller', 'buyer_to_pay');
-- Declaration order is meaningful: deliveries use `status < 'dispatched'`.
create type public.delivery_status as enum ('pending', 'packed', 'dispatched', 'delivered');
create type public.transport_mode  as enum ('own_vehicle', 'transporter', 'courier', 'customer_pickup', 'hand_delivery');
create type public.job_work_status as enum ('open', 'closed');
create type private.app_role       as enum ('owner', 'staff');


-- =============================================================================
-- 2. Pure helpers (no table access)
-- =============================================================================
-- Indian financial year: 1 April – 31 March. Input is an IST calendar date.
create function private.fiscal_year_start(p_date date)
returns date
language sql
immutable
strict
parallel safe
set search_path = ''
as $$
  select make_date(extract(year from p_date)::int - (extract(month from p_date) < 4)::int, 4, 1)
$$;

-- 2026-11-23 -> '26-27'; 2027-03-31 -> '26-27'; 2099-04-01 -> '99-00'.
create function private.fiscal_year_of(p_date date)
returns text
language sql
immutable
strict
parallel safe
set search_path = ''
as $$
  select lpad((fy.y % 100)::text, 2, '0') || '-' || lpad(((fy.y + 1) % 100)::text, 2, '0')
  from (select extract(year from private.fiscal_year_start(p_date))::int as y) as fy
$$;

-- ('INV', '26-27', 1) -> 'INV/26-27/0001'. greatest() matters: lpad() TRUNCATES, so a
-- plain lpad(.., 4, ..) would turn invoice 10000 into '1000' — a duplicate number.
create function private.format_document_no(p_series text, p_fiscal_year text, p_seq integer)
returns text
language sql
immutable
strict
parallel safe
set search_path = ''
as $$
  select p_series || '/' || p_fiscal_year || '/'
      || lpad(p_seq::text, greatest(4, length(p_seq::text)), '0')
$$;

-- Business "today". Supabase servers run in UTC; between 00:00 and 05:30 IST the UTC
-- date is still yesterday, which would put a 1 April bill into the previous FY.
create function private.today_ist()
returns date
language sql
stable
parallel safe
set search_path = ''
as $$
  select (now() at time zone 'Asia/Kolkata')::date
$$;

-- state(2) + PAN(10) + 3, the last being a mod-36 check character. It catches a mistyped or
-- swapped character before the GSTIN is frozen into an invoice the buyer claims ITC on.
create function private.is_valid_gstin(p_gstin text)
returns boolean
language sql
immutable
strict
parallel safe
set search_path = ''
as $$
  select p_gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3}$'
     and right(p_gstin, 1) = substr(d.digits, 1 + (36 - s.total % 36) % 36, 1)
  from (select '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'::text as digits) as d
  cross join lateral (
    select sum(v.product / 36 + v.product % 36)::int as total
    from (select (strpos(d.digits, substr(p_gstin, g.i, 1)) - 1) * (2 - g.i % 2) as product
          from generate_series(1, 14) as g(i)) as v
  ) as s
$$;


-- =============================================================================
-- 3. Access allowlist, gapless counters, edit log (private, never exposed)
-- =============================================================================
-- Supabase lets anyone with the publishable key sign up, so "authenticated" alone
-- must never mean "allowed". Only active users listed here can touch business data.
create table private.app_users (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  display_name text not null check (char_length(btrim(display_name)) between 1 and 80),
  role         private.app_role not null default 'staff',
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
comment on table private.app_users is
  'Access allowlist. Signing up grants nothing until the owner adds the user here (SQL editor / service role).';

-- One row per (series, FY). Open both series before the first bill: last_value = the last
-- number the old system issued, or 0 for a fresh start.
create table private.document_sequences (
  series      text not null check (series in ('INV', 'DC')),
  fiscal_year text not null check (
                case when fiscal_year ~ '^[0-9]{2}-[0-9]{2}$'
                     then (left(fiscal_year, 2)::int + 1) % 100 = right(fiscal_year, 2)::int
                     else false
                end),
  last_value  integer not null default 0 check (last_value >= 0),
  updated_at  timestamptz not null default now(),
  primary key (series, fiscal_year)
);
comment on table private.document_sequences is
  'Gapless per-FY counters for GST invoice (Rule 46) and delivery challan (Rule 55) serial numbers.';

-- CGST Rule 56(8): registers kept electronically need a log of every entry edited or
-- deleted. Append-only; rows are written by the private.log_change() trigger.
create table private.audit_log (
  id         bigint generated always as identity primary key,
  logged_at  timestamptz not null default now(),
  actor_id   uuid,            -- signed-in user; null for cron jobs and the SQL editor
  actor_role text not null,
  table_name text not null,
  row_id     uuid,
  action     text not null check (action in ('UPDATE', 'DELETE')),
  old_row    jsonb not null,
  new_row    jsonb
);
create index audit_log_row_idx on private.audit_log (table_name, row_id);

-- SECURITY DEFINER so RLS policies can read the allowlist without exposing it.
-- Wrap calls as `(select private.is_staff())` in policies: evaluated once per statement.
create function private.is_staff()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from private.app_users as u
    where u.user_id = (select auth.uid())
      and u.is_active
  )
$$;

create function private.is_owner()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from private.app_users as u
    where u.user_id = (select auth.uid())
      and u.is_active
      and u.role = 'owner'
  )
$$;

-- PostgREST runs this before every Data API request (registered in section 10). RLS already
-- hides the rows; this also stops outsiders from reading planner row estimates
-- (`Prefer: count=planned` would tell a stranger how many invoices exist).
create function private.check_request()
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if current_user = 'authenticated' and not private.is_staff() then
    raise exception 'This account has no access to StudFlow' using errcode = '42501';
  end if;
end;
$$;

-- Gapless by construction: the counter row stays locked until the calling transaction
-- ends, so concurrent syncs queue up, and a rollback (validation error, crash, dropped
-- connection) hands the number back. Lock order is always INV, then DC, one bill per
-- transaction.
create function private.next_document_seq(p_series text, p_fiscal_year text)
returns integer
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_next integer;
begin
  update private.document_sequences as s
     set last_value = s.last_value + 1,
         updated_at = now()
   where s.series = p_series
     and s.fiscal_year = p_fiscal_year
  returning s.last_value into v_next;
  if found then
    return v_next;
  end if;

  -- A new FY may roll forward from an older one. Anything else (first use, or an FY before
  -- go-live) could repeat numbers the old system already issued, so it is never implicit.
  if not exists (select 1 from private.document_sequences as s
                  where s.series = p_series
                    and left(s.fiscal_year, 2)::int < left(p_fiscal_year, 2)::int) then
    raise exception '% numbering for FY % is not open', p_series, p_fiscal_year
      using errcode = '55000',
            hint = 'Seed private.document_sequences with the last number already issued (0 for a fresh start).';
  end if;

  insert into private.document_sequences as s (series, fiscal_year, last_value)
  values (p_series, p_fiscal_year, 1)
  on conflict (series, fiscal_year)
  do update set last_value = s.last_value + 1,
                updated_at = now()
  returning s.last_value into v_next;
  return v_next;
end;
$$;


-- =============================================================================
-- 4. Core tables (the 8 from PROJECT_BRIEF.md)
-- =============================================================================
-- Foreign keys use the default NO ACTION: RESTRICT behaves the same here but reports a
-- different SQLSTATE on PG 18 (23001) than on PG 15/17 (23503).

-- 4.1 customers ---------------------------------------------------------------
create table public.customers (
  id              uuid primary key default gen_random_uuid(),
  name            text not null check (char_length(btrim(name)) between 1 and 120),
  gstin           text check (private.is_valid_gstin(gstin)),
  phone           text check (phone ~ '^\+?[0-9]{10,15}$'),
  state_code      text not null default '33' check (state_code ~ '^[0-9]{2}$'),
  credit_days     integer not null default 30 check (credit_days between 0 and 365),
  address         text check (char_length(btrim(address)) between 1 and 500),
  opening_balance numeric(14,2) not null default 0 check (opening_balance < 'Infinity'),
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- The GST regime (CGST+SGST vs IGST) hangs off state_code, so it must agree with the GSTIN.
  constraint customers_gstin_matches_state check (gstin is null or left(gstin, 2) = state_code),
  -- GST Rule 46(d): an invoice to a registered buyer must show their address.
  constraint customers_gstin_needs_address check (gstin is null or address is not null)
);
create unique index customers_gstin_key on public.customers (gstin) where gstin is not null;
comment on column public.customers.opening_balance is
  'Balance carried over from the old system. Positive = customer owes us.';

-- 4.2 stud_items --------------------------------------------------------------
create table public.stud_items (
  id                     uuid primary key default gen_random_uuid(),
  sku_code               text not null unique check (sku_code ~ '^[A-Z0-9][A-Z0-9._/-]{0,39}$'),
  diameter_mm            numeric(8,3)  not null check (diameter_mm > 0 and diameter_mm <= 200),
  length_mm              numeric(10,2) not null check (length_mm > 0 and length_mm <= 10000),
  thread_type            text not null check (char_length(btrim(thread_type)) between 1 and 40),
  material_grade         text not null check (material_grade ~ '^[A-Z0-9][A-Z0-9 ./-]{0,29}$'),
  hsn_sac                text not null default '7318' check (hsn_sac ~ '^([0-9]{4}|[0-9]{6}|[0-9]{8})$'),
  gst_rate_percent       numeric(5,2) not null default 18 check (gst_rate_percent between 0 and 100),
  unit_weight_kg         numeric(12,6) not null check (unit_weight_kg > 0 and unit_weight_kg < 'Infinity'),
  unit_weight_is_manual  boolean not null default false,
  -- 6 decimals: small studs are quoted per 1000 pcs (Rs 43.75 / 1000 = Rs 0.04375 each).
  default_rate_per_piece numeric(14,6) check (default_rate_per_piece >= 0 and default_rate_per_piece < 'Infinity'),
  default_rate_per_kg    numeric(14,6) check (default_rate_per_kg >= 0 and default_rate_per_kg < 'Infinity'),
  is_active              boolean not null default true,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  -- Steel formula from the brief. Editing a dimension must also update the weight (or mark
  -- it manual), otherwise every piece<->kg conversion silently uses the old one.
  constraint stud_items_formula_weight check (
    unit_weight_is_manual
    or abs(unit_weight_kg - diameter_mm * diameter_mm / 162.2 * length_mm / 1000) <= 0.000001)
);
create index stud_items_material_grade_idx on public.stud_items (material_grade);

-- 4.3 metal_rates (price history) ---------------------------------------------
create table public.metal_rates (
  id                   uuid primary key default gen_random_uuid(),
  material_grade       text not null check (material_grade ~ '^[A-Z0-9][A-Z0-9 ./-]{0,29}$'),
  rate_per_kg          numeric(14,4) not null check (rate_per_kg > 0 and rate_per_kg < 'Infinity'),
  -- Always derived from history by triggers, never typed: alerts compare change_delta.
  previous_rate_per_kg numeric(14,4) check (previous_rate_per_kg > 0 and previous_rate_per_kg < 'Infinity'),
  change_delta         numeric(14,4) generated always as (rate_per_kg - previous_rate_per_kg) stored,
  source               text not null default 'manual' check (char_length(btrim(source)) between 1 and 60),
  recorded_at          timestamptz not null default now()
);
create index metal_rates_grade_recorded_idx on public.metal_rates (material_grade, recorded_at desc);

-- 4.4 invoices ----------------------------------------------------------------
-- Created ONLY through public.sync_invoice(). Never deleted (GST): cancel instead.
create table public.invoices (
  id                  uuid primary key default gen_random_uuid(),
  invoice_no          text not null unique,
  fiscal_year         text not null,
  invoice_seq         integer not null check (invoice_seq > 0),
  client_temp_id      text not null unique check (
                        client_temp_id ~ '^OFFLINE-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  sync_fingerprint    text not null check (sync_fingerprint ~ '^[0-9a-f]{64}$'),
  bill_type           public.bill_type not null,
  customer_id         uuid not null references public.customers (id),
  invoice_date        date not null,
  place_of_supply     text not null check (place_of_supply ~ '^[0-9]{2}$'),
  customer_snapshot   jsonb not null check (jsonb_typeof(customer_snapshot) = 'object'),
  subtotal            numeric(14,2) not null check (subtotal >= 0 and subtotal < 'Infinity'),
  packing_charge      numeric(14,2) not null default 0 check (packing_charge >= 0 and packing_charge < 'Infinity'),
  delivery_charge     numeric(14,2) not null default 0 check (delivery_charge >= 0 and delivery_charge < 'Infinity'),
  delivery_taxable    boolean not null default true,
  cgst                numeric(14,2) not null default 0 check (cgst >= 0 and cgst < 'Infinity'),
  sgst                numeric(14,2) not null default 0 check (sgst >= 0 and sgst < 'Infinity'),
  igst                numeric(14,2) not null default 0 check (igst >= 0 and igst < 'Infinity'),
  round_off           numeric(4,2)  not null default 0 check (round_off > -1 and round_off < 1),
  grand_total         numeric(14,2) not null check (grand_total >= 0 and grand_total < 'Infinity'),
  amount_paid         numeric(14,2) not null default 0 check (amount_paid >= 0 and amount_paid < 'Infinity'),
  payment_status      public.payment_status not null default 'unpaid',
  due_date            date not null,
  pdf_drive_url       text check (pdf_drive_url ~ '^https://(drive|docs)\.google\.com/' and char_length(pdf_drive_url) <= 500),
  notes               text check (char_length(notes) <= 1000),
  cancelled_at        timestamptz,
  cancellation_reason text check (char_length(btrim(cancellation_reason)) between 3 and 300),
  created_by          uuid,   -- no FK: the audit trail must outlive a deleted login
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint invoices_fy_seq_key        unique (fiscal_year, invoice_seq),
  constraint invoices_fy_matches_date   check (fiscal_year = private.fiscal_year_of(invoice_date)),
  constraint invoices_no_matches_seq    check (invoice_no = private.format_document_no('INV', fiscal_year, invoice_seq)
                                               and char_length(invoice_no) <= 16),   -- GST Rule 46(b)
  constraint invoices_total_identity    check (grand_total = subtotal + packing_charge + delivery_charge
                                                           + cgst + sgst + igst + round_off),
  -- A round-off must actually reach a whole rupee; a bill may also go unrounded.
  constraint invoices_round_off_lands   check (round_off = 0 or grand_total = trunc(grand_total)),
  constraint invoices_cgst_equals_sgst  check (cgst = sgst),
  -- '33' = Tamil Nadu, the supplier's state: intra-state -> CGST+SGST, otherwise IGST only.
  constraint invoices_gst_regime        check (case when place_of_supply = '33' then igst = 0
                                                    else cgst = 0 and sgst = 0 end),
  constraint invoices_due_not_before    check (due_date >= invoice_date),
  constraint invoices_payment_state     check (case payment_status
                                                 when 'unpaid'  then amount_paid = 0
                                                 when 'partial' then amount_paid > 0 and amount_paid < grand_total
                                                 else true end),
  constraint invoices_cancellation_pair check ((cancelled_at is null) = (cancellation_reason is null))
);
create index invoices_customer_date_idx on public.invoices (customer_id, invoice_date desc);
create index invoices_open_dues_idx     on public.invoices (due_date)
  where payment_status <> 'paid' and cancelled_at is null;

comment on column public.invoices.client_temp_id is
  'OFFLINE-<uuid> minted by the device when the bill is drafted. Idempotency key for sync.';
comment on column public.invoices.sync_fingerprint is
  'SHA-256 of the synced payload: a retry with the same content replays, an edited one is refused.';
comment on column public.invoices.place_of_supply is
  'Customer state code at sync time. 33 -> CGST+SGST, anything else -> IGST.';
comment on column public.invoices.customer_snapshot is
  'Customer details exactly as billed, so reprints never change when the master record is edited.';
comment on column public.invoices.delivery_taxable is
  'true -> packing + delivery charges are part of the taxable value (computed in billing-math.ts).';
comment on column public.invoices.amount_paid is
  'Running total received. ''paid'' may be below grand_total: buyers deduct TDS.';

-- 4.5 invoice_items (immutable once issued) -----------------------------------
create table public.invoice_items (
  id               uuid primary key default gen_random_uuid(),
  invoice_id       uuid not null references public.invoices (id),
  line_no          smallint not null check (line_no between 1 and 500),
  stud_item_id     uuid references public.stud_items (id),
  description      text not null check (char_length(btrim(description)) between 1 and 300),
  hsn_sac          text not null check (hsn_sac ~ '^([0-9]{4}|[0-9]{6}|[0-9]{8})$'),
  qty_pieces       integer check (qty_pieces > 0),
  -- 6 decimals, as billing-math.ts converts pieces to kg; 3 would move the line total.
  total_weight_kg  numeric(14,6) check (total_weight_kg >= 0 and total_weight_kg < 'Infinity'),
  billing_unit     public.billing_unit not null,
  unit_rate        numeric(14,6) not null check (unit_rate >= 0 and unit_rate < 'Infinity'),
  tax_rate_percent numeric(5,2)  not null check (tax_rate_percent between 0 and 100),
  line_total       numeric(14,2) not null check (line_total >= 0 and line_total < 'Infinity'),
  created_at       timestamptz not null default now(),

  constraint invoice_items_line_key      unique (invoice_id, line_no),
  constraint invoice_items_unit_has_qty  check (case billing_unit
                                                  when 'pcs' then qty_pieces is not null
                                                  else coalesce(total_weight_kg, 0) > 0 end),
  -- Holds for any rounding to the paisa (half-up or half-even), so it constrains the result
  -- without choosing billing-math.ts's convention.
  constraint invoice_items_amount        check (abs(line_total - unit_rate
                                                  * case billing_unit when 'pcs' then qty_pieces
                                                                      else total_weight_kg end) <= 0.005)
);
create index invoice_items_stud_item_idx on public.invoice_items (stud_item_id);
comment on column public.invoice_items.line_total is 'Taxable value of the line (before GST).';

-- 4.6 deliveries (delivery challans) ------------------------------------------
create table public.deliveries (
  id               uuid primary key default gen_random_uuid(),
  invoice_id       uuid not null references public.invoices (id),
  dc_no            text not null unique,
  fiscal_year      text not null,
  dc_seq           integer not null check (dc_seq > 0),
  dc_date          date not null,
  transport_mode   public.transport_mode not null default 'own_vehicle',
  vehicle_no       text check (vehicle_no ~ '^[A-Z0-9]{4,15}$'),
  driver_name      text check (char_length(btrim(driver_name)) between 1 and 80),
  driver_phone     text check (driver_phone ~ '^\+?[0-9]{10,15}$'),
  lr_number        text check (char_length(btrim(lr_number)) between 1 and 40),
  freight_paid_by  public.freight_payer not null default 'seller',
  freight_amount   numeric(14,2) not null default 0 check (freight_amount >= 0 and freight_amount < 'Infinity'),
  delivery_address text check (char_length(delivery_address) <= 500),
  status           public.delivery_status not null default 'pending',
  proof_drive_url  text check (proof_drive_url ~ '^https://(drive|docs)\.google\.com/' and char_length(proof_drive_url) <= 500),
  dispatched_at    timestamptz,
  delivered_at     timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint deliveries_fy_seq_key       unique (fiscal_year, dc_seq),
  constraint deliveries_fy_matches_date  check (fiscal_year = private.fiscal_year_of(dc_date)),
  constraint deliveries_no_matches_seq   check (dc_no = private.format_document_no('DC', fiscal_year, dc_seq)
                                                and char_length(dc_no) <= 16),        -- GST Rule 55
  constraint deliveries_dispatch_stamped check (status < 'dispatched' or dispatched_at is not null),
  constraint deliveries_delivery_stamped check (status <> 'delivered' or delivered_at is not null),
  constraint deliveries_stamp_order      check (delivered_at is null or dispatched_at is null
                                                or delivered_at >= dispatched_at)
);
create index deliveries_invoice_idx on public.deliveries (invoice_id);
create index deliveries_open_idx    on public.deliveries (status) where status <> 'delivered';
comment on column public.deliveries.freight_amount is
  'Freight printed on the DC. With freight_paid_by = buyer_to_pay it is NOT billed on the invoice.';

-- 4.7 job_work_ledger (customer-owned material lots) ---------------------------
create table public.job_work_ledger (
  id                uuid primary key default gen_random_uuid(),
  customer_id       uuid not null references public.customers (id),
  party_dc_no       text not null check (char_length(btrim(party_dc_no)) between 1 and 40),
  party_dc_date     date not null,
  material_grade    text not null check (material_grade ~ '^[A-Z0-9][A-Z0-9 ./-]{0,29}$'),
  description       text check (char_length(description) <= 300),
  inward_weight_kg  numeric(12,3) not null check (inward_weight_kg > 0 and inward_weight_kg < 'Infinity'),
  outward_weight_kg numeric(12,3) not null default 0 check (outward_weight_kg >= 0 and outward_weight_kg < 'Infinity'),
  scrap_weight_kg   numeric(12,3) not null default 0 check (scrap_weight_kg >= 0 and scrap_weight_kg < 'Infinity'),
  -- Generated so the stock balance can never drift. Not sign-checked: scale variance
  -- between the party's weighbridge and ours must stay visible, not be rejected.
  balance_weight_kg numeric(12,3) generated always as
                      (inward_weight_kg - outward_weight_kg - scrap_weight_kg) stored,
  status            public.job_work_status not null default 'open',
  notes             text check (char_length(notes) <= 1000),
  created_by        uuid,   -- no FK: the audit trail must outlive a deleted login
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index job_work_ledger_customer_status_idx on public.job_work_ledger (customer_id, status);
comment on column public.job_work_ledger.party_dc_date is
  'Date on the customer''s challan. Inputs not returned within 1 year become a deemed supply (CGST s.143).';

-- 4.8 alert_rules -------------------------------------------------------------
create table public.alert_rules (
  id                  uuid primary key default gen_random_uuid(),
  material_grade      text not null check (material_grade ~ '^[A-Z0-9][A-Z0-9 ./-]{0,29}$'),
  threshold_rs_per_kg numeric(14,4) not null check (threshold_rs_per_kg > 0 and threshold_rs_per_kg < 'Infinity'),
  telegram_chat_id    text not null check (telegram_chat_id ~ '^-?[0-9]{1,20}$'),
  is_active           boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint alert_rules_grade_chat_key unique (material_grade, telegram_chat_id)
);
comment on column public.alert_rules.threshold_rs_per_kg is
  'Fire when |change_delta| for this grade is >= threshold (Rs/kg).';


-- =============================================================================
-- 5. Triggers
-- =============================================================================
-- BEFORE row triggers on one table fire in name order.

-- 5.1 Row stamps: clients can never choose or change created_at / updated_at / created_by.
create function private.stamp_row()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
  else
    new.created_at := old.created_at;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create function private.stamp_creator()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
  else
    new.created_by := old.created_by;
  end if;
  return new;
end;
$$;

create trigger customers_stamp       before insert or update on public.customers       for each row execute function private.stamp_row();
create trigger stud_items_stamp      before insert or update on public.stud_items      for each row execute function private.stamp_row();
create trigger invoices_stamp        before insert or update on public.invoices        for each row execute function private.stamp_row();
create trigger deliveries_stamp      before insert or update on public.deliveries      for each row execute function private.stamp_row();
create trigger job_work_ledger_stamp before insert or update on public.job_work_ledger for each row execute function private.stamp_row();
create trigger alert_rules_stamp     before insert or update on public.alert_rules     for each row execute function private.stamp_row();
create trigger app_users_stamp       before insert or update on private.app_users      for each row execute function private.stamp_row();

create trigger invoices_stamp_creator        before insert or update on public.invoices        for each row execute function private.stamp_creator();
create trigger job_work_ledger_stamp_creator before insert or update on public.job_work_ledger for each row execute function private.stamp_creator();

-- 5.2 Edit log (CGST Rule 56(8)). SECURITY DEFINER: callers cannot reach audit_log.
create function private.log_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and to_jsonb(new) - 'updated_at' = to_jsonb(old) - 'updated_at' then
    return null;   -- nothing but the timestamp moved
  end if;
  insert into private.audit_log (actor_id, actor_role, table_name, row_id, action, old_row, new_row)
  values (
    auth.uid(),
    coalesce(auth.jwt() ->> 'role', session_user::text),
    tg_table_schema || '.' || tg_table_name,
    coalesce(to_jsonb(old) ->> 'id', to_jsonb(old) ->> 'user_id')::uuid,
    tg_op,
    to_jsonb(old),
    case when tg_op = 'UPDATE' then to_jsonb(new) end
  );
  return null;
end;
$$;

create trigger customers_log       after update or delete on public.customers       for each row execute function private.log_change();
create trigger stud_items_log      after update or delete on public.stud_items      for each row execute function private.log_change();
create trigger metal_rates_log     after update or delete on public.metal_rates     for each row execute function private.log_change();
create trigger invoices_log        after update or delete on public.invoices        for each row execute function private.log_change();
create trigger invoice_items_log   after update or delete on public.invoice_items   for each row execute function private.log_change();
create trigger deliveries_log      after update or delete on public.deliveries      for each row execute function private.log_change();
create trigger job_work_ledger_log after update or delete on public.job_work_ledger for each row execute function private.log_change();
create trigger app_users_log       after update or delete on private.app_users      for each row execute function private.log_change();

-- 5.3 Permanence. Grants already stop the API roles; these also stop the service role, the
-- SQL editor and cascades. One lost invoice row is a hole in the series, and its next sync
-- from a device queue would mint a second number for the same bill.
create function private.reject_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '% on %.% is not allowed: GST records are permanent', tg_op, tg_table_schema, tg_table_name
    using errcode = '42501';
end;
$$;

create trigger invoices_permanent      before delete or truncate on public.invoices                  for each statement execute function private.reject_change();
create trigger deliveries_permanent    before delete or truncate on public.deliveries                for each statement execute function private.reject_change();
create trigger invoice_items_permanent before update or delete or truncate on public.invoice_items   for each statement execute function private.reject_change();
create trigger audit_log_permanent     before update or delete or truncate on private.audit_log      for each statement execute function private.reject_change();

-- 5.4 Metal rates: previous_rate_per_kg is always the latest earlier reading of the grade.
-- The row trigger sets it on the row being written; the statement trigger re-links its
-- neighbours after a correction, a back-fill or a delete.
create function private.metal_rates_before_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.recorded_at > now() + interval '5 minutes' then
    raise exception 'A metal rate cannot be dated in the future' using errcode = '22023';
  end if;
  new.previous_rate_per_kg := (
    select mr.rate_per_kg
      from public.metal_rates as mr
     where mr.material_grade = new.material_grade
       and (mr.recorded_at, mr.id) < (new.recorded_at, new.id)
     order by mr.recorded_at desc, mr.id desc
     limit 1);
  return new;
end;
$$;

create trigger metal_rates_before_write
  before insert or update on public.metal_rates
  for each row execute function private.metal_rates_before_write();

-- SECURITY DEFINER: staff may add readings but not update existing rows.
create function private.metal_rates_relink()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.metal_rates as m
     set previous_rate_per_kg = x.previous
    from (select mr.id, lag(mr.rate_per_kg) over (partition by mr.material_grade
                                                  order by mr.recorded_at, mr.id) as previous
            from public.metal_rates as mr) as x
   where x.id = m.id
     and m.previous_rate_per_kg is distinct from x.previous;
  return null;
end;
$$;

create trigger metal_rates_relink
  after insert or update or delete on public.metal_rates
  for each statement when (pg_trigger_depth() = 0)
  execute function private.metal_rates_relink();

-- 5.5 A DC's identity is part of a gapless legal series; logistics fields stay editable.
create function private.deliveries_before_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
     and (new.invoice_id, new.dc_no, new.fiscal_year, new.dc_seq, new.dc_date)
         is distinct from
         (old.invoice_id, old.dc_no, old.fiscal_year, old.dc_seq, old.dc_date) then
    raise exception 'Delivery challan %: invoice link, number and date are immutable', old.dc_no
      using errcode = '23514';
  end if;

  -- Brief rule: freight the buyer pays the transporter for is shown on the DC only.
  if new.freight_paid_by = 'buyer_to_pay'
     and exists (select 1 from public.invoices as i
                  where i.id = new.invoice_id and i.delivery_charge <> 0) then
    raise exception 'Freight paid by the buyer must not also be billed (invoice delivery_charge must be 0)'
      using errcode = '23514';
  end if;

  if new.status >= 'dispatched' and new.dispatched_at is null then
    new.dispatched_at := now();
  end if;
  if new.status = 'delivered' and new.delivered_at is null then
    new.delivered_at := now();
  end if;
  return new;
end;
$$;

create trigger deliveries_before_write
  before insert or update on public.deliveries
  for each row execute function private.deliveries_before_write();

-- 5.6 Issued invoices are legal documents (GST Rule 46). This trigger is the last line of
-- defence for EVERY write path (REST, RPC, service role) after an invoice is synced.
-- It fires before invoices_stamp, which re-stamps created_at / updated_at / created_by.
create function private.invoices_guard_issued()
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

  -- Cancellation is one-way, and dated by the server so it cannot land in a filed GST period.
  if old.cancelled_at is not null then
    if (new.cancelled_at, new.cancellation_reason)
       is distinct from (old.cancelled_at, old.cancellation_reason) then
      raise exception 'Invoice % is already cancelled; that cannot be changed', old.invoice_no
        using errcode = '23514';
    end if;
  elsif new.cancelled_at is not null then
    new.cancelled_at := now();
  end if;
  return new;
end;
$$;

create trigger invoices_guard_issued
  before update on public.invoices
  for each row execute function private.invoices_guard_issued();


-- =============================================================================
-- 6. RPC: sync_invoice — the only way an invoice (+ items + DC) is created
-- =============================================================================
-- Called by the Next.js sync route (user's session, after Zod validation and a server-side
-- billing-math.ts recomputation). It is also reachable directly at /rpc/sync_invoice with any
-- staff login, so everything that must hold is verified HERE, not only in the route.
-- One transaction: either the invoice, its lines and its DC all exist with fresh numbers, or
-- nothing changed. Idempotent: the same bill again returns the original numbers; an edited
-- bill under the same client_temp_id is refused (23505 -> HTTP 409).
create function public.sync_invoice(p_payload jsonb)
returns table (invoice_id uuid, invoice_no text, dc_no text, replayed boolean)
language plpgsql
volatile
security definer
set search_path = ''
-- PostgREST hoists this to the request's transaction (see the check in step 0).
set default_transaction_isolation = 'read committed'
as $$
#variable_conflict use_column
declare
  v_client_temp_id text;
  v_fingerprint    text;
  v_existing       public.invoices%rowtype;
  v_customer       public.customers%rowtype;
  v_items          jsonb;
  v_lines          record;
  v_delivery       jsonb;
  v_today          date;
  v_invoice_date   date;
  v_fiscal_year    text;
  v_invoice_seq    integer;
  v_dc_seq         integer;
  v_invoice_id     uuid;
  v_invoice_no     text;
  v_dc_no          text;
  v_field          text;
  v_subtotal       numeric;
  v_charges        numeric;
  v_tax            numeric;
  v_tolerance      numeric;
begin
  -- 0. Authorization (SECURITY DEFINER bypasses RLS) and isolation: the replay check below
  --    needs a fresh snapshot per statement to see a concurrent twin's committed row.
  if not private.is_staff() then
    raise exception 'sync_invoice: caller is not an active StudFlow user' using errcode = '42501';
  end if;
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'sync_invoice must run under read committed, not %', current_setting('transaction_isolation')
      using errcode = '25001';
  end if;

  -- 1. Shape (Zod validates first in the API route; this is defence in depth).
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'sync_invoice: payload must be a JSON object' using errcode = '22023';
  end if;

  v_client_temp_id := p_payload ->> 'client_temp_id';
  if v_client_temp_id is null
     or v_client_temp_id !~ '^OFFLINE-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'sync_invoice: client_temp_id must be OFFLINE-<lowercase uuid>' using errcode = '22023';
  end if;
  -- jsonb text is canonical (key order, whitespace), so only real edits change the hash.
  v_fingerprint := encode(sha256(convert_to(p_payload::text, 'UTF8')), 'hex');

  -- 2. Serialize concurrent syncs of the SAME bill (double-tap, retry storm after a
  --    crash). Transaction-scoped: released automatically on commit, rollback or disconnect.
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

  -- 4. Dates are IST calendar dates in ISO form, at most 31 days old. Late syncs after an
  --    outage fit; a PC whose clock reset after a power cut (or a typed wrong year) does not
  --    get to number a bill inside a closed GST period.
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

  -- 5. Precision: billing-math.ts sends exact decimals and the DB must never round them
  --    (a numeric(14,2) column would silently round 100.005 to 100.01).
  foreach v_field in array array['subtotal', 'packing_charge', 'delivery_charge', 'cgst', 'sgst',
                                 'igst', 'round_off', 'grand_total', 'amount_paid'] loop
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
           as x(total_weight_kg numeric, unit_rate numeric, tax_rate_percent numeric, line_total numeric)
    where x.line_total       <> round(x.line_total, 2)
       or x.unit_rate        <> round(x.unit_rate, 6)
       or x.total_weight_kg  <> round(x.total_weight_kg, 6)
       or x.tax_rate_percent <> round(x.tax_rate_percent, 2)
  ) then
    raise exception 'sync_invoice: a line item has more decimal places than its column allows'
      using errcode = '22023';
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

  -- 6. Cross-row identities a CHECK cannot express. The GST band verifies billing-math.ts
  --    without redoing it: the tax must match the declared line rates (and, for taxable
  --    charges, lie between the lowest and highest of them) within one paisa per line.
  select count(*) as n, sum(x.line_total) as total, sum(x.line_total * x.tax_rate_percent / 100) as tax,
         min(x.tax_rate_percent) as min_rate, max(x.tax_rate_percent) as max_rate
    into v_lines
    from jsonb_to_recordset(v_items) as x(line_total numeric, tax_rate_percent numeric);

  v_subtotal := (p_payload ->> 'subtotal')::numeric;
  if v_lines.total is distinct from v_subtotal then
    raise exception 'sync_invoice: subtotal % does not equal the sum of line totals %', v_subtotal, v_lines.total
      using errcode = '23514';
  end if;

  v_charges := case when coalesce((p_payload ->> 'delivery_taxable')::boolean, true)
                    then coalesce((p_payload ->> 'packing_charge')::numeric, 0)
                       + coalesce((p_payload ->> 'delivery_charge')::numeric, 0)
                    else 0 end;
  v_tax := coalesce((p_payload ->> 'cgst')::numeric, 0)
         + coalesce((p_payload ->> 'sgst')::numeric, 0)
         + coalesce((p_payload ->> 'igst')::numeric, 0);
  v_tolerance := 0.01 * (v_lines.n + 1);
  if v_tax < v_lines.tax + v_charges * v_lines.min_rate / 100 - v_tolerance
     or v_tax > v_lines.tax + v_charges * v_lines.max_rate / 100 + v_tolerance then
    raise exception 'sync_invoice: GST of % does not match the line rates', v_tax using errcode = '23514';
  end if;

  -- 7. Customer, snapshotted from the DB (never trusted from the device).
  select c.* into v_customer from public.customers as c where c.id = (p_payload ->> 'customer_id')::uuid;
  if not found then
    raise exception 'sync_invoice: customer % not found', p_payload ->> 'customer_id' using errcode = '23503';
  end if;
  -- GST Rule 46(e): from Rs 50,000 an unregistered buyer's address is mandatory too.
  if v_customer.address is null and v_subtotal + v_charges >= 50000 then
    raise exception 'sync_invoice: add an address for % before billing Rs 50,000 or more', v_customer.name
      using errcode = '22023';
  end if;

  -- 8. Allocate the gapless invoice number and write the invoice. CHECK constraints
  --    verify the GST regime, CGST = SGST and the grand-total identity.
  v_fiscal_year := private.fiscal_year_of(v_invoice_date);
  v_invoice_seq := private.next_document_seq('INV', v_fiscal_year);

  insert into public.invoices as inv (
    invoice_no, fiscal_year, invoice_seq, client_temp_id, sync_fingerprint, bill_type, customer_id,
    invoice_date, place_of_supply, customer_snapshot,
    subtotal, packing_charge, delivery_charge, delivery_taxable,
    cgst, sgst, igst, round_off, grand_total,
    amount_paid, payment_status, due_date, notes
  ) values (
    private.format_document_no('INV', v_fiscal_year, v_invoice_seq), v_fiscal_year, v_invoice_seq,
    v_client_temp_id, v_fingerprint, (p_payload ->> 'bill_type')::public.bill_type, v_customer.id,
    v_invoice_date, v_customer.state_code,
    jsonb_build_object('name', v_customer.name, 'gstin', v_customer.gstin, 'address', v_customer.address,
                       'state_code', v_customer.state_code, 'phone', v_customer.phone),
    v_subtotal,
    coalesce((p_payload ->> 'packing_charge')::numeric, 0),
    coalesce((p_payload ->> 'delivery_charge')::numeric, 0),
    coalesce((p_payload ->> 'delivery_taxable')::boolean, true),
    coalesce((p_payload ->> 'cgst')::numeric, 0),
    coalesce((p_payload ->> 'sgst')::numeric, 0),
    coalesce((p_payload ->> 'igst')::numeric, 0),
    coalesce((p_payload ->> 'round_off')::numeric, 0),
    (p_payload ->> 'grand_total')::numeric,
    coalesce((p_payload ->> 'amount_paid')::numeric, 0),
    coalesce((p_payload ->> 'payment_status')::public.payment_status, 'unpaid'),
    (p_payload ->> 'due_date')::date,
    nullif(btrim(p_payload ->> 'notes'), '')
  )
  returning inv.id, inv.invoice_no into v_invoice_id, v_invoice_no;

  insert into public.invoice_items (
    invoice_id, line_no, stud_item_id, description, hsn_sac, qty_pieces, total_weight_kg,
    billing_unit, unit_rate, tax_rate_percent, line_total
  )
  select v_invoice_id, x.line_no, x.stud_item_id, x.description, x.hsn_sac, x.qty_pieces, x.total_weight_kg,
         x.billing_unit, x.unit_rate, x.tax_rate_percent, x.line_total
  from jsonb_to_recordset(v_items) as x(
         line_no smallint, stud_item_id uuid, description text, hsn_sac text, qty_pieces integer,
         total_weight_kg numeric, billing_unit public.billing_unit, unit_rate numeric,
         tax_rate_percent numeric, line_total numeric);

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
  returning d.dc_no into v_dc_no;

  return query select v_invoice_id, v_invoice_no, v_dc_no, false;
end;
$$;

comment on function public.sync_invoice(jsonb) is
  'Atomically creates invoice + items + delivery challan with gapless numbers; idempotent on client_temp_id.';


-- =============================================================================
-- 7. Views
-- =============================================================================
-- security_invoker: the caller's RLS applies (a default view would run as its owner
-- and leak every row past RLS).
create view public.latest_metal_rates
with (security_invoker = true)
as
select distinct on (mr.material_grade)
       mr.material_grade,
       mr.rate_per_kg,
       mr.previous_rate_per_kg,
       mr.change_delta,
       mr.source,
       mr.recorded_at
from public.metal_rates as mr
order by mr.material_grade, mr.recorded_at desc, mr.id desc;


-- =============================================================================
-- 8. Row level security
-- =============================================================================
-- Everything is gated on the allowlist. Destructive or admin actions need the owner.
-- No INSERT/DELETE policies on invoices, invoice_items or deliveries: those rows are
-- created only by sync_invoice() and never deleted.
alter table public.customers           enable row level security;
alter table public.stud_items          enable row level security;
alter table public.metal_rates         enable row level security;
alter table public.invoices            enable row level security;
alter table public.invoice_items       enable row level security;
alter table public.deliveries          enable row level security;
alter table public.job_work_ledger     enable row level security;
alter table public.alert_rules         enable row level security;
alter table private.app_users          enable row level security;   -- no policies: no API access
alter table private.document_sequences enable row level security;   -- no policies: no API access
alter table private.audit_log          enable row level security;   -- no policies: no API access

-- customers
create policy customers_select on public.customers for select to authenticated
  using ((select private.is_staff()));
create policy customers_insert on public.customers for insert to authenticated
  with check ((select private.is_staff()));
create policy customers_update on public.customers for update to authenticated
  using ((select private.is_staff())) with check ((select private.is_staff()));
create policy customers_delete on public.customers for delete to authenticated
  using ((select private.is_owner()));

-- stud_items
create policy stud_items_select on public.stud_items for select to authenticated
  using ((select private.is_staff()));
create policy stud_items_insert on public.stud_items for insert to authenticated
  with check ((select private.is_staff()));
create policy stud_items_update on public.stud_items for update to authenticated
  using ((select private.is_staff())) with check ((select private.is_staff()));
create policy stud_items_delete on public.stud_items for delete to authenticated
  using ((select private.is_owner()));

-- metal_rates: anyone on staff records today's rate; corrections are owner-only.
create policy metal_rates_select on public.metal_rates for select to authenticated
  using ((select private.is_staff()));
create policy metal_rates_insert on public.metal_rates for insert to authenticated
  with check ((select private.is_staff()));
create policy metal_rates_update on public.metal_rates for update to authenticated
  using ((select private.is_owner())) with check ((select private.is_owner()));
create policy metal_rates_delete on public.metal_rates for delete to authenticated
  using ((select private.is_owner()));

-- invoices: read + update (payments, cancellation, archive URL); field rules live in
-- the invoices_guard_issued trigger.
create policy invoices_select on public.invoices for select to authenticated
  using ((select private.is_staff()));
create policy invoices_update on public.invoices for update to authenticated
  using ((select private.is_staff())) with check ((select private.is_staff()));

-- invoice_items: read-only.
create policy invoice_items_select on public.invoice_items for select to authenticated
  using ((select private.is_staff()));

-- deliveries: read + update logistics/status.
create policy deliveries_select on public.deliveries for select to authenticated
  using ((select private.is_staff()));
create policy deliveries_update on public.deliveries for update to authenticated
  using ((select private.is_staff())) with check ((select private.is_staff()));

-- job_work_ledger
create policy job_work_ledger_select on public.job_work_ledger for select to authenticated
  using ((select private.is_staff()));
create policy job_work_ledger_insert on public.job_work_ledger for insert to authenticated
  with check ((select private.is_staff()));
create policy job_work_ledger_update on public.job_work_ledger for update to authenticated
  using ((select private.is_staff())) with check ((select private.is_staff()));
create policy job_work_ledger_delete on public.job_work_ledger for delete to authenticated
  using ((select private.is_owner()));

-- alert_rules: who gets Telegram alerts is the owner's call.
create policy alert_rules_select on public.alert_rules for select to authenticated
  using ((select private.is_staff()));
create policy alert_rules_insert on public.alert_rules for insert to authenticated
  with check ((select private.is_owner()));
create policy alert_rules_update on public.alert_rules for update to authenticated
  using ((select private.is_owner())) with check ((select private.is_owner()));
create policy alert_rules_delete on public.alert_rules for delete to authenticated
  using ((select private.is_owner()));


-- =============================================================================
-- 9. Privileges
-- =============================================================================
-- Never rely on Supabase's default privileges: older projects granted everything on new
-- public objects to the API roles, and since 30 Oct 2026 no project grants anything
-- (supabase discussion #45329). Strip and re-grant so both give the same result:
-- privileges decide WHICH operations exist, RLS decides WHICH rows.
revoke all on table public.customers, public.stud_items, public.metal_rates, public.invoices,
                    public.invoice_items, public.deliveries, public.job_work_ledger,
                    public.alert_rules, public.latest_metal_rates
  from anon, authenticated, service_role;

grant select, insert, update, delete on table public.customers, public.stud_items, public.metal_rates,
                                              public.job_work_ledger, public.alert_rules
  to authenticated;
grant select, update on table public.invoices, public.deliveries to authenticated;
grant select on table public.invoice_items, public.latest_metal_rates to authenticated;

-- service_role (secret key: cron, Drive archive) bypasses RLS, so grants are its only limit:
-- read everything, record rates, attach Drive links.
grant select on table public.customers, public.stud_items, public.metal_rates, public.invoices,
                      public.invoice_items, public.deliveries, public.job_work_ledger,
                      public.alert_rules, public.latest_metal_rates
  to service_role;
grant insert on table public.metal_rates to service_role;
grant update (pdf_drive_url) on table public.invoices to service_role;
grant update (proof_drive_url) on table public.deliveries to service_role;

revoke all on table private.app_users, private.document_sequences, private.audit_log
  from public, anon, authenticated, service_role;
grant select, insert, update, delete on table private.app_users to service_role;
grant select on table private.document_sequences, private.audit_log to service_role;

-- Functions are executable by PUBLIC by default. Lock all private helpers down, then
-- grant back only those evaluated as the caller (policies, CHECKs, the Data API gate).
revoke all on all functions in schema private from public;
grant execute on function private.is_staff(),
                          private.is_owner(),
                          private.check_request(),
                          private.is_valid_gstin(text),
                          private.fiscal_year_start(date),
                          private.fiscal_year_of(date),
                          private.format_document_no(text, text, integer)
  to authenticated, service_role;

revoke all on function public.sync_invoice(jsonb) from public, anon, service_role;
grant execute on function public.sync_invoice(jsonb) to authenticated;


-- =============================================================================
-- 10. Data API gate
-- =============================================================================
-- Defence in depth, so a project that refuses it still migrates (with a warning).
do $$
begin
  alter role authenticator set pgrst.db_pre_request = 'private.check_request';
exception
  when undefined_object or insufficient_privilege then
    raise warning 'Data API gate not registered: %', sqlerrm
      using hint = 'Run as an admin: alter role authenticator set pgrst.db_pre_request = ''private.check_request''; notify pgrst, ''reload config'';';
end;
$$;
notify pgrst, 'reload config';
