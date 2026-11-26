import { describe, expect, it } from 'vitest';
import {
  APP_ORIGIN,
  CHOOSER_LIMIT,
  PAPER_SIZE,
  PRINT_REASONS,
  chooserList,
  decideLink,
  downloadAllowed,
  isInside,
  permissionAllowed,
  printPaper,
  printerFor,
  readSavedPrinters,
  refusedSwitch,
  rememberPrinter,
  siteOrigin,
} from '../desktop/src/policy';

// The rules of the PC app (specs/desktop-app.md): what may open inside its window, what goes to
// the normal browser, what is refused, and what the installed exe will not start with.

const ID = '8f14e45f-ceea-4e7a-9f3b-2a1c3d4e5f60';
const NETWORK = '\\\\SHOP-PC\\HP LaserJet 1020 (Copy 2)';

describe('the one site inside the window', () => {
  it('is the live site, fixed in the program', () => {
    expect(APP_ORIGIN).toBe('https://studflow-six.vercel.app');
    expect(PAPER_SIZE).toEqual({ a4: 'A4', a5: 'A5' });
    expect(PRINT_REASONS).toEqual(['cancelled', 'failed', 'refused', 'no-printer']);
    expect(CHOOSER_LIMIT).toBe(8);
  });

  it.each([
    'https://studflow-six.vercel.app/',
    'https://studflow-six.vercel.app/invoices?show=open#top',
    'https://STUDFLOW-SIX.Vercel.App/home',
    'https://studflow-six.vercel.app:443/home',
  ])('opens %s inside', (url) => {
    expect(isInside(url, APP_ORIGIN)).toBe(true);
  });

  it.each([
    'http://studflow-six.vercel.app/',
    'https://studflow-six.vercel.app:444/',
    'https://studflow-six.vercel.app./home',
    'https://studflow-six.vercel.app.evil.example/',
    'https://studflow-six.vercel.app@evil.example/',
    'https://user:pw@studflow-six.vercel.app/',
    'https://studfIow-six.vercel.app/',
    'https://studfl\u043ew-six.vercel.app/',
    'blob:https://studflow-six.vercel.app/1234',
    'data:text/html,hi',
    'javascript:alert(1)',
    'file:///C:/Windows/win.ini',
    'not a url',
    '',
  ])('keeps %s out of the window', (url) => {
    expect(isInside(url, APP_ORIGIN)).toBe(false);
  });
});

describe('links', () => {
  it('opens the site inside', () => {
    expect(decideLink(`${APP_ORIGIN}/invoices/${ID}`, APP_ORIGIN)).toBe('inside');
  });

  it.each([
    'https://wa.me/910000000000?text=hi',
    'https://drive.google.com/file/d/abc123/view',
    'https://studflow-six.vercel.app./home',
    'https://studfIow-six.vercel.app/',
  ])('sends %s to the normal browser', (url) => {
    expect(decideLink(url, APP_ORIGIN)).toBe('browser');
  });

  it.each([
    'https://studflow-six.vercel.app@evil.example/',
    'http://example.com/',
    'file:///C:/Windows/win.ini',
    'javascript:alert(1)',
    'data:text/html,hi',
    'blob:https://studflow-six.vercel.app/1234',
    'ms-msdt:/id PCWDiagnostic',
    'whatsapp://send?text=hi',
    'about:blank',
    'not a url',
  ])('refuses %s', (url) => {
    expect(decideLink(url, APP_ORIGIN)).toBe('refuse');
  });
});

describe('permissions', () => {
  it('allows writing to the clipboard and keeping its own storage, for the site only', () => {
    expect(permissionAllowed('clipboard-sanitized-write', `${APP_ORIGIN}/invoices`, APP_ORIGIN)).toBe(true);
    expect(permissionAllowed('persistent-storage', `${APP_ORIGIN}/billing`, APP_ORIGIN)).toBe(true);
    expect(permissionAllowed('persistent-storage', APP_ORIGIN, APP_ORIGIN)).toBe(true);
    expect(permissionAllowed('clipboard-sanitized-write', 'https://evil.example/', APP_ORIGIN)).toBe(false);
    expect(permissionAllowed('persistent-storage', 'http://studflow-six.vercel.app/', APP_ORIGIN)).toBe(false);
  });

  it.each(['media', 'geolocation', 'notifications', 'clipboard-read', 'openExternal', 'fullscreen', 'hid', 'serial', 'usb', 'display-capture', 'midi', 'pointerLock', 'unknown'])(
    'refuses %s',
    (permission) => {
      expect(permissionAllowed(permission, `${APP_ORIGIN}/`, APP_ORIGIN)).toBe(false);
    },
  );
});

describe('downloads', () => {
  it('takes files from the site only', () => {
    expect(downloadAllowed(`${APP_ORIGIN}/api/books/2026-11`, APP_ORIGIN)).toBe(true);
    expect(downloadAllowed(`blob:${APP_ORIGIN}/0b2c6a1e-1111-4222-8333-944455556666`, APP_ORIGIN)).toBe(true);
    expect(downloadAllowed('blob:https://evil.example/123', APP_ORIGIN)).toBe(false);
    expect(downloadAllowed('data:application/octet-stream;base64,AAAA', APP_ORIGIN)).toBe(false);
    expect(downloadAllowed('http://studflow-six.vercel.app/x', APP_ORIGIN)).toBe(false);
    expect(downloadAllowed('https://studflow-six.vercel.app@evil.example/x', APP_ORIGIN)).toBe(false);
  });
});

describe('which site a run opens', () => {
  it('the installed exe always opens the live site', () => {
    expect(siteOrigin(true, 'http://localhost:3100')).toBe(APP_ORIGIN);
    expect(siteOrigin(true, 'https://evil.example')).toBe(APP_ORIGIN);
  });

  it('a development run may open the practice copy on this PC', () => {
    expect(siteOrigin(false, undefined)).toBe(APP_ORIGIN);
    expect(siteOrigin(false, '')).toBe(APP_ORIGIN);
    expect(siteOrigin(false, 'http://localhost:3100')).toBe('http://localhost:3100');
    expect(siteOrigin(false, 'http://127.0.0.1:3100/')).toBe('http://127.0.0.1:3100');
  });

  it.each(['https://evil.example', 'http://localhost.evil.example:3100', 'http://user@localhost:3100', 'file:///C:/x', 'not a url'])(
    'a development run refuses %s',
    (override) => {
      expect(() => siteOrigin(false, override)).toThrow();
    },
  );
});

describe('the paper of a print page', () => {
  const page = `${APP_ORIGIN}/invoices/${ID}/print`;

  it('reads it from the page address the way the page does', () => {
    expect(printPaper(`${page}?paper=a5&docs=both`, APP_ORIGIN)).toBe('a5');
    expect(printPaper(`${page}?docs=dc&paper=a5#x`, APP_ORIGIN)).toBe('a5');
    expect(printPaper(page, APP_ORIGIN)).toBe('a4');
    expect(printPaper(`${page}?paper=A5`, APP_ORIGIN)).toBe('a4');
    expect(printPaper(`${page}?paper=a3`, APP_ORIGIN)).toBe('a4');
    expect(printPaper(`${page}?paper=a5&paper=a4`, APP_ORIGIN)).toBe('a4');
  });

  it('is nothing on any other page', () => {
    expect(printPaper(`${APP_ORIGIN}/invoices/${ID}`, APP_ORIGIN)).toBeNull();
    expect(printPaper(`${APP_ORIGIN}/invoices/not-a-uuid/print?paper=a5`, APP_ORIGIN)).toBeNull();
    expect(printPaper(`https://evil.example/invoices/${ID}/print?paper=a5`, APP_ORIGIN)).toBeNull();
    expect(printPaper('not a url', APP_ORIGIN)).toBeNull();
  });
});

describe('the printers it remembers', () => {
  it('reads what was saved', () => {
    expect(readSavedPrinters('{"a4":"HP LaserJet","a5":"Epson L3110"}')).toEqual({ a4: 'HP LaserJet', a5: 'Epson L3110' });
    expect(readSavedPrinters(JSON.stringify({ a5: NETWORK }))).toEqual({ a5: NETWORK });
    expect(readSavedPrinters(JSON.stringify({ a4: 'P'.repeat(256) }))).toEqual({ a4: 'P'.repeat(256) });
  });

  it.each([
    null,
    undefined,
    'not json',
    '[]',
    '{"a4":5}',
    '{"a3":"HP"}',
    '{"a4":"bad\\u0007name"}',
    JSON.stringify({ a4: 'P'.repeat(257) }),
    '{"__proto__":{"a4":"HP"}}',
  ])('drops %s', (text) => {
    const saved = readSavedPrinters(text);
    expect(saved).toEqual({});
    expect(saved.a4).toBeUndefined();
    expect(({} as { a4?: string }).a4).toBeUndefined();
  });

  it('keeps the good one beside a bad one', () => {
    expect(readSavedPrinters('{"a4":"","a5":"Epson"}')).toEqual({ a5: 'Epson' });
  });

  it('remembers a printer for one paper without touching the other', () => {
    const before = { a4: 'HP' };
    expect(rememberPrinter(before, 'a5', 'Epson')).toEqual({ a4: 'HP', a5: 'Epson' });
    expect(before).toEqual({ a4: 'HP' });
  });

  it('uses a saved printer only while Windows still has it', () => {
    expect(printerFor({ a5: 'Epson' }, 'a5', ['HP', 'Epson'])).toBe('Epson');
    expect(printerFor({ a5: 'Epson' }, 'a5', ['HP'])).toBeNull();
    expect(printerFor({ a4: 'HP' }, 'a5', ['HP'])).toBeNull();
  });
});

describe('the printer list', () => {
  it('puts the default first, without doubles or empty names', () => {
    expect(chooserList([
      { name: 'HP LaserJet', isDefault: false },
      { name: 'Epson L3110', isDefault: true },
      { name: 'HP LaserJet', isDefault: false },
      { name: '', isDefault: false },
      { name: 'bad\u0007name', isDefault: false },
      { name: 'P'.repeat(257), isDefault: false },
      { name: NETWORK, isDefault: false },
    ])).toEqual(['Epson L3110', 'HP LaserJet', NETWORK]);
  });

  it('shows at most eight', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ name: `Printer ${i + 1}`, isDefault: i === 11 }));
    const list = chooserList(many);
    expect(list).toHaveLength(CHOOSER_LIMIT);
    expect(list[0]).toBe('Printer 12');
  });
});

describe('switches the installed exe will not start with', () => {
  it.each([
    [['--remote-debugging-port=9222'], 'remote-debugging-port'],
    [['--REMOTE-DEBUGGING-PORT=9222'], 'remote-debugging-port'],
    [['/remote-debugging-port=1'], 'remote-debugging-port'],
    [['-inspect'], 'inspect'],
    [['--inspect-brk=0'], 'inspect-brk'],
    [['--no-sandbox'], 'no-sandbox'],
    [['--disable-web-security'], 'disable-web-security'],
    [['--ignore-certificate-errors'], 'ignore-certificate-errors'],
    [['--proxy-server=x'], 'proxy-server'],
    [['--host-resolver-rules=x'], 'host-resolver-rules'],
    [['--js-flags=x'], 'js-flags'],
    [['--load-extension=x'], 'load-extension'],
    [['--remote-debugging-pipe'], 'remote-debugging-pipe'],
    [['--squirrel-firstrun', '--no-sandbox'], 'no-sandbox'],
  ])('refuses %j', (argv, name) => {
    expect(refusedSwitch(argv)).toBe(name);
  });

  it.each([[['--squirrel-firstrun']], [['C:\\x.txt']], [['--', '--remote-debugging-port=1']], [[]]])('starts with %j', (argv) => {
    expect(refusedSwitch(argv)).toBeNull();
  });
});
