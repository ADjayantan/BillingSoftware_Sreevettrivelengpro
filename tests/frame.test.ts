// The frame around every page, and the words of the whole software (specs/new-look.md).
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { MAKE, MENU } from '@/components/frame/menu';
import { deviceState } from '@/lib/queue-note';

vi.mock('next/navigation', () => ({ usePathname: () => '/invoices/abc', useRouter: () => ({ push: () => undefined }) }));
vi.mock('@/app/login/actions', () => ({ signOut: async () => undefined }));

const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => (statSync(`${dir}/${name}`).isDirectory() ? files(`${dir}/${name}`) : [`${dir}/${name}`]));
const pageOf = (href: string): string => `src/app/(app)${href.split('?')[0] ?? ''}/page.tsx`;

describe('the menu', () => {
  const entries = [...MENU, ...MAKE].flatMap((group) => group.entries);

  it('leads only to pages that exist', () => {
    for (const { href } of entries) expect(existsSync(pageOf(href)), href).toBe(true);
    expect(new Set(MENU.flatMap((group) => group.entries).map(({ href }) => href)).size).toBe(MENU.flatMap((group) => group.entries).length);
  });

  it('reaches every page that is a place of its own', () => {
    const reached = new Set([...entries.map(({ href }) => pageOf(href)), pageOf('/find'), pageOf('/more')]);
    const places = files('src/app/(app)').filter((file) => file.endsWith('/page.tsx') && !file.includes('['));
    expect(places.filter((file) => !reached.has(file))).toEqual([]);
  });
});

describe('the frame', () => {
  it('is the same for everybody: no data in it, and it knows which page is open', async () => {
    const { default: AppLayout } = await import('@/app/(app)/layout');
    const html = renderToStaticMarkup(createElement(AppLayout, null, createElement('p', null, 'the page')));
    expect(html).toContain('<p>the page</p>');
    expect(html).toContain('StudFlow'); // until this device knows the company's name
    for (const { label } of MENU.flatMap((group) => group.entries)) expect(html).toContain(label);
    expect([...html.matchAll(/<a[^>]*aria-current="page"[^>]*>/g)].map(([tag]) => /href="([^"]*)"/.exec(tag)?.[1])).toEqual(['/invoices', '/invoices']);
    expect(html).toMatch(/popovertarget="make-menu"/i);
    expect(html).not.toMatch(/₹|GSTIN\s*:|@/);
  });

  it('every sign stands beside words, or its button has a name', async () => {
    const { default: AppLayout } = await import('@/app/(app)/layout');
    const html = renderToStaticMarkup(createElement(AppLayout, null));
    for (const [, tag = '', inside = ''] of html.matchAll(/<(?:button|a)([^>]*)>(.*?)<\/(?:button|a)>/gs)) {
      const words = inside.replace(/<svg.*?<\/svg>/gs, '').replace(/<[^>]*>/g, '').trim();
      expect(words !== '' || tag.includes('aria-label='), `${tag} ${inside.slice(0, 40)}`).toBe(true);
    }
  });
});

describe('what the menu says about this device', () => {
  it.each([
    ['online', 0, 0, 'ok', 'Online · all saved'],
    ['online', 1, 0, 'wait', 'Sending 1 bill'],
    ['online', 3, 0, 'wait', 'Sending 3 bills'],
    ['offline', 0, 0, 'offline', 'No internet · billing works'],
    ['offline', 2, 0, 'offline', 'No internet · 2 bills kept here'],
    ['signed_out', 2, 0, 'attention', 'Signed out'],
    ['online', 0, 1, 'attention', '1 bill needs you'],
    ['offline', 4, 2, 'attention', '2 bills need you'],
  ] as const)('%s, %d waiting, %d for a person', (connection, pending, attention, state, text) => {
    expect(deviceState(connection, { pending, attention })).toEqual({ state, text });
  });
});

describe('the software speaks easy English', () => {
  // What it understands may be Tamil or Tanglish (src/lib/gemini.ts); what it says may not.
  const TANGLISH = /tanglish|vanakkam|nandri|\b(irukku|pannunga|panniten|anuppunga|venum|vendaam|kuduppaanga|paarunga|paathukkonga|kidaikkaadhu|innaikku|aagudhu|mudinju|baaki|namma|macha|kanakku|thogai)\w*|\w-ku\b/i;
  const spoken = [...files('src/app'), ...files('src/components'), ...files('public')]
    .filter((file) => /\.(tsx|html|json)$/.test(file) || /src\/app\/api\/cron\/.*\.ts$/.test(file))
    .concat(['src/lib/whatsapp.ts', 'src/lib/telegram.ts', 'src/lib/queue-note.ts', 'src/lib/bill-state.ts', 'src/lib/bill-form.ts', 'src/lib/api-client.ts', 'src/lib/api/http.ts', 'public/sw.js'])
    // The PC app: what the page says about printing and voice, and the program's own windows.
    .concat(['src/lib/desktop.ts', 'desktop/src/main.ts'])
    // Connecting Google Drive from the Company page.
    .concat(['src/lib/drive-words.ts']);

  it('in every file that says something', () => {
    expect(spoken.length).toBeGreaterThan(45);
    const found = spoken.flatMap((file) => readFileSync(file, 'utf8').split('\n').flatMap((line, i) => (TANGLISH.test(line) ? [`${file}:${i + 1} ${line.trim().slice(0, 100)}`] : [])));
    expect(found).toEqual([]);
  });
});
