// A local rehearsal: the real app against an in-memory Postgres with every migration (005 too).
// Nothing here can reach the live project. Any password signs the test owner in.
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
registerHooks({
  resolve(specifier, context, next) {
    let wanted = specifier.startsWith('@/') ? pathToFileURL(`${root}/src/${specifier.slice(2)}`).href : specifier;
    if (/^(\.|file:)/.test(wanted) && !/\.[a-z]+$/i.test(wanted)) wanted += '.ts';
    return next(wanted, context);
  },
});
const { createTestDb, seedMasterData, USERS } = await import(pathToFileURL(`${root}/tests/db/harness.ts`).href);
const { handle } = await import(pathToFileURL(`${root}/tests/support/postgrest.ts`).href);
const { FakeDrive } = await import(pathToFileURL(`${root}/tests/support/fake-drive.ts`).href);

// A pretend Google Drive on this PC. only-local.mjs sends the app's Google calls here.
const drive = new FakeDrive('local_vault_root');
let driveUp = true;
drive.fate = () => (driveUp ? 'ok' : 503);
const DRIVE_PORT = 54322;
createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  try {
    const target = `https://${req.headers['x-google-host']}${req.url}`;
    const reply = await drive.fetch(target, { method: req.method, headers: req.headers, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) });
    res.writeHead(reply.status, { 'content-type': 'application/json' });
    res.end(Buffer.from(await reply.arrayBuffer()));
  } catch (error) {
    console.error('pretend drive', error instanceof Error ? error.message : error);
    res.writeHead(500).end();
  }
}).listen(DRIVE_PORT, '127.0.0.1');

const db = await createTestDb({ today: null });
await seedMasterData(db);

const PORT = 54321;
const APP = Number(process.env.PORT ?? 3100);
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const userOf = (who) => ({ id: USERS[who].id, aud: 'authenticated', role: 'authenticated', email: USERS[who].email, app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' });
function session(who = 'owner') {
  const user = userOf(who);
  const now = Math.floor(Date.now() / 1000);
  const claims = { sub: user.id, role: 'authenticated', aud: 'authenticated', iat: now, exp: now + 3600 };
  return { access_token: `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(claims)}.${Buffer.from('sig').toString('base64url')}`, token_type: 'bearer', expires_in: 3600, expires_at: now + 3600, refresh_token: `local-${who}`, user };
}
const actorOf = (headers) => {
  if (headers.authorization === 'Bearer sb_secret_local') return { role: 'service_role' };
  try {
    const claims = JSON.parse(Buffer.from((headers.authorization ?? '').split('.')[1] ?? '', 'base64url').toString());
    return claims.sub ? { role: 'authenticated', sub: claims.sub } : { role: 'anon' };
  } catch {
    return { role: 'anon' };
  }
};

/** 'down' answers like a dead cloud, for the offline check. */
let cloud = 'up';
createServer(async (req, res) => {
  const send = (status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(body === null ? undefined : JSON.stringify(body));
  };
  try {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
    if (url.pathname.startsWith('/local/')) {
      const what = url.pathname.slice(7);
      if (what === 'down' || what === 'up') cloud = what;
      if (what === 'drive-down' || what === 'drive-up') driveUp = what === 'drive-up';
      if (what === 'files') return send(200, [...drive.nodes.values()].map((node) => ({ id: node.id, path: drive.pathOf(node), bytes: node.bytes.length, trashed: node.trashed, appProperties: node.appProperties })));
      if (what === 'file') {
        const node = drive.nodes.get(url.searchParams.get('id') ?? '');
        res.writeHead(node ? 200 : 404, { 'content-type': 'application/octet-stream' });
        return res.end(node?.bytes);
      }
      if (what === 'sql') {
        let query = '';
        for await (const chunk of req) query += chunk;
        return send(200, (await db.query(query)).rows);
      }
      return send(200, { cloud, driveUp });
    }
    if (cloud === 'down') return send(503, { message: 'down' });
    let text = '';
    for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : undefined;
    if (url.pathname === '/auth/v1/token') return send(200, session(/staff/.test(body?.email ?? body?.refresh_token ?? '') ? 'staff' : 'owner'));
    if (url.pathname === '/auth/v1/user') return send(200, userOf(actorOf(req.headers).sub === USERS.staff.id ? 'staff' : 'owner'));
    if (url.pathname === '/auth/v1/logout') return send(204, null);
    if (url.pathname.startsWith('/rest/v1/')) {
      const reply = await handle(db, actorOf(req.headers), req.method, url.href, body, req.headers.accept ?? '');
      res.writeHead(reply.status, Object.fromEntries(reply.headers));
      return res.end(req.method === 'HEAD' ? undefined : await reply.text());
    }
    send(404, { message: `unexpected ${req.method} ${url.pathname}` });
  } catch (error) {
    console.error('local-check', error instanceof Error ? error.message : error);
    send(500, { code: 'XX000', message: 'local-check' });
  }
}).listen(PORT, '127.0.0.1', () => console.log(`in-memory database on ${PORT}`));

// `next start` reads .env.production.local, which holds the LIVE keys (Drive, Telegram, Gemini, database).
// Every name in an env file is set to empty here, so nothing outside this PC can be reached or written.
const live = [...new Set(readdirSync(root).filter((f) => f.startsWith('.env')).flatMap((f) => readFileSync(`${root}/${f}`, 'utf8').split('\n').map((l) => /^([A-Z0-9_]+)=/.exec(l)?.[1]).filter(Boolean)))];
const env = { ...process.env, ...Object.fromEntries(live.map((name) => [name, ''])), NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${PORT}`, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_local', SUPABASE_SECRET_KEY: 'sb_secret_local', GOOGLE_DRIVE_ROOT_FOLDER_ID: 'local_vault_root', GOOGLE_DRIVE_OAUTH_CLIENT_ID: 'local', GOOGLE_DRIVE_OAUTH_CLIENT_SECRET: 'local', GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN: 'local', CRON_SECRET: 'local-cron-secret-0001' };
console.log(`${live.length} live settings blanked`);

// Next writes NEXT_PUBLIC_* into the build itself: a build made with the live address would still talk to it.
const values = [...new Set(readdirSync(root).filter((f) => f.startsWith('.env') && f !== '.env.example').flatMap((f) => readFileSync(`${root}/${f}`, 'utf8').split('\n').map((l) => /^[A-Z0-9_]+=(.*)$/.exec(l.trim())?.[1]?.replace(/^["']|["']$/g, '') ?? '')).filter((v) => v.length >= 12))];
const scripts = (dir) => readdirSync(dir).flatMap((name) => (statSync(`${dir}/${name}`).isDirectory() ? scripts(`${dir}/${name}`) : [`${dir}/${name}`]));
const built = [...scripts(`${root}/.next/server`), ...scripts(`${root}/.next/static`)].filter((f) => /\.(js|html|json|rsc|body)$/.test(f));
const tainted = built.filter((f) => {
  const body = readFileSync(f, 'utf8');
  return values.some((v) => body.includes(v));
});
console.log(`${values.length} live values looked for in ${built.length} built files: ${tainted.length} found`);
if (tainted.length) {
  console.error('This build holds live settings. Not starting.');
  process.exit(1);
}
env.NODE_OPTIONS = `--import ${new URL('./only-local.mjs', import.meta.url).href}`;
const app = spawn(process.execPath, [`${root}/node_modules/next/dist/bin/next`, 'start', '-p', String(APP), '-H', '127.0.0.1'], { env, stdio: 'inherit' });
app.on('exit', (code) => process.exit(code ?? 0));
for (const signal of ['SIGINT', 'SIGTERM', 'exit']) process.on(signal, () => app.kill());
