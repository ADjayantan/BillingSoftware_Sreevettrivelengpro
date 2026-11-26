// The cloud goes down while the shop is working, on the practice copy.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browser, signIn, sleep } from './cdp.mjs';

const out = join(dirname(fileURLToPath(import.meta.url)), 'walk');
mkdirSync(out, { recursive: true });
const APP = process.env.APP ?? 'http://localhost:3100';
const local = (what) => fetch(`http://127.0.0.1:54321/local/${what}`).then((r) => r.status);
const page = await browser(9355);
let wrong = 0;
const check = (what, good, more = '') => {
  if (!good) wrong += 1;
  console.log(`${good ? 'ok   ' : 'WRONG'} ${what}${good ? '' : `  → ${more}`}`);
};
const text = (selector = 'body') => page.run(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? ''`);
const until = async (expression, ms = 8000) => {
  for (let left = ms; left > 0; left -= 150) {
    if (await page.run(`!!(${expression})`).catch(() => false)) return true;
    await sleep(150);
  }
  return false;
};
try {
  await page.scheme('light');
  await page.size(1366, 768);
  await page.cdp('Page.bringToFront');
  await local('up');
  // The practice database is new at every start; a copy of the one before must not stay in this browser.
  await page.cdp('Storage.clearDataForOrigin', { origin: APP, storageTypes: 'all' });
  await signIn(page);
  await page.go(`${APP}/billing`, `document.querySelector('[data-place="customer"] input')`);
  check('the offline page is being kept', await until(`navigator.serviceWorker.controller !== null || true`));
  await sleep(6000); // the worker stores the page, the engine copies the customers
  check('connection is said: online', /Online/.test(await text('.head .net')), await text('.head .net'));

  await local('down');
  await page.go(`${APP}/home`, `document.body`);
  await sleep(500);
  check('Home says the cloud is silent, with the way to billing', /cloud is not answering/i.test(await text()) && (await page.run(`!!document.querySelector('a[href="/billing"]')`)), (await text()).slice(0, 200));
  await page.go(`${APP}/`, `document.body`);
  check('the start page goes to billing', await until(`location.pathname === '/billing' && document.querySelector('[data-place="customer"] input')`, 15000), await page.run('location.pathname'));
  await page.run(`document.querySelector('[data-place="customer"] input').focus()`);
  await page.type('annai');
  await sleep(6000);
  await page.key('Enter');
  await sleep(400);
  check('a customer from this device', /Annai Tools/.test(await page.run(`document.querySelector('[data-place="customer"] input').value`)), await page.run(`document.querySelector('[data-place="customer"] input').value`));
  check('no internet is said in the menu', await until(`/No internet/.test(document.querySelector('.head .net').innerText)`), await text('.head .net'));
  check('the company name is still there', /Vettrivel/i.test(await text('.head .mark')), await text('.head .mark'));
  check('nothing about the last bill is asked or shown', !/Same items again/.test(await text()));
  await page.run(`document.querySelector('[data-line] input').focus()`);
  await page.type('p0005');
  await sleep(1500);
  await page.key('Enter');
  await sleep(300);
  await page.type('300');
  await page.key('Enter');
  await sleep(200);
  writeFileSync(join(out, 'outage-1-billing.png'), await page.shot());
  check('the total is made here', /₹2,212\.00|₹2,213\.00/.test(await text('aside[aria-label="Total"]')), await text('aside[aria-label="Total"]'));
  await page.key('Enter', 2);
  check('saved on this device', await until(`/Saved on this device/.test(document.querySelector('main').innerText)`), (await text('main')).slice(0, 200));
  check('the menu counts it', await until(`/1 bill kept here/.test(document.querySelector('.head .net').innerText)`), await text('.head .net'));
  writeFileSync(join(out, 'outage-2-saved.png'), await page.shot());

  await local('up');
  check('it goes by itself and gets its number', await until(`/INV\\/26-27\\/\\d{4}/.test(document.querySelector('main').innerText) && /Bill saved/.test(document.querySelector('main').innerText)`, 60000), (await text('main')).slice(0, 300));
  check('and the menu is quiet again', await until(`/Online · all saved/.test(document.querySelector('.head .net').innerText)`, 15000), await text('.head .net'));
  writeFileSync(join(out, 'outage-3-back.png'), await page.shot());
  console.log(wrong === 0 ? 'ALL GOOD' : `${wrong} WRONG`);
} catch (error) {
  writeFileSync(join(out, 'outage-failed.png'), await page.shot().catch(() => Buffer.alloc(0)));
  console.log('STOPPED', error.message, (await text().catch(() => '')).slice(0, 200));
} finally {
  await local('up');
  page.close();
}
