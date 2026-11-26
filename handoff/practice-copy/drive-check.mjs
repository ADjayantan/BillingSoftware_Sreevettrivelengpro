// The Company page's Google Drive section (specs/drive-button.md) on the practice copy: not
// connected, Connect without a Google client, connected by the button, Disconnect, and what staff
// see. Google is never reached: the practice copy has no Google client. Pictures in pictures-drive/.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browser, signIn, sleep } from './cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const APP = process.env.APP ?? 'http://localhost:3100';
const DB = process.env.DB ?? 'http://127.0.0.1:54321';
const sql = (query) => fetch(`${DB}/local/sql`, { method: 'POST', body: query }).then((r) => r.json());
const pictures = join(here, 'pictures-drive');
mkdirSync(pictures, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'ok   ' : 'WRONG'} ${name}${detail ? ` (${detail.replace(/\s+/g, ' ').slice(0, 140)})` : ''}`);
};

const page = await browser(9362);
const section = () => page.run(`document.querySelector('#drive')?.innerText ?? ''`);
const until = async (expression, ms = 8000) => {
  for (let waited = 0; waited < ms; waited += 150) {
    if (await page.run(expression).catch(() => false)) return true;
    await sleep(150);
  }
  return false;
};
async function picture(name, selector) {
  const clip = await page.run(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return { x: r.x + scrollX - 12, y: r.y + scrollY - 12, width: r.width + 24, height: r.height + 24, scale: 1 }; })()`);
  const { data } = await page.cdp('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: true });
  writeFileSync(join(pictures, `${name}.png`), Buffer.from(data, 'base64'));
}

try {
  await page.size(1366, 900);
  await signIn(page, APP);
  await page.go(`${APP}/company`, `!!document.querySelector('#drive a[href="/api/drive/connect"]')`);
  // local-check.mjs gives the practice copy server settings for a pretend Drive, as live has real ones.
  let said = await section();
  check('the owner sees Drive set up by the server settings, and Connect again', /Connected\. It was set up when StudFlow was put in\./.test(said) && /Connect again/i.test(said) && !/Disconnect/i.test(said), said);
  await picture('1-settings', '#drive');

  // Its CRON_SECRET is too short to seal a permission with, so Connect stops before Google.
  await page.run(`document.querySelector('#drive a[href="/api/drive/connect"]').click(); true`);
  await until(`location.search.includes('drive=not-ready') && !!document.querySelector('#drive [role=alert]')`);
  said = await section();
  check('Connect on a server without a sealing key says it is not ready', /not ready for it yet/.test(said), said);
  await picture('2-not-ready', '#drive');

  // As if the owner had come back from Google: the row the button keeps (sealed text, made up).
  await sql(`insert into private.drive_link (singleton, sealed_token, folder_id, account_email, connected_by)
    select true, 'v1.AAAAAAAAAAAAAAAA.${'B'.repeat(60)}', 'practice-vault-0001', 'owner@example.com', id from auth.users where email = 'owner@studflow.test'`);
  await page.go(`${APP}/company`, `!!document.querySelector('#drive')`);
  said = await section();
  check('connected: the account and the day, Connect again and Disconnect', /Connected to owner@example\.com since \d+ \w{3} \d{4}/.test(said) && /Connect again/i.test(said) && /Disconnect/i.test(said), said);
  await picture('3-connected', '#drive');

  await page.go(`${APP}/home`, `!!document.querySelector('section[aria-label="Safe and in order"]')`);
  check('Home counts Drive as connected', !/Not connected/.test(await page.run(`document.querySelector('section[aria-label="Safe and in order"]').innerText`)));
  await picture('4-home', 'section[aria-label="Safe and in order"]');

  await page.go(`${APP}/company`, `!!document.querySelector('#drive button')`);
  await page.run(`window.confirm = () => true; [...document.querySelectorAll('#drive button')].find((b) => b.textContent.trim() === 'Disconnect').click(); true`);
  await until(`document.querySelector('#drive [role=status]')?.textContent.startsWith('Disconnected')`);
  await until(`/It was set up when StudFlow was put in/.test(document.querySelector('#drive').innerText)`);
  said = await section();
  check('Disconnect forgets the link and says the settings hold again', /Disconnected\. Copies go to the Drive set up when StudFlow was put in\./.test(said) && /Connected\. It was set up/.test(said), said);
  await picture('5-disconnected', '#drive');
  const [row] = await sql(`select count(*)::int as n from private.drive_link`);
  check('the row is gone from the database', row?.n === 0, JSON.stringify(row));

  await page.cdp('Network.clearBrowserCookies');
  await signIn(page, APP, 'staff@studflow.test');
  await page.go(`${APP}/company`, `!!document.querySelector('#drive')`);
  said = await section();
  check('staff see where Drive stands, without the buttons', /Only the owner can connect Google Drive/.test(said) && !/Disconnect|Connect Google Drive/i.test(said.replace('Only the owner can connect Google Drive', '')), said);
} finally {
  page.close();
}

const wrong = results.filter((ok) => !ok).length;
console.log(`${results.length - wrong} of ${results.length} right; pictures in ${pictures}`);
process.exitCode = wrong === 0 ? 0 : 1;
