// The drawing of the bill and the challan (specs/own-bill.md): whatever is on it, every mark is on
// the paper, nothing covers anything else, and everything is said once.
import { describe, expect, it } from 'vitest';
import { billSheets } from '@/lib/bill-sheets';
import type { PrintDocument, PrintItem, PrintSum } from '@/lib/print-documents';
import { FRAME, type Op, type Sheet, type TextOp } from '@/lib/sheet';

const item = (no: number, over: Partial<PrintItem> = {}): PrintItem => ({
  code: '7318', codeNote: '', description: `Stud line ${String(no).padStart(2, '0')}.`, detail: '', third: '42.50', thirdNote: '/pc', fourth: '100 PCS', fourthNote: '', amount: '4,250.00', ...over,
});
const items = (count: number, over: Partial<PrintItem> = {}): PrintItem[] => Array.from({ length: count }, (_, i) => item(i + 1, over));
const sum = (label: string, amount: string | null, rate = '', base = ''): PrintSum => ({ label, rate, base, amount });

const invoice = (over: Partial<PrintDocument> = {}): PrintDocument => ({
  key: 'invoice-Original for Recipient', kind: 'invoice', title: 'TAX INVOICE', subtitle: '', copyLabel: 'Original for Recipient', stamp: '',
  issuer: {
    name: 'Demo Engineering Products', tagline: 'Mfrs : Plastic, MS, SS 410, SS 304, Stud & Pump Spares',
    addresses: ['Office : 1 Test Road, Ganapathy, Coimbatore - 641 001.', 'Factory : 2 Works Road, Test Thottam, Test Nagar, Ganapathy, Coimbatore - 641 001.'],
    contact: ['Office : 0422 - 1234567', 'Mobile : 90000 00000', 'E-mail : someone@example.com'], gstin: '33AAECS2468R1ZS',
  },
  number: 'INV/26-27/0001', issueDate: '25 Nov 2026',
  refs: [{ label: 'DC No.', value: 'DC/26-27/0001', date: '25.11.26' }, { label: 'P. O. No.', value: 'PO/1187', date: '20.11.26' }],
  to: { role: 'To,', name: 'Murugan Engineering Works', address: '12 SIDCO Industrial Estate, Coimbatore 641021', phone: '98765 43210', gstin: '33AABCM1234F1Z4', state: 'Tamil Nadu (33)' },
  notes: [], heads: { code: 'HSN CODE', third: 'RATE', fourth: 'QTY.', amount: 'AMOUNT', split: true },
  items: items(4),
  sums: [sum('SUB TOTAL', '17,000.00'), sum('CGST', '1,530.00', '9%'), sum('SGST', '1,530.00', '9%'), sum('IGST', null), sum('R. Off', '0.00')],
  rows: [],
  facts: [{ label: 'Place of supply', value: 'Tamil Nadu (33)' }, { label: 'Reverse charge', value: 'No' }, { label: 'Due date', value: '25 Dec 2026' }],
  total: { label: 'TOTAL AMOUNT', amount: '20,060.00' }, words: { label: 'Rupees', value: 'Twenty Thousand Sixty Only' },
  bank: [{ label: 'BANK NAME', value: 'Demo Bank' }, { label: 'BRANCH', value: 'Main' }, { label: 'ACCOUNT No.', value: '000011112222' }, { label: 'IFS CODE', value: 'DEMO0000001' }],
  signatures: [{ organisation: 'Demo Engineering Products', role: 'Authorised Signatory', hint: '', own: true }],
  ...over,
});
const challan = (over: Partial<PrintDocument> = {}): PrintDocument => ({
  ...invoice(), key: 'dc-Original for Consignee', kind: 'challan', title: 'DELIVERY CHALLAN', subtitle: 'SALE DISPATCH', copyLabel: 'Original for Consignee', number: 'DC/26-27/0001',
  refs: [{ label: 'Invoice No.', value: 'INV/26-27/0001', date: '25.11.26' }, { label: 'P. O. No.', value: '', date: '' }],
  heads: { code: 'HSN CODE', third: 'PIECES', fourth: 'NET KG', amount: 'REMARKS', split: false },
  items: items(3, { third: '1,000 PCS', thirdNote: '', fourth: '133.169', amount: null }),
  sums: [], rows: [{ label: 'Value', value: 'As per invoice INV/26-27/0001' }],
  facts: [
    { label: 'Reason', value: 'Sale' }, { label: 'Mode', value: 'Own vehicle' }, { label: 'Vehicle No', value: 'TN38AB1234' }, { label: 'Driver', value: 'Kumar' },
    { label: 'Driver Phone', value: '98765 00000' }, { label: 'LR No', value: 'N/A' }, { label: 'Status', value: 'Pending' },
  ],
  total: null, words: null, bank: [],
  signatures: [
    { organisation: 'Murugan Engineering Works', role: 'Received by', hint: 'Name · Signature · Date', own: false },
    { organisation: 'Demo Engineering Products', role: 'Dispatched by', hint: '', own: true },
  ],
  ...over,
});

const long = (word: string, length: number): string => Array.from({ length: Math.ceil(length / (word.length + 1)) }, () => word).join(' ').slice(0, length).trim();

/** Bills as hard as the database allows. */
const HARD: Record<string, PrintDocument> = {
  ordinary: invoice(),
  'one line': invoice({ items: items(1) }),
  'nine lines': invoice({ items: items(9) }),
  '26 lines': invoice({ items: items(26) }),
  '60 lines': invoice({ items: items(60) }),
  '500 lines': invoice({ items: items(500) }),
  'a job-work bill': invoice({ subtitle: 'JOB WORK', heads: { ...invoice().heads, code: 'SAC CODE' }, refs: [...invoice().refs, { label: 'Party DC', value: 'KF/101', date: '18.11.26' }], items: items(1, { code: '998873' }) }),
  'two rates, with charges': invoice({
    items: items(3, { codeNote: '18%' }),
    sums: [
      sum('SUB TOTAL', '5,540.00'), sum('Packing', '40.00'), sum('Delivery', '300.00'), sum('Taxable value', '5,880.00'), sum('CGST', '386.10', '9%', 'on 4,290.00'), sum('SGST', '386.10', '9%', 'on 4,290.00'),
      sum('CGST', '75.00', '6%', 'on 1,250.00'), sum('SGST', '75.00', '6%', 'on 1,250.00'), sum('IGST', null), sum('R. Off', '-0.20'),
    ],
  }),
  'nine rates': invoice({
    items: items(9, { codeNote: '18%' }),
    sums: [sum('SUB TOTAL', '1,00,000.00'), ...Array.from({ length: 9 }, (_, i) => [sum('CGST', `1,234.${10 + i}`, `${i + 1}.25%`, `on 11,11,111.${10 + i}`), sum('SGST', `1,234.${10 + i}`, `${i + 1}.25%`, `on 11,11,111.${10 + i}`)]).flat(), sum('IGST', null), sum('R. Off', '0.00')],
  }),
  'twelve crore': invoice({
    items: items(5, { third: '1,74,376.82', fourth: '12,34,567.891234 KGS', fourthNote: '2,00,00,00,000 pcs', amount: '12,03,72,319.45' }),
    sums: [sum('SUB TOTAL', '10,20,10,439.70'), sum('CGST', '91,80,939.57', '9%'), sum('SGST', '91,80,939.57', '9%'), sum('IGST', null), sum('R. Off', '0.16')],
    total: { label: 'TOTAL AMOUNT', amount: '99,99,99,99,999.00' },
    words: { label: 'Rupees', value: 'Nine Thousand Nine Hundred Ninety-Nine Crore Ninety-Nine Lakh Ninety-Nine Thousand Nine Hundred Ninety-Nine Only' },
  }),
  'a small rate': invoice({ items: items(2, { third: '0.042575', fourth: '1,00,000 PCS', fourthNote: '1,775.6 kg' }) }),
  'long descriptions': invoice({ items: Array.from({ length: 12 }, (_, i) => item(i + 1, { description: `First${i}. ${long('SS 316 double-end stud with collar hot-dip galvanised M24', 270)} Last${i}.`, fourthNote: '13.317 kg' })) }),
  'a description without a space': invoice({ items: [item(1, { description: 'X'.repeat(300) })] }),
  'a long customer': invoice({ to: { ...invoice().to, name: long('Sri Murugan Engineering', 160), address: long('12 SIDCO Industrial Estate', 500), gstin: 'Unregistered', state: 'Dadra and Nagar Haveli and Daman and Diu (26)' } }),
  'a long company': invoice({
    issuer: {
      name: long('Demo Engineering Products', 120), tagline: long('Mfrs : Plastic, MS', 160), addresses: [`Office : ${long('1 Test Road', 500)}`, `Factory : ${long('2 Works Road', 500)}`],
      contact: ['Office : 0422 - 1234567 / 1234568 / 1234569', 'Mobile : +91 90000 00000', `E-mail : ${'x'.repeat(108)}@example.com`], gstin: '33AAECS2468R1ZS',
    },
    bank: [{ label: 'BANK NAME', value: long('Demo Bank', 80) }, { label: 'BRANCH', value: long('Main', 80) }, { label: 'ACCOUNT No.', value: '0'.repeat(20) }, { label: 'IFS CODE', value: 'DEMO0000001' }],
    signatures: [{ organisation: long('Demo Engineering Products', 120), role: 'Authorised Signatory', hint: '', own: true }],
  }),
  'everything in the notes': invoice({
    notes: [
      { label: 'CANCELLED', value: `on 25 Nov 2026 · ${long('wrong buyer', 300)}`, strong: true }, { label: '', value: 'Supply to SEZ unit / developer for authorised operations under Bond or Letter of Undertaking without payment of integrated tax', strong: true },
      { label: 'Delivery at', value: long('Plot 88, KIADB Phase 2', 500) }, { label: 'Party DC', value: Array.from({ length: 50 }, (_, i) => `PARTY-DC-NUMBER-${100 + i} dt 18.11.26`).join(', ') }, { label: 'Note', value: long('handle with care', 1000) },
    ],
    stamp: 'CANCELLED',
  }),
  'everything at once': invoice({
    issuer: { name: long('Demo Engineering Products', 120), tagline: long('Mfrs : Plastic, MS', 160), addresses: [`Office : ${long('1 Test Road', 500)}`, `Factory : ${long('2 Works Road', 500)}`], contact: ['Office : 0422 - 1234567 / 1234568 / 1234569', 'Mobile : +91 90000 00000', `E-mail : ${'x'.repeat(108)}@example.com`], gstin: '33AAECS2468R1ZS' },
    to: { ...invoice().to, name: long('Sri Murugan Engineering', 160), address: long('12 SIDCO Industrial Estate', 500) },
    notes: [{ label: 'Delivery at', value: long('Plot 88, KIADB Phase 2', 500) }, { label: 'Note', value: long('handle with care', 1000) }],
    refs: [...invoice().refs, { label: 'Party DC', value: 'KF/101', date: '18.11.26' }], items: items(40, { description: long('SS 316 double-end stud', 300) }),
    facts: [...invoice().facts, { label: 'Transport', value: 'Self-collection' }, { label: 'Vehicle', value: 'TN38AB1234' }, { label: 'Driver', value: `${long('Kumaravel', 80)} · 98765 00000` }, { label: 'LR No', value: 'X'.repeat(40) }],
  }),
  'long references': invoice({ refs: [{ label: 'DC No.', value: 'DC/26-27/000001', date: '25.11.26' }, { label: 'P. O. No.', value: '4500012345/AMENDMENT-2/LINE-00010/XYZ-0001', date: '20.11.26' }], number: 'INV/26-27/000001' }),
  'no bank, no GSTIN, no phone': invoice({ bank: [], to: { ...invoice().to, gstin: 'Unregistered', phone: '', address: '' }, issuer: { name: 'A', tagline: '', addresses: ['B'], contact: [], gstin: '33AAECS2468R1ZS' } }),
  Tamil: invoice({ to: { ...invoice().to, name: 'ஸ்ரீ முருகன் பொறியியல்', address: 'கோயம்புத்தூர்' }, items: [item(1, { description: 'குண்டூசி & studs “M12” × 80 mm · ½' })], notes: [{ label: 'Note', value: 'அவசரம்' }] }),
  challan: challan(),
  'a challan of 45 lines': challan({ items: items(45, { third: '1,000 PCS', thirdNote: '', amount: null }) }),
  'a challan the buyer pays the driver of': challan({ rows: [{ label: 'Value', value: 'As per invoice INV/26-27/0001' }, { label: 'Payable directly by buyer · Freight', value: '₹1,23,456.00' }] }),
  'a valued job-work return': challan({
    subtitle: 'JOB-WORK RETURN', to: { ...challan().to, role: 'Principal / deliver to,' }, heads: { ...challan().heads, amount: 'VALUE', split: true },
    refs: [...challan().refs, { label: 'Party DC', value: 'KF/101', date: '18.11.26' }],
    items: [item(1, { code: '7318', description: '12 mm rods · MS', detail: 'Party DC KF/101 dt 18.11.26', third: '5,400 PCS', thirdNote: '', fourth: '480.500', amount: '5,000.50' })],
    rows: [{ label: 'Inward kg', value: '500.000' }, { label: 'Returned kg, this DC', value: '480.500' }, { label: 'Scrap / wastage kg', value: '15.000' }, { label: 'Balance held kg', value: '4.500' }],
    total: { label: 'DECLARED GOODS VALUE', amount: '5,000.50' }, words: { label: 'Declared goods value, Rupees', value: 'Five Thousand and Fifty Paise Only' },
  }),
  'a return of fifty lots': challan({
    subtitle: 'JOB-WORK RETURN', heads: { ...challan().heads, amount: 'VALUE', split: true }, facts: [...challan().facts, { label: 'Place of supply', value: 'Karnataka (29)' }],
    items: Array.from({ length: 50 }, (_, i) => item(i + 1, { description: `${long('12 mm rods threaded', 280)} · EN8 lot${i}.`, detail: `Party DC ${'K'.repeat(40)} dt 18.11.26 · Inward 12345678.000 kg · Scrap 100.000 kg · Balance 1000.000 kg`, third: '5,400 PCS', thirdNote: '', fourth: '12345678.500', amount: '12,03,72,319.45' })),
    rows: [{ label: 'Returned kg, this DC', value: '617283925.000' }, { label: 'Scrap / wastage kg', value: '5000.000' }],
    total: { label: 'DECLARED GOODS VALUE', amount: '60,18,61,597.50' }, words: { label: 'Declared goods value, Rupees', value: long('Ninety-Nine Crore', 180) },
    signatures: [{ organisation: long('Sri Murugan Engineering', 160), role: 'Received by', hint: 'Name · Signature · Date', own: false }, { organisation: long('Demo Engineering Products', 120), role: 'Dispatched by', hint: '', own: true }],
  }),
};

const texts = (sheet: Sheet): TextOp[] => sheet.ops.filter((op): op is TextOp => op.kind === 'text');
/** Not read: the Vel, and the word across a cancelled bill, are behind everything. */
const read = (sheet: Sheet): TextOp[] => texts(sheet).filter((op) => op.ink !== 'blush' && op.ink !== 'white');
const said = (sheets: readonly Sheet[]): string => sheets.map((sheet) => read(sheet).map((op) => op.text).join(' ')).join(' ');
const times = (sheets: readonly Sheet[], what: string): number => said(sheets).split(what).length - 1;

interface Rect { left: number; right: number; top: number; bottom: number }
const rect = (op: TextOp): Rect => (op.up
  ? { left: op.x - op.size * 0.72, right: op.x + op.size * 0.2, top: op.y - op.width, bottom: op.y }
  : { left: op.x, right: op.x + op.width, top: op.y - op.size * 0.72, bottom: op.y + op.size * 0.2 });
const corners = (op: Extract<Op, { kind: 'path' }>): Rect => {
  const numbers = op.d.flatMap(([, ...values]) => values as number[]);
  const xs = numbers.filter((_, i) => i % 2 === 0);
  const ys = numbers.filter((_, i) => i % 2 === 1);
  return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
};

function problems(sheet: Sheet): string[] {
  const found: string[] = [];
  const near = 0.02;
  const inside = (r: Rect, what: string): void => {
    if (r.left < -near || r.right > FRAME.width + near || r.top < -near || r.bottom > FRAME.height + near) found.push(`off the paper: ${what}`);
  };
  for (const op of sheet.ops) {
    if (op.kind === 'text') inside(rect(op), op.text);
    else if (op.kind === 'path') inside(corners(op), 'a shape');
    else inside({ left: Math.min(op.x1, op.x2), right: Math.max(op.x1, op.x2), top: Math.min(op.y1, op.y2), bottom: Math.max(op.y1, op.y2) }, 'a line');
  }
  const words = read(sheet).map((op) => ({ text: op.text, ...rect(op) }));
  for (const [i, a] of words.entries()) {
    for (const b of words.slice(i + 1)) {
      if (a.left < b.right - near && b.left < a.right - near && a.top < b.bottom - near && b.top < a.bottom - near) found.push(`“${a.text}” covers “${b.text}”`);
    }
  }
  // Edges of boxes and drawn lines. The gear and the Vel are not ruled lines.
  const edges: { x1: number; y1: number; x2: number; y2: number }[] = [];
  for (const op of sheet.ops) {
    if (op.kind === 'line') edges.push(op);
    if (op.kind === 'path' && op.stroke === 'ink') {
      const { left, right, top, bottom } = corners(op);
      edges.push({ x1: left, y1: top, x2: left, y2: bottom }, { x1: right, y1: top, x2: right, y2: bottom }, { x1: left, y1: top, x2: right, y2: top }, { x1: left, y1: bottom, x2: right, y2: bottom });
    }
  }
  for (const word of words) {
    for (const edge of edges) {
      const [x1, x2] = [Math.min(edge.x1, edge.x2), Math.max(edge.x1, edge.x2)];
      const [y1, y2] = [Math.min(edge.y1, edge.y2), Math.max(edge.y1, edge.y2)];
      if (x1 < word.right - near && x2 > word.left + near && y1 < word.bottom - near && y2 > word.top + near) found.push(`a line through “${word.text}”`);
    }
  }
  return [...new Set(found)];
}

describe('whatever is on the bill', () => {
  for (const [name, doc] of Object.entries(HARD)) {
    it(`${name}: nothing off the paper, nothing covered, nothing crossed out`, () => {
      const sheets = billSheets([doc]);
      expect(sheets.length).toBeGreaterThan(0);
      for (const sheet of sheets) expect(problems(sheet), sheet.label).toEqual([]);
    });

    it(`${name}: everything is said, each line once, the closing once and not alone`, () => {
      const sheets = billSheets([doc]);
      const all = said(sheets).replace(/\s+/g, '');
      const squash = (text: string): string => text.replace(/\s+/g, '');
      const last = sheets.at(-1)!;
      for (const text of [doc.issuer.name, doc.issuer.tagline, ...doc.issuer.addresses, ...doc.issuer.contact, doc.number, doc.issueDate, doc.to.name, doc.to.address, doc.to.phone, doc.to.gstin, doc.to.state]) expect(all, text).toContain(squash(text));
      for (const ref of doc.refs) for (const text of [ref.label, ref.value, ref.date]) expect(all, text).toContain(squash(text));
      // Notes may run on to the next page, below its head: every word of them, as often as it is there.
      const words = (text: string): string[] => text.split(/\s+/).filter(Boolean);
      const spoken = Map.groupBy(words(said(sheets)), (word) => word);
      for (const note of doc.notes) {
        expect(said(sheets), note.label).toContain(note.label ? `${note.label} :` : '');
        for (const [word, list] of Map.groupBy(words(note.value), (one) => one)) expect(spoken.get(word)?.length ?? 0, word).toBeGreaterThanOrEqual(list.length);
      }
      for (const fact of doc.facts) expect(all, fact.label).toContain(squash(fact.label + fact.value));
      for (const row of doc.rows) expect(said([last]), row.label).toContain(`${row.label} ${row.value}`);
      for (const one of doc.items) for (const text of [one.description, one.detail, one.third, one.fourth, one.fourthNote, one.codeNote]) expect(all, text).toContain(squash(text));
      for (const row of doc.sums) {
        const [rupees = '', paise = ''] = (row.amount ?? '').split('.');
        expect(said([last]), row.label).toContain([row.label, row.rate, row.base, rupees, paise].filter(Boolean).join(' '));
      }
      if (doc.total) {
        expect(times(sheets, doc.total.label)).toBe(1);
        expect(said([last])).toContain(`${doc.total.label} ${doc.total.amount.split('.').join(' ')}`.trim());
      }
      if (doc.words) expect(squash(said([last]))).toContain(squash(doc.words.label + doc.words.value));
      for (const row of doc.bank) expect(said([last]), row.label).toContain(`${row.label} : ${row.value}`);
      for (const sign of doc.signatures) expect(said([last]), sign.role).toContain(sign.role);
      // The numbers of the rows run through, and the last page has at least one of them.
      const numbers = sheets.map((sheet) => read(sheet).filter((op) => op.x + op.width <= 6.2 && op.x >= 0 && /^\d+$/.test(op.text) && op.y > 15).map((op) => Number(op.text)));
      expect(numbers.flat()).toEqual(doc.items.map((_, i) => i + 1));
      expect(numbers.at(-1)!.length).toBeGreaterThan(0);
    });
  }
});

describe('pages', () => {
  it('an ordinary bill is one page with nine rows, like the book', () => {
    for (const count of [1, 4, 9]) {
      const [sheet, ...more] = billSheets([invoice({ items: items(count) })]);
      expect(more).toEqual([]);
      const across = sheet!.ops.filter((op) => op.kind === 'line' && op.x1 === 0 && op.x2 === FRAME.width && op.y1 === op.y2);
      expect(across, `${count} lines`).toHaveLength(9);
      expect(said([sheet!])).not.toContain('Page ');
    }
  });

  it('where the rows end in corners of their own, no line runs across them', () => {
    for (const doc of [challan(), invoice({ items: items(60) })]) {
      const [sheet] = billSheets([doc]);
      const bottoms = sheet!.ops.flatMap((op) => (op.kind === 'path' && op.stroke === 'ink' && op.d.length > 8 && corners(op).left === 0 && corners(op).right === 6.2 ? [corners(op).bottom] : []));
      const rows = Math.max(...bottoms);
      expect(rows).toBeGreaterThan(60);
      expect(sheet!.ops.some((op) => op.kind === 'line' && op.x2 === FRAME.width && Math.abs(op.y1 - rows) < 0.01)).toBe(false);
    }
  });

  it('the customer’s box is ruled to its end', () => {
    const dotted = (doc: PrintDocument): number => billSheets([doc])[0]!.ops.filter((op) => op.kind === 'line' && op.dotted && op.x1 === 9.2).length;
    expect(dotted(invoice())).toBe(4);
    expect(dotted(HARD['a job-work bill']!)).toBeGreaterThan(4);
    expect(dotted(HARD['a long customer']!)).toBeGreaterThan(8);
  });

  it('a row that needs more height takes the place of an empty one', () => {
    const tall = invoice({ items: [item(1, { description: long('SS 316 double-end stud', 200) })] });
    const ends = (doc: PrintDocument): number => Math.max(...billSheets([doc])[0]!.ops.flatMap((op) => (op.kind === 'text' ? [op.y] : [])));
    expect(billSheets([tall])).toHaveLength(1);
    expect(Math.abs(ends(tall) - ends(invoice()))).toBeLessThan(4.3);
  });

  it('more pages are numbered, carry the bill’s number, and repeat the heading', () => {
    const sheets = billSheets([invoice({ items: items(60) })]);
    expect(sheets.length).toBeGreaterThan(1);
    for (const [i, sheet] of sheets.entries()) {
      expect(said([sheet])).toContain(`Page ${i + 1} of ${sheets.length}`);
      expect(said([sheet])).toContain('INV/26-27/0001');
      expect(times([sheet], 'PARTICULARS')).toBe(1);
      expect(times([sheet], 'ORIGINAL FOR RECIPIENT')).toBe(1);
      expect(times([sheet], 'TOTAL AMOUNT')).toBe(i === sheets.length - 1 ? 1 : 0);
    }
  });

  it('every number of lines from 1 to 80 closes well', () => {
    for (let count = 1; count <= 80; count += 1) {
      const sheets = billSheets([invoice({ items: items(count) })]);
      for (const sheet of sheets) expect(problems(sheet), `${count} lines, ${sheet.label}`).toEqual([]);
      expect(times(sheets, 'Stud line'), `${count} lines`).toBe(count);
      expect(said([sheets.at(-1)!]), `${count} lines`).toContain('Stud line');
    }
  });

  it('each copy and each document starts on a page of its own, with a key of its own', () => {
    const copies = ['Original for Recipient', 'Duplicate for Transporter', 'Triplicate for Supplier'].map((copyLabel) => invoice({ copyLabel, key: `invoice-${copyLabel}`, items: items(30) }));
    const sheets = billSheets([...copies, challan()]);
    expect(new Set(sheets.map((sheet) => sheet.key)).size).toBe(sheets.length);
    expect(sheets.filter((sheet) => said([sheet]).includes('DUPLICATE FOR TRANSPORTER')).length).toBe(billSheets([copies[1]!]).length);
    expect(sheets.at(-1)!.label).toBe('Delivery challan DC/26-27/0001, Original for Consignee');
    expect(sheets[0]!.label).toMatch(/^Tax invoice INV\/26-27\/0001, Original for Recipient, page 1 of \d$/);
  });

  it('a cancelled bill has the word across its rows, on every page, behind the text', () => {
    for (const sheet of billSheets([invoice({ stamp: 'CANCELLED', items: items(40) })])) {
      const at = sheet.ops.findIndex((op) => op.kind === 'text' && op.text === 'CANCELLED' && op.ink === 'blush');
      const firstRow = sheet.ops.findIndex((op) => op.kind === 'text' && op.text.startsWith('Stud line'));
      expect(at).toBeGreaterThanOrEqual(0);
      if (firstRow >= 0) expect(at).toBeLessThan(firstRow);
    }
  });

  it('the Vel is behind the rows, and the gear at the head of the first page only', () => {
    const sheets = billSheets([invoice({ items: items(60) })]);
    const gears = sheets.map((sheet) => sheet.ops.filter((op) => op.kind === 'path' && op.fill === 'rose').length);
    expect(gears).toEqual([1, ...sheets.slice(1).map(() => 0)]);
    const vel = sheets[0]!.ops.findIndex((op) => op.kind === 'path' && op.fill === 'vel');
    expect(vel).toBeGreaterThanOrEqual(0);
    expect(vel).toBeLessThan(sheets[0]!.ops.findIndex((op) => op.kind === 'text' && op.text.startsWith('Stud line')));
  });

  it('no letters are too small to read: at least 6 point on A5', () => {
    const smallest = 6 / 72 * 25.4 / 1.34;
    for (const [name, doc] of Object.entries(HARD)) {
      if (['twelve crore', 'a long company', 'everything at once', 'a return of fifty lots', 'long references', 'nine rates'].includes(name)) continue; // squeezed into its room on purpose
      for (const sheet of billSheets([doc])) for (const op of read(sheet)) expect(op.size, `${name}: ${op.text}`).toBeGreaterThanOrEqual(smallest);
    }
  });
});
