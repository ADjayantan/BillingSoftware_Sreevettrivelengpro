-- =============================================================================
-- StudFlow AI · 008_home.sql
-- -----------------------------------------------------------------------------
-- specs/new-look.md: what Home, the list of bills, "Money received", "Send goods" and the customers read.
-- Nothing is stored and nothing is changed: every figure is added up from issued rows at the
-- moment it is asked for, so it cannot disagree with the bills. The functions run as the
-- caller (RLS applies); the check in front only makes the refusal plain. Amounts leave as
-- text: a JSON number would be read as floating point.
-- Tables, RLS, grants on tables and the edit log stay as they are, and the app version before
-- this one keeps working with it.
-- =============================================================================

create index invoices_date_idx     on public.invoices (invoice_date desc, invoice_seq desc);
create index payments_received_idx on public.payments (received_on desc, created_at desc);


-- =============================================================================
-- 1. Bills, found by number, customer or P.O.
-- =============================================================================
-- p_show: all, open (money to collect, the late ones too), overdue, paid, cancelled.
-- "counts" are of everything found, "shown" adds up the chosen kind without cancelled bills.
create function public.find_bills(p_q text, p_show text, p_month date, p_customer uuid, p_today date, p_skip integer, p_take integer)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_like   text := '%' || replace(replace(replace(btrim(coalesce(p_q, '')), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  v_by_due boolean := p_show in ('open', 'overdue');
  v_answer jsonb;
begin
  if not private.is_staff() then
    raise exception 'find_bills: caller is not an active StudFlow user' using errcode = '42501';
  end if;
  if p_show is null or p_show not in ('all', 'open', 'overdue', 'paid', 'cancelled') or p_today is null
     or p_skip is null or p_skip < 0 or p_take is null or p_take not between 1 and 100 then
    raise exception 'find_bills: not a list of these books' using errcode = '22023';
  end if;

  with found as (
    select i.id, i.invoice_no, i.invoice_seq, i.bill_type, i.invoice_date, i.due_date, i.grand_total, i.amount_paid,
           i.payment_status, i.po_no, i.customer_snapshot, i.supplier_snapshot,
           i.cancelled_at is not null as cancelled,
           i.cancelled_at is null and i.payment_status = 'paid' as paid,
           i.cancelled_at is null and i.payment_status <> 'paid' as open,
           i.cancelled_at is null and i.payment_status <> 'paid' and i.due_date < p_today as overdue
      from public.invoices as i
     where (p_customer is null or i.customer_id = p_customer)
       and (p_month is null or (i.invoice_date >= p_month and i.invoice_date < (p_month + interval '1 month')::date))
       and (i.invoice_no ilike v_like or i.customer_snapshot ->> 'name' ilike v_like or i.po_no ilike v_like)
  ), chosen as (
    select f.* from found as f
     where case p_show when 'open' then f.open when 'overdue' then f.overdue when 'paid' then f.paid when 'cancelled' then f.cancelled else true end
  ), page as (
    select c.*, row_number() over (order by case when v_by_due then c.due_date end, c.invoice_date desc, c.invoice_seq desc) as place
      from chosen as c
     order by place
     offset p_skip limit p_take
  )
  select jsonb_build_object(
    'counts', (select jsonb_build_object('all', count(*), 'open', count(*) filter (where f.open), 'overdue', count(*) filter (where f.overdue),
                                         'paid', count(*) filter (where f.paid), 'cancelled', count(*) filter (where f.cancelled)) from found as f),
    'shown', (select jsonb_build_object('bills', count(*),
                                        'total', coalesce(sum(c.grand_total), 0)::numeric(16,2)::text,
                                        'balance', coalesce(sum(c.grand_total - c.amount_paid) filter (where c.open), 0)::numeric(16,2)::text)
                from chosen as c where not c.cancelled),
    'rows', (select coalesce(jsonb_agg(jsonb_build_object(
               'id', p.id, 'invoice_no', p.invoice_no, 'bill_type', p.bill_type, 'invoice_date', p.invoice_date, 'due_date', p.due_date,
               'grand_total', p.grand_total::text, 'amount_paid', p.amount_paid::text, 'payment_status', p.payment_status, 'cancelled', p.cancelled,
               'po_no', p.po_no, 'customer', p.customer_snapshot ->> 'name', 'phone', p.customer_snapshot ->> 'phone',
               'supplier', p.supplier_snapshot ->> 'legal_name') order by p.place), '[]'::jsonb) from page as p))
    into v_answer;
  return v_answer;
end;
$$;


-- =============================================================================
-- 2. The figures of Home
-- =============================================================================
create function public.home_figures(p_today date)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_month  date;
  v_answer jsonb;
begin
  if not private.is_staff() then
    raise exception 'home_figures: caller is not an active StudFlow user' using errcode = '42501';
  end if;
  if p_today is null or p_today not between date '2020-01-01' and date '2100-12-31' then
    raise exception 'home_figures: not a day of these books' using errcode = '22023';
  end if;
  v_month := p_today - (extract(day from p_today)::integer - 1);

  with months as (
    select (v_month - make_interval(months => n))::date as month from generate_series(0, 5) as n
  ), sold as (
    select i.invoice_date, i.grand_total
      from public.invoices as i
     where i.cancelled_at is null
       and i.invoice_date >= (v_month - interval '5 months')::date and i.invoice_date < (v_month + interval '1 month')::date
  ), owed as (
    select i.due_date, i.grand_total - i.amount_paid as balance
      from public.invoices as i
     where i.cancelled_at is null and i.payment_status <> 'paid'
  )
  select jsonb_build_object(
    'today', (select jsonb_build_object('bills', count(*), 'total', coalesce(sum(s.grand_total), 0)::numeric(16,2)::text) from sold as s where s.invoice_date = p_today),
    'month', (select jsonb_build_object('bills', count(*), 'total', coalesce(sum(s.grand_total), 0)::numeric(16,2)::text) from sold as s where s.invoice_date >= v_month),
    'last_month', (select jsonb_build_object('bills', count(*), 'total', coalesce(sum(s.grand_total), 0)::numeric(16,2)::text)
                     from sold as s where s.invoice_date >= (v_month - interval '1 month')::date and s.invoice_date < v_month),
    'to_collect', (select jsonb_build_object('bills', count(*), 'total', coalesce(sum(o.balance), 0)::numeric(16,2)::text) from owed as o),
    'overdue', (select jsonb_build_object('bills', count(*), 'total', coalesce(sum(o.balance), 0)::numeric(16,2)::text, 'oldest', min(o.due_date))
                  from owed as o where o.due_date < p_today),
    'months', (select jsonb_agg(jsonb_build_object('month', m.month, 'total', t.total) order by m.month)
                 from months as m
                 cross join lateral (select coalesce(sum(s.grand_total), 0)::numeric(16,2)::text as total from sold as s
                                      where s.invoice_date >= m.month and s.invoice_date < (m.month + interval '1 month')::date) as t),
    'to_send', (select count(*) from public.deliveries as d join public.invoices as i on i.id = d.invoice_id
                 where d.status in ('pending', 'packed') and i.cancelled_at is null),
    'not_on_drive', (select count(*) from public.invoices as i where i.drive_sync_pending))
    into v_answer;
  return v_answer;
end;
$$;


-- =============================================================================
-- 3. Money that came in
-- =============================================================================
create function public.receipts_found(p_q text, p_month date, p_skip integer, p_take integer)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_like   text := '%' || replace(replace(replace(btrim(coalesce(p_q, '')), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  v_answer jsonb;
begin
  if not private.is_staff() then
    raise exception 'receipts_found: caller is not an active StudFlow user' using errcode = '42501';
  end if;
  if p_skip is null or p_skip < 0 or p_take is null or p_take not between 1 and 100 then
    raise exception 'receipts_found: not a list of these books' using errcode = '22023';
  end if;

  with found as (
    select r.id, r.invoice_id, r.amount, r.received_on, r.mode, r.reference, r.settles_invoice, r.voided_at is not null as voided, r.created_at,
           i.invoice_no, i.customer_snapshot ->> 'name' as customer
      from public.payments as r
      join public.invoices as i on i.id = r.invoice_id
     where (p_month is null or (r.received_on >= p_month and r.received_on < (p_month + interval '1 month')::date))
       and (i.invoice_no ilike v_like or i.customer_snapshot ->> 'name' ilike v_like or r.reference ilike v_like)
  ), page as (
    select f.*, row_number() over (order by f.received_on desc, f.created_at desc, f.id) as place
      from found as f
     order by place
     offset p_skip limit p_take
  )
  select jsonb_build_object(
    'receipts', (select count(*) from found as f where not f.voided),
    'total', (select coalesce(sum(f.amount), 0)::numeric(16,2)::text from found as f where not f.voided),
    'rows', (select coalesce(jsonb_agg(jsonb_build_object(
               'id', p.id, 'invoice_id', p.invoice_id, 'invoice_no', p.invoice_no, 'customer', p.customer, 'amount', p.amount::text,
               'received_on', p.received_on, 'mode', p.mode, 'reference', p.reference, 'settles_invoice', p.settles_invoice, 'voided', p.voided)
               order by p.place), '[]'::jsonb) from page as p))
    into v_answer;
  return v_answer;
end;
$$;


-- =============================================================================
-- 4. Goods that did not arrive yet
-- =============================================================================
create function public.goods_to_send()
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if not private.is_staff() then
    raise exception 'goods_to_send: caller is not an active StudFlow user' using errcode = '42501';
  end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', g.id, 'dc_no', g.dc_no, 'dc_date', g.dc_date, 'status', g.status, 'transport_mode', g.transport_mode, 'vehicle_no', g.vehicle_no,
             'driver_name', g.driver_name, 'driver_phone', g.driver_phone, 'lr_number', g.lr_number, 'delivery_address', g.delivery_address,
             'invoice_id', g.invoice_id, 'invoice_no', g.invoice_no, 'customer', g.customer, 'items', g.items)
             order by g.dc_date, g.dc_seq), '[]'::jsonb)
      from (
        select d.*, i.invoice_no, i.customer_snapshot ->> 'name' as customer,
               -- The charges of a bill are lines of it, but no goods: the challan leaves them out too.
               (select count(*) from public.invoice_items as t
                 where t.invoice_id = i.id
                   and t.description not in ('Packing charges', 'Delivery charges', 'Delivery, recovered at cost')) as items
          from public.deliveries as d
          join public.invoices as i on i.id = d.invoice_id
         where d.status <> 'delivered' and i.cancelled_at is null
         order by d.dc_date, d.dc_seq
         limit 200) as g);
end;
$$;

-- =============================================================================
-- 5. What each customer owes
-- =============================================================================
-- balance = what was owed before this software (opening_balance, typed in by hand; minus is what we
-- owe them) + what is left on bills that are not settled. "overdue" is the part of those bills that is
-- past its due date. p_sort: name, or owes (who owes most first). The sums on top are of everything
-- found; what we owe somebody is not taken off what the others owe.
create function public.customer_balances(p_q text, p_sort text, p_today date, p_skip integer, p_take integer)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_like   text := '%' || replace(replace(replace(btrim(coalesce(p_q, '')), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  v_answer jsonb;
begin
  if not private.is_staff() then
    raise exception 'customer_balances: caller is not an active StudFlow user' using errcode = '42501';
  end if;
  if p_sort is null or p_sort not in ('name', 'owes') or p_today is null
     or p_skip is null or p_skip < 0 or p_take is null or p_take not between 1 and 100 then
    raise exception 'customer_balances: not a list of these books' using errcode = '22023';
  end if;

  with owed as (
    select i.customer_id, count(*) as bills, sum(i.grand_total - i.amount_paid) as on_bills,
           coalesce(sum(i.grand_total - i.amount_paid) filter (where i.due_date < p_today), 0) as overdue,
           min(i.due_date) filter (where i.due_date < p_today) as oldest
      from public.invoices as i
     where i.cancelled_at is null and i.payment_status <> 'paid'
     group by i.customer_id
  ), found as (
    select c.id, c.name, c.gstin, c.phone, c.state_code, c.is_sez, c.credit_days, c.address, c.opening_balance, c.is_active,
           coalesce(o.bills, 0) as bills, coalesce(o.on_bills, 0) as on_bills, coalesce(o.overdue, 0) as overdue, o.oldest,
           c.opening_balance + coalesce(o.on_bills, 0) as balance
      from public.customers as c
      left join owed as o on o.customer_id = c.id
     where c.search_text ilike v_like
  ), page as (
    select f.*, row_number() over (order by case when p_sort = 'owes' then f.balance end desc, f.name, f.id) as place
      from found as f
     order by place
     offset p_skip limit p_take
  )
  select jsonb_build_object(
    'customers', (select count(*) from found),
    'owing', (select count(*) filter (where f.balance > 0) from found as f),
    'balance', (select coalesce(sum(f.balance) filter (where f.balance > 0), 0)::numeric(16,2)::text from found as f),
    'overdue', (select coalesce(sum(f.overdue), 0)::numeric(16,2)::text from found as f),
    'rows', (select coalesce(jsonb_agg(jsonb_build_object(
               'id', p.id, 'name', p.name, 'gstin', p.gstin, 'phone', p.phone, 'state_code', p.state_code, 'is_sez', p.is_sez,
               'credit_days', p.credit_days, 'address', p.address, 'opening_balance', p.opening_balance::text, 'is_active', p.is_active,
               'bills', p.bills, 'on_bills', p.on_bills::numeric(16,2)::text, 'overdue', p.overdue::numeric(16,2)::text,
               'oldest', p.oldest, 'balance', p.balance::numeric(16,2)::text) order by p.place), '[]'::jsonb) from page as p))
    into v_answer;
  return v_answer;
end;
$$;

revoke all on function public.find_bills(text, text, date, uuid, date, integer, integer), public.home_figures(date),
                       public.receipts_found(text, date, integer, integer), public.goods_to_send(),
                       public.customer_balances(text, text, date, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.find_bills(text, text, date, uuid, date, integer, integer), public.home_figures(date),
                          public.receipts_found(text, date, integer, integer), public.goods_to_send(),
                          public.customer_balances(text, text, date, integer, integer)
  to authenticated;

notify pgrst, 'reload schema';
