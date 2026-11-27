# StudFlow: hand-over (27 Nov 2026, morning)

For the next AI coding agent. `AGENTS.md` holds the rules every agent keeps; read `CLAUDE.md` and `PROJECT_BRIEF.md` first, then this.

## Where it stands

- **Live** (checked by Claude on the evening of 26 Nov): the site `studflow-six.vercel.app` runs commit `ca6ecf6` (deploy `dpl_DtUasoJFmqd9KKLwgp2Lrgw5Ry3w`, region bom1); GitHub `main` is `ca6ecf6` too. Before it: `3fff5dc` (the PC app) by Claude; `f71a1e3` (fixes) and `64ed469` (loading shell, link prefetch, sign-in key cache, region bom1) by Antigravity.
- **Live database** `studflow-production`: migrations 001–009 applied, two owner logins, the Company page filled, public sign-ups off, no bills. The next change of schema is `010_*.sql`.
- **Not ready for the first bill:** the INV and DC counters are not opened (`specs/golive-runbook.md`, section 3). Billing is refused until the owner gives the last numbers of the paper book (or 0) and says yes to writing them; a bill saved before that waits on the device and becomes real the moment the counters open.
- **How live is changed**, each time with the owner's yes:
  - A push does not deploy: the Vercel project is not connected to Git. Deploy with `vercel deploy --prod --yes` from a clean `git worktree add --detach <folder> <commit>` with `.vercel/project.json` copied in, so only committed files go up (no env files, no `node_modules`, no 148 MB Setup). Write logs outside that folder: everything in it is uploaded. A CLI deploy records no commit; the deployment's file list shows what went up.
  - A migration: run the file's text in one `do` block that executes it and inserts the same text into `supabase_migrations.schema_migrations` as version `NNN` with its name, as 001–009 are recorded (`apply_migration` would stamp a date version, and `supabase db push` would then run the file twice). Compare the SHA-256 of `statements[1]` with the file's, and read the security advisor before and after.
- **Connect Google Drive from the Company page** (`specs/drive-button.md`, owner: "You decide"): live since the evening of 26 Nov. The owner has **not** pressed Connect yet: `private.drive_link` is empty, so copies still go through the four Drive settings saved on Vercel on 24 Nov (the page says "Connected. It was set up when StudFlow was put in."). Waiting for the owner: Connect in Chrome or Edge (the PC app shows how instead), and Google's consent screen "In production": while it is "Testing", the 24 Nov permission ends about 1 Dec 2026. If Connect answers "not ready": `CRON_SECRET` is shorter than 32 characters, or the OAuth client settings are missing. If Google answers "redirect_uri_mismatch": the OAuth client must allow `https://studflow-six.vercel.app/api/drive/callback` (a "Web application" client).
- After `5bdb1d2` (25 Nov), each approved by the owner: the new look part 1 (`specs/new-look.md`, migration 008); the clean look ("AJIO as the reference"); what each company owes on Customers.
- **The PC app** (`desktop/`, `specs/desktop-app.md`, owner: "2 ok da. certificate la vanga vena da macha. ana ithu security ni enna panna num panni du"): committed as `3fff5dc`; its web part is live with `ca6ecf6`, so Print goes straight to the printer kept for A4 or A5. `StudFlow-Setup.exe` 1.0.0 (SHA-256 in `desktop/README.md`) is installed on the owner's PC, and the owner is putting it on Appa's PC too. The built Setup is not in git: the owner keeps the 1.0.0 file, and a new build gets a new version and its own SHA-256 row. GitHub takes a 148 MB file only as a release file (the web upload stops at 25 MB, a push at 100 MB).
- Checked on 26 Nov after the PC app: the root suite, database tests, lint, typecheck, build; in the practice copy, inside the program: the keyboard walk 42, the cloud-down walk 13, the program's own checks 21; the keyboard walk in Edge 42; `desktop/scripts/check-exe.sh`, 19 locks of the built exe. After the Drive button: `npm test` 1216 (the 260 database tests among them), lint, typecheck, build; in the practice copy the Drive section 7 checks and the keyboard walk 42. On live after the deploy: the sign-in page answers 200, `/api/drive/*` 401 without a session. Not checked: the owner's real printer, phone, and the button's own Google Drive link.
- The walks now wait until React has taken a control over and the grey loading shell has gone: since `64ed469` pages arrive in parts, and the Edge walk on `main` stopped at "Record money" before that.
- The print design is approved by the owner ("Nalla irukku"). Do not redesign the bill.
- Money for dues from before the software is written by lowering the customer's opening balance: no receipt exists for it yet (part 3).

## Never

- Change `tests/billing-math.test.ts` or an applied migration (001–009).
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
2. Google Drive: the owner presses Connect Google Drive on the Company page (Chrome or Edge), and sets Google's consent screen to "In production" before about 1 Dec 2026.
3. Hosting: Vercel Hobby forbids a company's use. Netlify Free (hard monthly stop) or Vercel Pro; not decided.
4. One real A4 and one real A5 print from the PC app on the shop printer; the PC app on Appa's PC; the owner's phone; the real Google Drive.

## The parts of the new look

Owner: "not professional, not easy to use", "like Zoho billing, free", "no Tanglish in the software, easy English", "AJIO as the reference, clean". Zoho and AJIO are measures, never copied. One company, the owner's own.

1. New look, menu, Home, Bills, Money received, Send goods, Find, New bill in three steps, the clean look, what each company owes: **built and approved**. The PC app: **built and live**, waiting for the owner's first real print.
2. Quotation that becomes a bill in one click.
3. Customer page: statement, receipt for dues from before, UPI QR.
4. Credit note.
5. Reports and the GSTR-1 file.
6. Expenses and suppliers. Later: e-way bill, recurring bills, stock.

Build one part, verify it, show pictures of the real screens with made-up data, stop.
