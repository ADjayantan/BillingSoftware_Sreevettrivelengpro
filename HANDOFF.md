# StudFlow: hand-over (26 Nov 2026, evening)

For the next AI coding agent. `AGENTS.md` holds the rules every agent keeps; read `CLAUDE.md` and `PROJECT_BRIEF.md` first, then this.

## Where it stands

- **Live** (read by Claude on 26 Nov, read-only): the site `studflow-six.vercel.app` runs commit `64ed469`; GitHub `main` is `64ed469` too. Antigravity made `f71a1e3` (fixes) and `64ed469` (loading shell, link prefetch, sign-in key cache, region bom1) and deployed both.
- **Live database** `studflow-production`: migrations 001–008, two owner logins, the Company page filled, public sign-ups off, no bills. 001–008 are applied; `009_drive_link.sql` is written and waits for the owner's yes; the next change of schema is `010_*.sql`.
- **Not ready for the first bill:** the INV and DC counters are not opened (`specs/golive-runbook.md`, section 3). Billing is refused until the owner gives the last numbers of the paper book (or 0) and says yes to writing them; a bill saved before that waits on the device and becomes real the moment the counters open.
- A push does not deploy: pushing `3fff5dc` started no Vercel deployment, and GitHub shows no Vercel status for any commit (the project is not connected to Git; deploys are made with the CLI).
- **Connect Google Drive from the Company page** (`specs/drive-button.md`, owner: "You decide"): built after `3fff5dc`, with migration `009_drive_link.sql`; not committed, not on live. Before it works on live: 009 on live, a deploy, the Google OAuth client allowing `https://studflow-six.vercel.app/api/drive/callback` (a "Web application" client), its consent screen "In production", and `CRON_SECRET` of at least 32 characters. Until then the four Drive settings saved on Vercel on 24 Nov keep working as before.
- After `5bdb1d2` (25 Nov), each approved by the owner: the new look part 1 (`specs/new-look.md`, migration 008); the clean look ("AJIO as the reference"); what each company owes on Customers.
- **The PC app** (`desktop/`, `specs/desktop-app.md`, owner: "2 ok da. certificate la vanga vena da macha. ana ithu security ni enna panna num panni du"): built in this folder on 26 Nov and **not committed**. `StudFlow-Setup.exe` 1.0.0 (SHA-256 in `desktop/README.md`) is installed on the owner's PC and opens the live sign-in page. Its Print goes straight to the printer kept for A4 or A5 once the web part (print button, mic message, `src/lib/desktop.ts`) is deployed; until then Print opens the Windows print window.
- Checked on 26 Nov after the PC app: the root suite, database tests, lint, typecheck, build; in the practice copy, inside the program: the keyboard walk 42, the cloud-down walk 13, the program's own checks 21; the keyboard walk in Edge 42; `desktop/scripts/check-exe.sh`, 19 locks of the built exe. Not checked: the owner's real printer, phone, and Google Drive.
- The walks now wait until React has taken a control over and the grey loading shell has gone: since `64ed469` pages arrive in parts, and the Edge walk on `main` stopped at "Record money" before that.
- The print design is approved by the owner ("Nalla irukku"). Do not redesign the bill.
- `handoff/ai-fill-fix.patch`: an unfinished change of another session (retired Gemini model, time limit, built-in parser). Run all checks before keeping it.
- Known and not fixed, because that patch owns the file: the built-in parser of dealer messages (`src/lib/gemini.ts`) drops the first grade when it stands on the same line as "Rs/kg:".
- Money for dues from before the software is written by lowering the customer's opening balance: no receipt exists for it yet (part 3).

## Never

- Change `tests/billing-math.test.ts` or an applied migration (001–008).
- Read out, print, commit or paste a secret, or a real GSTIN, bank account, phone or address. `.env*` stays ignored. Do not open the env files: tests, lint and build need none of them.
- Run `npm run dev` or `next start` in a folder with the env files: both point at the live database (`next start` also at the real Drive). Use `handoff/practice-copy/`. Point the PC app's development run only at the practice copy.
- Commit, push, deploy, migrate or write the live database, or send Telegram messages, without the owner's yes, each time.
- Start review agents or mutation testing: the owner ruled them out.

## Working with the owner

Answers in simple Tanglish, short. Not a software person: show a picture of real screens with made-up data first, build after the yes. When a login, dashboard switch or key is needed: stop, give one line with the exact click, wait for "done". Finish one part, verify it, report, stop.

## Commands

`npm ci` · `npm test` · `npm run db:verify` · `npm run lint` · `npm run typecheck` · `npm run build`

`handoff/practice-copy/` (Windows, Node 24, Edge): the app against an in-memory database, all live settings blanked, made-up data, and the walks above; `fresh.mjs` runs one on fresh data. See its `README.md`. The PC app: `desktop/README.md`.

## Waiting, only when the owner says so

1. INV and DC counters: the last numbers of the paper book (or 0), then the runbook's block on live.
2. Commit and push the Drive button; migration 009 on live; deploy (this also brings the PC app's straight printing); then the owner's Google Cloud steps for the button.
3. Hosting: Vercel Hobby forbids a company's use. Netlify Free (hard monthly stop) or Vercel Pro; not decided.
4. One real A4 and one real A5 print from the PC app on the shop printer; the owner's phone; the real Google Drive.

## The parts of the new look

Owner: "not professional, not easy to use", "like Zoho billing, free", "no Tanglish in the software, easy English", "AJIO as the reference, clean". Zoho and AJIO are measures, never copied. One company, the owner's own.

1. New look, menu, Home, Bills, Money received, Send goods, Find, New bill in three steps, the clean look, what each company owes: **built and approved**. The PC app: **built**, waiting for the owner's first real print.
2. Quotation that becomes a bill in one click.
3. Customer page: statement, receipt for dues from before, UPI QR.
4. Credit note.
5. Reports and the GSTR-1 file.
6. Expenses and suppliers. Later: e-way bill, recurring bills, stock.

Build one part, verify it, show pictures of the real screens with made-up data, stop.
