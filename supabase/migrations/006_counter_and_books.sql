-- =============================================================================
-- StudFlow AI · 006_counter_and_books.sql
-- -----------------------------------------------------------------------------
-- specs/counter-and-books.md
--   1 customers found by name, phone or GSTIN
--   2 invoice lines that remember the grade and size they were billed with
--   3 the outbox behind the monthly Excel books: what changed, and one worker per month
-- Existing rows, RLS, the billing RPCs and issued documents stay as they are.
-- =============================================================================


-- =============================================================================
-- 1. Customers
-- =============================================================================
-- A customer made at the counter gets its id on the device (the column's default stays for
-- everyone else), so a bill waiting for it never has to change.
alter table public.customers
  add column search_text text generated always as (
    upper(name || coalesce(' ' || phone, '') || coalesce(' ' || gstin, ''))
  ) stored;


-- =============================================================================
-- 2. Grade and size, as billed
-- =============================================================================
-- The product list may be edited later; the line may not. Written by the trigger only.
alter table public.invoice_items
  add column material_grade text,
  add column size_text      text;
comment on column public.invoice_items.size_text is 'M12 × 80 mm, copied from the product when the bill was issued. Null: typed by hand, or not a stud.';

create function private.invoice_items_remember_size()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.material_grade := null;
  new.size_text := null;
  if new.stud_item_id is not null then
    select s.material_grade, 'M' || trim_scale(s.diameter_mm)::text || ' × ' || trim_scale(s.length_mm)::text || ' mm'
      into new.material_grade, new.size_text
      from public.stud_items as s
     where s.id = new.stud_item_id;
  end if;
  return new;
end;
$$;
revoke all on function private.invoice_items_remember_size() from public;

create trigger invoice_items_remember_size before insert on public.invoice_items for each row execute function private.invoice_items_remember_size();


-- =============================================================================
-- 3. Monthly books: what changed, and where each book stands
-- =============================================================================
-- Rows are only added (by the sale itself, in its own transaction) and deleted (by the worker
-- that has put them into the workbook), so two bills never wait for each other here. Finished
-- is what was SEEN, by id: a bill that commits late, under a lower id, is still waiting.
create table private.book_changes (
  id         bigint generated always as identity primary key,
  month      date not null check (extract(day from month) = 1),
  invoice_id uuid references public.invoices (id),   -- null: the owner asked for the month again
  changed_at timestamptz not null default now()
);
create index book_changes_month_idx   on private.book_changes (month, id);
create index book_changes_invoice_idx on private.book_changes (invoice_id);

create table private.month_books (
  month          date primary key check (extract(day from month) = 1),
  drive_file_id  text check (drive_file_id ~ '^[A-Za-z0-9_-]{8,128}$'),
  drive_link     text check (drive_link ~ '^https://(drive|docs)\.google\.com/' and char_length(drive_link) <= 500),
  revision       bigint not null default 0 check (revision >= 0),
  content_sha256 text check (content_sha256 ~ '^[0-9a-f]{64}$'),
  written_at     timestamptz,
  lease_token    uuid,
  lease_until    timestamptz,
  attempts       integer not null default 0 check (attempts >= 0),
  next_try_at    timestamptz,
  last_error     text check (char_length(last_error) <= 200),
  constraint month_books_lease_pair check ((lease_token is null) = (lease_until is null))
);
comment on table private.month_books is
  'One Drive workbook per month. Whoever holds the lease may write it; the file id never changes.';

alter table private.book_changes enable row level security;   -- no policies: no API access
alter table private.month_books  enable row level security;   -- no policies: no API access
revoke all on table private.book_changes, private.month_books from public, anon, authenticated, service_role;
revoke all on sequence private.book_changes_id_seq from public, anon, authenticated, service_role;

create function private.month_of(p_date date)
returns date
language sql
immutable
strict
parallel safe
set search_path = ''
as $$
  select make_date(extract(year from p_date)::int, extract(month from p_date)::int, 1)
$$;
revoke all on function private.month_of(date) from public;


-- =============================================================================
-- 4. Marking: in the same transaction as the sale, the receipt, the cancellation
-- =============================================================================
create function private.mark_books(p_invoice_id uuid, p_dates date[])
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  insert into private.book_changes (month, invoice_id)
  select distinct private.month_of(d), p_invoice_id from unnest(p_dates) as d where d is not null
$$;
revoke all on function private.mark_books(uuid, date[]) from public;

-- The trigger functions run as their owner: callers reach neither the table nor mark_books.
create function private.invoices_mark_books()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Drive links, reminders and timestamps are not in the book.
  if tg_op = 'INSERT'
     or (new.amount_paid, new.payment_status, new.cancelled_at, new.cancellation_reason)
        is distinct from (old.amount_paid, old.payment_status, old.cancelled_at, old.cancellation_reason) then
    perform private.mark_books(new.id, array[new.invoice_date]);
  end if;
  return null;
end;
$$;

create function private.deliveries_mark_books()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_silent constant text[] := array['proof_drive_url', 'proof_drive_file_id', 'updated_at'];
begin
  if tg_op = 'INSERT' or to_jsonb(new) - c_silent is distinct from to_jsonb(old) - c_silent then
    perform private.mark_books(new.invoice_id, array[new.dc_date, (select i.invoice_date from public.invoices as i where i.id = new.invoice_id)]);
  end if;
  return null;
end;
$$;

-- The month of the money, and the month of the bill whose balance it changes.
create function private.payments_mark_books()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.mark_books(new.invoice_id, array[new.received_on, (select i.invoice_date from public.invoices as i where i.id = new.invoice_id)]);
  return null;
end;
$$;

create function private.job_work_returns_mark_books()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.mark_books(new.invoice_id, array[(select d.dc_date from public.deliveries as d where d.id = new.delivery_id)]);
  return null;
end;
$$;

revoke all on function private.invoices_mark_books(), private.deliveries_mark_books(), private.payments_mark_books(),
                       private.job_work_returns_mark_books() from public;

create trigger invoices_mark_books         after insert or update on public.invoices         for each row execute function private.invoices_mark_books();
create trigger deliveries_mark_books       after insert or update on public.deliveries       for each row execute function private.deliveries_mark_books();
create trigger payments_mark_books         after insert or update on public.payments         for each row execute function private.payments_mark_books();
create trigger job_work_returns_mark_books after insert or update on public.job_work_returns for each row execute function private.job_work_returns_mark_books();

-- What is in the books already.
insert into private.book_changes (month, invoice_id)
select distinct private.month_of(x.day), x.invoice_id
  from (select i.invoice_date as day, i.id as invoice_id from public.invoices as i
        union all
        select p.received_on, p.invoice_id from public.payments as p
        union all
        select d.dc_date, d.invoice_id from public.deliveries as d) as x
 order by 1;


-- =============================================================================
-- 5. The worker (server only: the secret key)
-- =============================================================================
create function private.assert_server()
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  -- No claims at all: the SQL editor.
  if coalesce(auth.jwt() ->> 'role', 'service_role') <> 'service_role' then
    raise exception 'Only the server updates the Excel books' using errcode = '42501';
  end if;
end;
$$;
revoke all on function private.assert_server() from public;

-- Takes a month that has changes, for p_seconds. Nothing when there is none, or others have it.
-- p_except: months this worker has just failed at.
create function public.book_claim(p_month date, p_seconds integer, p_force boolean, p_except date[] default '{}')
returns table (month date, token uuid, change_ids bigint[], drive_file_id text, drive_link text, revision bigint)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_month date;
  v_book  private.month_books%rowtype;
begin
  perform private.assert_server();
  if p_seconds is null or p_seconds not between 5 and 900 then
    raise exception 'book_claim: 5 to 900 seconds' using errcode = '22023';
  end if;
  for v_month in
    select c.month
      from private.book_changes as c
      left join private.month_books as b on b.month = c.month
     where (p_month is null or c.month = p_month)
       and c.month <> all (p_except)
       and (b.lease_until is null or b.lease_until < clock_timestamp())
       and (p_force or b.next_try_at is null or b.next_try_at <= clock_timestamp())
     group by c.month
     order by min(c.id)
  loop
    insert into private.month_books as b (month) values (v_month) on conflict do nothing;
    -- Checked again under the row lock: of two workers, one gets it.
    update private.month_books as b
       set lease_token = gen_random_uuid(),
           lease_until = clock_timestamp() + make_interval(secs => p_seconds)
     where b.month = v_month
       and (b.lease_until is null or b.lease_until < clock_timestamp())
    returning b.* into v_book;
    if found then
      return query
        select v_book.month, v_book.lease_token,
               (select array_agg(c.id order by c.id) from private.book_changes as c where c.month = v_month),
               v_book.drive_file_id, v_book.drive_link, v_book.revision;
      return;
    end if;
  end loop;
end;
$$;

-- "May I still write, with p_seconds to spare?" Asked right before the upload.
create function public.book_hold(p_month date, p_token uuid, p_seconds integer)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.assert_server();
  return exists (
    select 1 from private.month_books as b
     where b.month = p_month and b.lease_token = p_token
       and b.lease_until > clock_timestamp() + make_interval(secs => p_seconds));
end;
$$;

-- The id is kept BEFORE the file is made: a lost reply cannot lead to a second file.
create function public.book_set_file(p_month date, p_token uuid, p_file_id text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.assert_server();
  update private.month_books as b
     set drive_file_id = p_file_id
   where b.month = p_month and b.lease_token = p_token and b.lease_until > clock_timestamp();
  return found;
end;
$$;

-- Finished with exactly the changes that were seen. False: the month is somebody else's by now.
create function public.book_done(p_month date, p_token uuid, p_change_ids bigint[], p_link text, p_sha256 text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.assert_server();
  update private.month_books as b
     set revision = b.revision + 1, content_sha256 = p_sha256, drive_link = p_link, written_at = now(),
         lease_token = null, lease_until = null, attempts = 0, next_try_at = null, last_error = null
   where b.month = p_month and b.lease_token = p_token;
  if not found then
    return false;
  end if;
  delete from private.book_changes as c where c.month = p_month and c.id = any (p_change_ids);
  return true;
end;
$$;

-- Rests 1, 2, 4 ... minutes, at most 6 hours. When it is unknown whether an upload arrived, the
-- month stays taken until its time is over, so a late one cannot land on a newer one.
create function public.book_failed(p_month date, p_token uuid, p_error text, p_unknown_outcome boolean)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.assert_server();
  update private.month_books as b
     set attempts    = b.attempts + 1,
         last_error  = left(p_error, 200),
         next_try_at = greatest(
           clock_timestamp() + least(interval '6 hours', interval '1 minute' * power(2, least(b.attempts, 12))),
           case when p_unknown_outcome then b.lease_until end),
         lease_token = case when p_unknown_outcome then b.lease_token end,
         lease_until = case when p_unknown_outcome then b.lease_until end
   where b.month = p_month and b.lease_token = p_token;
  return found;
end;
$$;


-- =============================================================================
-- 6. What people see
-- =============================================================================
-- Is this bill, with its latest receipt, in the workbook on Drive?
create function public.bill_in_book(p_invoice_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_staff() then
    raise exception 'bill_in_book: caller is not an active StudFlow user' using errcode = '42501';
  end if;
  if not exists (select 1 from public.invoices as i where i.id = p_invoice_id) then
    raise exception 'bill_in_book: no such bill' using errcode = '22023';
  end if;
  return case when exists (select 1 from private.book_changes as c where c.invoice_id = p_invoice_id)
              then 'waiting' else 'updated' end;
end;
$$;

-- Is there a month to write now? Any open device asks from time to time.
create function public.book_due()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_staff() then
    raise exception 'book_due: caller is not an active StudFlow user' using errcode = '42501';
  end if;
  return exists (
    select 1
      from private.book_changes as c
      left join private.month_books as b on b.month = c.month
     where (b.lease_until is null or b.lease_until < clock_timestamp())
       and (b.next_try_at is null or b.next_try_at <= clock_timestamp()));
end;
$$;

create function public.book_months()
returns table (month date, bills bigint, waiting bigint, waiting_since timestamptz, written_at timestamptz,
               drive_link text, retry_at timestamptz, last_error text, updating boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if not private.is_owner() then
    raise exception 'book_months: only the owner opens the Excel books' using errcode = '42501';
  end if;
  return query
    select m.month,
           (select count(*) from public.invoices as i
             where i.invoice_date >= m.month and i.invoice_date < (m.month + interval '1 month')::date),
           coalesce(c.n, 0), c.since, b.written_at, b.drive_link, b.next_try_at, b.last_error,
           coalesce(b.lease_until > clock_timestamp(), false)
      from (select b.month from private.month_books as b
            union
            select c.month from private.book_changes as c) as m
      left join private.month_books as b on b.month = m.month
      left join (select c.month, count(*) as n, min(c.changed_at) as since
                   from private.book_changes as c group by c.month) as c on c.month = m.month
     order by m.month desc;
end;
$$;

-- Try again now; and when nothing is waiting, make the month once more.
create function public.book_retry(p_month date)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not private.is_owner() then
    raise exception 'book_retry: only the owner opens the Excel books' using errcode = '42501';
  end if;
  if p_month is null or p_month <> private.month_of(p_month)
     or p_month < date '2020-01-01' or p_month > private.today_ist() then
    raise exception 'book_retry: not a month of these books' using errcode = '22023';
  end if;
  update private.month_books as b set next_try_at = null where b.month = p_month;
  if not exists (select 1 from private.book_changes as c where c.month = p_month) then
    insert into private.book_changes (month) values (p_month);
  end if;
end;
$$;

revoke all on function public.book_claim(date, integer, boolean, date[]), public.book_hold(date, uuid, integer),
                       public.book_set_file(date, uuid, text), public.book_done(date, uuid, bigint[], text, text),
                       public.book_failed(date, uuid, text, boolean),
                       public.bill_in_book(uuid), public.book_due(), public.book_months(), public.book_retry(date)
  from public, anon, authenticated, service_role;
grant execute on function public.book_claim(date, integer, boolean, date[]), public.book_hold(date, uuid, integer),
                          public.book_set_file(date, uuid, text), public.book_done(date, uuid, bigint[], text, text),
                          public.book_failed(date, uuid, text, boolean)
  to service_role;
grant execute on function public.bill_in_book(uuid), public.book_due(), public.book_months(), public.book_retry(date)
  to authenticated;

notify pgrst, 'reload schema';
