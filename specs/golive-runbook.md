# StudFlow AI · Go-live and recovery

Use this checklist once in a rehearsal environment, then in production. The owner signs off the paper registers, first bill and phone drill. The engineer runs the SQL, deploys and records the results. Keep the release commit, project reference, date/time in IST, test IDs and last good backup in the company operations log. Keep passwords and keys in the company password manager.

**Release baseline.** Sprint 3A is commit `e4294f9`. It contains the billing PWA, payment receipts, two migrations and the draft-to-invoice sync path. Task A adds AI, rates and reminders. Task B adds PDF archiving and recoverable backups. The environment changes for those tasks are specified below. [Sprint 3A source](https://github.com/ADjayantan/BillingSoftware_Sreevettrivelengpro/tree/e4294f980c2c8506bd00bd48edb4ddbd5ea81e00)

## 1. Prepare two environments

- [ ] **Owner** prepares the company GSTIN, legal address, owner login email, current paper invoice and DC registers, the company's Google Workspace administrator and a private Telegram account for alerts.
- [ ] **Engineer** creates separate rehearsal and production Supabase projects. Select the specific region **South Asia (Mumbai), `ap-south-1`**. Record each project reference from its dashboard. Use separate Vercel environments, vaults, bot chats and credentials so rehearsal data stays in rehearsal. [Supabase regions](https://supabase.com/docs/guides/platform/regions)
- [ ] In a clean checkout of the release candidate, run `npm ci`, `npm run db:verify`, `npm test`, `npm run typecheck`, `npm run lint` and `npm run build`. The Sprint 3A baseline is 343 passing tests. Require the new Task A/B tests as well. Load fictional masters **only in rehearsal**, via the release's `npm run --silent seed:sql` import script. The script maps the JSON to DB columns and grades. Use the company's actual masters in production.

## 2. Create the database and prove access control

- [ ] In **Supabase → Authentication → Sign In / Providers**, turn off **Allow new users to sign up** and **Allow anonymous sign-ins**. Keep email/password available. Set the Site URL and allowed redirect URLs for this environment. In **Authentication → Users → Add user**, create the verified owner login with a password using the admin flow. Sprint 3A's login form uses email and password. [Auth settings](https://supabase.com/docs/guides/auth/general-configuration) · [Managing users](https://supabase.com/docs/guides/auth/users)
- [ ] From the release root, use a company-admin Supabase CLI session. The following PowerShell example uses CLI v3. Set `STUDFLOW_PROJECT_REF` to the intended dashboard reference first. Read the displayed target and dry run before applying. Use the same migration-history mechanism for subsequent releases. [Supabase CLI](https://supabase.com/docs/reference/cli/supabase-db-push)

```powershell
if (-not $env:STUDFLOW_PROJECT_REF) { throw "Set the target project reference first." }
supabase migration list --remote=$env:STUDFLOW_PROJECT_REF
supabase db push --dry-run --remote=$env:STUDFLOW_PROJECT_REF
# On an empty target the plan must start with 001_initial_schema.sql,
# then 002_sprint2_billing.sql. Review any Task A/B migrations after those.
supabase db push --remote=$env:STUDFLOW_PROJECT_REF
supabase migration list --remote=$env:STUDFLOW_PROJECT_REF
```

- [ ] Confirm remote history shows **001 then 002**, each applied once, followed by the reviewed integration migrations. Run 002 **before the first bill**. It adds non-null frozen invoice data. If an existing 001-only installation already has invoices, take a backup and rehearse an explicit data-preserving upgrade first. A project with manually applied SQL needs its actual schema reconciled with migration history before a CLI push.
- [ ] In **SQL Editor**, run the checks below. Expect 11 named tables with RLS true, a non-null sync RPC, and the gate setting `pgrst.db_pre_request=private.check_request`. Check any new Task A/B tables separately. If migration 001 warned that the gate was skipped, an admin can run `alter role authenticator set pgrst.db_pre_request = 'private.check_request';` then `notify pgrst, 'reload config';` and repeat the checks. Keep the `private` schema outside the Data API's exposed schemas.

```sql
select relname, relrowsecurity
from pg_class
where relnamespace = 'public'::regnamespace and relname in
  ('customers','stud_items','metal_rates','invoices','invoice_items','deliveries',
   'job_work_ledger','alert_rules','company_profile','job_work_returns','payments')
order by relname;
select to_regprocedure('public.sync_invoice(jsonb)') as sync_rpc;
select unnest(setconfig) as setting from pg_db_role_setting
where setrole = 'authenticator'::regrole
  and setdatabase in (0, (select oid from pg_database where datname = current_database()));
```

- [ ] **Allowlist the owner.** Replace the example email below in **both** places. This links the verified Auth user's UUID to the owner role. A repeated run preserves an existing assignment. Expect exactly one verification row with the intended email, role `owner`, and `is_active = true`. Resolve an empty result or a different existing role with the owner before proceeding.

```sql
insert into private.app_users (user_id, display_name, role)
select id, 'Owner', 'owner' from auth.users
where lower(email) = lower('owner@example.invalid')
on conflict (user_id) do nothing;

select u.email, a.user_id, a.role, a.is_active
from auth.users u join private.app_users a on a.user_id = u.id
where lower(u.email) = lower('owner@example.invalid');
```

- [ ] In the app, sign in as this owner and complete **Company** (`/company`) with the real TN GSTIN and issuing details. Reopen it and compare the saved details with the letterhead. In rehearsal, try a new email with the public sign-up flow, then separately sign in as an admin-created user absent from `private.app_users`. Sign-up must fail, the second user must be denied business reads/writes, and a signed-out request must expose no customer data. Use ordinary browser sessions and the publishable key for these tests.

## 3. Open both paper series before switching the counter

- [ ] Agree a cutover time. Finish or account for every pending bill on each device. Pause digital issuance and the paper counter together. For the same issuing entity and financial year, check the registers, cancelled/spoiled numbers, other terminals and any earlier software. Record the **highest number already used or reserved** for INV and DC separately. If paper must resume during an outage, record each new number and reconcile before reopening digital billing.
- [ ] Run the following read-only queries in the target SQL Editor. Compare these figures with the registers. Existing counter rows indicate an already-open series. Reconcile those with issued records and the owner before changing anything.

```sql
select series, fiscal_year, last_value from private.document_sequences order by 2,1;
select fiscal_year, max(invoice_seq) as highest_inv from public.invoices group by 1;
select fiscal_year, max(dc_seq) as highest_dc from public.deliveries group by 1;
```

- [ ] **First opening only.** Enter the two signed-off last numbers in place of the two `null` values. Enter the actual FY. Use 0 only for a genuinely new series. The block fails closed on missing values, a wrong FY, an existing counter or existing documents in this FY. Both series open in one transaction. The old paper register does not need dummy electronic invoices.

```sql
do $open_series$
declare
  fy text := '26-27';       -- April 2026 through March 2027
  inv_last integer := null; -- replace with the owner's verified last INV
  dc_last integer := null;  -- replace with the owner's verified last DC
begin
  if inv_last is null or dc_last is null or least(inv_last, dc_last) < 0
     or inv_last >= 999999 or dc_last >= 9999999 -- next label must fit 16 characters
     or fy is distinct from private.fiscal_year_of(private.today_ist()) then
    raise exception 'Check both last-used numbers and the current financial year';
  end if;
  lock table private.document_sequences in exclusive mode;
  if exists (select 1 from private.document_sequences where fiscal_year = fy)
     or exists (select 1 from public.invoices where fiscal_year = fy)
     or exists (select 1 from public.deliveries where fiscal_year = fy) then
    raise exception 'This FY has activity. Reconcile the live register first';
  end if;
  insert into private.document_sequences (series, fiscal_year, last_value)
    values ('INV', fy, inv_last), ('DC', fy, dc_last);
end;
$open_series$;
```

- [ ] **Rehearsal example.** Paper ended at `INV/26-27/0824` and `DC/26-27/0117`. Store **824** and **117**. Issue one rehearsal bill and expect **0825** and **0118**. Submit the identical draft with the same `OFFLINE-<uuid>` again. Expect the original invoice/DC, one invoice row and no counter advance on replay. Also issue two different drafts concurrently in rehearsal and check distinct consecutive numbers. In production make the first submission a real sale. Reconcile its printed pair with the two paper registers before releasing the next bill.

## 4. Connect the vault, bot and Gemini

| In Vercel → Project → Settings → Environment Variables | Who uses it |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Browser and server. Use this environment's project URL and publishable key. |
| `SUPABASE_SECRET_KEY`, `CRON_SECRET` | Server jobs only. Use the Supabase secret key and a separate, randomly generated cron secret of at least 32 random bytes. |
| `GEMINI_API_KEY` | Task A server only. Use one key for the approved Gemini Flash model. Update the release's older primary/fallback variable names and tests to this single-key contract. |
| `TELEGRAM_BOT_TOKEN` | Server sender. For per-grade recipients, the existing DB column is `alert_rules.telegram_chat_id`. For the owner's reminder digest, Task A must also configure an explicit recipient, e.g. server setting `TELEGRAM_OWNER_CHAT_ID`. |
| `GOOGLE_DRIVE_ROOT_FOLDER_ID`, proposed `GOOGLE_DRIVE_SHARED_DRIVE_ID`, `GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON` | Task B server uploader. The root is a **folder ID** inside a Shared Drive. These proposed service-account settings replace the release template's OAuth client/refresh-token entries. Store the credential as a sensitive secret and parse it server-side. |

- [ ] **Drive administrator.** Confirm the company Workspace plan supports Shared Drives and permits this service account access. A consumer 2 TB My Drive subscription alone does not give a service account upload quota. If Shared Drives are unavailable, resolve company storage before enabling Task B. [Google Shared Drive ownership and service accounts](https://developers.google.com/workspace/drive/api/guides/about-shareddrives)
- [ ] Create a dedicated Shared Drive for this factory. Inside it create **Company_Billing_Vault** and record its folder ID. In Google Cloud enable **Google Drive API**, create a dedicated uploader service account, and grant its email Contributor access on this dedicated drive. Give the owner their own read/management access. Keep the vault's general access **Restricted**. No domain-wide delegation or project-wide Editor role is needed. [Shared Drive roles](https://developers.google.com/workspace/drive/api/guides/ref-roles)
- [ ] Task B pins the configured parent ID, uses `supportsAllDrives=true` and checks the returned drive and parent IDs. Test with the intended OAuth scope. `drive.file` can access app-authorized files; verify the pre-created parent is accessible. If the server needs the `drive` scope, keep the service account's actual Drive permissions confined to this dedicated drive. Reject a caller-supplied path or folder ID outside the vault. [Shared Drive API](https://developers.google.com/workspace/drive/api/guides/enable-shareddrives) · [Choosing Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
- [ ] In rehearsal, issue one **supply** and one **job-work** bill. Upload the issued invoice and DC snapshots under `Company_Billing_Vault/StudFlow/<FY>/<MM>/`, e.g. `StudFlow/26-27/11/`. Open each PDF as the owner. Match invoice/DC number, amounts and goods with the app. Check an unauthorised account cannot open it. Interrupt just after Drive accepts a file, then rerun. Expect one file per document/copy, one stable reference and no new invoice. A durable job with a preallocated Drive file ID lets a retry verify the original parent and checksum. Reserve `proof_drive_url` for proof of delivery. Give an archived DC its own file reference or archive record. [Drive file IDs](https://developers.google.com/workspace/drive/api/guides/create-file)
- [ ] **Telegram.** In the official **@BotFather**, use `/newbot`. Put its token in the environment above. From the owner's private chat open that bot, press **Start**, and send a unique setup phrase. Using a trusted server-side Bot API client, call `getMe`, then `getUpdates` and match that phrase to `message.chat.id`. If a webhook is already active, read the matching update in the webhook receiver. Save the verified ID as a string. Send one rehearsal message to the test chat and read it on the owner's phone. [Telegram setup](https://core.telegram.org/bots/tutorial) · [Bot API](https://core.telegram.org/bots/api)
- [ ] **Gemini.** In Google AI Studio create the environment's single Gemini API key, restricted to the Gemini API. Pin a supported Flash model ID in the release and run one live server-side smoke test. Validate structured JSON against a strict allowlist. Resolve names/SKUs with the authenticated user's catalog. An unlisted user must never reach a paid model call. On quota, timeout or invalid JSON, preserve the transcript/draft and keep manual billing available. [Gemini keys](https://ai.google.dev/gemini-api/docs/api-key) · [Structured output](https://ai.google.dev/gemini-api/docs/structured-output)
- [ ] In Vercel, import the release repo as a Next.js project, select the release branch for production, configure the company HTTPS domain, set each variable in its intended environment and redeploy. Keep secret readers in server-only modules. Inspect the browser Network tab and built client assets for accidental secrets and unredacted customer transcripts. If a secret was exposed, rotate it and redeploy. [Vercel environments](https://vercel.com/docs/environment-variables/managing-environment-variables)

## 5. Prove both scheduled jobs and the AI draft flow

- [ ] **Before turning on cron**, change the Sprint 3A proxy for the two machine endpoints. It currently requires a user cookie on every `/api/` request. Route **only the exact scheduled GET paths** to handlers that independently require the cron bearer secret before any DB or provider call. A missing server-side secret fails closed. Use a job-specific server client. Keep user-facing AI/billing routes behind authentication and the staff allowlist. A logged-in user's cookie alone cannot trigger a scheduled job.
- [ ] Add the actual routes to `vercel.json` and deploy. Example cron expressions are **03:30 UTC daily** (`30 3 * * *`, 09:00 IST) for `/api/cron/metal-rates` and **04:00 UTC daily** (`0 4 * * *`, 09:30 IST) for `/api/cron/reminders`. Confirm the owner's preferred times and plan's scheduling precision. Vercel schedules invoke **production deployments** using GET and supply `Authorization: Bearer <CRON_SECRET>`. Use a separate rehearsal project with its own production deployment to verify a real scheduler event. [Vercel cron configuration](https://vercel.com/docs/cron-jobs) · [Authentication and delivery behaviour](https://vercel.com/docs/cron-jobs/manage-cron-jobs)
- [ ] **Engineer, in rehearsal.** Use PowerShell 7. Set `STUDFLOW_TEST_URL` to the rehearsal HTTPS origin and securely load that environment's `CRON_SECRET` into this shell. The following sends no cookies. The first two calls to each path must return 401/403 and have zero effects. The next two must return 2xx with at most one set of business effects. Also test missing server config in an isolated deployment. Match a subsequent scheduled invocation in Vercel's cron and function logs. A login redirect or a 200 HTML login page is a failed test.

```powershell
if (-not $env:STUDFLOW_TEST_URL -or -not $env:CRON_SECRET) { throw "Set rehearsal URL and secret first." }
foreach ($path in '/api/cron/metal-rates','/api/cron/reminders') {
  $uri = $env:STUDFLOW_TEST_URL.TrimEnd('/') + $path
  (Invoke-WebRequest $uri -SkipHttpErrorCheck -MaximumRedirection 0).StatusCode
  (Invoke-WebRequest $uri -Headers @{Authorization='Bearer invalid'} -SkipHttpErrorCheck -MaximumRedirection 0).StatusCode
  $headers = @{Authorization = 'Bearer ' + $env:CRON_SECRET}
  (Invoke-WebRequest $uri -Headers $headers -SkipHttpErrorCheck -MaximumRedirection 0).StatusCode
  (Invoke-WebRequest $uri -Headers $headers -SkipHttpErrorCheck -MaximumRedirection 0).StatusCode
}
```

| Rehearsal | What must happen before launch |
|---|---|
| Voice and typed bills | Run all 25 cases in `specs/ai-voice-test-cases.json` with the matching seed. Deep-compare each route's entire JSON, including empty warning/alert results. Run golden tests offline with deterministic provider fixtures and run a few live utterances separately. Speak a counter order on a phone and deny mic permission once to verify text fallback. Resolve missing quantities, unknown customers and inch stock with the owner. Opening or discarding a draft consumes no invoice number. Only the reviewed billing flow may calculate and issue a bill. |
| Margin | Confirm a low quote warns, an allowed quote stays quiet and customer-owned job work avoids a raw-metal warning. Recheck after a rate change, using the server's current metal data and the same billing unit. The owner confirms any change to their quote. |
| Dealer rates | Feed all 10 messages from `specs/metal-rate-samples.json` into the configured dealer intake. Replay the same source message and run overlapping invocations. Confirm one accepted observation per intended quote and the fixture's exact owner alert. The DB derives predecessor and delta. Active rules compare the **absolute** change against the inclusive threshold. Missing grades produce no invented prices. On a failed feed, flag stale data and preserve the last verified rate. |
| Reminders | Freeze the business date in IST. Test an unpaid bill due today, a partial bill 7 days late, and a bill 15 days late. Also test tomorrow, day 8, settled (including TDS), cancelled and missing-phone cases. Reuse `src/lib/whatsapp.ts`, current invoice status and the exact outstanding amount after receipts. Send the owner a Telegram digest and customer-specific WhatsApp draft links when eligible. The owner reviews and sends in WhatsApp. A missing phone must not produce a link. |
| Retry and observability | Record a durable job key and status by IST business date/source message, with a per-recipient delivery record. For reminders key by invoice, due-date stage and recipient. Re-read the balance immediately before dispatch. A second run skips completed work. Simulate provider 429/timeout and concurrent invocation. Preserve pending work, respect retry timing, and mark an ambiguous Telegram send for review before resending. Record job ID, counts, last success and error class. A stale job or unarchived issued bill must be visible to the owner. |

## 6. Simulate a PC crash and recover on the owner's phone

Do this end to end in rehearsal before cutover. Use the PC and a **different phone**, both on the same rehearsal tenant. Do not clear site storage or physically damage a device.

1. **Prepare.** On the PC sign in, open Billing online and let the master cache load. Issue one test invoice and wait for its official INV/DC pair and Drive archive. Write down both numbers and the amount. On the phone open the same HTTPS site in a fresh browser session.
2. **Lose the PC.** Close its browser completely. On the phone, sign in independently and open **Invoices**. Find the same issued bill, linked DC, amount and payment status. Open the archived documents with the owner's Google account. Successful recovery uses cloud records even while the PC stays off.
3. **Prove the offline limit.** Reopen Billing on the PC, disconnect its network and save a different bill. Record `OFFLINE-<uuid>`. Wait for **Saved on this PC** or **Pending Sync**, then close the browser. The phone should still show only issued cloud bills. A draft that existed solely in Dexie cannot be recovered from the cloud if the device and its browser profile are lost.
4. **Recover the surviving queue.** Reopen the same browser profile on the same PC and site, reconnect, and use **Sync Now** if needed. Refresh the phone. Match the newly issued INV/DC to that original temporary ID. Rehearse a lost acknowledgement by letting a staging sync commit and dropping only its response; replay the identical queued payload. Verify one invoice, one linked DC and one archive per document. A conflict showing “Already issued” is investigated using the returned invoice.
5. **If the PC really dies.** Continue issued-bill work on the phone. Preserve the old disk/profile if recoverable. For a missing unsynced order, first compare the cloud register and customer/party DC records. Re-enter only after the owner confirms it was never issued. Do not restore yesterday's database over healthy cloud records to recover one workstation.

## 7. Weekly backup and database disaster recovery

- [ ] **Task B engineer** schedules a weekly encrypted logical backup to `Company_Billing_Vault/Backups/` from a cloud runner that can execute the pinned Supabase CLI and PostgreSQL tools. Vercel Cron can enqueue the job. Use a direct/session-pooler database connection and a backup account with access to all required rows. A dump of application API responses omits Auth, counters and privileges.
- [ ] Follow the Supabase **roles + schema + data** procedure. Export the `supabase_migrations` history separately; capture custom Auth/Storage functions and policies if used. Include the entire `private` schema (allowlist, INV/DC counters, audit log), all public ledgers and Task A/B job state, Auth users and identities. Keep migrations fixed during the export. Store any Storage object bytes separately from DB metadata. Preserve settings, redirect URLs, signing/credential recovery instructions and the decryption key in the company recovery store. [Supabase backup and restore commands](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore) · [Backup coverage](https://supabase.com/docs/guides/platform/backups)
- [ ] Store a dated manifest with project ref, release SHA, migration versions, backup start/completion time, file sizes and SHA-256 hashes. Verify the uploaded bytes and a test decryption. Record success only after every required file is present. Alert the owner on a missed backup. A weekly copy can lose changes since its last successful run; agree the acceptable interval and check the project's daily backups/PITR coverage.
- [ ] **Restore drill, fresh isolated project.** Keep cron, outbound messages, Drive writes and billing off. Verify/decrypt the bundle. On a compatible Supabase target, use the linked procedure to restore roles, schema, then data in a transaction with error-stop enabled and triggers suppressed only during the data load. Restore migration history once. Reapply custom settings, the Data API gate and reviewed grants. The target provides Supabase-managed roles; review ownership differences and restore custom login credentials separately. Reconnect Auth and compare customer, invoice, line, DC, payment, lot, audit and job counts against the snapshot. Check an owner login, an unlisted login denial, several invoice/DC pairs, settled balances, both counters and the private Drive links. Record actual restore time and latest recovered transaction.
- [ ] **Real DB incident.** Freeze issuance and cron on every writer. Prefer the most recent verified restore/PITR point. Reconcile paper, Drive PDFs, receipts, dealer messages and any surviving device queues issued **after** that point. Recover the ledger or document gaps and the used serials with the owner. Before resuming, both counters must cover every number already issued anywhere. Preserve the public app origin for existing queues. Point the app at the recovered project, redeploy environment changes, sign in again and replay only reconciled work. Resume jobs from their recorded state to prevent duplicate reminders.

## 8. Release decision and rollback

- [ ] The engineer records successful migration/access checks, first-number rehearsal, both real cron invocations, a readable invoice/DC archive, the mobile drill and a dated backup restore. The owner confirms company details, both last paper numbers, Telegram destination, and their ability to open a bill on the phone.
- [ ] If a bill number collides, an unlisted user can read business data, an AI route returns a calculated bill total, or a required archive/backup cannot be recovered, pause the affected feature. Suspend issuance for access or numbering failures. Keep existing records, counter values and browser queues intact.
- [ ] For a faulty Task A/B release, pause its schedulers/senders and archive worker. Roll Vercel back only to a release compatible with the live schema and pending Dexie records, or deploy a forward fix. Reconcile incomplete jobs, rerun the failing rehearsal and observe the next successful scheduled run before closing the incident.
