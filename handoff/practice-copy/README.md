# Practice copy

The app against an in-memory database with every migration and made-up data, for looking at screens and walking through them in a real browser. Tools, not part of the app: lint leaves this folder out, and what they write (pictures, browser profiles) stays in its subfolders, which git ignores.

Nothing here can reach the live project: every name in the env files is set to empty, the build is searched for live values before it starts, and any connection that would leave the PC is refused (`only-local.mjs`).

Needs Windows, Node 24, Microsoft Edge and Git Bash. From the project folder:

1. `bash handoff/practice-copy/build-practice.sh .` builds with the practice address and every live setting blanked.
2. `node handoff/practice-copy/local-check.mjs` starts it on http://localhost:3100 with a database on port 54321. Any password signs in `owner@studflow.test`, or `staff@studflow.test` for the staff view.
3. `node handoff/practice-copy/fill.mjs` adds made-up customers, products and 16 bills.

Checks, each on fresh data (start `local-check.mjs` again and fill again, or let `fresh.mjs` do both: `node handoff/practice-copy/fresh.mjs . handoff/practice-copy/walk.mjs`):

- `walk.mjs`: the day's work by keyboard, 42 checks.
- `outage.mjs`: the cloud goes down while a bill is made, 13 checks.
- `widths.mjs [widths…]`: every page at each window width; says what is too wide, out of its box or cut.
- `print-check.mjs`: 28 print jobs of A4 and A5 bills and challans, printed to PDF by Edge.
- `drive-check.mjs`: the Company page's Google Drive section (settings, not ready, connected by the button, Disconnect, staff), with pictures; 7 checks. Google itself is never reached.
- `desktop-check.mjs`: the PC app (`desktop/`, built with `npm run build` there): its window, links, permissions, straight printing (to PDF), the Excel download, the mic, a second start, no site to reach; 21 checks.

`fresh.mjs . --program <port> walk.mjs` (or `outage.mjs`) runs a walk inside the PC app: `ATTACH=<port>` makes `cdp.mjs` drive that program's page instead of starting Edge.

`APP` and `DB` (environment) point the scripts at another copy, for example `APP=http://localhost:3101 DB=http://127.0.0.1:54331`.
