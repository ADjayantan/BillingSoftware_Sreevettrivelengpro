// A small driver for Edge (own empty profile): open, wait, look, act. Only used against the practice copy on this PC.
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function browser(port = 9340) {
  const edge = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions', '--hide-scrollbars', `--remote-debugging-port=${port}`, `--user-data-dir=${join(here, `edge-${port}`)}`, 'about:blank'], { stdio: 'ignore' });
  let target;
  for (let i = 0; i < 60 && !target; i += 1) {
    await sleep(250);
    target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' }).then((r) => r.json()).catch(() => undefined);
  }
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve) => socket.addEventListener('open', resolve));
  let id = 0;
  const waiting = new Map();
  const logs = [];
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) waiting.get(message.id)?.(message);
    if (message.method === 'Runtime.exceptionThrown') logs.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') logs.push(message.params.args.map((a) => a.value ?? a.description).join(' '));
  });
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    id += 1;
    waiting.set(id, (message) => (message.error ? reject(new Error(`${method}: ${message.error.message}`)) : resolve(message.result)));
    socket.send(JSON.stringify({ id, method, params }));
  });
  await cdp('Page.enable');
  await cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
  await cdp('Runtime.enable');
  const run = async (expression) => {
    const { result, exceptionDetails } = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  };
  return {
    cdp, run, logs,
    async go(url, until = 'true') {
      await cdp('Page.navigate', { url });
      for (let i = 0; i < 100; i += 1) {
        await sleep(120);
        if (await run(`document.readyState === 'complete' && !!(${until})`).catch(() => false)) return;
      }
      throw new Error(`never ready: ${url}`);
    },
    async size(width, height, mobile = false, scale = 1) {
      await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile });
    },
    async scheme(value) {
      await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
    },
    async shot(full = false) {
      const { data } = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full, ...(full ? { clip: await run(`({ x: 0, y: 0, width: document.documentElement.clientWidth, height: Math.min(6000, document.documentElement.scrollHeight), scale: 1 })`) } : {}) });
      return Buffer.from(data, 'base64');
    },
    async key(key, modifiers = 0) {
      const code = { Enter: 13, Tab: 9, Escape: 27, ArrowDown: 40, ArrowUp: 38 }[key];
      const base = { key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, modifiers, ...(key === 'Enter' ? { text: '\r' } : {}) };
      await cdp('Input.dispatchKeyEvent', { type: 'keyDown', ...base });
      await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    },
    async type(text) {
      await cdp('Input.insertText', { text });
    },
    close() {
      socket.close();
      edge.kill();
    },
  };
}

export async function signIn(page, app = process.env.APP ?? 'http://localhost:3100', email = 'owner@studflow.test') {
  await page.go(`${app}/login`, `document.querySelector('input[type=password]') || location.pathname !== '/login'`);
  if (await page.run(`location.pathname !== '/login'`)) return;
  await page.run(`(() => { const set = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
    set(document.querySelector('input[type=email], input[name=email]'), ${JSON.stringify(email)}); set(document.querySelector('input[type=password]'), 'any-password'); document.querySelector('form').requestSubmit(); })()`);
  for (let i = 0; i < 60 && !(await page.run(`location.pathname !== '/login'`).catch(() => false)); i += 1) await sleep(200);
}
