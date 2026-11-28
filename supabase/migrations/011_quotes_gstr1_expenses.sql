-- =============================================================================
-- StudFlow AI · 011_quotes_gstr1_expenses.sql
-- -----------------------------------------------------------------------------
-- 1. Quotations (public.quotes) that convert to a tax invoice in one click.
-- 2. Suppliers (public.suppliers) and Shop / Raw-Material Expenses (public.expenses).
-- =============================================================================

-- 1. Quotations ---------------------------------------------------------------
create table public.quotes (
  id                   uuid primary key default gen_random_uuid(),
  quote_no             integer generated always as identity unique,
  bill_type            text not null default 'supply' check (bill_type in ('supply', 'job_work')),
  customer_id          uuid not null references public.customers(id),
  quote_date           date not null default private.today_ist() check (quote_date between date '2020-01-01' and date '2100-12-31'),
  valid_until          date not null check (valid_until >= quote_date and valid_until <= date '2100-12-31'),
  place_of_supply      text not null check (place_of_supply ~ '^[0-9]{2}$'),
  is_sez               boolean not null default false,
  customer_snapshot    jsonb not null check (jsonb_typeof(customer_snapshot) = 'object'),
  lines                jsonb not null check (jsonb_typeof(lines) = 'array' and jsonb_array_length(lines) between 1 and 100),
  packing_charge       numeric(14,2) not null default 0 check (packing_charge >= 0 and packing_charge < 'Infinity'),
  delivery_charge      numeric(14,2) not null default 0 check (delivery_charge >= 0 and delivery_charge < 'Infinity'),
  freight_paid_by      text not null default 'seller' check (freight_paid_by in ('seller', 'buyer_to_pay')),
  delivery_taxable     boolean not null default true,
  charges_gst_rate     numeric(5,2) check (charges_gst_rate is null or (charges_gst_rate in (0, 5, 12, 18, 28) and charges_gst_rate < 'Infinity')),
  subtotal             numeric(14,2) not null check (subtotal >= 0 and subtotal < 'Infinity'),
  cgst                 numeric(14,2) not null default 0 check (cgst >= 0 and cgst < 'Infinity'),
  sgst                 numeric(14,2) not null default 0 check (sgst >= 0 and sgst < 'Infinity'),
  igst                 numeric(14,2) not null default 0 check (igst >= 0 and igst < 'Infinity'),
  round_off            numeric(4,2) not null default 0 check (round_off > -1 and round_off < 1),
  grand_total          numeric(14,2) not null check (grand_total > 0 and grand_total < 'Infinity'),
  notes                text check (notes is null or char_length(notes) <= 1000),
  status               text not null default 'open' check (status in ('open', 'converted', 'cancelled')),
  converted_invoice_id uuid references public.invoices(id),
  converted_invoice_no text check (converted_invoice_no is null or char_length(converted_invoice_no) <= 20),
  created_by           uuid references auth.users(id),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index quotes_date_idx on public.quotes (quote_date desc, quote_no desc);
create index quotes_customer_idx on public.quotes (customer_id);

-- 2. Suppliers ----------------------------------------------------------------
create table public.suppliers (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (btrim(name) <> '' and char_length(name) <= 160),
  gstin      text check (gstin is null or private.is_valid_gstin(gstin)),
  phone      text check (phone is null or phone ~ '^[0-9]{10}$'),
  category   text not null default 'raw_material' check (category in ('raw_material', 'tools', 'transport', 'power', 'other')),
  notes      text check (notes is null or char_length(notes) <= 500),
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index suppliers_name_idx on public.suppliers (name);

-- 3. Shop & Raw-Material Expenses ---------------------------------------------
create table public.expenses (
  id             uuid primary key default gen_random_uuid(),
  expense_date   date not null default private.today_ist() check (expense_date between date '2020-01-01' and date '2100-12-31'),
  category       text not null check (category in ('raw_material', 'tools', 'electricity', 'transport', 'wages', 'maintenance', 'office', 'other')),
  supplier_id    uuid references public.suppliers(id),
  supplier_name  text check (supplier_name is null or char_length(supplier_name) <= 160),
  bill_no        text check (bill_no is null or char_length(bill_no) <= 60),
  description    text not null check (btrim(description) <> '' and char_length(description) <= 300),
  material_grade text check (material_grade is null or char_length(material_grade) <= 40),
  weight_kg      numeric(12,3) check (weight_kg is null or (weight_kg > 0 and weight_kg < 'Infinity')),
  taxable_amount numeric(14,2) not null check (taxable_amount > 0 and taxable_amount < 'Infinity'),
  gst_amount     numeric(14,2) not null default 0 check (gst_amount >= 0 and gst_amount < 'Infinity'),
  total_amount   numeric(14,2) not null check (total_amount > 0 and total_amount < 'Infinity' and total_amount = taxable_amount + gst_amount),
  payment_mode   text not null default 'bank_transfer' check (payment_mode in ('cash', 'upi', 'bank_transfer', 'cheque', 'credit')),
  payment_status text not null default 'paid' check (payment_status in ('paid', 'unpaid')),
  created_by     uuid references auth.users(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index expenses_date_idx on public.expenses (expense_date desc, created_at desc);

-- 4. Triggers (stamps & edit log) ---------------------------------------------
create trigger quotes_stamp    before insert or update on public.quotes    for each row execute function private.stamp_row();
create trigger suppliers_stamp before insert or update on public.suppliers for each row execute function private.stamp_row();
create trigger expenses_stamp  before insert or update on public.expenses  for each row execute function private.stamp_row();

create trigger quotes_stamp_creator   before insert or update on public.quotes   for each row execute function private.stamp_creator();
create trigger expenses_stamp_creator before insert or update on public.expenses for each row execute function private.stamp_creator();

create trigger quotes_log    after update or delete on public.quotes    for each row execute function private.log_change();
create trigger suppliers_log after update or delete on public.suppliers for each row execute function private.log_change();
create trigger expenses_log  after update or delete on public.expenses  for each row execute function private.log_change();

-- 5. RLS & Policies -----------------------------------------------------------
alter table public.quotes    enable row level security;
alter table public.suppliers enable row level security;
alter table public.expenses  enable row level security;

create policy quotes_select on public.quotes for select to authenticated using ((select private.is_staff()));
create policy quotes_insert on public.quotes for insert to authenticated with check ((select private.is_staff()));
create policy quotes_update on public.quotes for update to authenticated using ((select private.is_staff())) with check ((select private.is_staff()));
create policy quotes_delete on public.quotes for delete to authenticated using ((select private.is_owner()));

create policy suppliers_select on public.suppliers for select to authenticated using ((select private.is_staff()));
create policy suppliers_insert on public.suppliers for insert to authenticated with check ((select private.is_staff()));
create policy suppliers_update on public.suppliers for update to authenticated using ((select private.is_staff())) with check ((select private.is_staff()));
create policy suppliers_delete on public.suppliers for delete to authenticated using ((select private.is_owner()));

create policy expenses_select on public.expenses for select to authenticated using ((select private.is_staff()));
create policy expenses_insert on public.expenses for insert to authenticated with check ((select private.is_staff()));
create policy expenses_update on public.expenses for update to authenticated using ((select private.is_staff())) with check ((select private.is_staff()));
create policy expenses_delete on public.expenses for delete to authenticated using ((select private.is_owner()));

-- 6. Privileges ---------------------------------------------------------------
revoke all on table public.quotes, public.suppliers, public.expenses from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.quotes, public.suppliers, public.expenses to authenticated;
grant select on table public.quotes, public.suppliers, public.expenses to service_role;
grant usage, select on sequence public.quotes_quote_no_seq to authenticated, service_role;

notify pgrst, 'reload schema';
