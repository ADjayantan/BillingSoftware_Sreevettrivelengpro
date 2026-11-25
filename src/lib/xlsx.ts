/**
 * Writes a real .xlsx workbook: a ZIP of XML (ECMA-376), no library. It places and formats what
 * it is given and computes no money; the same input gives the same bytes.
 */
import { trimZeros } from './money';
import { createZipArchive } from './zip';

/** text also holds whatever must not become a number: document numbers, GSTINs, phones. */
export type Kind = 'text' | 'whole' | 'number' | 'rate' | 'money' | 'date' | 'time';

export interface Column {
  title: string;
  kind: Kind;
  width: number;
}

export interface Row {
  /** Text as it is, numbers as plain decimals, dates as YYYY-MM-DD, times as ISO instants. */
  cells: readonly (string | null)[];
  /** Cancelled or voided: kept, struck through. */
  void?: boolean;
}

export interface Sheet {
  name: string;
  columns: readonly Column[];
  rows: readonly Row[];
  /** Sums by column title, over the rows whose `status` column is not `except`. */
  totals: { label: string; status: string; except: string; values: Readonly<Record<string, string>> } | null;
  notes: readonly string[];
  /** Said instead of a table without rows. */
  empty: string;
}

const KINDS: readonly Kind[] = ['text', 'whole', 'number', 'rate', 'money', 'date', 'time'];
const FORMAT_IDS: Record<Kind, number> = { text: 49, whole: 1, number: 0, rate: 164, money: 165, date: 166, time: 167 };
const FORMATS: readonly [number, string][] = [
  [164, '0.00####'],
  // Lakh and crore grouping. Negative amounts here are round-offs, below every limit.
  [165, '[>=10000000]##\\,##\\,##\\,##0.00;[>=100000]##\\,##\\,##0.00;##,##0.00'],
  [166, 'dd\\-mmm\\-yyyy'],
  [167, 'dd\\-mmm\\-yyyy hh:mm'],
];
const STYLE = { header: 1, note: 2, headerRight: 3, plain: 4, void: 4 + KINDS.length, total: 4 + 2 * KINDS.length } as const;
const styleOf = (look: 'plain' | 'void' | 'total', kind: Kind): number => STYLE[look] + KINDS.indexOf(kind);

// ---- Text --------------------------------------------------------------------
// Control characters and halves of surrogate pairs: not allowed in XML at all.
const NOT_XML = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

const xml = (text: string): string =>
  text.replace(NOT_XML, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Cell text: Excel reads _x0041_ as an escape, and holds at most 32767 characters. */
const cellText = (text: string): string => xml(text.replace(/\r\n?/g, '\n').slice(0, 32_767).replace(/_x(?=[0-9A-Fa-f]{4}_)/g, '_x005F_x'));

// ---- Numbers, dates ----------------------------------------------------------
const DAY = 86_400_000;
/** 25569 days from Excel's day 0 to 1 January 1970. */
const EPOCH = 25_569;
const IST = 330 * 60_000;

function plainNumber(value: string, whole = false): string {
  if (!(whole ? /^-?\d{1,15}$/ : /^-?\d{1,15}(\.\d{1,6})?$/).test(value)) throw new RangeError(`not a plain number: ${value}`);
  const trimmed = trimZeros(value);
  return trimmed === '-0' ? '0' : trimmed;
}

function dateSerial(value: string): string {
  const at = /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(`${value}T00:00:00Z`) : Number.NaN;
  if (Number.isNaN(at) || new Date(at).toISOString().slice(0, 10) !== value) throw new RangeError(`not a date: ${value}`);
  return String(at / DAY + EPOCH);
}

/** The time on an Indian clock. */
function timeSerial(value: string): string {
  const at = /^\d{4}-\d{2}-\d{2}T/.test(value) ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(at)) throw new RangeError(`not a time: ${value}`);
  return trimZeros(((at + IST) / DAY + EPOCH).toFixed(8));
}

function serial(kind: Exclude<Kind, 'text'>, value: string): string {
  if (kind === 'date') return dateSerial(value);
  if (kind === 'time') return timeSerial(value);
  return plainNumber(value, kind === 'whole');
}

// ---- Cells -------------------------------------------------------------------
/** 0 -> A, 25 -> Z, 26 -> AA */
function letters(column: number): string {
  let name = '';
  for (let n = column + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

const textCell = (ref: string, style: number, text: string): string => `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${cellText(text)}</t></is></c>`;

function cell(ref: string, look: 'plain' | 'void' | 'total', kind: Kind, value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  if (kind === 'text') return textCell(ref, styleOf(look, 'text'), value);
  return `<c r="${ref}" s="${styleOf(look, kind)}"><v>${serial(kind, value)}</v></c>`;
}

function worksheet(sheet: Sheet, selected: boolean): string {
  const { columns, rows, totals } = sheet;
  const lastColumn = letters(columns.length - 1);
  const lastRow = rows.length + 1;
  const lines: string[] = [
    `<row r="1" ht="32" customHeight="1">${columns.map((column, i) => textCell(`${letters(i)}1`, column.kind === 'text' ? STYLE.header : STYLE.headerRight, column.title)).join('')}</row>`,
    ...rows.map((row, i) => {
      const r = i + 2;
      return `<row r="${r}">${columns.map((column, c) => cell(`${letters(c)}${r}`, row.void ? 'void' : 'plain', column.kind, row.cells[c])).join('')}</row>`;
    }),
  ];
  // Below an empty row: sorting or filtering the table must not carry the totals along.
  let next = lastRow + 2;
  if (rows.length === 0) {
    lines.push(`<row r="${next}">${textCell(`A${next}`, STYLE.note, sheet.empty)}</row>`);
    next += 1;
  } else if (totals) {
    const range = (column: string): string => `${column}2:${column}${lastRow}`;
    const status = range(letters(columns.findIndex((column) => column.title === totals.status)));
    const cells = columns.map((column, c) => {
      const ref = `${letters(c)}${next}`;
      const value = totals.values[column.title];
      if (c === 0) return textCell(ref, styleOf('total', 'text'), totals.label);
      if (value === undefined) return `<c r="${ref}" s="${styleOf('total', 'text')}"/>`;
      const formula = `SUMIFS(${range(letters(c))},${status},"<>${totals.except}")`;
      return `<c r="${ref}" s="${styleOf('total', column.kind)}"><f>${xml(formula).replace(/&quot;/g, '"')}</f><v>${plainNumber(value)}</v></c>`;
    });
    lines.push(`<row r="${next}">${cells.join('')}</row>`);
    next += 1;
  }
  for (const note of sheet.notes) {
    lines.push(`<row r="${next}">${textCell(`A${next}`, STYLE.note, note)}</row>`);
    next += 1;
  }
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
    '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>',
    `<dimension ref="A1:${lastColumn}${next - 1}"/>`,
    `<sheetViews><sheetView${selected ? ' tabSelected="1"' : ''} workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>`,
    '<sheetFormatPr defaultRowHeight="15"/>',
    `<cols>${columns.map((column, i) => `<col min="${i + 1}" max="${i + 1}" width="${column.width}" customWidth="1"/>`).join('')}</cols>`,
    `<sheetData>${lines.join('')}</sheetData>`,
    `<autoFilter ref="A1:${lastColumn}${lastRow}"/>`,
    '<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/>',
    '<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/>',
    // Phone and document numbers are text on purpose: no green corner on each of them.
    `<ignoredErrors><ignoredError sqref="A2:${lastColumn}${Math.max(2, lastRow)}" numberStoredAsText="1"/></ignoredErrors>`,
    '</worksheet>',
  ].join('');
}

function styles(): string {
  const looks = [['plain', 0, 0, 0], ['void', 2, 0, 0], ['total', 1, 3, 1]] as const;
  const header = (side: string): string =>
    `<xf numFmtId="49" fontId="1" fillId="2" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment ${side}vertical="center" wrapText="1"/></xf>`;
  const xfs = [
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>',
    header(''),
    '<xf numFmtId="49" fontId="3" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>',
    header('horizontal="right" '),
    ...looks.flatMap(([, font, fill, border]) =>
      KINDS.map((kind) => `<xf numFmtId="${FORMAT_IDS[kind]}" fontId="${font}" fillId="${fill}" borderId="${border}" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>`),
    ),
  ];
  const font = (inside: string): string => `<font>${inside}<sz val="11"/><name val="Calibri"/><family val="2"/></font>`;
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
    `<numFmts count="${FORMATS.length}">${FORMATS.map(([id, code]) => `<numFmt numFmtId="${id}" formatCode="${xml(code)}"/>`).join('')}</numFmts>`,
    '<fonts count="4">',
    font(''),
    font('<b/>'),
    '<font><strike/><sz val="11"/><color rgb="FF808080"/><name val="Calibri"/><family val="2"/></font>',
    '<font><i/><sz val="10"/><color rgb="FF606060"/><name val="Calibri"/><family val="2"/></font>',
    '</fonts>',
    '<fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>',
    '<fill><patternFill patternType="solid"><fgColor rgb="FFD9EAE6"/><bgColor indexed="64"/></patternFill></fill>',
    '<fill><patternFill patternType="solid"><fgColor rgb="FFF2F2F2"/><bgColor indexed="64"/></patternFill></fill></fills>',
    '<borders count="3"><border><left/><right/><top/><bottom/><diagonal/></border>',
    '<border><left/><right/><top style="thin"><color auto="1"/></top><bottom style="double"><color auto="1"/></bottom><diagonal/></border>',
    '<border><left/><right/><top/><bottom style="thin"><color auto="1"/></bottom><diagonal/></border></borders>',
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>',
    `<cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs>`,
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>',
    '</styleSheet>',
  ].join('');
}

// ---- The package -------------------------------------------------------------
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE = 'http://schemas.openxmlformats.org/package/2006';

export function xlsx(sheets: readonly Sheet[], about: { title: string }): Uint8Array {
  const numbered = sheets.map((sheet, i) => ({ sheet, no: i + 1 }));
  const entries = [
    {
      name: '[Content_Types].xml',
      content: [
        XML,
        `<Types xmlns="${PACKAGE}/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>`,
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
        ...numbered.map(({ no }) => `<Override PartName="/xl/worksheets/sheet${no}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`),
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
        '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>',
      ].join(''),
    },
    {
      name: '_rels/.rels',
      content: `${XML}<Relationships xmlns="${PACKAGE}/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="${PACKAGE}/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`,
    },
    {
      name: 'docProps/core.xml',
      content: `${XML}<cp:coreProperties xmlns:cp="${PACKAGE}/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${xml(about.title)}</dc:title><dc:creator>StudFlow</dc:creator></cp:coreProperties>`,
    },
    {
      name: 'xl/workbook.xml',
      content: [
        XML,
        `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${REL}"><bookViews><workbookView activeTab="0"/></bookViews><sheets>`,
        ...numbered.map(({ sheet, no }) => `<sheet name="${xml(sheet.name)}" sheetId="${no}" r:id="rId${no}"/>`),
        '</sheets><definedNames>',
        ...numbered.map(({ sheet, no }) => `<definedName name="_xlnm.Print_Titles" localSheetId="${no - 1}">${xml(`'${sheet.name.replace(/'/g, "''")}'!$1:$1`)}</definedName>`),
        '</definedNames><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>',
      ].join(''),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      content: [
        XML,
        `<Relationships xmlns="${PACKAGE}/relationships">`,
        ...numbered.map(({ no }) => `<Relationship Id="rId${no}" Type="${REL}/worksheet" Target="worksheets/sheet${no}.xml"/>`),
        `<Relationship Id="rId${sheets.length + 1}" Type="${REL}/styles" Target="styles.xml"/></Relationships>`,
      ].join(''),
    },
    { name: 'xl/styles.xml', content: styles() },
    ...numbered.map(({ sheet, no }) => ({ name: `xl/worksheets/sheet${no}.xml`, content: worksheet(sheet, no === 1) })),
  ];
  return createZipArchive(entries);
}
