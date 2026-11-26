// A real browser (Edge, own empty profile) signs in to the practice copy on this PC, issues made-up bills through
// the app's own API, opens the print page and prints it to PDF, with background graphics switched off.
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'printed');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const APP = 'http://localhost:3100';
const PORT = 9333;
const edge = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', ['--headless=new', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(here, 'edge-e2e')}`, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let target;
for (let i = 0; i < 40 && !target; i += 1) {
  await sleep(250);
  target = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' }).then((r) => r.json()).catch(() => undefined);
}
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve) => socket.addEventListener('open', resolve));
let id = 0;
const waiting = new Map();
socket.addEventListener('message', ({ data }) => {
  const message = JSON.parse(data);
  if (message.id) waiting.get(message.id)?.(message);
});
const cdp = (method, params = {}) => new Promise((resolve, reject) => {
  id += 1;
  waiting.set(id, (message) => (message.error ? reject(new Error(`${method}: ${message.error.message}`)) : resolve(message.result)));
  socket.send(JSON.stringify({ id, method, params }));
});
const run = async (expression) => {
  const { result, exceptionDetails } = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  return result.value;
};
const go = async (url, until) => {
  await cdp('Page.navigate', { url });
  for (let i = 0; i < 80; i += 1) {
    await sleep(150);
    if (await run(`document.readyState === 'complete' && (${until})`).catch(() => false)) return;
  }
  throw new Error(`never ready: ${url}`);
};
try {
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await go(`${APP}/login`, `!!document.querySelector('input[type=password]')`);
  await run(`(() => { const set = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
    set(document.querySelector('input[type=email], input[name=email]'), 'owner@studflow.test'); set(document.querySelector('input[type=password]'), 'any-password'); document.querySelector('form').requestSubmit(); })()`);
  for (let i = 0; i < 60 && !(await run(`location.pathname !== '/login'`).catch(() => false)); i += 1) await sleep(200);

  const api = (path, method = 'GET', body) => run(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'content-type': 'application/json' }, ${body ? `body: ${JSON.stringify(JSON.stringify(body))}` : ''} }).then((r) => r.json())`);
  // Made-up details; only the name and the line under it are the owner's own.
  await api('/api/company', 'PUT', { legal_name: 'Sre Vettrivel Engineering Products', tagline: 'Mfrs : Plastic, MS, SS 410, SS 304, Stud & Pump Spares', gstin: '33AAECS2468R1ZS', address: '1 Test Road, Ganapathy, Coimbatore - 641 001.', factory_address: '2/3, Test Thottam, Sample Nagar, Ganapathy, Coimbatore - 641 001.', office_phone: '0422 - 1234567', phone: '9000000000', email: 'sample@example.com', bank_name: 'Demo Bank', bank_branch: 'Main Branch', bank_account_no: '000011112222', bank_ifsc: 'DEMO0000001' });
  const customers = async (q) => (await api(`/api/customers?q=${encodeURIComponent(q)}`)).data.rows[0];
  const tn = await customers('Murugan Engineering');
  const ka = await customers('Bharat');
  const today = await run(`new Date(Date.now() + 19800000).toISOString().slice(0, 10)`);
  const line = (over = {}) => ({ stud_item_id: null, description: 'SS 304 Stud M12 × 150 mm, both ends threaded', hsn_sac: '7318', billing_unit: 'pcs', quantity: '100', rate: '42.50', gst_rate: '18', ...over });
  const issue = async (name, over) => {
    const draft = { client_temp_id: `OFFLINE-${crypto.randomUUID()}`, bill_type: 'supply', customer_id: tn.id, invoice_date: today, due_date: today, lines: [line()], delivery: {}, expected_total_paise: 0, ...over };
    let reply = await api('/api/invoices/sync', 'POST', draft);
    if (reply.error?.code === 'TOTAL_CHANGED') {
      const [, rupees, paise] = /₹([\d,]+)\.(\d\d)/.exec(reply.error.message);
      reply = await api('/api/invoices/sync', 'POST', { ...draft, expected_total_paise: Number(rupees.replace(/,/g, '')) * 100 + Number(paise) });
    }
    if (reply.error) throw new Error(`${name}: ${JSON.stringify(reply.error)}`);
    return { name, id: reply.data.invoice_id, no: reply.data.invoice_no };
  };
  const tamil = (await api('/api/customers', 'POST', { name: 'ஸ்ரீ முருகன் பொறியியல்', gstin: '', phone: '9876543299', state_code: '33', is_sez: false, credit_days: 0, address: 'காந்திபுரம், கோயம்புத்தூர்', opening_balance: '0', is_active: true })).data ?? (await customers('முருகன்'));
  const lot = (await api('/api/job-work', 'POST', { customer_id: tn.id, party_dc_no: `KF/${Date.now() % 100000}`, party_dc_date: today, material_grade: 'SS 410', description: '12 mm rods', inward_weight_kg: '500' })).data;
  const bills = [
    await issue('ordinary', { po_no: 'PO/1187', po_date: today, lines: [line(), line({ description: 'SS 410 Pump Shaft Stud M16 × 220 mm', quantity: '40', rate: '118.75' }), line({ description: 'MS Stud M10 × 80 mm', billing_unit: 'kg', quantity: '25.5', rate: '96', pieces: 480 }), line({ description: 'Plastic Bush 25 mm, pump spare', hsn_sac: '3926', quantity: '200', rate: '6.25' })], delivery: { vehicle_no: 'TN38AB1234', driver_name: 'Kumar', driver_phone: '9876500000' } }),
    await issue('rates', { customer_id: ka.id, notes: 'Handle with care.', lines: [line(), line({ description: 'Bush', quantity: '200', rate: '6.25', gst_rate: '12' }), line({ description: 'Sample', quantity: '1', rate: '15.35', gst_rate: '5' })], packing: '40', freight: '300', delivery: { transport_mode: 'transporter', lr_number: 'LR/7', delivery_address: 'Plot 88, KIADB Phase 2, Nelamangala 562123' } }),
    await issue('charges', { packing: '40', freight: '300' }),
    await issue('sixty', { lines: Array.from({ length: 60 }, (_, i) => line({ description: `Stud line ${i + 1}`, quantity: String(i + 1) })) }),
    await issue('jobwork', { bill_type: 'job_work', lines: [line({ description: 'Threading M12 both ends', hsn_sac: '998873', billing_unit: 'kg', quantity: '480.5', rate: '12' })], returns: [{ lot_id: lot.id, returned_weight_kg: '480.5', scrap_weight_kg: '15', pieces: 5400, declared_value: '5000.50', goods_description: '12 mm rods threaded', close: true }] }),
    await issue('tamil', { customer_id: tamil.id, lines: [line({ description: 'குண்டூசி & studs “M12” × 80 mm · ½' })] }),
  ];
  const results = [];
  for (const bill of bills) {
    for (const paper of ['a4', 'a5']) {
      for (const query of ['docs=invoice', 'docs=dc', ...(bill.name === 'ordinary' || bill.name === 'sixty' ? ['docs=both&copies=all'] : [])]) {
        await go(`${APP}/invoices/${bill.id}/print?paper=${paper}&${query}`, `document.querySelectorAll('.sheet').length > 0`);
        const sheets = await run(`document.querySelectorAll('.sheet').length`);
        const { data } = await cdp('Page.printToPDF', { preferCSSPageSize: true, printBackground: false, displayHeaderFooter: true });
        const file = `${bill.name}-${paper}-${query.replace(/\W+/g, '_')}.pdf`;
        writeFileSync(join(out, file), Buffer.from(data, 'base64'));
        const pdf = Buffer.from(data, 'base64').toString('latin1');
        const pages = (pdf.match(/\/Type\s*\/Page\b(?!s)/g) ?? []).length;
        const boxes = [...new Set([...pdf.matchAll(/\/MediaBox\s*\[([^\]]+)\]/g)].map((m) => m[1].trim()))];
        results.push({ file, sheets, pages, boxes });
      }
    }
  }
  let bad = 0;
  for (const r of results) {
    const a4 = r.file.includes('-a4-');
    const [, , w, h] = (r.boxes[0] ?? '').split(/\s+/).map(Number);
    const size = a4 ? Math.abs(w - 595.28) < 1 && Math.abs(h - 841.89) < 1 : Math.abs(w - 419.53) < 1 && Math.abs(h - 595.28) < 1;
    const ok = r.sheets === r.pages && r.boxes.length === 1 && size;
    if (!ok) bad += 1;
    console.log(ok ? 'ok ' : 'BAD', r.file, `${r.sheets} sheets, ${r.pages} pages`, r.boxes.join(' | '));
  }
  console.log(`${results.length} print jobs, ${bad} wrong`);
  writeFileSync(join(out, 'bills.json'), JSON.stringify(bills));
  // The screen, on a phone.
  await cdp('Emulation.setDeviceMetricsOverride', { width: 375, height: 800, deviceScaleFactor: 2, mobile: true });
  await go(`${APP}/invoices/${bills[0].id}/print?paper=a4`, `document.querySelectorAll('.sheet').length > 0`);
  console.log('phone: wider than the screen by', await run(`document.documentElement.scrollWidth - innerWidth`), 'px; sheet', await run(`Math.round(document.querySelector('.sheet').getBoundingClientRect().width)`), 'px wide');
  const phone = await cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(out, 'phone-print.png'), Buffer.from(phone.data, 'base64'));
  await go(`${APP}/billing`, `!!document.querySelector('form[aria-label="New bill"]')`);
  await sleep(800);
  console.log('phone billing: wider than the screen by', await run(`document.documentElement.scrollWidth - innerWidth`), 'px; screens', await run(`(document.documentElement.scrollHeight / innerHeight).toFixed(2)`));
  writeFileSync(join(out, 'phone-billing.png'), Buffer.from((await cdp('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  await go(`${APP}/company`, `!!document.querySelector('[aria-label="How your bill looks"]')`);
  console.log('phone company: wider than the screen by', await run(`document.documentElement.scrollWidth - innerWidth`), 'px');
} finally {
  socket.close();
  edge.kill();
}
