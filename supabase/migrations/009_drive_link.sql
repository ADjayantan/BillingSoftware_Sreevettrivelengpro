-- =============================================================================
-- StudFlow AI · 009_drive_link.sql
-- -----------------------------------------------------------------------------
-- specs/drive-button.md: the Google Drive sign-in the owner makes with the Company page's button.
-- Google's refresh token is stored only sealed (AES-256-GCM, its key derived from a server
-- setting the database never sees), so the row alone opens nothing. The table is out of the
-- Data API; four functions reach it: the state (staff), keep and forget (owner), and the sealed
-- token for the server's own copying (service_role only). No signed-in person can read the
-- token, sealed or not.
-- Not in the edit log: it keeps whole rows forever, and a credential must not be copied there.
-- The app version before this one keeps working with it (it does not read the table).
-- =============================================================================

create table private.drive_link (
  singleton     boolean primary key default true check (singleton),
  -- A regex repeat stops at 255, so the length is checked apart.
  sealed_token  text not null check (sealed_token ~ '^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{40,}$' and length(sealed_token) <= 4200),
  folder_id     text not null check (folder_id ~ '^[A-Za-z0-9_-]{8,128}$'),
  account_email text check (account_email is null or (length(account_email) <= 254 and account_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  connected_at  timestamptz not null default now(),
  connected_by  uuid not null
);
comment on table private.drive_link is
  'The Google Drive sign-in made with the Company page''s button: one row at most, the token sealed.';

alter table private.drive_link enable row level security;   -- no policies: no API access
revoke all on table private.drive_link from public, anon, authenticated, service_role;


-- Whether the button's link is there, to which account, since when; and whether the caller may change it.
create function public.drive_link_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_staff() then
    raise exception 'drive_link_status: caller is not an active StudFlow user' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'linked', exists (select 1 from private.drive_link as l where l.singleton),
    'account_email', (select l.account_email from private.drive_link as l where l.singleton),
    'connected_at', (select l.connected_at from private.drive_link as l where l.singleton),
    'owner', private.is_owner());
end;
$$;

-- Keeps a new link. Answers the sealed token it replaced, for the server to revoke at Google.
create function public.drive_link_save(p_sealed text, p_folder_id text, p_account_email text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_old text;
begin
  if not private.is_owner() then
    raise exception 'drive_link_save: only the owner connects Google Drive' using errcode = '42501';
  end if;
  select l.sealed_token into v_old from private.drive_link as l where l.singleton for update;
  insert into private.drive_link as l (singleton, sealed_token, folder_id, account_email, connected_at, connected_by)
  values (true, p_sealed, p_folder_id, nullif(btrim(p_account_email), ''), now(), (select auth.uid()))
  on conflict (singleton) do update
    set sealed_token = excluded.sealed_token,
        folder_id = excluded.folder_id,
        account_email = excluded.account_email,
        connected_at = excluded.connected_at,
        connected_by = excluded.connected_by;
  return v_old;
end;
$$;

-- Forgets the link. Answers its sealed token, for the server to revoke at Google.
create function public.drive_link_clear()
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_old text;
begin
  if not private.is_owner() then
    raise exception 'drive_link_clear: only the owner disconnects Google Drive' using errcode = '42501';
  end if;
  delete from private.drive_link as l where l.singleton returning l.sealed_token into v_old;
  return v_old;
end;
$$;

-- The sealed token and the folder, for the server's own copying to Drive. Null when not linked.
create function public.drive_link_secret()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if coalesce((select auth.role()), '') <> 'service_role' then
    raise exception 'drive_link_secret: only the server reads the Drive link' using errcode = '42501';
  end if;
  return (select jsonb_build_object('sealed', l.sealed_token, 'folder_id', l.folder_id) from private.drive_link as l where l.singleton);
end;
$$;

revoke all on function public.drive_link_status(), public.drive_link_save(text, text, text), public.drive_link_clear(),
                       public.drive_link_secret()
  from public, anon, authenticated, service_role;
grant execute on function public.drive_link_status(), public.drive_link_save(text, text, text), public.drive_link_clear()
  to authenticated;
grant execute on function public.drive_link_secret() to service_role;

notify pgrst, 'reload schema';
