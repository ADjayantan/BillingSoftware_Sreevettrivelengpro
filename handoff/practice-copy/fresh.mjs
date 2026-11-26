// One practice-copy check on fresh data: start the practice copy, fill it, optionally start the PC
// app's development run at it (--program <port>, the check then attaches), run the check, stop all.
// Usage, from the project folder: node handoff/practice-copy/fresh.mjs . [--program <port>] <check script> [args...]
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [root, ...rest] = process.argv.slice(2);
let port = 0;
if (rest[0] === '--program') port = Number(rest.splice(0, 2)[1]);
const [script, ...args] = rest;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stop = (child) => {
  try {
    execFileSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' });
  } catch {
    // already gone
  }
};

const server = spawn(process.execPath, [join(root, 'handoff/practice-copy/local-check.mjs')], { cwd: root, stdio: 'ignore' });
let program = null;
try {
  let up = false;
  for (let i = 0; i < 120 && !up; i += 1) {
    up = await fetch('http://localhost:3100/login').then((r) => r.ok, () => false);
    if (!up) await sleep(500);
  }
  if (!up) throw new Error('the practice copy did not start');
  execFileSync(process.execPath, [join(root, 'handoff/practice-copy/fill.mjs')], { cwd: root, stdio: 'inherit' });
  const env = { ...process.env };
  if (port) {
    const work = mkdtempSync(join(tmpdir(), 'studflow-walk-'));
    program = spawn(join(root, 'desktop/node_modules/electron/dist/electron.exe'), [join(root, 'desktop'), `--remote-debugging-port=${port}`], {
      cwd: root,
      stdio: 'ignore',
      env: { ...process.env, STUDFLOW_URL: 'http://localhost:3100', STUDFLOW_PROFILE: join(work, 'profile'), STUDFLOW_PDF_DIR: join(work, 'out'), STUDFLOW_NO_BROWSER: '1' },
    });
    let page = false;
    for (let i = 0; i < 80 && !page; i += 1) {
      page = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()).then((list) => list.some((t) => t.type === 'page' && t.url.startsWith('http://localhost:3100')), () => false);
      if (!page) await sleep(250);
    }
    if (!page) throw new Error('the program did not open the practice copy');
    env.ATTACH = String(port);
  }
  const code = await new Promise((resolve) => spawn(process.execPath, [join(root, script), ...args], { cwd: root, stdio: 'inherit', env }).on('exit', resolve));
  process.exitCode = code ?? 1;
} finally {
  if (program) stop(program);
  stop(server);
}
