// Walks through the built screens like a person, with real keys, on the practice copy.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browser, signIn, sleep } from './cdp.mjs';

const out = join(dirname(fileURLToPath(import.meta.url)), 'walk');
mkdirSync(out, { recursive: true });
const APP = process.env.APP ?? 'http://localhost:3100';
const DB = process.env.DB ?? 'http://127.0.0.1:54321';
const page = await browser(9353);
let wrong = 0;
const check = (what, good, more = '') => {
  if (!good) wrong += 1;
  console.log(`${good ? 'ok   ' : 'WRONG'} ${what}${good ? '' : `  → ${more}`}`);
};
const sql = (query) => fetch(`${DB}/local/sql`, { method: 'POST', body: query }).then((r) => r.json());
const text = (selector = 'main') => page.run(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? ''`);
const shot = async (name) => writeFileSync(join(out, `${name}.png`), await page.shot());
const until = async (expression, ms = 6000) => {
  for (let left = ms; left > 0; left -= 120) {
    if (await page.run(expression).catch(() => false)) return true;
    await sleep(120);
  }
  return false;
};
const click = (selector) => page.run(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) throw new Error('no ' + ${JSON.stringify(selector)}); e.click(); })()`);
const clickText = (words, inside = 'body') => page.run(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(inside)} + ' button, ' + ${JSON.stringify(inside)} + ' a')].find((x) => x.offsetParent !== null && x.textContent.trim().toLowerCase().startsWith(${JSON.stringify(words.toLowerCase())})); if (!e) throw new Error('no button ' + ${JSON.stringify(words)}); e.click(); })()`);
const focusName = () => page.run(`document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.closest('label')?.querySelector('span')?.innerText ?? document.activeElement?.textContent ?? ''`);
const typeThenEnter = async (words, wait = 500) => {
  await page.type(words);
  await sleep(wait);
  await page.key('Enter');
  await sleep(150);
};
try {
  await page.scheme('light');
  await page.cdp('Network.clearBrowserCookies');
  await page.size(1366, 768);
  await page.cdp('Page.bringToFront');
  await signIn(page);
  check('sign-in starts at Home', (await page.run('location.pathname')) === '/home');

  // ---- New bill, keyboard only
  await page.go(`${APP}/billing`, `document.querySelector('[data-place="customer"] input')`);
  await page.run(`document.querySelector('[data-place="customer"] input').focus()`);
  await typeThenEnter('murugan', 700);
  check('customer picked', /Murugan Engineering Works/.test(await page.run(`document.querySelector('[data-place="customer"] input').value`)));
  check('Enter goes to the first item', (await focusName()) === 'Product or ID, line 1', await focusName());
  check('old balance and last bill are offered', await until(`/Old balance of this customer ₹/.test(document.querySelector('main').innerText) && /Same items again/.test(document.querySelector('main').innerText)`), await text());
  await shot('1-customer');
  await typeThenEnter('p0002', 700);
  check('Enter goes to Qty', (await focusName()) === 'Qty, line 1', await focusName());
  await typeThenEnter('100');
  check('Enter skips the unit, goes to Rate', (await focusName()) === 'Rate ₹, line 1', await focusName());
  await page.key('Enter');
  await sleep(150);
  check('GST came from the product, Enter goes to the next line', (await focusName()) === 'Product or ID, line 2', await focusName());
  check('total is on the side', /₹5,015\.00/.test(await text('aside[aria-label="Total"]')), await text('aside[aria-label="Total"]'));
  await typeThenEnter('Special bracket', 900);
  check('a typed item goes to Qty', (await focusName()) === 'Qty, line 2', await focusName());
  await typeThenEnter('2');
  await typeThenEnter('150');
  check('without a product Enter stops at GST %', (await focusName()) === 'GST %, line 2', await focusName());
  await shot('2-gst-asked');
  await typeThenEnter('18');
  check('then the next line', (await focusName()) === 'Product or ID, line 3', await focusName());
  await page.key('Enter');
  await sleep(200);
  check('Enter on an empty line goes to packing', /Packing/.test(await focusName()), await focusName());
  for (let i = 0; i < 3; i += 1) {
    await page.key('Enter');
    await sleep(120);
  }
  check('then Received now', /Received now/.test(await focusName()), await focusName());
  await shot('3-ready');
  await page.key('Enter');
  await sleep(150);
  check('and then Save', /Save bill/.test(await focusName()), await focusName());
  await page.key('Enter', 2);
  check('Ctrl+Enter saves and the number comes', await until(`/INV\\/26-27\\/\\d+/.test(document.querySelector('main').innerText) && /Bill saved/.test(document.querySelector('main').innerText)`, 9000), (await text()).slice(0, 200));
  await shot('4-saved');

  // ---- Same items again
  await page.run(`window.dispatchEvent(new KeyboardEvent('keydown', { altKey: true, code: 'KeyN', key: 'n' }))`);
  await until(`document.querySelector('[data-place="customer"] input')`);
  await page.run(`document.querySelector('[data-place="customer"] input').focus()`);
  await typeThenEnter('murugan', 700);
  await until(`/Same items again/.test(document.querySelector('main').innerText)`);
  await clickText('Same items again', 'main');
  await sleep(300);
  const lines = await page.run(`[...document.querySelectorAll('[data-line]')].map((l) => [...l.querySelectorAll('input')].map((i) => i.value))`);
  check('the goods of the last bill are there', lines.length === 3 && lines[0][1] === '100' && lines[1][0] === 'Special bracket' && lines[1][1] === '2', JSON.stringify(lines));
  check('a product brings its GST, the typed item asks for it', lines[0][4] === '18' && lines[1][4] === '', JSON.stringify(lines));
  check('the cursor is where something is missing', (await focusName()) === 'GST %, line 2', await focusName());
  await shot('5-same-again');
  await page.run(`window.confirm = () => true`);
  await clickText('Clear', 'main');
  await sleep(400);
  check('Clear empties the bill', (await page.run(`document.querySelector('[data-place="customer"] input').value`)) === '');
  await clickText('Job work', 'main');
  await sleep(200);
  check('job work shows its own section', /Job work/i.test(await text()) && (await page.run(`document.querySelector('[aria-pressed="true"]').textContent`)) === 'Job work');
  await clickText('Sale', 'main');

  // ---- Money received
  await page.go(`${APP}/money`, `document.querySelector('input[aria-label="Who paid"]')`);
  await page.run(`document.querySelector('input[aria-label="Who paid"]').focus()`);
  await typeThenEnter('kongu', 700);
  check('the unpaid bill comes with its amount', await until(`document.querySelector('input[name="amount"]')?.value === '39309.00'`), await page.run(`document.querySelector('input[name="amount"]')?.value ?? 'no box'`));
  await shot('6-money');
  await page.run(`(() => { const e = document.querySelector('input[name="amount"]'); e.focus(); e.select(); })()`);
  await page.type('40000');
  await sleep(150);
  check('more than the bill needs is said at once', /More than this bill needs/.test(await text()));
  await page.run(`(() => { const e = document.querySelector('input[name="amount"]'); e.focus(); e.select(); })()`);
  await page.type('39000');
  await sleep(150);
  check('less than the bill offers full settlement', /settles the bill in full/.test(await text()));
  await clickText('Cash', 'main');
  await clickText('Save', 'form[aria-label="Write down money"]');
  check('saved, said in words', await until(`/₹39,000\\.00 from Kongu Pump Works for INV\\/26-27\\/0006 is saved/.test(document.querySelector('main').innerText)`), (await text()).slice(0, 300));
  check('and it stands in the list', await until(`/Kongu Pump Works[\\s\\S]*₹39,000/.test(document.querySelector('section[aria-label="What came in"]').innerText)`));
  await shot('7-money-saved');

  // ---- Send goods
  await page.go(`${APP}/dispatch`, `document.querySelector('ul[aria-label="Goods to send"]')`);
  const before = await page.run(`document.querySelectorAll('ul[aria-label="Goods to send"] li').length`);
  await clickText('Packed', 'ul[aria-label="Goods to send"]');
  check('Packed', await until(`/Packed/.test(document.querySelector('ul[aria-label="Goods to send"] li .pill').innerText)`));
  await clickText('Send', 'ul[aria-label="Goods to send"] li');
  await sleep(300);
  await shot('8-send');
  check('Send asks how it goes', await page.run(`document.querySelector('dialog[open]') !== null && /How it goes/.test(document.querySelector('dialog[open]').innerText)`));
  await page.run(`(() => { const i = document.querySelector('dialog[open] input[placeholder="TN38AB1234"]'); i.focus(); i.select(); })()`);
  await page.type('tn 37 ab 4455');
  await clickText('Goods are sent', 'dialog[open]');
  check('then it is on the way, with the vehicle', await until(`!document.querySelector('dialog[open]') && /TN37AB4455/.test(document.querySelector('main').innerText)`), (await text()).slice(0, 300));
  await clickText('Delivered', 'ul[aria-label="Goods to send"] li');
  check('Delivered takes it off the list', await until(`document.querySelectorAll('ul[aria-label="Goods to send"] li').length === ${before - 1}`));

  // ---- One bill
  const [bill] = await sql(`select id from public.invoices where po_no = 'PO/1187'`);
  await page.go(`${APP}/invoices/${bill.id}`, `document.querySelector('section[aria-label="Money"]')`);
  await clickText('Record money', 'main');
  await sleep(250);
  check('Record money has the rest filled in', (await page.run(`document.querySelector('dialog[open] input[name="amount"]').value`)) === '9984.00');
  await shot('9-record');
  await page.run(`(() => { const e = document.querySelector('dialog[open] input[name="amount"]'); e.focus(); e.select(); })()`);
  await page.type('984');
  await clickText('Save', 'dialog[open]');
  check('the balance goes down', await until(`/₹9,000\\.00/.test(document.querySelector('section[aria-label="Money"]').innerText)`), await text('section[aria-label="Money"]'));
  await clickText('Undo', 'section[aria-label="What happened"]');
  await sleep(250);
  await page.run(`document.querySelector('dialog[open] input[name="reason"]').focus()`);
  await page.type('typed twice');
  await clickText('Undo this receipt', 'dialog[open]');
  check('Undo brings it back', await until(`/₹9,984\\.00/.test(document.querySelector('section[aria-label="Money"]').innerText)`), await text('section[aria-label="Money"]'));
  await clickText('Cancel bill', 'main');
  await sleep(250);
  await page.run(`document.querySelector('dialog[open] input[name="reason"]').focus()`);
  await page.type('test of a refusal');
  await clickText('Cancel this bill', 'dialog[open]');
  check('a bill with money on it cannot be cancelled, and says why', await until(`/receipts; void them before cancelling|has receipts/.test(document.querySelector('dialog[open]')?.innerText ?? '')`), await page.run(`document.querySelector('dialog[open]')?.innerText ?? 'closed'`));
  await shot('10-refused');

  // ---- Finding, and the + menu
  await page.go(`${APP}/home`, `document.querySelector('main')`);
  await page.run(`window.dispatchEvent(new KeyboardEvent('keydown', { ctrlKey: true, key: 'k' }))`);
  check('Ctrl+K goes to the find box', (await page.run(`document.activeElement?.name`)) === 'q');
  await page.type('PO/1187');
  await page.key('Enter');
  check('found by P.O. number', await until(`location.pathname === '/find' && /Murugan Engineering Works/.test(document.querySelector('main').innerText)`));
  await page.go(`${APP}/find?q=${encodeURIComponent('inv/26-27/0014')}`, `document.querySelector('main')`);
  check('a whole bill number opens that bill', await until(`location.pathname === '/invoices/${bill.id}'`), await page.run('location.pathname'));
  await click('.head button[popovertarget="make-menu"]');
  await sleep(250);
  check('+ opens the menu', await page.run(`document.querySelector('#make-menu').matches(':popover-open')`));
  await shot('11-make');
  await clickText('Customer', '#make-menu');
  check('Customer opens an empty customer', await until(`location.pathname === '/customers' && !!document.querySelector('form[aria-label="New customer"]')`));
  check('and the menu is closed', await page.run(`!document.querySelector('#make-menu').matches(':popover-open')`));

  // ---- Staff, and an empty list
  await page.cdp('Network.clearBrowserCookies');
  await signIn(page, APP, 'staff@studflow.test');
  await page.go(`${APP}/home`, `document.querySelector('section[aria-label="Figures"]')`);
  check('staff has Home, without the Excel line', !/Excel book/.test(await text('section[aria-label="Safe and in order"]')), await text('section[aria-label="Safe and in order"]'));
  await page.go(`${APP}/invoices?q=${encodeURIComponent("nobody';--")}`, `document.querySelector('main')`);
  check('nothing found is said in words', /Nothing found for/.test(await text()));
  await page.go(`${APP}/invoices?show=rubbish&page=-4&month=99`, `document.querySelector('main')`);
  check('a broken address is the plain list', /16 bills|17 bills|15 bills/.test(await text()), (await text()).slice(0, 120));
  console.log(page.logs.length ? `console: ${page.logs.join(' | ').slice(0, 600)}` : 'no errors in the console');
  console.log(wrong === 0 ? 'ALL GOOD' : `${wrong} WRONG`);
} catch (error) {
  await shot('failed');
  console.log('STOPPED', error.message, (await text().catch(() => '')).slice(0, 300));
} finally {
  page.close();
}
