// Fills the practice copy (in-memory, this PC only) with made-up data for a few months.
import { browser, signIn } from './cdp.mjs';

const APP = process.env.APP ?? 'http://localhost:3100';
const DB = process.env.DB ?? 'http://127.0.0.1:54321';
const page = await browser(9351);
const sql = async (query) => {
  const reply = await fetch(`${DB}/local/sql`, { method: 'POST', body: query });
  if (!reply.ok) throw new Error(`${query.slice(0, 60)}: ${await reply.text()}`);
  return reply.json();
};
try {
  await signIn(page);
  const api = (path, method = 'GET', body) => page.run(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'content-type': 'application/json' }, ${body ? `body: ${JSON.stringify(JSON.stringify(body))}` : ''} }).then((r) => r.json())`);
  const ok = (reply, what) => {
    if (reply.error) throw new Error(`${what}: ${JSON.stringify(reply.error)}`);
    return reply.data;
  };
  ok(await api('/api/company', 'PUT', {
    legal_name: 'Sre Vettrivel Engineering Products', tagline: 'Mfrs : Plastic, MS, SS 410, SS 304, Stud & Pump Spares', gstin: '33AAECS2468R1ZS', address: '1 Test Road, Sample Nagar, Coimbatore - 641 001.', factory_address: '2/3, Test Thottam, Sample Nagar, Coimbatore - 641 001.',
    office_phone: '0422 - 1234567', phone: '9000000000', email: 'sample@example.com', bank_name: 'SAMPLE BANK', bank_branch: 'Test Branch', bank_account_no: '000011112222', bank_ifsc: 'DEMO0000001',
  }), 'company');
  const customer = async (name, phone, gstin = '', credit_days = 30) => {
    const found = ok(await api(`/api/customers?q=${encodeURIComponent(name)}`), 'find').rows[0];
    return found ?? ok(await api('/api/customers', 'POST', { name, gstin, phone, state_code: '33', is_sez: false, credit_days, address: 'SIDCO, Coimbatore', opening_balance: '0', is_active: true }), name);
  };
  const people = [];
  for (const [name, phone, gstin] of [['Murugan Engineering Works', '', '33AABCM1234F1Z4'], ['Bharat Fasteners Pvt Ltd', '', ''], ['Annai Tools', '9000010001', ''], ['Marudham Valves', '9000010002', ''], ['Kongu Pump Works', '9000010003', ''], ['Siruvani Motors', '', ''], ['Sri Balaji Fabricators', '9000010005', ''], ['Noyyal Castings', '9000010006', '']]) people.push(await customer(name, phone, gstin));
  const product = async (body) => ok(await api('/api/stud-items', 'POST', body), 'product');
  const base = { diameter_mm: null, length_mm: null, thread_type: null, material_grade: null, manual_unit_weight_kg: null, sku_code: '', is_active: true };
  const studs = [
    await product({ ...base, name: 'SS 304 Stud M12 × 150 mm, both ends threaded', diameter_mm: '12', length_mm: '150', thread_type: 'Both ends', material_grade: 'SS 304', hsn_sac: '7318', gst_rate_percent: '18', default_rate_per_piece: '42.50', default_rate_per_kg: null }),
    await product({ ...base, name: 'SS 410 Pump Shaft Stud M16 × 220 mm', diameter_mm: '16', length_mm: '220', thread_type: 'Full thread', material_grade: 'SS 410', hsn_sac: '7318', gst_rate_percent: '18', default_rate_per_piece: '118.75', default_rate_per_kg: null }),
    await product({ ...base, name: 'MS Stud M10 × 80 mm', diameter_mm: '10', length_mm: '80', thread_type: 'Full thread', material_grade: 'MS', hsn_sac: '7318', gst_rate_percent: '18', default_rate_per_piece: null, default_rate_per_kg: '96' }),
    await product({ ...base, name: 'Plastic Bush 25 mm, pump spare', hsn_sac: '3926', gst_rate_percent: '18', default_rate_per_piece: '6.25', default_rate_per_kg: null }),
  ];
  const [a, b, c, d] = studs;
  const line = (stud, quantity, unit = 'pcs') => ({ stud_item_id: stud.id, description: stud.name, hsn_sac: stud.hsn_sac, billing_unit: unit, quantity, rate: unit === 'kg' ? '96' : stud === a ? '42.50' : stud === b ? '118.75' : '6.25', gst_rate: '18' });
  const today = await page.run('new Date(Date.now() + 19800000).toISOString().slice(0, 10)');
  const day = (back) => new Date(Date.parse(`${today}T00:00:00Z`) - back * 86_400_000).toISOString().slice(0, 10);
  const issue = async (who, back, dueIn, lines, over = {}) => {
    const draft = { client_temp_id: `OFFLINE-${crypto.randomUUID()}`, bill_type: 'supply', customer_id: people[who].id, invoice_date: day(Math.min(back, 30)), due_date: day(Math.min(back, 30) - dueIn), lines, delivery: {}, expected_total_paise: 0, ...over };
    let reply = await api('/api/invoices/sync', 'POST', draft);
    if (reply.error?.code === 'TOTAL_CHANGED') {
      const [, rupees, paise] = /₹([\d,]+)\.(\d\d)/.exec(reply.error.message);
      reply = await api('/api/invoices/sync', 'POST', { ...draft, expected_total_paise: Number(rupees.replace(/,/g, '')) * 100 + Number(paise) });
    }
    const made = ok(reply, 'bill');
    if (back > 30) await sql(`set session_replication_role = replica; `).then(() => sql(`update public.invoices set invoice_date = '${day(back)}', due_date = '${day(back - dueIn)}' where id = '${made.invoice_id}'`)).then(() => sql('set session_replication_role = origin'));
    return made;
  };
  const pay = async (bill, amount, mode = 'upi', back = 0, over = {}) => ok(await api(`/api/invoices/${bill.invoice_id}/payments`, 'POST', { client_receipt_id: crypto.randomUUID(), amount, received_on: day(back), mode, reference: '', settles_invoice: false, ...over }), 'pay');
  const total = async (bill) => ok(await api(`/api/invoices/${bill.invoice_id}`), 'bill').invoice.grand_total;

  for (const [back, quantity] of [[160, '2600'], [130, '3300'], [98, '3000'], [67, '3900'], [40, '3700']]) {
    const old = await issue(back % 8, back, 20, [line(a, quantity)]);
    await pay(old, await total(old), 'bank_transfer', 1);
  }
  const late1 = await issue(4, 30, 9, [line(a, '700'), line(b, '30')], { po_no: 'KPW/88' });
  await issue(7, 26, 14, [line(b, '170'), line(d, '250')]);
  const late3 = await issue(6, 24, 20, [line(a, '430')]);
  await pay(late3, '5000', 'cash', 2);
  await issue(5, 29, 30, [line(a, '900'), line(c, '15', 'kg')]);
  const paid = await issue(2, 6, 30, [line(b, '120'), line(a, '85')]);
  await pay(paid, await total(paid), 'upi', 1, { reference: 'UTR 998877' });
  const part = await issue(3, 4, 30, [line(b, '600')], { po_no: 'MV/PO/2026/117' });
  await pay(part, '50000', 'bank_transfer', 1);
  const wrong = await issue(2, 3, 30, [line(d, '10')]);
  ok(await api(`/api/invoices/${wrong.invoice_id}/cancel`, 'POST', { reason: 'Wrong customer' }), 'cancel');
  await issue(1, 1, 45, [line(a, '130')], { delivery: { transport_mode: 'transporter', lr_number: 'LR 5521' } });
  await issue(0, 0, 30, [line(a, '100'), line(b, '40'), line(c, '25.5', 'kg'), line(d, '200')], { po_no: 'PO/1187', po_date: day(5), delivery: { vehicle_no: 'TN38AB1234', driver_name: 'Kumar' }, paid_now: { amount: '5000', mode: 'upi' } });
  await issue(0, 0, 30, [line(a, '250')]);
  await issue(7, 0, 14, [line(b, '60')]);
  const goods = (await sql("select id, dc_no from public.deliveries order by dc_seq")).map((row) => row.id);
  for (const id of goods.slice(0, 11)) await api(`/api/deliveries/${id}`, 'PATCH', { status: 'delivered' });
  await api(`/api/deliveries/${goods[11]}`, 'PATCH', { status: 'packed' });
  await api(`/api/deliveries/${goods[13]}`, 'PATCH', { status: 'dispatched', vehicle_no: 'TN66C9001' });
  ok(await api('/api/job-work', 'POST', { customer_id: people[0].id, party_dc_no: 'KF/8812', party_dc_date: day(9), material_grade: 'SS 410', description: '12 mm rods, 3 m', inward_weight_kg: '500' }), 'lot');
  ok(await api('/api/metal-rates', 'POST', { raw_message: '19/11 rod basic, Rs/kg: M.S round 58.25 | EN-8 84.25 | EN 19 116.50 | s.s.304 210.55' }), 'rates');
  ok(await api('/api/metal-rates', 'POST', { raw_message: '24/11 rod basic, Rs/kg: M.S round 58.25 | EN-8 84.75 | s.s.304 211.75' }), 'rates');

  const quote = async (who, lines, notes) => {
    const draft = { bill_type: 'supply', customer_id: people[who].id, quote_date: today, valid_until: day(-15), notes, lines, expected_total_paise: 0 };
    let reply = await api('/api/quotes', 'POST', draft);
    if (reply.error?.code === 'TOTAL_CHANGED') {
      const [, rupees, paise] = /₹([\d,]+)\.(\d\d)/.exec(reply.error.message);
      reply = await api('/api/quotes', 'POST', { ...draft, expected_total_paise: Number(rupees.replace(/,/g, '')) * 100 + Number(paise) });
    }
    return ok(reply, 'quote');
  };
  await quote(0, [line(a, '400'), line(b, '120')], 'Delivery within 3 days · Ex-works SIDCO Coimbatore');
  await quote(3, [line(b, '250'), line(d, '500')], 'Special pump shaft batch rate valid for 15 days');

  const sup1 = ok(await api('/api/suppliers', 'POST', { name: 'Coimbatore Bright Steels & Alloys', gstin: '33ABCPV1357D1ZX', phone: '9842211223', category: 'raw_material', notes: 'SS 304, SS 410 & EN8 bright bars' }), 'sup1');
  const sup2 = ok(await api('/api/suppliers', 'POST', { name: 'Kovai Thread Dies & Tooling', gstin: '', phone: '9842299887', category: 'tools', notes: 'Thread rolling dies & cutting oil' }), 'sup2');
  ok(await api('/api/expenses', 'POST', { expense_date: day(4), category: 'raw_material', supplier_id: sup1.id, supplier_name: sup1.name, bill_no: 'CBS/26-27/418', description: 'SS 304 12mm bright rod bundle', material_grade: 'SS 304', weight_kg: '320', taxable_amount: '67200.00', gst_amount: '12096.00', payment_mode: 'bank_transfer', payment_status: 'paid' }), 'exp1');
  ok(await api('/api/expenses', 'POST', { expense_date: day(2), category: 'raw_material', supplier_id: sup1.id, supplier_name: sup1.name, bill_no: 'CBS/26-27/439', description: 'SS 410 16mm pump shaft rods', material_grade: 'SS 410', weight_kg: '210', taxable_amount: '31500.00', gst_amount: '5670.00', payment_mode: 'credit', payment_status: 'unpaid' }), 'exp2');
  ok(await api('/api/expenses', 'POST', { expense_date: day(1), category: 'tools', supplier_id: sup2.id, supplier_name: sup2.name, bill_no: 'KTD/882', description: 'M12 × 1.75 thread rolling die set & coolant oil', taxable_amount: '8500.00', gst_amount: '1530.00', payment_mode: 'upi', payment_status: 'paid' }), 'exp3');
  ok(await api('/api/expenses', 'POST', { expense_date: today, category: 'electricity', supplier_name: 'TANGEDCO (TNEB)', bill_no: 'EB-11/2026', description: 'Factory 3-phase electricity bill', taxable_amount: '14200.00', gst_amount: '0', payment_mode: 'bank_transfer', payment_status: 'paid' }), 'exp4');

  console.log('filled:', (await sql('select count(*)::int as n from public.invoices'))[0].n, 'bills');
} finally {
  page.close();
}
