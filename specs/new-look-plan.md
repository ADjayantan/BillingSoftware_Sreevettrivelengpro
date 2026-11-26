# New look, part 1: plan

Spec: `specs/new-look.md`. Done solo, tests first, no new packages.

Limits that hold in every step: `/billing` static and ≤ 170 KB; frozen files untouched (`tests/billing-math.test.ts`, migrations 001–004); no amount computed outside `billing-math.ts` or the database; no real company data; the files of `handoff/ai-fill-fix.patch` (`gemini.ts`, `api-client.ts`, `parse-bill/route.ts`, `.env.example`) stay as they are so that it still applies.

1. **Database** `supabase/migrations/008_home.sql`, `tests/db/home.test.ts`
   - `find_bills(p_q text, p_show text, p_month date, p_customer uuid, p_today date, p_skip int, p_take int) → jsonb {counts{all,open,overdue,paid,cancelled}, shown{bills,total,balance}, rows[]}`
   - `home_figures(p_today date) → jsonb`, `receipts_found(p_q, p_month, p_skip, p_take) → jsonb`, `goods_to_send() → jsonb`
   - tests: figures against hand-counted bills; cancelled out; part paid; TDS-settled; `%` and `_` typed literally; outsider and signed-out refused; amounts are strings
2. **Reads** `src/lib/schemas/home.ts`, `src/lib/data.ts`, `GET /api/invoices` (q, show, month, customer, page), `GET /api/customers/[id]/last-bill`; tests in `tests/api/home.test.ts`
3. **Pure parts** `src/lib/bill-state.ts` (`billState`, `dueWords`), `src/lib/look.ts` (`initials`, `greeting`, `salesBars`); `tests/look.test.ts`
4. **Look** `globals.css`, `components/icon.tsx`, `page-head.tsx`, `pill.tsx`
5. **Frame** `(app)/layout.tsx`, `components/frame/*`, `lib/company-name.ts`, `lib/queue-note.ts`, proxy, manifest, sign-in; `tests/frame.test.ts`, `tests/proxy.test.ts`
6. **Pages** home, bills, bill, money, dispatch, find, more
7. **New bill**: same state and handlers, new layout; *Same items again*, old balance
8. **English** everywhere: billing, rates, margin words, metal-rate Telegram, WhatsApp, reminders
9. **Check**: typecheck, lint, tests, build, first load; real browser on the practice copy (PC, phone, keyboard, cloud down, print); pictures; CLAUDE.md, HANDOFF.md

Review focus, each with a test or a browser check: a customer name of 120 letters; a bill of ₹9,99,99,999.00 in every list; no bill at all; a staff login (no Excel book); the cloud down while Home is open; an old draft from before this change opened on New bill.
