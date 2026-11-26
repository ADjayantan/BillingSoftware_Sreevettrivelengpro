# Desktop App Implementation Plan

> **How it is carried out:** in this session, task by task, test first, by one agent. The owner has ruled out reviewer sub-agents and mutation testing. Nothing is committed, pushed or deployed until the owner says so.

**Goal:** a `StudFlow-Setup.exe` that installs a window locked to the live site, prints straight to a chosen printer, and keeps the PC and the login safe.

**Architecture:** `desktop/` is its own small npm project. `src/policy.ts` holds every rule as pure functions (tested from the root suite); `src/main.ts` applies them to Electron; `src/preload.ts` hands the page a two-call bridge. The web app learns of the bridge in `src/lib/desktop.ts` and uses it on the print page and the mic.

**Tech Stack:** Electron 45.5.0, Electron Forge 8.0.1 (Squirrel.Windows maker, fuses plugin), @electron/fuses 2.1.3, electron-squirrel-startup 1.0.1, TypeScript 6.0.3, @types/node 26.6.6, all pinned. Web: Next.js 16, React 19, Vitest 5.

**Spec:** `specs/desktop-app.md`.

## Global Constraints

- `APP_ORIGIN = 'https://studflow-six.vercel.app'`. The installed exe never opens another address; only a development run may, and only `http://localhost:<port>` or `http://127.0.0.1:<port>`.
- Every word the program or the page says is easy English (`tests/frame.test.ts` reads `src/lib/desktop.ts` too).
- No key, password or real phone number anywhere in `desktop/` or the tests (made-up: `910000000000`). Never type the owner's password; the practice copy signs in with any password.
- Never `npm run dev` or `next start` in this folder; tests against the practice copy only, never a test bill on live.
- No new client dependency; the bridge reader is hand-written (no Zod in the client bundle); `/billing` stays ≤ 170 KB.
- Commit, push and deploy only with the owner's yes, each time.

## Review Focus

1. **The PC is offline at start and the app has never been opened**: a "StudFlow could not open" window with Try again, never a blank or Chromium error page.
2. **The remembered printer was removed or renamed in Windows**: the printer list comes back; nothing goes to another printer.
3. **StudFlow started twice**: the first window comes to the front; no second window.
4. **Many printers, long and network names** (`\\SHOP-PC\HP LaserJet 1020 (Copy 2)`): at most eight in the list, default first, no duplicates, "Other printer" always there.
5. **Print pressed twice quickly**: one job; the second call answers `refused`.

---

### Task 1: The rules (`desktop/src/policy.ts`)

**Files:** create `desktop/src/policy.ts`, `tests/desktop-policy.test.ts`.

**Produces:** `APP_ORIGIN`; `type Paper = 'a4' | 'a5'`; `PAPER_SIZE: Record<Paper, 'A4' | 'A5'>`; `siteOrigin(packaged: boolean, override: string | undefined): string` (throws on a bad override); `isInside(url: string, origin: string): boolean`; `type LinkDecision = 'inside' | 'browser' | 'refuse'`; `decideLink(url, origin): LinkDecision`; `downloadAllowed(url, origin): boolean`; `printPaper(url, origin): Paper | null`; `type SavedPrinters = Partial<Record<Paper, string>>`; `readSavedPrinters(text: string | null | undefined): SavedPrinters`; `rememberPrinter(saved, paper, name): SavedPrinters`; `printerFor(saved, paper, available: readonly string[]): string | null`; `CHOOSER_LIMIT = 8`; `chooserList(printers: readonly { name: string; isDefault: boolean }[]): string[]`; `PRINT_REASONS = ['cancelled', 'failed', 'refused', 'no-printer'] as const`; `type PrintAnswer = { ok: true; printer: string } | { ok: false; reason: (typeof PRINT_REASONS)[number] }`; `REFUSED_SWITCHES: readonly string[]`; `refusedSwitch(argv: readonly string[]): string | null`. No import of `electron` or `node:*`.

- [ ] Tests first, each failing for the right reason:
  - `isInside`: true for `/`, a path with query and hash, capitals in the host, `:443`; false for `http://` (same host), `:444`, a trailing dot, `studflow-six.vercel.app.evil.example`, `studflow-six.vercel.app@evil.example`, `user:pw@` on our host, `studfIow` (capital I), an `xn--` look-alike, `blob:` and `data:` and `javascript:` and `file:`, `not a url`, `''`.
  - `decideLink`: inside → `'inside'`; `https://wa.me/910000000000?text=hi`, a Drive link, the trailing-dot and look-alike hosts → `'browser'`; `@`-trick, `http:`, `file:`, `javascript:`, `data:`, `blob:`, `ms-msdt:`, `whatsapp:`, `about:blank`, garbage → `'refuse'`.
  - `downloadAllowed`: our https and `blob:https://studflow-six.vercel.app/<id>` yes; another site's blob, `data:`, `http:` no.
  - `siteOrigin`: packaged ignores the override; no override → `APP_ORIGIN`; `http://localhost:3100` and `http://127.0.0.1:3100/` accepted (origin only); `https://evil.example`, `http://localhost.evil.example:3100`, `http://user@localhost:3100`, `file:///C:/x` throw.
  - `printPaper` on `/invoices/<uuid>/print`: `?paper=a5` → `'a5'`; none, `A5`, `a3`, `paper=a5&paper=a4` → `'a4'` (the page's own `.catch('a4')`); the bill page, a non-uuid id, another origin → `null`.
  - `readSavedPrinters`: good JSON read; `null`, bad JSON, `[]`, numbers, `''`, a control character, 257 characters, a `__proto__` key → dropped. `printerFor`: saved and listed → name; saved but gone → `null`.
  - `chooserList`: default first, duplicates and empty names out, at most 8.
  - `refusedSwitch`: `--remote-debugging-port=9222`, capitals, `/remote-debugging-port=1`, `-inspect`, `--inspect-brk=0`, `--no-sandbox`, `--disable-web-security`, `--ignore-certificate-errors`, `--proxy-server=x`, `--host-resolver-rules=x`, `--js-flags=x`, `--load-extension=x`, `--remote-debugging-pipe` → the name; `--squirrel-firstrun`, `C:\x.txt`, anything after a bare `--` → `null`.
- [ ] Write the module; the root suite passes.

### Task 2: The program

**Files:** create `desktop/package.json` (+ lockfile), `desktop/tsconfig.json` (strict, `noUncheckedIndexedAccess`, `module`/`moduleResolution` `nodenext`, CJS, `src` → `dist`), `desktop/forge.config.js`, `desktop/scripts/make-icon.cjs` (Electron `nativeImage` resizes `public/icon-512.png` to 16–256 and packs `assets/icon.ico`), `desktop/src/main.ts`, `desktop/src/preload.ts`, `desktop/src/squirrel.d.ts`. Modify root `tsconfig.json` (exclude `desktop`), `eslint.config.mjs` (ignore `desktop/dist/**`, `desktop/out/**`), `.gitignore` (`desktop/dist/`).

**Consumes:** Task 1. **Produces:** `window.studflowDesktop = { print(): Promise<PrintAnswer>; choosePrinter(): Promise<PrintAnswer> }` on channels `studflow:print`, `studflow:choose-printer`. Dev-only (`!app.isPackaged`) environment: `STUDFLOW_URL`, `STUDFLOW_PDF_DIR` (print writes `<paper>-<n>.pdf` with the same page size and margins instead of printing; downloads saved there), `STUDFLOW_NO_BROWSER` (links written to the log instead of opened).

- [ ] `main.ts`, in this order: Squirrel start-up; packaged + `refusedSwitch(process.argv.slice(1))` or `app.commandLine.hasSwitch` of any refused name → `app.exit(1)`; `app.enableSandbox()`; single-instance lock (second start focuses the first); no menu; zoom (Ctrl +, −, 0) and reload (F5, Ctrl R) through `before-input-event`; context menu with cut, copy, paste, select all only.
- [ ] Window: `contextIsolation`, `sandbox`, `webSecurity` on; `nodeIntegration`, `webviewTag`, `spellcheck`, `allowRunningInsecureContent`, `navigateOnDragDrop` off; `devTools` only unpackaged; maximised; loads `origin + '/'`.
- [ ] Every web contents: `will-attach-webview` prevented; `setWindowOpenHandler` denies, opens `'browser'` links with `shell.openExternal`, loads `'inside'` ones in the window; `will-navigate` and `will-redirect` stop all but `'inside'`; `will-frame-navigate` stops subframes outside.
- [ ] Session: permission request and check handlers allow only `clipboard-sanitized-write` from the origin; device permission handler false; `will-download` cancels unless `downloadAllowed`, else the save window (Downloads, file name).
- [ ] Main-frame `did-fail-load` (not `-3`): "StudFlow could not open." with Try again / Close; certificate errors (−200 to −299) say the connection is not safe.
- [ ] Printing: sender must be the main frame of this window; `printPaper(frame.url)` or `refused`; one job at a time; `printerFor` or the list (`chooserList` + "Other printer (Windows print window)" + Cancel, command links, "Remember this printer" ticked); silent print with `deviceName`, `pageSize: PAPER_SIZE[paper]`, `margins.marginType 'none'`, `printBackground`; saved printers in `userData/printers.json`.
- [ ] `npm run build` (tsc) and `npm start` with `STUDFLOW_URL` open the practice copy.

### Task 3: The page side

**Files:** create `src/lib/desktop.ts`, `tests/desktop-bridge.test.ts`; modify `src/app/invoices/[id]/print/print-button.tsx`, `startVoiceMic` in `src/app/(app)/billing/screen.tsx`, the list in `tests/frame.test.ts`.

**Produces:** `type PrintAnswer` (same shape as Task 1); `desktopBridge(from?: unknown): DesktopBridge | null`; `readPrintAnswer(value: unknown): PrintAnswer` (anything else → `{ ok: false, reason: 'failed' }`); `printAnswerText(answer: PrintAnswer): string`; `VOICE_IN_PC_APP`, `VOICE_FAILED`.

- [ ] Tests first: bridge found only with both functions; answers read safely (empty or 257-character printer, unknown reason, `null`); every reason of `PRINT_REASONS` reads back unchanged; the words exactly: `Sent to HP LaserJet.` · `Not printed. No printer was chosen.` · `Not printed. Check that the printer is on, then try again.` · `Not printed. Open this page again from the bill.` · `Not printed. This PC has no printer. Add one in Windows settings.` · `Voice works in Chrome or on the phone. Type it here.` · `Could not listen. Try again, or type it here.`
- [ ] Print button: bridge through `useSyncExternalStore` (server snapshot `null`); with it, Print and Change printer call the bridge, disabled while busy, the answer in a `role="status"` line; without it, `window.print()` as today.
- [ ] Mic: in the exe, `VOICE_IN_PC_APP` and no listening; `onerror` everywhere says `VOICE_FAILED`.

### Task 4: Setup.exe and its locks

- [ ] `npm ci`, `npm run icon`, `npm run make` → `desktop/out/make/squirrel.windows/x64/StudFlow-Setup.exe`.
- [ ] `npx @electron/fuses read` on `out/StudFlow-win32-x64/StudFlow.exe`: RunAsNode, NodeOptions, NodeCliInspect off; CookieEncryption, EmbeddedAsarIntegrityValidation, OnlyLoadAppFromAsar on.
- [ ] The packaged exe with `--remote-debugging-port=9555` exits within seconds and nothing answers on 9555; with `ELECTRON_RUN_AS_NODE=1 … -e "console.log(41+1)"` prints no 42.
- [ ] SHA-256 of the Setup written down.

### Task 5: On the practice copy

**Files:** create `handoff/practice-copy/desktop-check.mjs`; `cdp.mjs` may gain attaching to a running page.

- [ ] Build and fill the practice copy; run the unpackaged program at it with a debugging port, `STUDFLOW_PDF_DIR`, `STUDFLOW_NO_BROWSER`.
- [ ] Checks: the sign-in page inside; the bridge has exactly two functions and the page has no `require` or `process`; outside links logged as browser or refuse and the window stays; mic, camera, notifications, location refused, clipboard allowed; A4 and A5 print to PDF with the same number of pages as Edge's `print-check.mjs` and the right page size; two print calls at once: the second answers `refused`; the Excel download arrives; the mic message; a second start exits and focuses the first; started with the practice server off and a fresh profile, the could-not-open window is logged.
- [ ] `walk.mjs` (42) and `outage.mjs` (13) inside the program where attaching allows it.

### Task 6: This PC, papers, proof

- [ ] Install the Setup on this PC (per user); it opens the live sign-in page; a picture of the window only (PrintWindow on its handle, nothing else of the screen).
- [ ] `desktop/README.md` (build, install, SHA-256, rebuild every two months), `CLAUDE.md` (layout line, desktop rules), `HANDOFF.md` (live state of 26 Nov, the desktop app), `specs/desktop-app.md` if anything changed.
- [ ] `npm test`, `npm run db:verify`, `npm run lint`, `npm run typecheck`, `npm run build` (`/billing` size) all pass; report to the owner with pictures; stop.
