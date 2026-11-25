// The .xlsx writer, read back by a reader that shares no code with it.
import { describe, expect, it } from 'vitest';
import { xlsx, type Sheet } from '@/lib/xlsx';
import { dateOf, kid, kids, parseXml, readXlsx, table, totals, unzip } from './support/xlsx-reader';

const sheet = (over: Partial<Sheet> = {}): Sheet => ({
  name: 'Bills',
  columns: [
    { title: 'Invoice no', kind: 'text', width: 18 }, { title: 'Date', kind: 'date', width: 12 }, { title: 'GSTIN', kind: 'text', width: 20 }, { title: 'Pieces', kind: 'whole', width: 10 },
    { title: 'Kg', kind: 'number', width: 10 }, { title: 'Rate', kind: 'rate', width: 10 }, { title: 'Final', kind: 'money', width: 14 }, { title: 'Sent', kind: 'time', width: 20 }, { title: 'Status', kind: 'text', width: 12 },
  ],
  rows: [
    { cells: ['INV/26-27/0001', '2026-11-25', '33AABCM1234F1Z4', '50', '6.658450', '12.500000', '1180.00', '2026-11-25T05:02:30+00:00', 'Unpaid'] },
    { cells: ['INV/26-27/0002', '2026-11-25', null, null, null, '0.123456', '1234567.89', null, 'CANCELLED'], void: true },
  ],
  totals: { label: 'Total', status: 'Status', except: 'CANCELLED', values: { Final: '1180.00' } },
  notes: ['Made by StudFlow'],
  empty: 'No bills this month',
  ...over,
});
const read = (over: Partial<Sheet> = {}) => readXlsx(xlsx([sheet(over)], { title: 'Billing 2026-11' })).sheets[0]!;

describe('an .xlsx', () => {
  it('is a ZIP with the parts a spreadsheet program looks for', () => {
    const { files, workbook, sheets } = readXlsx(xlsx([sheet(), sheet({ name: 'Dispatch & Job Work' })], { title: 'Billing 2026-11' }));
    expect([...files.keys()].sort()).toEqual([
      '[Content_Types].xml', '_rels/.rels', 'docProps/core.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml',
    ]);
    expect(sheets.map((one) => one.name)).toEqual(['Bills', 'Dispatch & Job Work']);
    expect(kids(kid(workbook, 'sheets'), 'sheet').map((one) => one.attrs.sheetId)).toEqual(['1', '2']);
    expect(kid(workbook, 'calcPr')?.attrs.fullCalcOnLoad).toBe('1'); // Excel works the totals out itself
    for (const [name, bytes] of files) expect(() => parseXml(bytes.toString('utf8')), name).not.toThrow();
  });

  it('gives the same file for the same books', () => {
    expect(Buffer.from(xlsx([sheet()], { title: 'x' })).equals(Buffer.from(xlsx([sheet()], { title: 'x' })))).toBe(true);
  });

  it('keeps document numbers, GSTINs and phones as text', () => {
    const phones = read({ columns: [{ title: 'Phone', kind: 'text', width: 14 }, { title: 'Status', kind: 'text', width: 12 }], rows: [{ cells: ['09876543210', 'Paid'] }, { cells: ['919876543210123', 'Paid'] }], totals: null });
    expect(phones.rows[1]?.[0]).toMatchObject({ type: 'text', value: '09876543210', format: '@' });
    expect(phones.rows[2]?.[0]).toMatchObject({ type: 'text', value: '919876543210123', format: '@' });
    expect(read().rows[1]?.[0]).toMatchObject({ type: 'text', value: 'INV/26-27/0001', format: '@' });
  });

  it('never lets what was typed become a formula or break the file', () => {
    const nasty = ['=1+1', '+SUM(A1)', '@x', '<b>&"\'', 'Murugan & Sons <Pvt>', 'மு𝒜ருகன்', '  spaces  ', 'two\nlines', 'bad\u0000\u0001\u000b￾\ud800end', ']]>'];
    const got = read({ columns: [{ title: 'Name', kind: 'text', width: 14 }], rows: nasty.map((text) => ({ cells: [text] })), totals: null }).rows.slice(1, nasty.length + 1);
    expect(got.map((row) => row[0]?.value)).toEqual([...nasty.slice(0, 8), 'badend', ']]>']);
    expect(got.every((row) => row[0]?.type === 'text' && row[0]?.formula === null)).toBe(true);
  });

  it('writes exact numbers with Indian grouping, and real dates', () => {
    const [, first, second] = read().rows;
    expect(first?.[6]).toMatchObject({ type: 'number', value: '1180' });
    expect(second?.[6]).toMatchObject({ type: 'number', value: '1234567.89' });
    expect(first?.[6]?.format).toBe('[>=10000000]##\\,##\\,##\\,##0.00;[>=100000]##\\,##\\,##0.00;##,##0.00');
    expect(dateOf(first?.[1]?.value ?? '')).toBe('2026-11-25');
    expect(first?.[1]?.format).toBe('dd\\-mmm\\-yyyy');
    expect(first?.[3]).toMatchObject({ type: 'number', value: '50', format: '0' });
    expect(first?.[4]).toMatchObject({ type: 'number', value: '6.65845', format: 'General' });
    expect(first?.[5]).toMatchObject({ type: 'number', value: '12.5', format: '0.00####' });
    // 05:02:30 UTC is 10:32:30 in India
    expect(Number(first?.[7]?.value)).toBeCloseTo(46351 + (10 * 3600 + 32 * 60 + 30) / 86400, 6);
    expect(read({ columns: [{ title: 'R', kind: 'money', width: 9 }], rows: [{ cells: ['-0.40'] }, { cells: ['0.00'] }, { cells: ['99999999999.99'] }], totals: null }).rows.slice(1, 4).map((row) => row[0]?.value)).toEqual(['-0.4', '0', '99999999999.99']);
  });

  it.each([['2026-04-01', '46113'], ['1900-03-01', '61'], ['2024-02-29', '45351'], ['2027-03-31', '46477']])('%s is day %s', (date, serial) => {
    expect(read({ columns: [{ title: 'D', kind: 'date', width: 9 }], rows: [{ cells: [date] }], totals: null }).rows[1]?.[0]?.value).toBe(serial);
  });

  it('refuses what is not a number or a date, instead of writing a file Excel has to repair', () => {
    for (const [kind, value] of [['money', 'abc'], ['money', '1,180.00'], ['number', '1e5'], ['date', '25/11/2026'], ['date', '2026-02-30'], ['time', 'yesterday'], ['whole', '1.5'], ['money', 'NaN']] as const) {
      expect(() => read({ columns: [{ title: 'X', kind, width: 9 }], rows: [{ cells: [value] }], totals: null }), `${kind} ${value}`).toThrow();
    }
  });

  it('leaves an empty cell out', () => {
    expect(read().rows[2]?.[2]).toBeUndefined();
  });

  it('strikes a cancelled row through', () => {
    expect(read().rows[1]?.every((cell) => !cell?.strike)).toBe(true);
    expect(read().rows[2]?.filter(Boolean).every((cell) => cell?.strike)).toBe(true);
  });

  it('adds up without the cancelled rows: the formula, and the value shown before Excel calculates', () => {
    expect(totals(read())).toEqual({ Final: { value: '1180', formula: 'SUMIFS(G2:G3,I2:I3,"<>CANCELLED")' } });
    const last = read().rows.at(-2);
    expect(read().rows.find((row) => row?.[0]?.value === 'Total')?.[0]?.bold).toBe(true);
    expect(last).toBeDefined();
  });

  it('puts the totals under an empty row, so sorting the table leaves them alone', () => {
    const one = read();
    expect(kid(one.xml, 'autoFilter')?.attrs.ref).toBe('A1:I3');
    expect(one.rows[3] ?? []).toHaveLength(0);
    expect(one.rows[4]?.[0]?.value).toBe('Total');
    expect(one.rows.at(-1)?.[0]?.value).toBe('Made by StudFlow');
  });

  it('keeps the titles on screen and on every printed page', () => {
    const { workbook, sheets } = readXlsx(xlsx([sheet()], { title: 'x' }));
    const pane = kid(kid(kid(sheets[0]!.xml, 'sheetViews'), 'sheetView'), 'pane');
    expect(pane?.attrs).toMatchObject({ ySplit: '1', topLeftCell: 'A2', state: 'frozen' });
    expect(kids(kid(workbook, 'definedNames'), 'definedName').map((one) => [one.attrs.name, one.text])).toEqual([['_xlnm.Print_Titles', "'Bills'!$1:$1"]]);
    expect(kid(sheets[0]!.xml, 'pageSetup')?.attrs).toMatchObject({ orientation: 'landscape', fitToWidth: '1', fitToHeight: '0' });
    expect(sheets[0]!.rows[0]?.every((cell) => cell?.bold)).toBe(true);
  });

  it('puts a title over the side its figures are on', () => {
    const { files, sheets } = readXlsx(xlsx([sheet()], { title: 'x' }));
    const xfs = kids(kid(parseXml(files.get('xl/styles.xml')!.toString('utf8')), 'cellXfs'), 'xf');
    const sideOf = (ref: string) => {
      const cell = kids(kids(kid(sheets[0]!.xml, 'sheetData'), 'row')[0], 'c').find((one) => one.attrs.r === ref);
      return kid(xfs[Number(cell?.attrs.s)], 'alignment')?.attrs.horizontal ?? 'left';
    };
    expect([sideOf('A1'), sideOf('B1'), sideOf('G1'), sideOf('I1')]).toEqual(['left', 'right', 'right', 'left']);
  });

  it('has its elements in the order the format demands', () => {
    const order = ['sheetPr', 'dimension', 'sheetViews', 'sheetFormatPr', 'cols', 'sheetData', 'autoFilter', 'pageMargins', 'pageSetup', 'ignoredErrors'];
    expect(read().xml.children.map((child) => child.name)).toEqual(order);
  });

  it('says so when a sheet is empty, without a formula over nothing', () => {
    const none = read({ rows: [] });
    expect(table(none)).toEqual([]);
    expect(totals(none)).toEqual({});
    expect(none.rows.flat().map((cell) => cell?.value)).toContain('No bills this month');
    expect(kid(none.xml, 'autoFilter')?.attrs.ref).toBe('A1:I1');
  });

  it('names columns past Z', () => {
    const columns = Array.from({ length: 30 }, (_, i) => ({ title: `C${i}`, kind: 'whole' as const, width: 8 }));
    const wide = read({ columns, rows: [{ cells: columns.map((_, i) => String(i)) }], totals: null });
    expect(wide.rows[1]?.map((cell) => cell?.ref).slice(25, 28)).toEqual(['Z2', 'AA2', 'AB2']);
    expect(table(wide)[0]?.C29).toBe('29');
  });

  it('holds a large month', () => {
    const rows = Array.from({ length: 5000 }, (_, i) => ({ cells: [`INV/26-27/${String(i + 1).padStart(4, '0')}`, '2026-11-25', '33AABCM1234F1Z4', '50', '6.5', '12', '1180.00', null, 'Paid'] }));
    const bytes = xlsx([sheet({ rows, totals: { label: 'Total', status: 'Status', except: 'CANCELLED', values: { Final: '5900000.00' } } })], { title: 'x' });
    expect(table(readXlsx(bytes).sheets[0]!)).toHaveLength(5000);
    expect(unzip(bytes).size).toBe(7);
    expect(bytes.byteLength).toBeLessThan(400_000);
  });
});
