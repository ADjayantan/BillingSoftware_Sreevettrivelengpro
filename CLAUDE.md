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
  src/components/           UI (server by default); frame/ = menu, find box, "+" (around every page, without data)
  src/lib/billing-math.ts   ALL money/tax/weight arithmetic (pure)
  src/lib/bill-form.ts      billing screen state → draft (pure); bill-draft.ts: draft → sync payload
  src/lib/customer-form.ts  a new customer typed inside a bill (pure); customer-match.ts: who it may already be;
                            add-customer.ts: "Save & use"; counter-customer.ts: the server side of it
  src/lib/products.ts       product names, IDs, finding (pure); product-form.ts: Products page state (pure)
  src/lib/print-documents.ts  what an issued bill and its challan say (pure); bill-sheets.ts: the owner's bill drawn
                            from it; sheet.ts, text-width.ts, bill-art.ts: pen, measuring, gear and Vel (pure);
                            components/sheets.tsx → SVG, sheet-pdf.ts + latin.ts → PDF
  src/lib/schemas/          Zod schemas; client components import their *types* only
  src/lib/api/http.ts       route wrapper: session, Zod, error shape, SQLSTATE → HTTP
  src/lib/data.ts           all reads (numerics cast `::text`); src/proxy.ts refreshes the session
  src/lib/bill-state.ts     the state of a bill in words; goods-steps.ts, queue-note.ts, pay-ways.ts likewise (pure)
  src/lib/supabase/         server.ts (cookie session → RLS), client.ts (browser), admin.ts (secret key, cron/admin only)
  src/lib/offline-db.ts     Dexie tables + atomic moves; offline-sync.ts (queue), master-cache.ts (copy),
                            offline-client.ts (browser wiring). Load ONLY through offline.ts (lazy)
  public/sw.js              caches /billing's own files; never an API reply or a page with data
  src/lib/xlsx.ts           .xlsx writer (pure, no library); month-workbook.ts: one month as a book (pure);
                            month-data.ts: its reads; month-books.ts: the worker; drive-workbook.ts: its Drive file
  src/lib/{gemini,drive-backup,telegram}.ts   server-only integrations
  desktop/                  the PC app (Electron, its own npm project): src/policy.ts = every rule (pure, tested from
                            tests/), main.ts applies them, preload.ts = the bridge; src/lib/desktop.ts is its page side
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
- `next start` reads `.env.production.local`, the **live** keys: a test bill then goes to the real Drive. A local production run sets every name in the env files to empty first (an empty variable wins over the file). `npm run dev` reads `.env.local` only, which also points at the live database: look at screens on the practice copy (`handoff/practice-copy/`).

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
- `print.css` is the spec CSS verbatim (tested); exactly one `@page` rule per print job, with margin 0.
- API errors reach the user only through the `OWN_SENTENCES` allowlist in `api/http.ts`.
- Keyboard: Enter advances (`data-enter-skip` fields stay on Tab), Ctrl+Enter saves, Alt+N new.

## Products (migration 005, `specs/company-products.md`, approved 24 Nov 2026)
- `stud_items` is the whole product list; a stud is a product with a size. The product ID (`product_no`, shown `P0007`) comes from the database only: never typed, changed or used again. Without an own code `sku_code` holds the ID; own codes of the form `P<digits>` are refused. The ID is for typing and never goes on a bill.
- **GST % is typed by a person**: no default in the database, the forms or a bill line. `FormLine.gstFrom` says who gave it; only a hand-typed one passes to the empty line below. AI never gives one.
- What a picked product puts on a line is decided in one place, `filledBy` (`bill-form.ts`). On a job-work bill goods fill only the text; a SAC (99…) fills everything. Typing over a product, or switching the bill type, takes back what it filled and leaves what was typed.
- Finding has one order, cloud and PC copy alike (`findRank`): the ID, an own code, then part of `search_text` (kept by the database). For a typed number every other match is `loose`: Enter never takes it, and the number is never billed as a description.
- A product without a size is left out of margin check and AI fill (`.not('diameter_mm', 'is', null)`) and converts pieces ↔ kg only with a measured weight.
- New columns in copied rows: raise `SHAPE` in `master-cache.ts` so PCs fetch them once; that needs no new Dexie version.
- Once a product without a size exists, a version from before 005 cannot read the list: fix forward, do not roll back.

## First bill for a new customer, and the monthly Excel (migration 006, `specs/counter-and-books.md`, 25 Nov 2026)
- A new customer gets its uuid on the device and keeps it: `POST /api/customers` with `id` is idempotent, so a waiting bill never has to change. Without `id` it is the Customers page's plain insert.
- Never merge by itself: same GSTIN → *Use X*; like-sounding name or same phone (`lookAlikes`, the same code on server and device) → the owner chooses. Only the same GSTIN **and** `sameName` joins, and the bill says so (`note`).
- `new_customers` (Dexie version 2): pending → created | review | merged. The drain sends customers first; a bill whose customer is not settled is not sent, and in `review` it can be neither sent nor dismissed. Only a never-sent bill (`attempts` 0) may be moved to another customer.
- ₹50,000 and no address is said before saving (`previewBill`, `place: 'address'`); `firstUnfinished` decides where the cursor goes.
- What changed in a month is written by triggers in the sale's own transaction (`private.book_changes`); the book is made only from issued rows, by `invoice_date` (challans `dc_date`, receipts `received_on`). A worker finishes exactly the change ids it saw.
- One writer per month: `book_claim` (lease) → read → `book_hold` → upload (cut off well before the lease ends) → `book_done`. Unknown outcome keeps the lease. The Drive file id is stored before the file is made; a 409 is our own lost reply.
- Anything that changes a bill, receipt or dispatch calls `booksLater()` (`after()`); open devices ask `/api/books/run` every 10 minutes; `/api/cron/books` is the daily catch-up (a new cron path also goes into `CRON_PATHS` in `proxy.ts`).
- Owner only: `/books`, `/api/books*` (gate: `book_months()` refuses others). *Open* builds from the database, so it works without Drive.

## The owner's own bill (migration 007, `specs/own-bill.md`, approved 25 Nov 2026)
- One drawing for A4, A5 and the Drive PDF: change `bill-sheets.ts` and all three change. Units of the frame (100 wide), never mm or px. Nothing is cut: a text gets a `max` or is wrapped, and `tests/bill-sheets.test.ts` finds any mark off the paper, over another text or through a line; add new content to its `HARD` bills.
- `print-documents.ts` formats issued figures and adds nothing to them. What a bill says goes there, where it stands goes into `bill-sheets.ts`.
- Every text is told its width (Helvetica = Arial). Letters the PDF fonts lack go through `latin()`; a new sign needs a line there.
- The head comes only from the snapshot (`company_profile`: `tagline`, `factory_address`, `office_phone` …); a key an old snapshot lacks is null. No real GSTIN, bank or address in code or tests; the gear and the Vel are drawn in the code.
- P.O. number and date (`po_no`, `po_date`): left out of the sync payload when there is none, so that a bill sent before keeps its fingerprint. The same goes for every later addition to the payload.

## The new look, part 1 (migration 008, `specs/new-look.md`, approved 25 Nov 2026)
- **Every word the software says is easy English**: screens, Telegram, WhatsApp drafts. What it understands may be Tamil or Tanglish (`gemini.ts`). `tests/frame.test.ts` reads every file that speaks; the owner's chat is not part of it.
- The frame (`(app)/layout.tsx`) is also around the static `/billing`: no data in it on the server. The company name comes from this device (`company-name.ts`, taken off at sign-out), what waits from `queue-note.ts`.
- `MENU` and `MAKE` (`frame/menu.ts`) list only pages that exist. `?new` opens the empty form of a page. Alt+N: a page's own new record first (`useAltN`), else New bill; Ctrl+K: the find box.
- One place for each wording: `billState`, `STEP`, `deviceState`, `payWay`. A state is always a sign and words, never colour alone.
- Figures are added up by the database when asked (`home_figures`, `find_bills`, `receipts_found`, `goods_to_send`, `customer_balances`): read-only, run as the caller, staff only, amounts as text, "today" passed in. Cancelled bills count nowhere. Nothing is stored for them, and **no generated or search column on `invoices`**: `invoices_guard_issued` compares whole rows and would refuse every update.
- "Same items again" (`repeatGoods`) never copies a GST %.
- From `side:` (52rem) the menu stands on top (`.head`, then `.top-nav`, which sticks): a page has the window less 56 px, at most 1300 px. Look at 320, 390, 832, 1024, 1093 (a 1366 laptop at 125%), 1280, 1366 and 1536 (the owner's PC). Words inside a drawing shrink on a phone: the sales bars are boxes.
- The clean look (owner, 26 Nov 2026: "AJIO as the reference", approved the same day): white, thin lines, 3 px corners, no shadows; one gold (`accent`) for the main action, slate for what is chosen, crimson only for the thin lines; states without boxes; the serif (`--font-serif`) for titles only, never for numbers. Nothing of AJIO's own (name, logo, pictures). Tokens in `globals.css`; classes that a utility must be able to beat go into `@layer components`. Contrast ≥ 4.5 for text.

## The PC app (`desktop/`, `specs/desktop-app.md`, approved 26 Nov 2026)
- One window on `APP_ORIGIN` (`desktop/src/policy.ts`) and nothing else: other https links go to the normal browser, every other kind is refused. It holds no key. If the site moves, change `APP_ORIGIN`, raise the version, rebuild.
- Every rule is in `policy.ts`, pure and tested (`tests/desktop-policy.test.ts`); `main.ts` only applies them. A new permission, kind of link or call from the page goes there first, with its test.
- The bridge has two calls, `print` and `choosePrinter`, no arguments; the paper comes from the print page's own address. The page finds it in `src/lib/desktop.ts`, hand-checked (no Zod in the client).
- The installed exe never reads `STUDFLOW_*`, refuses debugging and safety-lowering switches (only what its caller passed: Electron adds `allow-file-access-from-files` to its own command line), and has fuses burnt in (`forge.config.js`). Development runs open only the practice copy on localhost, never the live site.
- No code-signing certificate (owner) and no automatic update. About every two months: newest Electron, raise the version, `npm run make`, `bash desktop/scripts/check-exe.sh`, the practice checks, and the SHA-256 in `desktop/README.md`.

## Offline rules (Sprint 3A)
- `/billing` stays **static with no data** (`dynamic = 'error'`): it is the offline shell, and the proxy lets a PC with a session cookie open it while the cloud is down. Data comes from `/api` (RLS) or Dexie.
- A bill has one `OFFLINE-<uuid>` from the first moment: draft → queue (one transaction) → issued. Edits after a refusal keep the id. Never mint a second id for the same bill, never change a queued `draft`.
- `/api/invoices/sync` passes a refusal on only after checking that the id has no invoice: otherwise 409 `ALREADY_ISSUED` with `details.issued`. Failures ≥ 500 prove nothing and are resent.
- Queue: only a `pending` bill never sent, or a `rejected` one, may be edited; `pending` can never be dismissed. Network, 5xx, 401, 403 and `NOT_READY` stop the run and keep the bill.
- `searchCustomers` / `searchStuds` / `openLots` fall back to the copy on network loss or 5xx, never on 401/403. Sign-out clears the copy and the shell; unsent bills stay.
- Dexie opens with `chromeTransactionDurability: 'strict'` (power cuts). New tables or indexes: add `this.version(3)`, never edit versions 1 and 2.

## Scheduled jobs
- Read with `readAllRows` (`src/lib/read-all.ts`): Supabase cuts every answer at 1000 rows and does not say so. The test stand-in cuts too (`pgliteFetch(db, actor, maxRows)`).
- Claim only what is proven: the backup counts each table it read; a reminder is recorded after Telegram took it (messages ≤ 4096 characters). A failed backup tells the owner on Telegram and undelivered reminders answer 502, in our own sentences only: an unexpected error's text may hold a credential (Telegram's address has the bot token in it).
- Which wording is true today is decided in one place, `reminderStage` (`whatsapp.ts`): day 0, 7 or 15, else `invoiceSummaryText`. On the days between, `last_reminder_stage` is null and `last_reminder_sent_on` still stops a second listing.

## Database rules
- SQL must run on Supabase Postgres 15+. Migrations are append-only `supabase/migrations/NNN_name.sql`; never edit one that has been applied. Run `npm run db:verify` (PGlite) before applying.
- New-table checklist: RLS on; policies `to authenticated` gated by `(select private.is_staff())` / `(select private.is_owner())` (never `using (true)`); explicit grants after `revoke all … from anon, authenticated, service_role` (Supabase grants nothing by default since 30 Oct 2026, #45329; `service_role` gets only what cron needs); FK indexes; FKs `NO ACTION`; `private.stamp_row` + `private.log_change` triggers if mutable; every numeric column bounded above (`< 'Infinity'`: NaN passes `>= 0`).
- `SECURITY DEFINER` only for deliberate RPCs and `private.*` helpers: `set search_path = ''`, schema-qualified names, explicit authorization check, `revoke execute … from public, anon`. Views use `with (security_invoker = true)`.
- Multi-table writes that must be atomic are plpgsql RPCs (supabase-js has no client transactions). Invoices + items + DC are created only by `public.sync_invoice(jsonb)`.
- `private` schema (not exposed by the Data API): `app_users` (access allowlist), `document_sequences` (gapless counters), `audit_log` (edit log, CGST Rule 56(8)), `book_changes` / `month_books` (Excel), helpers. Lock order is always INV → DC → job-work lots by id.
- Access: only users listed in `private.app_users` can read or write anything. Bootstrap the owner in the SQL editor:
  `insert into private.app_users (user_id, display_name, role) select id, 'Owner', 'owner' from auth.users where email = '<owner email>';`
- Go-live: open **both** series with the last numbers the old system used (0 = fresh start); billing is refused until then, later FYs roll forward by themselves:
  `insert into private.document_sequences (series, fiscal_year, last_value) values ('INV', '26-27', <last>), ('DC', '26-27', <last>);`
- Go-live: fill in the Company page (billing is refused without it); run the migrations in order (001–008).
- Go-live: turn off public sign-ups in Supabase Auth, and confirm the Data API gate registered (the migration warns if not).

## Performance budget
- Browser ≤ 150 MB on the billing screen after 30 min of use; first-load JS ≤ 170 KB gzip per route (check `next build`).
- No heavy client deps (UI kits, chart libs, moment, full lodash); prefer native `Intl`. Dynamic-import rarely used features (print, voice, AI panels).
- Dexie holds only drafts, the sync queue and a small master-data cache — never invoice history or PDFs. Paginate lists server-side (≤ 50 rows).
- Service worker caches the app shell + static assets only; data is network-first.

## Conventions
- TypeScript `strict` + `noUncheckedIndexedAccess`; no `any`, no unexplained `!`. Types inferred from Zod (`z.infer`) or generated Supabase types.
- Files kebab-case, components PascalCase, DB columns snake_case. Comments explain *why*, not what.
- UI: 16px base, 16.5px in boxes, 36px for the total of a bill; keyboard-first (Enter advances, shortcuts for save/print), mobile-first, zero clutter.
- Commands: `npm test` (all Vitest), `npm run db:verify` (schema + RLS tests), `npm run lint`, `npm run typecheck`, `npm run build`, `npm run dev`; `npm run --silent seed:sql > seed.sql` writes the trial data for the SQL editor (refuses once an invoice exists).
