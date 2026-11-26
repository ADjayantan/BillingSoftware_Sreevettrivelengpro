/**
 * Every rule of the PC app, pure, so the root suite can prove them (tests/desktop-policy.test.ts);
 * main.ts only applies them. Why each rule exists: specs/desktop-app.md, "Safety".
 * No import of electron or node here: the root type check compiles this file too.
 */

/** The one site the window shows. If the site moves, change it here, rebuild and reinstall. */
export const APP_ORIGIN = 'https://studflow-six.vercel.app';

export type Paper = 'a4' | 'a5';
export const PAPER_SIZE: Readonly<Record<Paper, 'A4' | 'A5'>> = { a4: 'A4', a5: 'A5' };

/** What a print call can answer; src/lib/desktop.ts reads the same reasons on the page. */
export const PRINT_REASONS = ['cancelled', 'failed', 'refused', 'no-printer'] as const;
export type PrintReason = (typeof PRINT_REASONS)[number];
export type PrintAnswer = { ok: true; printer: string } | { ok: false; reason: PrintReason };

const parse = (url: string): URL | null => {
  try {
    return new URL(url);
  } catch {
    return null;
  }
};

// A user name in a link is the classic way to dress one site up as another.
const hasUser = (url: URL): boolean => url.username !== '' || url.password !== '';

const PRACTICE_HOSTS = new Set(['localhost', '127.0.0.1']);

/**
 * The site a run opens. The installed exe ignores any override; a development run may open
 * only the practice copy on this PC, and says so loudly when told anything else.
 */
export function siteOrigin(packaged: boolean, override: string | undefined): string {
  if (packaged || !override) return APP_ORIGIN;
  const url = parse(override);
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:') || hasUser(url) || !PRACTICE_HOSTS.has(url.hostname)) {
    throw new Error('STUDFLOW_URL may only point at the practice copy on this PC, like http://localhost:3100');
  }
  return url.origin;
}

/** Exactly the site: same scheme, host and port, no user name. A blob or data page is not the site. */
export function isInside(url: string, origin: string): boolean {
  const target = parse(url);
  const home = parse(origin);
  return target !== null && home !== null && target.protocol === home.protocol && target.origin === home.origin && !hasUser(target);
}

export type LinkDecision = 'inside' | 'browser' | 'refuse';

/** The site opens inside; other https pages open in the normal browser; every other kind is refused. */
export function decideLink(url: string, origin: string): LinkDecision {
  if (isInside(url, origin)) return 'inside';
  const target = parse(url);
  return target !== null && target.protocol === 'https:' && !hasUser(target) ? 'browser' : 'refuse';
}

/** Files only from the site, or from a blob the site's own page made. */
export function downloadAllowed(url: string, origin: string): boolean {
  if (isInside(url, origin)) return true;
  const target = parse(url);
  // blob:https://host/<id> keeps the page that made it in its path.
  return target !== null && target.protocol === 'blob:' && isInside(target.pathname, origin);
}

/**
 * What a page may ask of the PC: writing text to the clipboard (the WhatsApp words) and keeping
 * its own storage, so unsent bills are never cleared to make room. For the site only; no camera,
 * mic, location, notifications, devices or screen.
 */
export const ALLOWED_PERMISSIONS: readonly string[] = ['clipboard-sanitized-write', 'persistent-storage'];

export function permissionAllowed(permission: string, requestingUrl: string, origin: string): boolean {
  return ALLOWED_PERMISSIONS.includes(permission) && isInside(requestingUrl, origin);
}

const PRINT_PATH =/^\/invoices\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/print$/i;

/**
 * The paper of a print page, from the page's own address, never from the page. The page reads
 * it with z.enum(['a4', 'a5']).catch('a4'), so anything but exactly one 'a5' is A4 here too.
 */
export function printPaper(url: string, origin: string): Paper | null {
  if (!isInside(url, origin)) return null;
  const page = new URL(url);
  if (!PRINT_PATH.test(page.pathname)) return null;
  const papers = page.searchParams.getAll('paper');
  return papers.length === 1 && papers[0] === 'a5' ? 'a5' : 'a4';
}

const MAX_NAME = 256;
const goodName = (name: unknown): name is string => typeof name === 'string' && name.length > 0 && name.length <= MAX_NAME && !/\p{Cc}/u.test(name);

export type SavedPrinters = Partial<Record<Paper, string>>;

/** printers.json as written by rememberPrinter; anything odd in it is dropped, not trusted. */
export function readSavedPrinters(text: string | null | undefined): SavedPrinters {
  if (!text) return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return {};
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const saved: SavedPrinters = {};
  for (const paper of ['a4', 'a5'] as const) {
    const name: unknown = Object.hasOwn(value, paper) ? (value as Record<string, unknown>)[paper] : undefined;
    if (goodName(name)) saved[paper] = name;
  }
  return saved;
}

export function rememberPrinter(saved: SavedPrinters, paper: Paper, name: string): SavedPrinters {
  return { ...saved, [paper]: name };
}

/** A saved printer counts only while Windows still lists it; otherwise the list is shown again. */
export function printerFor(saved: SavedPrinters, paper: Paper, available: readonly string[]): string | null {
  const name = saved[paper];
  return name !== undefined && available.includes(name) ? name : null;
}

/** Windows shows each choice as a large button: eight fit, the rest go to the Windows print window. */
export const CHOOSER_LIMIT = 8;

export function chooserList(printers: readonly { name: string; isDefault: boolean }[]): string[] {
  const names: string[] = [];
  for (const { name } of [...printers.filter((p) => p.isDefault), ...printers.filter((p) => !p.isDefault)]) {
    if (goodName(name) && !names.includes(name)) names.push(name);
  }
  return names.slice(0, CHOOSER_LIMIT);
}

/**
 * Switches that would let other software look inside the program, or lower its safety. The
 * installed exe does not start with any of them. Chromium on Windows reads --, - and / alike,
 * in any case, and stops reading switches at a bare --.
 */
export const REFUSED_SWITCHES: readonly string[] = [
  'remote-debugging-port', 'remote-debugging-pipe', 'remote-debugging-address', 'remote-allow-origins', 'auto-open-devtools-for-tabs',
  'inspect', 'inspect-brk', 'inspect-port', 'inspect-publish-uid', 'js-flags',
  'no-sandbox', 'disable-web-security', 'disable-site-isolation-trials', 'allow-running-insecure-content', 'allow-file-access-from-files',
  'unsafely-treat-insecure-origin-as-secure', 'ignore-certificate-errors', 'ignore-certificate-errors-spki-list', 'allow-insecure-localhost',
  'host-rules', 'host-resolver-rules', 'proxy-server', 'proxy-pac-url', 'proxy-bypass-list',
  'load-extension', 'disable-extensions-except', 'user-data-dir', 'enable-features', 'disable-features', 'enable-blink-features',
];

const SWITCH = /^(?:--|-|\/)([^=]+)(?:=.*)?$/s;

export function refusedSwitch(argv: readonly string[]): string | null {
  for (const arg of argv) {
    if (arg === '--') return null;
    const name = SWITCH.exec(arg)?.[1]?.toLowerCase();
    if (name !== undefined && REFUSED_SWITCHES.includes(name)) return name;
  }
  return null;
}
