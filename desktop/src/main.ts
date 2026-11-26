import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell } from 'electron';
import type { IpcMainInvokeEvent, MenuItemConstructorOptions, WebContents } from 'electron';
import squirrelStarted from 'electron-squirrel-startup';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  PAPER_SIZE,
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
} from './policy';
import type { Paper, PrintAnswer, SavedPrinters } from './policy';

// StudFlow on the PC: one window on the live site, locked down (specs/desktop-app.md, "Safety").
// Every rule is in policy.ts and tested there; this file only applies them to Electron.

// Only a development run (npm start) reads these, for the practice copy; the installed exe never does.
const dev = !app.isPackaged;
const devSetting = (name: string): string | undefined => (dev ? process.env[name] || undefined : undefined);
// Development runs only: a log line may hold practice data, the installed exe logs nothing.
const note = (line: string): void => {
  if (dev) console.log(`[studflow] ${line}`);
};

let win: BrowserWindow | null = null;

function main(): void {
  // Squirrel starts the exe to make or remove its shortcuts; then it must only quit.
  if (squirrelStarted) {
    app.quit();
    return;
  }
  // Only what the caller passed: app.commandLine also holds switches Electron adds for itself
  // (allow-file-access-from-files), and reading those would stop every start.
  if (app.isPackaged && refusedSwitch(process.argv.slice(1)) !== null) {
    app.exit(1);
    return;
  }
  const origin = siteOrigin(app.isPackaged, process.env.STUDFLOW_URL);
  // A development run keeps its own folder: practice sign-ins and printers never mix with the real app's.
  if (dev) app.setPath('userData', devSetting('STUDFLOW_PROFILE') ?? path.join(app.getPath('appData'), 'StudFlow-dev'));

  app.enableSandbox();
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on('second-instance', () => {
    note('second start: brought the first window to the front');
    if (win === null || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.setAppUserModelId('com.squirrel.studflow.StudFlow');
  Menu.setApplicationMenu(null);
  app.on('web-contents-created', (_event, contents) => guard(contents, origin));
  app.on('window-all-closed', () => app.quit());

  void app.whenReady().then(() => {
    lockSession(origin);
    ipcMain.handle('studflow:print', (event) => printFromPage(origin, event, false));
    ipcMain.handle('studflow:choose-printer', (event) => printFromPage(origin, event, true));
    win = openWindow(origin);
  });
}

function openWindow(origin: string): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    title: 'StudFlow',
    backgroundColor: '#ffffff',
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
      navigateOnDragDrop: false,
      experimentalFeatures: false,
      safeDialogs: true,
      devTools: dev,
    },
  });
  window.removeMenu();
  window.once('ready-to-show', () => reveal(window));
  // A page that never paints (no internet at all) must not leave an invisible program behind.
  setTimeout(() => reveal(window), 4000);
  window.webContents.on('did-fail-load', (_event, code, _description, url, isMainFrame) => {
    // -3 is a navigation stopped on purpose (by the rules below, or a newer one).
    if (!isMainFrame || code === -3) return;
    void couldNotOpen(window, origin, url, code <= -200 && code > -300);
  });
  window.loadURL(`${origin}/`).catch(() => undefined);
  return window;
}

function reveal(window: BrowserWindow): void {
  if (window.isDestroyed() || window.isVisible()) return;
  window.maximize();
  window.show();
}

let asking = false;

async function couldNotOpen(window: BrowserWindow, origin: string, url: string, unsafe: boolean): Promise<void> {
  if (asking || window.isDestroyed()) return;
  asking = true;
  note(unsafe ? 'could not open: the connection is not safe' : 'could not open');
  reveal(window);
  const { response } = await dialog.showMessageBox(window, {
    type: 'warning',
    title: 'StudFlow',
    message: 'StudFlow could not open.',
    detail: unsafe
      ? 'The connection is not safe, so StudFlow did not open the page. Try another internet connection, then try again.'
      : 'Check the internet, then try again. Bills already saved on this PC are safe.',
    buttons: ['Try again', 'Close'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  asking = false;
  if (window.isDestroyed()) return;
  if (response === 0) window.loadURL(isInside(url, origin) ? url : `${origin}/`).catch(() => undefined);
  else window.close();
}

/** The rules for every page the program shows: the site inside, https links outside, nothing else. */
function guard(contents: WebContents, origin: string): void {
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    const decision = decideLink(url, origin);
    if (decision === 'browser') openInBrowser(url);
    else if (decision === 'inside') contents.loadURL(url).catch(() => undefined);
    else note(`refused: ${url}`);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event) => {
    const decision = decideLink(event.url, origin);
    if (decision === 'inside') return;
    event.preventDefault();
    if (decision === 'browser') openInBrowser(event.url);
    else note(`refused: ${event.url}`);
  });
  contents.on('will-redirect', (event) => {
    if (isInside(event.url, origin)) return;
    event.preventDefault();
    note(`refused redirect: ${event.url}`);
  });
  contents.on('will-frame-navigate', (event) => {
    if (event.isMainFrame || isInside(event.url, origin) || event.url === 'about:blank') return;
    event.preventDefault();
    note(`refused frame: ${event.url}`);
  });
  contents.on('context-menu', (_event, params) => {
    const items: MenuItemConstructorOptions[] = params.isEditable
      ? [
          { role: 'cut', enabled: params.editFlags.canCut },
          { role: 'copy', enabled: params.editFlags.canCopy },
          { role: 'paste', enabled: params.editFlags.canPaste },
          { type: 'separator' },
          { role: 'selectAll' },
        ]
      : params.selectionText.trim() !== ''
        ? [{ role: 'copy' }]
        : [];
    if (items.length > 0) Menu.buildFromTemplate(items).popup();
  });
  // With no menu there are no built-in keys, so zoom and reload are kept here.
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const ctrl = (input.control || input.meta) && !input.alt;
    const key = input.key.toLowerCase();
    if (input.key === 'F5' || (ctrl && key === 'r')) {
      event.preventDefault();
      contents.reload();
    } else if (ctrl && (key === '+' || key === '=')) {
      event.preventDefault();
      contents.setZoomLevel(Math.min(contents.getZoomLevel() + 0.5, 4));
    } else if (ctrl && (key === '-' || key === '_')) {
      event.preventDefault();
      contents.setZoomLevel(Math.max(contents.getZoomLevel() - 0.5, -3));
    } else if (ctrl && key === '0') {
      event.preventDefault();
      contents.setZoomLevel(0);
    } else if (dev && input.key === 'F12') {
      contents.toggleDevTools();
    }
  });
}

function openInBrowser(url: string): void {
  if (devSetting('STUDFLOW_NO_BROWSER')) {
    note(`browser: ${url}`);
    return;
  }
  shell.openExternal(url).catch(() => undefined);
}

/** No camera, mic, location, notifications, devices or screen (policy.ts, permissionAllowed). */
function lockSession(origin: string): void {
  const ses = session.defaultSession;
  ses.setSpellCheckerEnabled(false);
  ses.setPermissionRequestHandler((_contents, permission, callback, details) => {
    const allowed = permissionAllowed(permission, details.requestingUrl, origin);
    if (!allowed) note(`permission refused: ${permission}`);
    callback(allowed);
  });
  ses.setPermissionCheckHandler((_contents, permission, requestingOrigin) => permissionAllowed(permission, requestingOrigin, origin));
  ses.setDevicePermissionHandler(() => false);
  ses.on('will-download', (event, item) => {
    if (!downloadAllowed(item.getURL(), origin)) {
      event.preventDefault();
      note(`download refused: ${item.getURL()}`);
      return;
    }
    const name = path.basename(item.getFilename());
    const folder = devSetting('STUDFLOW_PDF_DIR');
    if (folder) {
      item.setSavePath(path.join(folder, name));
      note(`download: ${name}`);
    } else {
      item.setSaveDialogOptions({ title: 'Save file', defaultPath: path.join(app.getPath('downloads'), name) });
    }
  });
}

// Printing ------------------------------------------------------------------------------------

const printersFile = (): string => path.join(app.getPath('userData'), 'printers.json');
let saved: SavedPrinters | null = null;

async function savedPrinters(): Promise<SavedPrinters> {
  saved ??= readSavedPrinters(await readFile(printersFile(), 'utf8').catch(() => null));
  return saved;
}

async function keepPrinter(paper: Paper, name: string): Promise<void> {
  saved = rememberPrinter(await savedPrinters(), paper, name);
  await mkdir(path.dirname(printersFile()), { recursive: true });
  await writeFile(printersFile(), JSON.stringify(saved));
}

let printing = false;
let pdfs = 0;

/** The bridge's two calls. Only the main frame of this window, on a print page of the site, may ask. */
async function printFromPage(origin: string, event: IpcMainInvokeEvent, choose: boolean): Promise<PrintAnswer> {
  const window = win;
  const frame = event.senderFrame;
  if (window === null || window.isDestroyed() || event.sender !== window.webContents || frame === null || frame.parent !== null
    || frame.frameTreeNodeId !== window.webContents.mainFrame.frameTreeNodeId) {
    return { ok: false, reason: 'refused' };
  }
  const paper = printPaper(frame.url, origin);
  // One job at a time: a second press while the first prints is not a second copy.
  if (paper === null || printing) return { ok: false, reason: 'refused' };
  printing = true;
  try {
    const folder = devSetting('STUDFLOW_PDF_DIR');
    if (folder) return await printToFolder(window, paper, folder);
    const printers = (await window.webContents.getPrintersAsync()).map((printer) => printer.name);
    if (printers.length === 0) return { ok: false, reason: 'no-printer' };
    let printer = choose ? null : printerFor(await savedPrinters(), paper, printers);
    if (printer === null) {
      // Electron does not say which printer is the Windows default: the list keeps Windows' order.
      const choice = await askPrinter(window, paper, chooserList(printers.map((name) => ({ name, isDefault: false }))));
      if (choice.kind === 'cancel') return { ok: false, reason: 'cancelled' };
      if (choice.kind === 'windows') return await printWith(window, paper, null);
      if (choice.remember) await keepPrinter(paper, choice.name);
      printer = choice.name;
    }
    return await printWith(window, paper, printer);
  } catch {
    return { ok: false, reason: 'failed' };
  } finally {
    printing = false;
  }
}

type Choice = { kind: 'printer'; name: string; remember: boolean } | { kind: 'windows' } | { kind: 'cancel' };

async function askPrinter(window: BrowserWindow, paper: Paper, names: string[]): Promise<Choice> {
  const other = names.length;
  const cancel = names.length + 1;
  const { response, checkboxChecked } = await dialog.showMessageBox(window, {
    type: 'question',
    title: 'Choose a printer',
    message: `Which printer for ${PAPER_SIZE[paper]} bills?`,
    detail: 'StudFlow prints there straight away from now on. "Change printer", next to Print, asks again.',
    // Windows shows each name as a large button; "Cancel" stays a plain one.
    buttons: [...names, 'Other printer (Windows print window)', 'Cancel'],
    defaultId: 0,
    cancelId: cancel,
    noLink: false,
    checkboxLabel: 'Remember this printer',
    checkboxChecked: true,
  });
  if (response === cancel) return { kind: 'cancel' };
  if (response === other) return { kind: 'windows' };
  const name = names[response];
  return name === undefined ? { kind: 'cancel' } : { kind: 'printer', name, remember: checkboxChecked };
}

/** Straight to the printer when one is named, else the Windows print window; the page's own paper, no margins. */
function printWith(window: BrowserWindow, paper: Paper, printer: string | null): Promise<PrintAnswer> {
  return new Promise((resolve) => {
    window.webContents.print(
      {
        silent: printer !== null,
        ...(printer === null ? {} : { deviceName: printer }),
        pageSize: PAPER_SIZE[paper],
        margins: { marginType: 'none' },
        printBackground: true,
        landscape: false,
        copies: 1,
      },
      (success, failureReason) =>
        resolve(success ? { ok: true, printer: printer ?? 'the printer you chose' } : { ok: false, reason: failureReason === 'cancelled' ? 'cancelled' : 'failed' }),
    );
  });
}

// The paper in inches, exactly: Electron's own A4 for a PDF is about a point off.
const PAPER_INCHES: Readonly<Record<Paper, { width: number; height: number }>> = {
  a4: { width: 210 / 25.4, height: 297 / 25.4 },
  a5: { width: 148 / 25.4, height: 210 / 25.4 },
};

/** Development runs only: the same paper and margins, written to a PDF instead of paper. */
async function printToFolder(window: BrowserWindow, paper: Paper, folder: string): Promise<PrintAnswer> {
  const pdf = await window.webContents.printToPDF({
    pageSize: PAPER_INCHES[paper],
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
    printBackground: true,
    landscape: false,
  });
  pdfs += 1;
  const file = path.join(folder, `${paper}-${pdfs}.pdf`);
  await mkdir(folder, { recursive: true });
  await writeFile(file, pdf);
  note(`printed: ${path.basename(file)}`);
  return { ok: true, printer: `PDF ${path.basename(file)}` };
}

main();
