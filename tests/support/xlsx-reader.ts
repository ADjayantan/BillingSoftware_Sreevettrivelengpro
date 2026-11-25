// Reads an .xlsx the way a spreadsheet program would: unzip by the central directory, parse the
// XML, follow the relationships. Shares no code with src/lib/xlsx.ts.
import { inflateRawSync } from 'node:zlib';

export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (raw: string): string =>
  raw.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (_, name: string) => {
    if (name.startsWith('#x')) return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    if (name.startsWith('#')) return String.fromCodePoint(Number(name.slice(1)));
    const known = ENTITIES[name];
    if (known === undefined) throw new Error(`unknown entity &${name};`);
    return known;
  });

/** Strict enough to refuse what Excel would: unbalanced tags, bare & and <, control characters. */
export function parseXml(xml: string): XmlNode {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/.test(xml)) throw new Error('character not allowed in XML');
  const root: XmlNode = { name: '#root', attrs: {}, children: [], text: '' };
  const open: XmlNode[] = [root];
  const token = /<\?[^>]*\?>|<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+="[^"<]*")*)\s*(\/?)>|([^<]+)|(<)/g;
  for (let match = token.exec(xml); match; match = token.exec(xml)) {
    const [whole, closing, name, attrText, selfClosing, text, stray] = match;
    if (stray) throw new Error(`stray < at ${match.index}: ${xml.slice(match.index, match.index + 40)}`);
    if (whole.startsWith('<?')) continue;
    const parent = open.at(-1)!;
    if (text !== undefined) {
      if (/&(?!(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);)/i.test(text)) throw new Error('bare & in text');
      parent.text += decode(text);
    } else if (closing) {
      if (parent.name !== name) throw new Error(`</${name}> closes <${parent.name}>`);
      open.pop();
    } else {
      const attrs: Record<string, string> = {};
      for (const [, key = '', value = ''] of (attrText ?? '').matchAll(/([\w:.-]+)="([^"]*)"/g)) {
        if (key in attrs) throw new Error(`attribute ${key} twice`);
        attrs[key] = decode(value);
      }
      const node: XmlNode = { name: name!, attrs, children: [], text: '' };
      parent.children.push(node);
      if (!selfClosing) open.push(node);
    }
  }
  if (open.length !== 1) throw new Error(`<${open.at(-1)!.name}> is never closed`);
  const [only, ...more] = root.children;
  if (!only || more.length > 0) throw new Error('one root element expected');
  return only;
}

export const kids = (node: XmlNode | undefined, name: string): XmlNode[] => node?.children.filter((child) => child.name === name) ?? [];
export const kid = (node: XmlNode | undefined, name: string): XmlNode | undefined => kids(node, name)[0];

export function unzip(bytes: Uint8Array): Map<string, Buffer> {
  const buf = Buffer.from(bytes);
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error('not a ZIP');
  const files = new Map<string, Buffer>();
  let at = buf.readUInt32LE(end + 16);
  for (let i = 0; i < buf.readUInt16LE(end + 10); i += 1) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error('bad central directory');
    const [compressed, size, nameLength, extra, comment, local] = [buf.readUInt32LE(at + 20), buf.readUInt32LE(at + 24), buf.readUInt16LE(at + 28), buf.readUInt16LE(at + 30), buf.readUInt16LE(at + 32), buf.readUInt32LE(at + 42)];
    const name = buf.toString('utf8', at + 46, at + 46 + nameLength);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const content = inflateRawSync(buf.subarray(start, start + compressed));
    if (content.length !== size) throw new Error(`${name}: wrong size`);
    if (files.has(name)) throw new Error(`${name} twice`);
    files.set(name, content);
    at += 46 + nameLength + extra + comment;
  }
  return files;
}

export interface ReadCell {
  ref: string;
  /** 'text' for inline text, 'number' for a number, as stored. */
  type: 'text' | 'number';
  value: string;
  formula: string | null;
  /** Number format code and font of its style. */
  format: string;
  strike: boolean;
  bold: boolean;
}
export interface ReadSheet {
  name: string;
  rows: (ReadCell | undefined)[][];
  xml: XmlNode;
}

const BUILT_IN: Record<string, string> = { '0': 'General', '1': '0', '2': '0.00', '3': '#,##0', '14': 'mm-dd-yy', '49': '@' };

const columnOf = (ref: string): number => [...ref.replace(/\d+/g, '')].reduce((n, letter) => n * 26 + letter.charCodeAt(0) - 64, 0) - 1;

export function readXlsx(bytes: Uint8Array): { sheets: ReadSheet[]; files: Map<string, Buffer>; workbook: XmlNode } {
  const files = unzip(bytes);
  const part = (name: string): XmlNode => {
    const file = files.get(name);
    if (!file) throw new Error(`no part ${name}`);
    return parseXml(file.toString('utf8'));
  };
  const types = part('[Content_Types].xml');
  for (const override of kids(types, 'Override')) if (!files.has(override.attrs.PartName!.slice(1))) throw new Error(`content type for missing ${override.attrs.PartName}`);
  const rootRels = new Map(kids(part('_rels/.rels'), 'Relationship').map((rel) => [rel.attrs.Type!.split('/').at(-1), rel.attrs.Target!]));
  const workbookPath = rootRels.get('officeDocument')!;
  const workbook = part(workbookPath);
  const rels = new Map(kids(part('xl/_rels/workbook.xml.rels'), 'Relationship').map((rel) => [rel.attrs.Id!, `xl/${rel.attrs.Target}`]));
  const styles = part('xl/styles.xml');
  const formats = new Map(kids(kid(styles, 'numFmts'), 'numFmt').map((fmt) => [fmt.attrs.numFmtId!, fmt.attrs.formatCode!]));
  const fonts = kids(kid(styles, 'fonts'), 'font');
  const xfs = kids(kid(styles, 'cellXfs'), 'xf');
  for (const list of ['numFmts', 'fonts', 'fills', 'borders', 'cellStyleXfs', 'cellXfs']) {
    const node = kid(styles, list);
    if (node && Number(node.attrs.count) !== node.children.length) throw new Error(`${list}: count is wrong`);
  }
  const sheets = kids(kid(workbook, 'sheets'), 'sheet').map((sheet): ReadSheet => {
    const xml = part(rels.get(sheet.attrs['r:id']!)!);
    const rows: (ReadCell | undefined)[][] = [];
    for (const row of kids(kid(xml, 'sheetData'), 'row')) {
      const cells: (ReadCell | undefined)[] = [];
      for (const cell of kids(row, 'c')) {
        const ref = cell.attrs.r!;
        if (!ref.endsWith(row.attrs.r!)) throw new Error(`${ref} in row ${row.attrs.r}`);
        const xf = xfs[Number(cell.attrs.s ?? 0)];
        if (!xf) throw new Error(`${ref}: no style ${cell.attrs.s}`);
        const font = fonts[Number(xf.attrs.fontId)];
        const inline = cell.attrs.t === 'inlineStr';
        const value = inline ? kids(kid(cell, 'is'), 't').map((t) => t.text).join('') : kid(cell, 'v')?.text;
        if (value === undefined) continue;
        if (!inline && !/^-?\d+(\.\d+)?$/.test(value)) throw new Error(`${ref}: ${value} is not a number`);
        cells[columnOf(ref)] = {
          ref, type: inline ? 'text' : 'number', value, formula: kid(cell, 'f')?.text ?? null,
          format: formats.get(xf.attrs.numFmtId!) ?? BUILT_IN[xf.attrs.numFmtId!] ?? `#${xf.attrs.numFmtId}`,
          strike: kid(font, 'strike') !== undefined, bold: kid(font, 'b') !== undefined,
        };
      }
      rows[Number(row.attrs.r) - 1] = cells;
    }
    return { name: sheet.attrs.name!, rows, xml };
  });
  return { sheets, files, workbook };
}

/** The table of a sheet, as records by column title; stops at the first empty row. */
export function table(sheet: ReadSheet): Record<string, string>[] {
  const titles = (sheet.rows[0] ?? []).map((cell) => cell?.value ?? '');
  const records: Record<string, string>[] = [];
  for (const row of sheet.rows.slice(1)) {
    if (!row?.some(Boolean)) break;
    if (row[0]?.bold) break; // the totals
    records.push(Object.fromEntries(titles.map((title, i) => [title, row[i]?.value ?? ''])));
  }
  return records;
}

/** The totals row: what Excel shows before it calculates, and the formula it calculates with. */
export function totals(sheet: ReadSheet): Record<string, { value: string; formula: string }> {
  const titles = (sheet.rows[0] ?? []).map((cell) => cell?.value ?? '');
  const row = sheet.rows.slice(1).find((cells) => cells?.some((cell) => cell?.formula));
  return Object.fromEntries((row ?? []).flatMap((cell, i) => (cell?.formula ? [[titles[i] ?? '', { value: cell.value, formula: cell.formula }]] : [])));
}

/** Serial day number -> ISO date. */
export const dateOf = (serial: string): string => new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(serial)) * 86_400_000).toISOString().slice(0, 10);
