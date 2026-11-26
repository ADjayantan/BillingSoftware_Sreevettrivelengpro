# Connect Google Drive from the app

Owner, 26 Nov 2026: **"drive va connect panna button vei da macha"**. Told that Drive is already linked on the live site (the four settings saved on Vercel on 24 Nov by `scripts/drive-connect.ts`) and that a button is a bigger piece of work, the owner answered **"You decide"**. Claude's decision, recorded here.

## What it is

- The Company page gets a **Google Drive** section: whether bills and Excel books go to Drive, to which Google account, since when; and for the owner **Connect Google Drive** (or **Connect again**) and **Disconnect**. Staff see the state only.
- Connect: Google's own page asks the owner to allow StudFlow to keep **its own files** in their Drive (`drive.file`: StudFlow sees nothing else there). StudFlow finds or makes the `Company_Billing_Vault` folder in that Drive and keeps the permission. From then on every bill, challan, proof, Excel book and weekly backup goes there.
- Why a button although Drive is linked: a Google permission can stop (the Google app still in "Testing" ends it after 7 days; removing access in the Google account; six months unused). Then copies wait, Home says so, and today only a person with the env files and a terminal can fix it. With the button the owner fixes it in one minute.
- Home's Drive line, for the owner, points to the Company page when Drive is not connected.
- In the PC app, Google's sign-in pages open in the normal browser, not inside (the exe's rule); the section says to connect from Chrome or Edge.

## Approaches

1. **Button in the app, permission kept in the database, encrypted** (chosen).
2. Keep the script; Claude runs it when needed: no button, needs the env files and a terminal each time.
3. The button writes the Vercel settings through Vercel's API and redeploys: the app would hold a key to the whole Vercel project. Rejected.

## Safety

- The permission (Google's refresh token) is stored only **sealed**: AES-256-GCM, with a key derived (HKDF-SHA256) from `CRON_SECRET`, which lives only in the server settings. The database row alone opens nothing; backups and the SQL editor show only the sealed text. Changing `CRON_SECRET` means connecting again.
- The table is in `private` (not on the Data API) with RLS on and no policies. Four functions: status (staff), save and clear (owner), the sealed token (`service_role` only, for the server's own copying). No signed-in person can read the token, sealed or not.
- The connect flow: owner only; `state` and a PKCE verifier sealed in a short-lived cookie (`httpOnly`, `SameSite=Lax`, ten minutes, path `/api/drive`); the callback checks both, exchanges the code once, and keeps nothing else. The old permission is revoked at Google when a new one replaces it or on Disconnect.
- The token never reaches a browser, a log or an error message; failures come back as one of a few fixed words.
- Not an audit-log row: the edit log keeps whole rows forever, and a credential must not be copied into it. The row keeps who connected it and when.

## Which sign-in wins

1. The one made with the button (when the row exists). If it cannot be opened (the key changed, the client settings are gone), copies stop with "connect Google Drive again"; they never fall back to another account's Drive.
2. Else the server settings (`GOOGLE_DRIVE_OAUTH_*`, or the service account), as before.

## For the owner, once, before it works on live

- Google Cloud: the OAuth client must accept `https://studflow-six.vercel.app/api/drive/callback` (a "Web application" client; a "Desktop app" client cannot). Its ID and secret go into `GOOGLE_DRIVE_OAUTH_CLIENT_ID` / `_SECRET` on Vercel.
- Google Cloud: the consent screen "In production", so the permission does not end after 7 days (`drive.file` needs no review).
- Migration `009_drive_link.sql` on live, then a deploy. Each with the owner's yes.

## Files

`supabase/migrations/009_drive_link.sql`; `src/lib/drive-link.ts` (sealing, the Google steps, server only); `src/lib/drive-backup.ts` (`driveCredentials`, `driveState`); `src/app/api/drive/{connect,callback,disconnect}/route.ts`; the Company page section and Home's line. Tests: `tests/drive-link.test.ts`, `tests/db/drive-link.test.ts`, `tests/api/drive-link.test.ts`, `tests/drive-vault.test.ts`.
