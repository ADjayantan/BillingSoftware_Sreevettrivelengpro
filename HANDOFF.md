# StudFlow: hand-over (25 Nov 2026)

For the next AI coding agent. Read `CLAUDE.md` (the rules; they hold for every agent) and `PROJECT_BRIEF.md` first, then this.

## Where it stands

- Live site = commit `fb10539`. `main` has gone on to `7ef390d` (products, first bill for a new customer, monthly Excel, the owner's own printed bill, P.O. number) and this note. Pushed to GitHub, **not deployed**.
- Live database has migrations **001–004 only** (read on 25 Nov 2026) and no business data. `7ef390d` needs **005, 006, 007 first, in that order**, then the deploy. Never the other way round, never back to a version before 005 afterwards.
- Vercel project `studflow` is not connected to Git: a push does not deploy. If it is ever connected, run 005–007 before that.
- Checked at `7ef390d`: 955 tests, lint, typecheck, build; `/billing` first load 161.1 KB (limit 170).
- The print design is approved by the owner ("Nalla irukku"). Do not redesign the bill.
- `handoff/ai-fill-fix.patch`: an unfinished change of another session (retired Gemini model, time limit, built-in parser). Uncommitted there; it applies cleanly on `7ef390d` (`git apply handoff/ai-fill-fix.patch`), with 1083 tests and lint green there; typecheck and build were not run. Run all checks before keeping it.

## Never

- Change `tests/billing-math.test.ts` or migrations 001–004.
- Read out, print, commit or paste a secret, or a real GSTIN, bank account, phone or address. `.env*` stays ignored. Do not open the env files: tests, lint and build need none of them.
- Run `next start` with `.env.production.local` (live keys): it writes to the real Drive.
- Commit, push, deploy, migrate the live database or send Telegram messages without the owner's yes, each time.
- Start review agents or mutation testing: the owner ruled them out.

## Working with the owner

Answers in simple Tanglish, short. Not a software person: show a picture of real screens with made-up data first, build after the yes. When a login, dashboard switch or key is needed: stop, give one line with the exact click, wait for "done". Finish one part, verify it, report, stop.

## Commands

`npm ci` · `npm test` · `npm run db:verify` · `npm run lint` · `npm run typecheck` · `npm run build`

## Waiting, only when the owner says so

1. Live migrations 005 → 006 → 007; then deploy.
2. Owner: fill the Company page on live, open the INV and DC series (last used numbers), give logins access (`private.app_users`).
3. Check with the real Google Drive and a phone. Vercel Hobby and a fourth cron job.
4. The new look (below): model approved to go on, **nothing of it is built**.

## Next work: the new look

Owner's words: not professional, not easy to use. Model: open `specs/ui-model/index.html#home` (also `#new #bills #bill #money #customer #enter`); exact sizes and colours are in `specs/ui-model/style.css`. All figures there are made up.

**Look.** Light only. canvas `#f2f5f3`, surface `#fff`, ink `#12211a`, muted `#5b6b63`, lines `#e0e7e3`/`#c9d4ce`, brand `#0f5c42`/`#0b4a35`, soft `#e5f2ec`, brass `#efc050` (text `#2c2102`); late `#b4233b` on `#fdecef`, due `#915107` on `#fdf1dc`, part paid `#1d5c9f` on `#e8f1fb`, paid `#0a6141` on `#e1f3ea`. System fonts only. Inputs 17–18 px, lists 15–16 px, total 37 px. A status is always icon + word. Contrast at least 4.5.

**Frame.** Side bar 236 px, dark green, gear, company name, brass "New bill" (Alt N); Home, Bills, Customers · Goods: Products, Job work, Metal rates · Office: Excel books, Company; connection pill; user. Up to 820 px: green bar on top, bar at the bottom (Home, Bills, ＋, Customers, More).

**Screens.**
- Home (new, `/home`): New bill, Money received, Send goods, Find and print; today, this month, to collect, overdue; "Collect first" with WhatsApp reminder; "To dispatch"; sales by month; "Safe and in order".
- Bills: find by customer, number or P.O. (today: number only); All, To collect, Overdue, Paid, Cancelled with counts; balance and status.
- One bill: the bill as printed on the left (`Sheets`, server side); balance, dispatch steps, what happened on the right; Print, WhatsApp, Record payment on top.
- New bill: 1 Customer, 2 Items, 3 Packing and delivery; HSN and GST as small text from the product, still editable; "Same items again", "Often bought"; total stays on the right with Save (Ctrl+Enter), Preview, Clear.
- Money received: customer → unpaid bills → amount filled in → UPI, Cash, Bank, Cheque → Save.
- Customer page: owes now, overdue, this year, usually pays in; bills; usually buys. Sign-in page. Icon to install on PC and phone.

**Limits found in the code.**
- `(app)/layout.tsx` also wraps `/billing`, which is static and the offline shell: no data in the frame on the server. A count on "Bills" comes from the browser, after loading. Only about 9 KB of script is left on `/billing`.
- `proxy.ts` sends `/` to `/billing`; with the cloud down it must still do so. `sw.js` and `tests/service-worker.test.ts`, `tests/proxy.test.ts` pin this.
- Sums for Home and the customer page: a new migration **008** with read-only functions gated by `private.is_staff()` (amounts as text), and a `search_text` column for bills like the one in 005/006. Money arithmetic otherwise only in `billing-math.ts`. `cancelled_at` bills count nowhere.
- Delivery steps are `pending, packed, dispatched, delivered`. Reminder wording only through `whatsapp.ts`. Receipts only through the existing payments route, with a kept `client_receipt_id`.
- Keep the Enter flow, the offline rules, "GST % is typed by a person", and the print sheets.

**Order.** (1) look, frame, sign-in, Bills, one bill; (2) New bill; (3) Home, Money received, Send goods, customer page, icon. After each: checks, pictures to the owner, stop.
