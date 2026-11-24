-- =============================================================================
-- StudFlow AI · 003_drive_vault.sql
-- -----------------------------------------------------------------------------
-- Task B: Isolated Google Drive Vault & Non-Blocking Archive Tracking
-- Adds drive_sync_pending, drive_file_id, dc_drive_url, dc_drive_file_id on
-- public.invoices and proof_drive_file_id on public.deliveries while preserving
-- issued-invoice immutability, allowlist RLS, and least-privilege grants.
-- =============================================================================

alter table public.invoices
  add column drive_sync_pending boolean not null default true,
  add column drive_file_id      text check (drive_file_id ~ '^[A-Za-z0-9_-]{8,128}$'),
  add column dc_drive_url       text check (dc_drive_url ~ '^https://(drive|docs)\.google\.com/' and char_length(dc_drive_url) <= 500),
  add column dc_drive_file_id   text check (dc_drive_file_id ~ '^[A-Za-z0-9_-]{8,128}$');

comment on column public.invoices.drive_sync_pending is
  'true until the finalized invoice/DC PDFs are archived to Company_Billing_Vault on Google Drive.';
comment on column public.invoices.drive_file_id is
  'Google Drive file ID of the archived invoice PDF inside Company_Billing_Vault.';
comment on column public.invoices.dc_drive_url is
  'Google Drive webViewLink of the archived Delivery Challan PDF.';
comment on column public.invoices.dc_drive_file_id is
  'Google Drive file ID of the archived Delivery Challan PDF.';

create index invoices_drive_sync_pending_idx
  on public.invoices (created_at)
  where drive_sync_pending and cancelled_at is null;

alter table public.deliveries
  add column proof_drive_file_id text check (proof_drive_file_id ~ '^[A-Za-z0-9_-]{8,128}$');

comment on column public.deliveries.proof_drive_file_id is
  'Google Drive file ID of the uploaded delivery proof photo (<200 KB) inside Delivery_Proofs/.';

-- Allow the Drive archive columns in the issued-invoice edit guard while keeping
-- all billed amounts, tax figures, customer/supplier snapshots, and numbers frozen.
create or replace function private.invoices_guard_issued()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  c_editable constant text[] := array[
    'amount_paid', 'payment_status',
    'pdf_drive_url', 'drive_sync_pending', 'drive_file_id', 'dc_drive_url', 'dc_drive_file_id',
    'cancelled_at', 'cancellation_reason', 'updated_at'
  ];
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

-- Least-privilege column grants for service_role background archiver
grant update (pdf_drive_url, drive_sync_pending, drive_file_id, dc_drive_url, dc_drive_file_id)
  on table public.invoices to service_role;

grant update (proof_drive_url, proof_drive_file_id)
  on table public.deliveries to service_role;
