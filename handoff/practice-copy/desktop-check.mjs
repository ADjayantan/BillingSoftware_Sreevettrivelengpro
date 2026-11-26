// The PC app (desktop/) against the practice copy: the site inside, links outside, permissions,
// straight printing (to PDF here), the Excel download, the mic's words, a second start, and a
// start with no site to reach. Needs local-check.mjs running, fill.mjs done and `npm run build`
// in desktop/. Development runs only: the installed exe never opens anything but the live site.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browser, signIn, sleep } from './cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const APP = process.env.APP ?? 'http://localhost:3100';
const PORT = 9357;
const ELECTRON = join(root, 'desktop', 'node_modules', 'electron', 'dist', 'electron.exe');
const work = mkdtempSync(join(tmpdir(), 'studflow-desktop-'));
const out = join(work, 'out');
const pictures = join(here, 'pictures-desktop');
mkdirSync(pictures, { recursive: true });

function start(profile, { url = APP, port = PORT } = {}) {
  const lines = [];
  const child = spawn(ELECTRON, [join(root, 'desktop'), `--remote-debugging-port=${port}`], {
    env: { ...process.env, STUDFLOW_URL: url, STUDFLOW_PROFILE: join(work, profile), STUDFLOW_PDF_DIR: out, STUDFLOW_NO_BROWSER: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (data) => lines.push(...String(data).split(/\r?\n/).filter(Boolean)));
  return { child, lines, exited: new Promise((resolve) => child.on('exit', (code) => resolve(code))) };
}

async function seen(lines, text, ms = 10_000) {
  for (let waited = 0; waited < ms; waited += 200) {
    if (lines.some((line) => line.includes(text))) return true;
    await sleep(200);
  }
  return false;
}

const files = () => (existsSync(out) ? readdirSync(out) : []);
async function arrives(test, ms = 15_000) {
  for (let waited = 0; waited < ms; waited += 200) {
    const found = files().find(test);
    if (found) return found;
    await sleep(200);
  }
  return null;
}

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'ok   ' : 'WRONG'} ${name}${detail ? ` (${detail})` : ''}`);
};

const app = start('main');
process.env.ATTACH = String(PORT);
const page = await browser();
const until = async (expression, ms = 10_000) => {
  for (let waited = 0; waited < ms; waited += 200) {
    if (await page.run(expression).catch(() => false)) return true;
    await sleep(200);
  }
  return false;
};
// As if a person clicked: window.open, the mic and permissions need a user's action.
const gesture = async (expression) => {
  const { result, exceptionDetails } = await page.cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  return result.value;
};
const button = (label) => `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)})`;
// A button drawn by the server does nothing until React has taken it over.
const live = (element) => `((el) => !!el && Object.keys(el).some((k) => k.startsWith('__reactProps')))(${element})`;

try {
  check('the practice site opens inside the window', await until(`location.origin === ${JSON.stringify(APP)} && document.readyState === 'complete'`, 20_000));
  check('the page has the two-call bridge and no Node', await page.run(`JSON.stringify(Object.keys(window.studflowDesktop ?? {}).sort()) === '["choosePrinter","print"]' && typeof require === 'undefined' && typeof process === 'undefined'`));
  await signIn(page, APP);
  check('signs in to the practice copy', await page.run(`location.pathname !== '/login'`));
  writeFileSync(join(pictures, 'home.png'), await page.shot());

  await page.run(`location.href = 'https://example.com/'; true`);
  check('another site goes to the normal browser, the window stays', (await seen(app.lines, 'browser: https://example.com/')) && (await page.run('location.origin')) === APP);
  check('a WhatsApp link opens outside, no window inside', (await gesture(`window.open('https://wa.me/910000000000?text=hi') === null`)) && (await seen(app.lines, 'browser: https://wa.me/910000000000')));
  // Chromium itself stops a site opening a file; the program's own rule is seen with a Windows tool's link.
  const pagesNow = async () => (await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())).filter((t) => t.type === 'page').length;
  check('a file link opens nothing', (await gesture(`window.open('file:///C:/Windows/win.ini') === null`)) && (await pagesNow()) === 1);
  check('a link to a Windows tool is refused', (await gesture(`window.open('ms-msdt:/id PCWDiagnostic') === null`)) && (await seen(app.lines, 'refused: ms-msdt:')));

  const mic = await gesture(`navigator.mediaDevices.getUserMedia({ audio: true }).then(() => 'allowed', (e) => e.name)`);
  check('the microphone is refused', mic === 'NotAllowedError', mic);
  const notes = await gesture('Notification.requestPermission()');
  check('notifications are refused', notes === 'denied', notes);
  const where = await gesture(`new Promise((done) => navigator.geolocation.getCurrentPosition(() => done('allowed'), (e) => done('refused ' + e.code)))`);
  check('location is refused', where.startsWith('refused'), where);
  const clip = await gesture(`navigator.clipboard.writeText('StudFlow').then(() => 'ok', (e) => e.name)`);
  check('copying text still works', clip === 'ok', clip);

  await page.go(`${APP}/invoices`, `document.querySelector('a[href^="/invoices/"]')`);
  const id = await page.run(`[...document.querySelectorAll('a[href^="/invoices/"]')].map((a) => a.getAttribute('href').split('/')[2]).find((x) => /^[0-9a-f-]{36}$/.test(x))`);
  const SIZE = { a5: [419.53, 595.28], a4: [595.28, 841.89] };
  for (const paper of ['a5', 'a4']) {
    await page.go(`${APP}/invoices/${id}/print?paper=${paper}&docs=both`, `document.querySelectorAll('.sheet').length > 0 && !!window.studflowDesktop && !!${button('Change printer')}`);
    const sheets = await page.run(`document.querySelectorAll('.sheet').length`);
    const before = new Set(files());
    await gesture(`${button('Print')}.click(); true`);
    const file = await arrives((name) => name.startsWith(`${paper}-`) && !before.has(name));
    await until(`document.querySelector('nav[aria-label="Print options"] [role=status]').textContent.startsWith('Sent to')`);
    const said = await page.run(`document.querySelector('nav[aria-label="Print options"] [role=status]').textContent`);
    check(`${paper.toUpperCase()}: Print goes straight out (a PDF here) and the page says so`, file !== null && said === `Sent to PDF ${file}.`, said);
    if (file !== null) {
      const pdf = readFileSync(join(out, file), 'latin1');
      const pages = (pdf.match(/\/Type\s*\/Page\b(?!s)/g) ?? []).length;
      const boxes = [...new Set([...pdf.matchAll(/\/MediaBox\s*\[([^\]]+)\]/g)].map((m) => m[1].trim()))];
      const [width, height] = (boxes[0] ?? '').split(/\s+/).slice(2).map(Number);
      const right = boxes.length === 1 && Math.abs(width - SIZE[paper][0]) < 1 && Math.abs(height - SIZE[paper][1]) < 1;
      check(`${paper.toUpperCase()}: one page per sheet, the right paper`, pages === sheets && right, `${sheets} sheets, ${pages} pages, ${boxes.join(' | ')}`);
    }
    writeFileSync(join(pictures, `print-${paper}.png`), await page.shot());
  }
  const both = await page.run(`Promise.all([window.studflowDesktop.print(), window.studflowDesktop.print()]).then((a) => JSON.stringify(a.map((x) => (x.ok ? 'ok' : x.reason)).sort()))`);
  check('two presses at once: one job, the second refused', both === '["ok","refused"]', both);

  await page.go(`${APP}/home`, `document.readyState === 'complete'`);
  const away = await page.run(`window.studflowDesktop.print().then((a) => JSON.stringify(a))`);
  check('printing from a page that is not a print page is refused', away === '{"ok":false,"reason":"refused"}', away);

  await page.go(`${APP}/books`, live(button('Open monthly Excel')));
  await gesture(`${button('Open monthly Excel')}.click(); true`);
  const book = await arrives((name) => /^Billing_\d{4}-\d{2}\.xlsx$/.test(name));
  check('the monthly Excel downloads from the site', book !== null, book ?? 'nothing arrived');

  await page.go(`${APP}/billing`, live(`document.querySelector('button[aria-label="Speak the bill"]')`));
  await gesture(`document.querySelector('button[aria-label="Speak the bill"]').click(); true`);
  await until(`[...document.querySelectorAll('[role=status]')].some((e) => e.textContent.includes('Voice works'))`);
  const micSaid = await page.run(`[...document.querySelectorAll('[role=status]')].map((e) => e.textContent).filter(Boolean).join(' | ')`);
  check('the mic says voice is for Chrome or the phone', micSaid.includes('Voice works in Chrome or on the phone. Type it here.'), micSaid);

  const second = start('main', { port: PORT + 1 });
  const code = await Promise.race([second.exited, sleep(15_000).then(() => 'still running')]);
  check('a second start opens no second window', code !== 'still running' && (await seen(app.lines, 'second start')), `exit ${code}`);
} finally {
  page.close();
  app.child.kill();
}

const lonely = start('fresh', { url: 'http://127.0.0.1:3999', port: PORT + 2 });
check('with no site to reach, it says it could not open', await seen(lonely.lines, 'could not open', 20_000));
lonely.child.kill();

const wrong = results.filter((ok) => !ok).length;
console.log(`${results.length - wrong} of ${results.length} right; pictures in ${pictures}`);
process.exitCode = wrong === 0 ? 0 : 1;
