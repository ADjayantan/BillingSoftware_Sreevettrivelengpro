-- =============================================================================
-- StudFlow AI · 004_ai_alerts.sql
-- -----------------------------------------------------------------------------
-- Task A: Backend AI, Metal Rate Alerts & Payment Reminder Deduplication
-- Adds reminder stage/date tracking columns on public.invoices and a source
-- lookup index on public.metal_rates while preserving issued-invoice
-- immutability, allowlist RLS, audit logging, and least-privilege grants.
-- =============================================================================

alter table public.invoices
  add column last_reminder_stage   text check (last_reminder_stage in ('due', 'overdue_7', 'overdue_15')),
  add column last_reminder_sent_on date check (last_reminder_sent_on >= date '2020-01-01');

comment on column public.invoices.last_reminder_stage is
  'Most recent payment-reminder stage (due, overdue_7, overdue_15) dispatched for this invoice.';
comment on column public.invoices.last_reminder_sent_on is
  'IST calendar date when last_reminder_stage was dispatched, preventing duplicate same-day stage reminders.';

create index metal_rates_source_idx
  on public.metal_rates (source, recorded_at desc);

create index invoices_payment_reminders_idx
  on public.invoices (due_date, payment_status)
  where cancelled_at is null and payment_status in ('unpaid', 'partial');

-- Allow the reminder tracking columns in the issued-invoice edit guard while
-- keeping all billed amounts, tax figures, snapshots, and numbers frozen.
create or replace function private.invoices_guard_issued()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  c_editable constant text[] := array[
    'amount_paid', 'payment_status',
    'pdf_drive_url', 'drive_sync_pending', 'drive_file_id', 'dc_drive_url', 'dc_drive_file_id',
    'last_reminder_stage', 'last_reminder_sent_on',
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

-- Least-privilege column grant for service_role payment-reminder cron
grant update (last_reminder_stage, last_reminder_sent_on)
  on table public.invoices to service_role;
