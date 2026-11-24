-- Minimal stand-in for what a Supabase project already has before our migrations run, so
-- PGlite tests exercise ownership, grants and RLS the way production will:
--   * the API roles PostgREST switches into (service_role bypasses RLS),
--   * `supabase_postgres` = Supabase's `postgres`: NOT a superuser; it runs the migrations and
--     therefore owns every table and SECURITY DEFINER function,
--   * the auth helpers that policies call (bodies as in Supabase's auth schema),
--   * no default grants on new public tables: Supabase stopped auto-granting them for every
--     project on 30 Oct 2026 (discussion #45329). harness.ts can add the older default.
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create role authenticator nologin noinherit;
create role supabase_postgres nologin nosuperuser createdb createrole replication bypassrls;

grant anon, authenticated, service_role to authenticator;
grant anon, authenticated, service_role to supabase_postgres;
-- supautils lets Supabase's `postgres` configure PostgREST through this role.
grant authenticator to supabase_postgres with admin option;
grant set on parameter pgrst.db_pre_request to supabase_postgres;

do $$
begin
  execute format('grant create on database %I to supabase_postgres', current_database());
end;
$$;
grant usage, create on schema public to supabase_postgres;
grant usage on schema public to anon, authenticated, service_role;

create schema auth;

create table auth.users (
  id         uuid primary key,
  email      text unique,
  created_at timestamptz not null default now()
);

create function auth.jwt() returns jsonb
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;

create function auth.uid() returns uuid
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

create function auth.role() returns text
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;

grant usage on schema auth to anon, authenticated, service_role, supabase_postgres;
grant references on auth.users to supabase_postgres;

-- Functions keep Supabase's older default grant in every project we know of; the migration
-- must therefore strip EXECUTE from anon itself.
alter default privileges for role supabase_postgres in schema public
  grant all on functions to anon, authenticated, service_role;
