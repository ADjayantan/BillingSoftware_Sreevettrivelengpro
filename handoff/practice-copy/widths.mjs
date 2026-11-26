// Every page at every window width between the phone and the big screen: nothing too wide, nothing out of its box,
// no text squeezed into a column of a few letters. Arguments: widths to look at (default: all).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browser, signIn, sleep } from './cdp.mjs';

const out = join(dirname(fileURLToPath(import.meta.url)), 'widths');
mkdirSync(out, { recursive: true });
const APP = process.env.APP ?? 'http://localhost:3100';
const WIDTHS = process.argv.slice(2).map(Number).filter(Boolean);
const page = await browser(9361);

const LOOK = `(() => {
  const bad = [];
  const say = (what, e) => bad.push(what + ': ' + (e.innerText || e.getAttribute('aria-label') || e.tagName).replace(/\\s+/g, ' ').slice(0, 44));
  const root = document.documentElement;
  if (root.scrollWidth > root.clientWidth) bad.push((root.scrollWidth - root.clientWidth) + 'px too wide');
  const scrolls = (e) => { for (let p = e; p && p !== document.body; p = p.parentElement) { if (['auto', 'scroll'].includes(getComputedStyle(p).overflowX)) return true; } return false; };
  for (const e of document.querySelectorAll('main *')) {
    if (e.offsetParent === null || e.closest('svg') || e.closest('.sr-only')) continue;
    const box = e.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) continue;
    const parent = e.parentElement.getBoundingClientRect();
    if (box.right > parent.right + 2 && getComputedStyle(e).position === 'static' && !scrolls(e)) say('out of its box by ' + Math.round(box.right - parent.right), e);
    const own = [...e.childNodes].some((n) => n.nodeType === 3 && n.data.trim().length > 6);
    if (own && !e.closest('.sr-only')) {
      const all = document.createRange();
      all.selectNodeContents(e);
      const lines = new Set([...all.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top / 4))).size;
      const longest = Math.max(...[...e.childNodes].filter((n) => n.nodeType === 3).flatMap((n) => n.data.split(/\\s+/)).map((w) => w.length));
      if (lines >= 4 && all.getBoundingClientRect().width < 110) say('squeezed (' + lines + ' lines in ' + Math.round(box.width) + 'px)', e);
      if (longest > 3 && longest < 16 && getComputedStyle(e).overflowWrap === 'anywhere') {
        const range = document.createRange();
        for (const n of e.childNodes) if (n.nodeType === 3) for (const m of n.data.matchAll(/[A-Za-z]{4,15}/g)) {
          range.setStart(n, m.index); range.setEnd(n, m.index + m[0].length);
          const tops = new Set([...range.getClientRects()].map((r) => Math.round(r.top)));
          if (tops.size > 1) { say('word cut in two (' + m[0] + ')', e); break; }
        }
      }
    }
  }
  return [...new Set(bad)].slice(0, 12);
})()`;

try {
  await page.scheme('light');
  await page.cdp('Network.clearBrowserCookies');
  await page.size(1366, 768);
  await signIn(page);
  const bill = (await page.run(`fetch('/api/invoices').then((r) => r.json())`)).data.rows[3]?.id;
  const pages = [['home', '/home'], ['bills', '/invoices'], ['bill', `/invoices/${bill}`], ['money', '/money'], ['dispatch', '/dispatch'], ['customers', '/customers'], ['products', '/stud-master'], ['find', '/find?q=engineering'], ['rates', '/rates'], ['books', '/books'], ['jobwork', '/job-work'], ['company', '/company'], ['more', '/more'], ['billing', '/billing']];
  for (const width of WIDTHS.length ? WIDTHS : [320, 360, 390, 430, 600, 768, 832, 900, 1024, 1100, 1152, 1280, 1366, 1440, 1600, 1920]) {
    await page.size(width, width < 832 ? 844 : 768, width < 832, 1);
    for (const [name, path] of pages) {
      await page.go(`${APP}${path}`, `document.querySelector('main')`);
      await sleep(name === 'billing' ? 900 : 300);
      const bad = await page.run(LOOK);
      if (bad.length) console.log(`${width} ${name}\n   ${bad.join('\n   ')}`);
      writeFileSync(join(out, `${width}-${name}.png`), await page.shot());
    }
  }
  console.log(page.logs.filter((line) => !/chrome-extension|Receiving end/.test(line)).join('\n') || 'no errors in the console');
} finally {
  page.close();
}
