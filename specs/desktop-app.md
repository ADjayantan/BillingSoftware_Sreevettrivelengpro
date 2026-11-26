# StudFlow on the PC: the desktop app

Owner, 26 Nov 2026, after the three ways were explained (install from Edge, a real exe, full offline like Tally): **"2 ok da. certificate la vanga vena da macha. ana ithu security ni enna panna num panni du"**: a real `StudFlow.exe` for the shop PCs, no code-signing certificate, and Claude decides what keeps it safe.

## What it is

- A small Windows program that opens the live site in its own window: **same login, same data, same cloud**. It holds no database and no key; it knows only the site's address.
- Built from `desktop/` in this repository. The owner gets one `Setup.exe`: it installs for the signed-in Windows user (no admin), puts StudFlow on the desktop and in the Start menu, and is removed from Settings → Apps.
- What the user sees: its own window with the StudFlow icon (the white stud on green, as on the phone), no address bar, no tabs; **Print sends the bill straight to the printer** chosen once for each paper (A4, A5); Drive and WhatsApp links open in the normal browser.
- What stays as today: the internet is needed (the billing page keeps working offline and sends bills later, as in Chrome); phones keep using the website; the site still needs hosting (`specs/golive-runbook.md`, the Vercel question is open).
- Voice billing needs Chrome's speech service, which a program of this kind does not have. In the PC app the mic says so instead of failing in silence.

## Approaches

1. **Install from Edge as an app** (manifest and service worker exist since Sprint 3): free, works today, but not a file, and no straight printing.
2. **Electron program around the live site**: chosen by the owner.
3. **Full offline, database on the PC**: a rewrite; no phone; a dead PC loses data; the keys would sit on the PC. Rejected.

Inside 2, Claude's calls:
- **Electron, not Tauri.** It builds with the Node already on this PC and carries its own Chromium, so printing, IndexedDB and the service worker behave as in Chrome. Tauri needs Rust and the C++ build tools, and uses the WebView2 that Windows updates on its own.
- **Electron Forge with the Squirrel.Windows installer**, Electron's own tools: a one-click per-user install, fuses applied while packaging.

## Safety

What could go wrong, and what stops it:

| Risk | What stops it |
|---|---|
| The window is led to another site (a fake sign-in page inside a trusted window) | Only `https://studflow-six.vercel.app` opens inside, fixed when the exe is built. Every navigation, redirect, new window and frame to anything else is stopped. `https:` links open in the normal browser; every other kind of link (`file:`, `javascript:`, custom schemes) is refused. |
| The site, or something injected into it, reaches into the PC | Node off, context isolation, sandbox for every page, web security on, no `<webview>`, no insecure content, spellcheck off (no calls to Google). |
| The bridge between page and program is abused | It has two calls, `print()` and `choosePrinter()`. The program checks that the call comes from the main frame of its own window, on a print page of the site. The paper size is read from that page's own address, never taken from the page. Printer names must be ones Windows lists. |
| A page asks for the camera, mic, location, notifications, USB or the screen | Refused, all of them. Allowed, for the site only: writing text to the clipboard, and keeping its own storage so unsent bills are never cleared to make room. |
| Files come down from somewhere else | Downloads only from the site itself (the monthly Excel), with the save window. |
| Other software on the PC uses the exe as a tool to read the login | Electron fuses: run-as-Node off, `NODE_OPTIONS` off, `--inspect` off, the app only from its archive with the archive checked, cookies encrypted with Windows' own protection. The installed exe refuses to start with debugging or safety-lowering switches (remote debugging port or pipe, `--inspect`, disable web security, ignore certificate errors, host rules, proxy settings). |
| A wrong HTTPS certificate | Never overridden: the page does not load. |
| Someone opens the inner tools | No menu, no DevTools, no "Inspect" in the installed app. |
| An updater as a way in | No automatic updates (an unsigned updater cannot be trusted). The program is rebuilt with the newest Electron about every two months, or soon after Electron announces a security fix, and installed over the old one. The site itself updates as today. |
| A fake `StudFlow.exe` (no certificate) | The SHA-256 of each `Setup.exe` goes into `desktop/README.md` and `HANDOFF.md`. Copy it to the shop PCs by pen drive (Windows then shows no warning) or from Google Drive (Windows shows "Windows protected your PC": More info, Run anyway, once). Never from a link someone sends. |
| The login taken from the PC's disk | Cookies are encrypted (fuse above). Unsent bills sit in IndexedDB as in Chrome. Shop PCs need a Windows password; Sign out on a shared PC. Uninstalling keeps unsent bills. |

**Testing.** Only a development run of the program (never the installed exe) may open another address, and only the practice copy on `http://localhost` or `http://127.0.0.1`; only a development run accepts a debugging port. Electron is the newest stable version when it is built; the printers chosen are kept in the program's own folder (`printers.json`) and read back through the same checks.

## Printing

- On the print page, inside the exe, **Print** sends the sheets straight to the printer remembered for that paper. The first time (or when that printer is gone) a small window asks "Which printer for A5 bills?", listing the printers Windows has, with "Remember this printer" ticked. More than eight printers, or "Other": the Windows print window.
- **Change printer** next to Print asks again. After printing the page says "Sent to <printer>." or "Not printed. <reason>".
- Straight printing uses page size A4 or A5, no margins, background on: the same as the page's one `@page` rule.
- In a browser nothing changes: Print opens the browser's print window. The page finds the bridge only after it has loaded, so the server's page and the browser's page stay the same.
- Until the web part is deployed, the exe's Print opens the Windows print window.

## Voice

In the exe the mic button says "Voice works in Chrome or on the phone. Type it here." When listening fails in any browser it now says so too: today it stops without a word.

## Files

- `desktop/`: `package.json` and its lockfile, `tsconfig.json`, `forge.config.js`, `src/policy.ts` (pure: the address rules, the paper from a print address, printer names, the refused switches, the saved printers), `src/main.ts`, `src/preload.ts`, `assets/icon.ico` (from `public/icon-512.png`), `scripts/check-exe.sh` (the locks of a built exe), `README.md` (build, install, check the SHA-256).
- Web: `src/lib/desktop.ts` (finds and checks the bridge, the words for a print result), `src/app/invoices/[id]/print/print-button.tsx`, the mic in `src/app/(app)/billing/screen.tsx`.
- Root: `tsconfig.json` leaves out `desktop`; `.gitignore` adds `desktop/dist/`; the linter skips `desktop`'s build output.
- If the site's address changes (Netlify, an own domain): change `APP_ORIGIN` in `desktop/src/policy.ts`, rebuild, reinstall.

## Done means

- `npm test`, `npm run db:verify`, `npm run lint`, `npm run typecheck`, `npm run build` pass; `/billing` stays within 170 KB.
- Tests for the address rules, with the tricky ones: `https://studflow-six.vercel.app.evil.com`, `https://studflow-six.vercel.app@evil.com`, `http://` instead of `https://`, another port, capitals, a trailing dot, look-alike letters, `javascript:`, `file:`, `blob:` and `data:`; the paper from a print address; refused switches; saved printers read safely.
- The program run against the practice copy (`handoff/practice-copy/`, made-up data, never the live database): the keyboard walk, billing with the network off, A4 and A5 printed to PDF with the same pages as Edge, links opening in the browser, permissions refused.
- The installed exe: fuses read back, refuses a debugging port, installs without admin, opens the live sign-in page, uninstalls. Installed on this PC for the owner to try.
- The owner: one real A4 and one real A5 print on the shop printer.
- Commit, push and the deploy of the web part only with the owner's yes, each time.

## Not in this part

Starting with Windows, a tray icon, automatic updates, voice inside the exe (would send the sound to Gemini), a Content Security Policy for the whole site (a separate piece of safety work).
