/**
 * Connects a personal Google Drive, once, from your own PC:
 *   node scripts/drive-connect.ts
 * You approve in the browser; the permission is written to .env.production.local and never
 * shown. Scope drive.file: the app sees only files it created, nothing else in your Drive.
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { z } from 'zod';

const FILE = '.env.production.local';
const PORT = 53682;
const REDIRECT = `http://127.0.0.1:${PORT}/callback`;
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const VAULT = 'Company_Billing_Vault';
const PATIENCE_MS = 10 * 60_000;

export function consentUrl(request: { clientId: string; redirectUri: string; state: string; challenge: string }): string {
  return `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
    client_id: request.clientId, redirect_uri: request.redirectUri, response_type: 'code', scope: SCOPE,
    access_type: 'offline', prompt: 'consent', // without these Google sends no lasting permission
    state: request.state, code_challenge: request.challenge, code_challenge_method: 'S256',
  }).toString()}`;
}

export function readEnv(text: string): Record<string, string> {
  return Object.fromEntries([...text.matchAll(/^([A-Z0-9_]+)=(.*?)\r?$/gm)].map((match) => [match[1] ?? '', (match[2] ?? '').trim().replace(/^"(.*)"$/, '$1')]));
}

/** Sets these lines and leaves every other byte alone. */
export function upsertEnv(text: string, values: Record<string, string>): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  let out = text;
  for (const [name, value] of Object.entries(values)) {
    if (/[\r\n]/.test(value)) throw new Error(`${name}: a value must be one line`);
    const line = new RegExp(`^${name}=.*?(?=\\r?$)`, 'm');
    if (line.test(out)) out = out.replace(line, () => `${name}=${value}`);
    else out = `${out}${out === '' || out.endsWith('\n') ? '' : eol}${name}=${value}${eol}`;
  }
  return out;
}

const tokenReply = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1), scope: z.string() });
const fileReply = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/) });

/** The vault folder this app made before, or a new one. */
async function vaultFolder(accessToken: string): Promise<string> {
  const headers = { authorization: `Bearer ${accessToken}` };
  const q = `name = '${VAULT}' and mimeType = 'application/vnd.google-apps.folder' and 'root' in parents and trashed = false`;
  const found = await fetch(`https://www.googleapis.com/drive/v3/files?${new URLSearchParams({ q, fields: 'files(id)', pageSize: '1' }).toString()}`, { headers });
  if (!found.ok) throw new Error(found.status === 403 ? 'Google Drive API is not enabled in your Google Cloud project yet' : `Drive answered HTTP ${found.status}`);
  const [existing] = z.object({ files: z.array(fileReply) }).parse(await found.json()).files;
  if (existing) return existing.id;
  const made = await fetch('https://www.googleapis.com/drive/v3/files?fields=id', {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ name: VAULT, mimeType: 'application/vnd.google-apps.folder' }),
  });
  if (!made.ok) throw new Error(`Drive could not create the folder (HTTP ${made.status})`);
  return fileReply.parse(await made.json()).id;
}

async function connect(): Promise<void> {
  execFileSync('git', ['check-ignore', '-q', FILE]); // refuses unless git ignores the file
  const env = readEnv(readFileSync(FILE, 'utf8'));
  const clientId = env.GOOGLE_DRIVE_OAUTH_CLIENT_ID ?? '';
  const clientSecret = env.GOOGLE_DRIVE_OAUTH_CLIENT_SECRET ?? '';
  if (!clientId.endsWith('.apps.googleusercontent.com') || !clientSecret) {
    throw new Error(`Fill GOOGLE_DRIVE_OAUTH_CLIENT_ID and GOOGLE_DRIVE_OAUTH_CLIENT_SECRET in ${FILE} first, and save it`);
  }
  const state = randomBytes(24).toString('base64url');
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');

  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error): void => {
      clearTimeout(timer);
      server.close();
      server.closeAllConnections();
      if (error) reject(error);
      else resolve();
    };
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', REDIRECT);
      const say = (status: number, text: string): void => {
        response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' }).end(text);
      };
      if (url.pathname === '/') {
        response.writeHead(302, { location: consentUrl({ clientId, redirectUri: REDIRECT, state, challenge }) }).end();
        return;
      }
      if (url.pathname !== '/callback' || url.searchParams.get('state') !== state) return say(404, 'Not here');
      const code = url.searchParams.get('code');
      if (!code) {
        say(200, 'Not connected. You can close this tab.');
        return finish(new Error('Permission was not given'));
      }
      void (async () => {
        const reply = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: clientId, client_secret: clientSecret, redirect_uri: REDIRECT, code_verifier: verifier }).toString(),
        });
        if (!reply.ok) throw new Error(`Google refused the sign-in (HTTP ${reply.status}). Check the client ID and secret`);
        const tokens = tokenReply.parse(await reply.json());
        if (!tokens.scope.split(' ').includes(SCOPE)) throw new Error('Tick the Google Drive permission on the consent page, then try again');
        const folder = await vaultFolder(tokens.access_token);
        // Read again: the file may have been edited while the browser was open.
        writeFileSync(FILE, upsertEnv(readFileSync(FILE, 'utf8'), { GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN: tokens.refresh_token, GOOGLE_DRIVE_ROOT_FOLDER_ID: folder }));
        say(200, 'Google Drive is connected. You can close this tab.');
        console.log(`Connected. Folder "${VAULT}" is ready, and the permission is saved in ${FILE}.`);
        finish();
      })().catch((error: unknown) => {
        say(200, 'Not connected. See the terminal.');
        finish(error instanceof Error ? error : new Error('failed'));
      });
    });
    const timer = setTimeout(() => finish(new Error('No answer in 10 minutes')), PATIENCE_MS);
    server.on('error', finish);
    server.listen(PORT, '127.0.0.1', () => console.log(`Open this in Chrome and approve:  http://127.0.0.1:${PORT}/`));
  });
}

if (process.argv[1]?.endsWith('drive-connect.ts')) {
  connect().catch((error: unknown) => {
    console.error(`Not connected: ${error instanceof z.ZodError ? 'Google sent an unexpected reply' : error instanceof Error ? error.message : 'failed'}`);
    process.exitCode = 1;
  });
}
