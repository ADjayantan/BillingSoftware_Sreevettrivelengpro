# StudFlow: hand-over (26 Nov 2026)

For the next AI coding agent (the owner goes on in Google Antigravity). `AGENTS.md` holds the rules every agent keeps; read `CLAUDE.md` and `PROJECT_BRIEF.md` first, then this.

## Where it stands

- Live site = commit `fb10539`. GitHub `main` has everything below (pushed on 26 Nov, owner: "push pannu"). **Nothing after `fb10539` is deployed.**
- After `5bdb1d2` (25 Nov) came three things, each approved by the owner:
  1. **The new look, part 1** (`specs/new-look.md`, migration 008): menu, Home, Bills, bill page, Money received, Send goods, Find, New bill in three steps, every word in easy English.
  2. **The clean look** (26 Nov, "AJIO as the reference", approved "Nalla irukku"): white, thin lines, menu on top, one gold, Palatino titles. Nothing of AJIO's own.
  3. **What each company owes** on Customers (26 Nov, approved "Aamaa, sari"): balance with the opening balance, the late part, bills to collect, *Owes most* (`customer_balances` in 008).
- Live database has migrations **001–004 only** (read on 25 Nov 2026) and no business data. The deploy needs **005, 006, 007, 008 first, in that order**. Never the other way round, never back to a version before 005 afterwards. 008 only reads; the version before it works with it.
- Vercel project `studflow` is not connected to Git: a push does not deploy. If it is ever connected, run the migrations before that.
- Checked on 26 Nov: 1049 tests, 244 database tests, lint, typecheck, build; `/billing` first load 165.9 KB (limit 170). In a real browser, on a practice copy with made-up data: keyboard walk 42 checks, cloud-down walk 13, 28 print jobs, every page at 16 window widths from 320 to 1920 px, 120-letter names and one-crore bills. Not checked: the owner's phone and printer, the real Google Drive.
- The print design is approved by the owner ("Nalla irukku"). Do not redesign the bill.
- `handoff/ai-fill-fix.patch`: an unfinished change of another session (retired Gemini model, time limit, built-in parser). It still applies on top of all this (`git apply --check`). Run all checks before keeping it.
- Known and not fixed, because that patch owns the file: the built-in parser of dealer messages (`src/lib/gemini.ts`, used without a Gemini key; with the patch also when Gemini does not answer) drops the first grade when it stands on the same line as "Rs/kg:" ("Rs/kg: MS round 58.25 | EN8 84.25" loses MS).
- Money for dues from before the software is written by lowering the customer's opening balance: no receipt exists for it yet. A receipt for old dues belongs with part 3.

## Never

- Change `tests/billing-math.test.ts` or migrations 001–004.
- Read out, print, commit or paste a secret, or a real GSTIN, bank account, phone or address. `.env*` stays ignored. Do not open the env files: tests, lint and build need none of them.
- Run `npm run dev` or `next start` in a folder with the env files: both point at the live database (`next start` also at the real Drive). Use `handoff/practice-copy/`.
- Commit, push, deploy, migrate the live database or send Telegram messages without the owner's yes, each time.
- Start review agents or mutation testing: the owner ruled them out.

## Working with the owner

Answers in simple Tanglish, short. Not a software person: show a picture of real screens with made-up data first, build after the yes. When a login, dashboard switch or key is needed: stop, give one line with the exact click, wait for "done". Finish one part, verify it, report, stop.

## Commands

`npm ci` · `npm test` · `npm run db:verify` · `npm run lint` · `npm run typecheck` · `npm run build`

`handoff/practice-copy/` (Windows, Node 24, Edge): the app against an in-memory database with every migration, all live settings blanked, made-up data (`fill.mjs`), and the browser walks used above. See its `README.md`.

## Waiting, only when the owner says so

1. Commit and push this work; live migrations 005 → 006 → 007 → 008; then deploy.
2. Hosting: Vercel Hobby forbids a company's use. Netlify Free (hard monthly stop) or Vercel Pro; not decided.
3. Owner: fill the Company page on live, open the INV and DC series (last used numbers), give logins access (`private.app_users`).
4. Check with the real Google Drive, the owner's phone and printer. Vercel Hobby and a fourth cron job.

## The parts of the new look

Owner: "not professional, not easy to use", "like Zoho billing, free", "no Tanglish in the software, easy English", "AJIO as the reference, clean". Zoho and AJIO are measures, never copied. One company, the owner's own.

1. New look, menu, Home, Bills, Money received, Send goods, Find, New bill in three steps, the clean look, what each company owes: **built and approved**.
2. Quotation that becomes a bill in one click.
3. Customer page: statement, receipt for dues from before, UPI QR; icon to install on PC and phone.
4. Credit note.
5. Reports and the GSTR-1 file.
6. Expenses and suppliers. Later: e-way bill, recurring bills, stock.

Build one part, verify it, show pictures of the real screens with made-up data, stop.
