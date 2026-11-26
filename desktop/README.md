# StudFlow on the PC

A small Windows program that opens the live site (`https://studflow-six.vercel.app`) in its own window, prints bills straight to a printer, and keeps the PC and the login safe. It holds no database and no key. Why each part is as it is: `specs/desktop-app.md` (approved by the owner, 26 Nov 2026).

## For the owner

- **Install:** double-click `StudFlow-Setup.exe`. It installs for this Windows user (no admin), puts StudFlow on the desktop and in the Start menu, and opens. It needs Windows 10 or 11, 64-bit (Electron runs on nothing older).
- **Copied by pen drive:** Windows asks nothing. **Downloaded** (Google Drive, a browser): Windows may say "Windows protected your PC". Click **More info**, then **Run anyway**, once. The file has no paid certificate; that is the only reason.
- **Is it ours?** In PowerShell, `Get-FileHash .\StudFlow-Setup.exe` must show the SHA-256 of that version below. Never install a StudFlow-Setup.exe that came as a link from someone.
- **Print:** on a bill's print page, Print sends it straight to the printer kept for A4 or for A5. The first time it asks which printer, with "Remember this printer" ticked. **Change printer** asks again.
- **Voice billing** works in Chrome or on the phone, not in the PC app.
- **Remove:** Settings → Apps → StudFlow. Bills not yet sent stay on the PC; on a shared PC, sign out first.

## Versions

| Version | Made | Electron | SHA-256 of StudFlow-Setup.exe |
|---|---|---|---|
| 1.0.0 | 26 Nov 2026 | 45.5.0 | `2422744ff38a4d13dfc5a8a3883f651bb9deeca023664b527a9912450ec19aef` |

## Make it (Windows, Node 24 or newer, Git Bash)

```bash
cd desktop
npm ci
npm run icon              # only when public/icon-512.png changes
npm run make              # out/make/squirrel.windows/x64/StudFlow-Setup.exe
bash scripts/check-exe.sh # fuses, refused switches, a changed archive, the SHA-256
```

- npm 11 asks before running install scripts: `allowScripts` in `package.json` lets electron-winstaller pick its 7-Zip.
- Raise `version` in `package.json` for every new Setup, and add its row above.

## Every two months

Electron carries its own Chrome, and Chrome needs its safety fixes. About every two months, or soon after Electron announces a security fix: move `electron` and the Forge packages to the newest stable, raise the version, `npm install`, `npm run make`, `bash scripts/check-exe.sh`, run the practice checks below, write the SHA-256 above, and give the owner the new Setup. It installs over the old one; nothing is lost. There is no automatic update on purpose: an unsigned updater cannot be trusted.

## Try it (the practice copy, never the live site)

`npm start` with `STUDFLOW_URL=http://localhost:3100` opens the practice copy (`handoff/practice-copy/README.md`). Only a development run reads these; the installed exe ignores them:

- `STUDFLOW_URL`: only `http://localhost:<port>` or `http://127.0.0.1:<port>`.
- `STUDFLOW_PROFILE`: its own folder (otherwise `%APPDATA%\StudFlow-dev`, never the installed app's).
- `STUDFLOW_PDF_DIR`: printing writes PDFs there instead of paper; downloads go there too.
- `STUDFLOW_NO_BROWSER=1`: links are written to the log instead of opened.

From the project folder, each on fresh data:

- `node handoff/practice-copy/fresh.mjs . handoff/practice-copy/desktop-check.mjs`: 21 checks of the window, links, permissions, printing, the Excel download, the mic, a second start, no site to reach.
- `node handoff/practice-copy/fresh.mjs . --program 9360 handoff/practice-copy/walk.mjs`: the keyboard walk (42) inside the program.
- `node handoff/practice-copy/fresh.mjs . --program 9361 handoff/practice-copy/outage.mjs`: the cloud-down walk (13) inside the program.

## Where things are

- `src/policy.ts`: every rule, pure, tested from the root suite (`tests/desktop-policy.test.ts`). A new permission, kind of link or call from the page goes here first, with its test.
- `src/main.ts`: applies the rules to Electron: the window, the locks, printing.
- `src/preload.ts`: the bridge, two calls (`print`, `choosePrinter`), no arguments. The page side: `src/lib/desktop.ts`.
- `forge.config.js`: the Setup and the fuses burnt into the exe.
- `APP_ORIGIN` in `src/policy.ts` is the only site the program opens. If the site moves (Netlify, an own domain), change it there, raise the version, make, reinstall.
