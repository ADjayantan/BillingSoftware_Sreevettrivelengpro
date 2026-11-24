# StudFlow AI — engineering rules

Crash-proof cloud billing & dispatch PWA for a stud-threading / job-work unit in Tamil Nadu (GST state `33`).
`PROJECT_BRIEF.md` is the source of truth for **what** to build; this file locks **how**.

## Delivery process
- Build in 4 sprints. Finish a sprint, verify it, report — then **stop and wait for the owner's explicit go-ahead** before starting the next.
  1. Foundation — Next.js App Router + TS + Tailwind, Supabase clients, `supabase/migrations/001_initial_schema.sql`, `src/lib/billing-math.ts` + Vitest.
  2. Customers CRUD, Stud Master (piece↔kg calculator), Supply + Job-Work billing, Delivery Challan & transport panel, A4 / A5 print views.
  3. Dexie offline queue (`src/lib/offline-db.ts`), idempotent sync on `client_temp_id`, PWA manifest + service worker, server-side PDF + Drive archive (`src/lib/drive-backup.ts`).
  4. `/api/ai/parse-bill`, `/api/ai/margin-check` (Gemini, primary→fallback key in `src/lib/gemini.ts`), `/api/cron/metal-rates`, `/api/cron/reminders`, Telegram sender.
- Done = typecheck + lint + `npm test` green, new behaviour covered by tests, no new advisor/security warnings.

## Architecture
- **Next.js App Router on Vercel.** Server Components by default; `'use client'` only for interactive leaves (forms, Dexie, voice input). Data reads happen on the server; mutations go through Route Handlers (`src/app/api/**/route.ts`) or Server Actions.
- **Supabase** = Postgres + Auth + RLS. All durable data lives in Postgres; the browser only holds drafts and the unsynced queue.
- **AI** = Gemini Flash, server routes only, JSON mode + Zod. No local LLM, no client-side ML/WASM models.
- **Files** = PDFs rendered server-side, archived to Google Drive (`/StudFlow/<FY>/<MM>/…`); weekly DB backup to Drive. Two sign-ins: `GOOGLE_DRIVE_OAUTH_*` (a person's account, `drive.file` scope, made by `node scripts/drive-connect.ts`; wins when set) or a service account (Shared Drive only). Archiving starts in `after()`.
- Layout:
  ```
  src/app/                  routes, layouts, route handlers
  src/components/           UI (server by default)
  src/lib/billing-math.ts   ALL money/tax/weight arithmetic (pure)
  src/lib/bill-form.ts      billing screen state → draft (pure); bill-draft.ts: draft → sync payload
  src/lib/print-documents.ts  issued bill → print slots of specs/print-templates.md (pure)
  src/lib/schemas/          Zod schemas; client components import their *types* only
  src/lib/api/http.ts       route wrapper: session, Zod, error shape, SQLSTATE → HTTP
  src/lib/data.ts           all reads (numerics cast `::text`); src/proxy.ts refreshes the session
  src/lib/supabase/         server.ts (cookie session → RLS), client.ts (browser), admin.ts (secret key, cron/admin only)
  src/lib/offline-db.ts     Dexie tables + atomic moves; offline-sync.ts (queue), master-cache.ts (copy),
                            offline-client.ts (browser wiring). Load ONLY through offline.ts (lazy)
  public/sw.js              caches /billing's own files; never an API reply or a page with data
  src/lib/{gemini,drive-backup,telegram}.ts   server-only integrations
  supabase/migrations/      append-only SQL
  tests/                    Vitest; tests/db = PGlite + Supabase shim
  ```

## Security boundaries (non-negotiable)
- Allowed `NEXT_PUBLIC_*` vars: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (publishable/anon — safe only because RLS is on), `NEXT_PUBLIC_VAPID_PUBLIC_KEY`. **Nothing else.**
- Server-only secrets: `SUPABASE_SECRET_KEY` (service role), `GEMINI_API_KEY_PRIMARY`, `GEMINI_API_KEY_FALLBACK`, `TELEGRAM_BOT_TOKEN`, `GOOGLE_DRIVE_*`, `VAPID_PRIVATE_KEY`, `CRON_SECRET`.
- Every module that reads a secret starts with `import 'server-only'`. Client components never import from such modules or receive their objects as props.
- User-facing routes use the cookie-session Supabase client so RLS applies. The secret key is used only by cron/admin code.
- Zod `safeParse` on every route-handler input (body, params, search params), every external response (Gemini, Telegram, Drive, rate source) and every Dexie record before sync. Failures → 4xx with `{ error: { code, message } }`; never leak stack traces, SQL or keys.
- AI output is an untrusted *draft*: it may pick customers/items/quantities, never prices, tax, weights or totals. Customer/voice text is data, never instructions.
- Cron routes require `Authorization: Bearer ${CRON_SECRET}`. No secrets or PII in logs.

## Billing & accounting rules
- `src/lib/billing-math.ts` is the **only** place money, GST, weights and totals are computed: pure functions, no I/O, no `Date.now()`, exhaustively unit-tested. The DB **verifies** invariants (CHECK constraints) and never rounds or derives billed figures.
- No floating-point money: integer paise internally (fixed-scale integers for rates and weights), explicit rounding, amounts cross JSON boundaries as decimal strings (`"1180.00"`). DB scales: money `numeric(14,2)`, billing rates `(14,6)` (small studs are quoted per 1000), metal rates `(14,4)`, billed line weights `(14,6)`, ledger weights `(12,3)`, unit weight `(12,6)`.
- Weight (steel): `unit_weight_kg = (d² / 162.2) × (L / 1000)`; manual override sets `unit_weight_is_manual`.
- GST: `place_of_supply = '33'` → CGST and SGST at rate/2 each, computed separately (so they are always equal); otherwise IGST only.
- Charges: `delivery_taxable` → packing + delivery join the taxable value before GST. `freight_paid_by = 'buyer_to_pay'` → freight shows on the DC (`deliveries.freight_amount`) and the invoice `delivery_charge` is 0.
- `grand_total = subtotal + packing + delivery + cgst + sgst + igst + round_off`, a round-off must land on a whole rupee, `|round_off| < 1`.
- `sync_invoice` re-verifies what a direct `/rpc` call could forge: line = qty × rate (±½ paisa), subtotal = Σ lines, GST within 1 paisa per line of the declared rates. `billing-math.ts` must stay inside that band.
- Business dates are **Asia/Kolkata calendar dates**; FY runs Apr–Mar, labelled `26-27`. Never derive invoice dates/FY from UTC server time without converting.
- Numbering: `INV/<FY>/<seq>` and `DC/<FY>/<seq>` (≥4 digits, ≤16 chars) are assigned **only** by Postgres at sync — gapless per FY, idempotent on `client_temp_id = 'OFFLINE-<uuid>'`. Every bill, online or offline, gets a `client_temp_id` and goes through the queue. One bill per transaction. A retry must re-send the **identical** payload: an edited one gets 409 (`23505`) naming the issued number.
- `invoice_date`: today or up to 31 days back (IST). Older bills must be re-dated.
- Invoices are never deleted (GST): cancel via `cancelled_at` + `cancellation_reason`; issued amounts must be immutable (`private.invoices_guard_issued`).

- `tests/billing-math.test.ts` is **frozen** (SHA-256 `E3D2EEC31F75B01ABECB500E6C2E48A965E789C4DFECF8784334730403B9DB6A`): never edit it. `tests/db/billing-math-alignment.test.ts` proves the math and the DB agree; keep both green.
- Per that contract: selling rates are whole paise; charges on a mixed-rate bill, or any untaxed seller charge, are billed as explicitly classified lines; buyer-to-pay charges go to the DC and are 0 on the invoice.

## Sprint 2 decisions (approved by the owner, 24 Nov 2026)
`is_sez` customers get IGST · packing is always taxable, `delivery_taxable` covers delivery only · one company profile, frozen on each invoice · GST stored per line · job-work bills link to party-DC lots, which close within 1% of inward weight or with a reason · receipts go through one atomic RPC. UI copy and print layouts: `specs/`.

In the code (002 adds `company_profile`, `job_work_returns`, `payments`):
- The browser sends a *draft* plus the total it showed; `/api/invoices/sync` recomputes with the same `composeBill` and refuses a mismatch (`TOTAL_CHANGED`). Never accept amounts from the client.
- `amount_paid` changes only through `record_payment` / `void_payment` (owner). Cancelling needs all receipts voided, and gives returned material back to its lot.
- An untaxed delivery, or any charge on a mixed-rate bill, becomes its own line ('Packing charges', 'Delivery charges', 'Delivery, recovered at cost'); the challan leaves those names out.
- `print.css` is the spec CSS verbatim (tested); exactly one `@page` rule per print job.
- API errors reach the user only through the `OWN_SENTENCES` allowlist in `api/http.ts`.
- Keyboard: Enter advances (`data-enter-skip` fields stay on Tab), Ctrl+Enter saves, Alt+N new.

## Offline rules (Sprint 3A)
- `/billing` stays **static with no data** (`dynamic = 'error'`): it is the offline shell, and the proxy lets a PC with a session cookie open it while the cloud is down. Data comes from `/api` (RLS) or Dexie.
- A bill has one `OFFLINE-<uuid>` from the first moment: draft → queue (one transaction) → issued. Edits after a refusal keep the id. Never mint a second id for the same bill, never change a queued `draft`.
- `/api/invoices/sync` passes a refusal on only after checking that the id has no invoice: otherwise 409 `ALREADY_ISSUED` with `details.issued`. Failures ≥ 500 prove nothing and are resent.
- Queue: only a `pending` bill never sent, or a `rejected` one, may be edited; `pending` can never be dismissed. Network, 5xx, 401, 403 and `NOT_READY` stop the run and keep the bill.
- `searchCustomers` / `searchStuds` / `openLots` fall back to the copy on network loss or 5xx, never on 401/403. Sign-out clears the copy and the shell; unsent bills stay.
- Dexie opens with `chromeTransactionDurability: 'strict'` (power cuts). New tables or indexes: add `this.version(2)`, never edit version 1.

## Database rules
- SQL must run on Supabase Postgres 15+. Migrations are append-only `supabase/migrations/NNN_name.sql`; never edit one that has been applied. Run `npm run db:verify` (PGlite) before applying.
- New-table checklist: RLS on; policies `to authenticated` gated by `(select private.is_staff())` / `(select private.is_owner())` (never `using (true)`); explicit grants after `revoke all … from anon, authenticated, service_role` (Supabase grants nothing by default since 30 Oct 2026, #45329; `service_role` gets only what cron needs); FK indexes; FKs `NO ACTION`; `private.stamp_row` + `private.log_change` triggers if mutable; every numeric column bounded above (`< 'Infinity'`: NaN passes `>= 0`).
- `SECURITY DEFINER` only for deliberate RPCs and `private.*` helpers: `set search_path = ''`, schema-qualified names, explicit authorization check, `revoke execute … from public, anon`. Views use `with (security_invoker = true)`.
- Multi-table writes that must be atomic are plpgsql RPCs (supabase-js has no client transactions). Invoices + items + DC are created only by `public.sync_invoice(jsonb)`.
- `private` schema (not exposed by the Data API): `app_users` (access allowlist), `document_sequences` (gapless counters), `audit_log` (edit log, CGST Rule 56(8)), helpers. Lock order is always INV → DC → job-work lots by id.
- Access: only users listed in `private.app_users` can read or write anything. Bootstrap the owner in the SQL editor:
  `insert into private.app_users (user_id, display_name, role) select id, 'Owner', 'owner' from auth.users where email = '<owner email>';`
- Go-live: open **both** series with the last numbers the old system used (0 = fresh start); billing is refused until then, later FYs roll forward by themselves:
  `insert into private.document_sequences (series, fiscal_year, last_value) values ('INV', '26-27', <last>), ('DC', '26-27', <last>);`
- Go-live: fill in the Company page (billing is refused without it); run migrations 001 then 002.
- Go-live: turn off public sign-ups in Supabase Auth, and confirm the Data API gate registered (the migration warns if not).

## Performance budget
- Browser ≤ 150 MB on the billing screen after 30 min of use; first-load JS ≤ 170 KB gzip per route (check `next build`).
- No heavy client deps (UI kits, chart libs, moment, full lodash); prefer native `Intl`. Dynamic-import rarely used features (print, voice, AI panels).
- Dexie holds only drafts, the sync queue and a small master-data cache — never invoice history or PDFs. Paginate lists server-side (≤ 50 rows).
- Service worker caches the app shell + static assets only; data is network-first.

## Conventions
- TypeScript `strict` + `noUncheckedIndexedAccess`; no `any`, no unexplained `!`. Types inferred from Zod (`z.infer`) or generated Supabase types.
- Files kebab-case, components PascalCase, DB columns snake_case. Comments explain *why*, not what.
- UI: large type (≥ 18px base), keyboard-first (Enter advances, shortcuts for save/print), mobile-first, zero clutter.
- Commands: `npm test` (all Vitest), `npm run db:verify` (schema + RLS tests), `npm run lint`, `npm run typecheck`, `npm run build`, `npm run dev`; `npm run --silent seed:sql > seed.sql` writes the trial data for the SQL editor (refuses once an invoice exists).
