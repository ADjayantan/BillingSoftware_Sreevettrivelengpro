# StudFlow: rules for every AI agent (Antigravity, Codex, Claude and others)

The billing and dispatch app of the owner's stud-threading company in Tamil Nadu. Before changing anything, read `CLAUDE.md` (how the code must be written), `PROJECT_BRIEF.md` (what it is for) and `HANDOFF.md` (where it stands, what waits).

## Talking with the owner

- Reply in simple Tanglish, short. The owner is not a software person.
- Anything the owner will see: show pictures of the real screens with made-up data, build after the yes. Finish one part, check it, report, stop.
- When a login, a dashboard switch or a key is needed: stop, give one line with the exact click, and wait for "done".

## Only with the owner's yes, each time

Commit, push, deploy, change the live database, send a Telegram or WhatsApp message.

## Never

- Open, print or copy `.env.local` or `.env.production.local`: they hold the live keys. Never put a secret, or a real GSTIN, bank account, phone or address, into a file, a message or a test.
- Run `npm run dev` or `next start` in this folder: both env files point at the live database, and a bill made there takes a real bill number. To look at screens, use `handoff/practice-copy/` (an in-memory database with made-up data).
- Change `tests/billing-math.test.ts` or migrations 001 to 004, or any migration that has been applied: add a new one.
- Start review agents or mutation testing: the owner ruled them out.
- Copy another product's name, logo or screens: Zoho and AJIO are only measures.

## Done means

`npm test`, `npm run db:verify`, `npm run lint`, `npm run typecheck` and `npm run build` all pass, and the new behaviour has tests.
