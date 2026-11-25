-- =============================================================================
-- StudFlow AI · 005_products.sql
-- -----------------------------------------------------------------------------
-- stud_items becomes the company's product list (specs/company-products.md): an ID from the
-- database for every product, a name, and a size only for studs. Its rows, RLS, grants, edit
-- log and the links from bills stay as they are, and the app version before this one keeps
-- working with it.
-- =============================================================================


-- =============================================================================
-- 1. ID, name, optional size
-- =============================================================================
-- Rows that are already there are numbered as they come. An identity column cannot be typed
-- (GENERATED ALWAYS), and its counter never goes back: no ID is given twice.
alter table public.stud_items
  add column product_no integer generated always as identity,
  add column name       text check (char_length(btrim(name)) between 1 and 120),
  add constraint stud_items_product_no_key unique (product_no),
  alter column diameter_mm    drop not null,
  alter column length_mm      drop not null,
  alter column thread_type    drop not null,
  alter column material_grade drop not null,
  alter column unit_weight_kg drop not null,
  -- HSN and GST % are typed by a person, never assumed.
  alter column hsn_sac          drop default,
  alter column gst_rate_percent drop default;

-- The counter belongs to the column: inserting needs no right on it, and nobody gets one.
revoke all on sequence public.stud_items_product_no_seq from public, anon, authenticated, service_role;

comment on column public.stud_items.product_no is
  'Product ID, shown as P0007. Given by the database; never typed, changed or used again.';
comment on column public.stud_items.name is
  'What the bill says. A stud may go without: its code and size say it.';


-- =============================================================================
-- 2. Own code: the product ID unless somebody gives one
-- =============================================================================
-- 7 -> 'P0007', 12345 -> 'P12345'. greatest() matters: lpad() TRUNCATES.
create function private.product_code(p_no integer)
returns text
language sql
immutable
strict
parallel safe
set search_path = ''
as $$
  select 'P' || lpad(p_no::text, greatest(4, length(p_no::text)), '0')
$$;
-- Runs as whoever saves a product (trigger and CHECK below).
revoke all on function private.product_code(integer) from public;
grant execute on function private.product_code(integer) to authenticated;

create function private.stud_items_identify()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    new.product_no := old.product_no;   -- not even `set product_no = default`
  end if;
  if btrim(coalesce(new.sku_code, '')) = '' then
    new.sku_code := private.product_code(new.product_no);
  end if;
  return new;
end;
$$;
revoke all on function private.stud_items_identify() from public;

create trigger stud_items_identify before insert or update on public.stud_items for each row execute function private.stud_items_identify();


-- =============================================================================
-- 3. What a product must have
-- =============================================================================
alter table public.stud_items
  -- P0007 is product 7 and nothing else: an own code can neither block nor imitate an ID.
  add constraint stud_items_own_code check (sku_code !~ '^P[0-9]+$' or sku_code = private.product_code(product_no)),
  -- A stud has its whole size and a weight. Anything else has a name, and a weight only if
  -- somebody weighed it. (The formula CHECK of 001 still holds a stud to its dimensions.)
  add constraint stud_items_kind check (
    case num_nonnulls(diameter_mm, length_mm, thread_type, material_grade)
      when 4 then unit_weight_kg is not null
      when 0 then name is not null and unit_weight_is_manual = (unit_weight_kg is not null)
      else false
    end);


-- =============================================================================
-- 4. Finding: one text, kept by the database, searched the same way everywhere
-- =============================================================================
-- 'HEX NUT M12 GI P0002', 'MS-M8-45-FT M8X45 MS'
alter table public.stud_items
  add column search_text text generated always as (
    upper(coalesce(name || ' ', '') || sku_code
      || coalesce(' M' || trim_scale(diameter_mm)::text || 'X' || trim_scale(length_mm)::text || ' ' || material_grade, ''))
  ) stored;

notify pgrst, 'reload schema';
