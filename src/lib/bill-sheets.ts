/**
 * The owner's printed bill (specs/own-bill.md): what print-documents.ts says, drawn on pages.
 * All lengths are in units of the frame, which is 100 wide. Pure.
 */
import { GEAR, RUPEE, VEL } from './bill-art';
import type { LabelValue, PrintDocument, PrintItem } from './print-documents';
import { FRAME, Pen, type Ink, type Sheet } from './sheet';
import { textWidth, wrap, type Face } from './text-width';

const WIDE = FRAME.width;
const HIGH = FRAME.height;
const GAP = 0.8;
/** The corners of the book. */
const ROUND = 1.4;

/** Nine rows, as in the book. */
const ROWS = 9;
const ROW = 4.2;
const BODY = 2.1;
const STEP = 2.45;
const DETAIL = 1.65;
const DETAIL_STEP = 2;
const TABLE_HEAD = 6.8;

interface Column {
  left: number;
  right: number;
}
const column = (left: number, right: number): Column => ({ left, right });
const NO = column(0, 6.2);
const CODE = column(7.2, 18);
const TEXT = column(19, 56.6);
const THIRD = column(57.6, 68);
const FOURTH = column(69, 81.6);
const AMOUNT = column(82.6, WIDE);
const COLUMNS = [NO, CODE, TEXT, THIRD, FOURTH, AMOUNT] as const;
/** Between rupees and paise. */
const PAISE = 95.6;
/** Between the words and the sums under the rows. */
const SPLIT = 43.6;

const middle = ({ left, right }: Column): number => (left + right) / 2;
const room = ({ left, right }: Column): number => right - left - 1;

/** The largest letters, up to `size`, with which the text takes at most this height. */
function fitted(text: string, face: Face, size: number, width: number, height: number): { size: number; step: number; lines: string[] } {
  for (let letters = size; ; letters -= 0.1) {
    const lines = wrap(text, face, letters, width);
    if (lines.length * letters * 1.15 <= height || letters < 1) return { size: letters, step: letters * 1.15, lines };
  }
}

// ---- Head ----------------------------------------------------------------------
function letterHead(pen: Pen, doc: PrintDocument, top: number): number {
  const { issuer } = doc;
  const gear = 11.2;
  pen.place(GEAR, 1.2, top + 0.8, gear);
  let y = top + 0.9;
  // Beside the gear, and under it from side to side.
  const space = (): Column => (y < top + gear + 0.4 ? column(13, 98.6) : column(1.4, 98.6));
  const lines = (text: string, face: Face, size: number, ink: Ink, step: number): void => {
    const place = space();
    for (const line of wrap(text, face, size, place.right - place.left)) {
      pen.text(line, middle(place), y + size * 0.82, { size, face, ink, align: 'center' });
      y += step;
    }
  };

  const natural = textWidth(issuer.name, 'bold', 4.95);
  const name = Math.min(4.95, Math.max(3.3, (4.95 * 85.6) / natural));
  lines(issuer.name, 'bold', name, 'red', name * 1.12);
  y += 0.35;
  lines(issuer.tagline, 'bold', 2.12, 'ink', 2.6);
  for (const address of issuer.addresses) lines(address, 'regular', 2.12, 'ink', 2.6);

  // Telephone numbers and e-mail side by side, as far as they fit.
  const apart = 2;
  let row: { text: string; width: number }[] = [];
  const write = (): void => {
    const place = space();
    const total = row.reduce((width, part) => width + part.width, 0) + apart * (row.length - 1);
    let x = middle(place) - Math.min(total, place.right - place.left) / 2;
    for (const part of row) {
      pen.text(part.text, x, y + 1.74, { size: 2.12, ink: 'ink', max: place.right - place.left });
      x += part.width + apart;
    }
    if (row.length > 0) y += 2.6;
    row = [];
  };
  for (const text of issuer.contact) {
    const width = textWidth(text, 'regular', 2.12);
    const place = space();
    if (row.length > 0 && row.reduce((sum, part) => sum + part.width + apart, 0) + width > place.right - place.left) write();
    row.push({ text, width });
  }
  write();

  const bottom = Math.max(y + 0.9, top + gear + 2);
  pen.box(0, top, WIDE, bottom - top, { r: ROUND });
  return bottom;
}

/** On the pages after the first: whose bill, and which. */
function shortHead(pen: Pen, doc: PrintDocument, top: number): number {
  pen.text(doc.issuer.name, 1.4, top + 3.6, { size: 2.3, face: 'bold', ink: 'red', max: 46 });
  pen.text(`${doc.title} ${doc.number} · ${doc.issueDate}`, 98.6, top + 3.6, { size: 2.1, face: 'bold', ink: 'ink', align: 'right', max: 49 });
  pen.box(0, top, WIDE, 5.6, { r: ROUND });
  return top + 5.6;
}

// ---- To whom, and which bill ------------------------------------------------------
const PARTY_RIGHT = 64;
const NUMBERS_LEFT = 64.8;

interface Ref {
  label: string;
  value: string;
  date: string;
  width: number;
  /** Too long to stand beside its date. */
  own: boolean;
}

function parties(pen: Pen, doc: PrintDocument, top: number): number {
  const { to } = doc;
  const written = PARTY_RIGHT - 11;
  const lines = [
    ...wrap(to.name, 'bold', 2.4, written).map((text) => ({ text, face: 'bold' as const, size: 2.4 })),
    ...wrap(to.address, 'regular', BODY, written).map((text) => ({ text, face: 'regular' as const, size: BODY })),
    ...(to.phone ? [{ text: `Ph : ${to.phone}`, face: 'regular' as const, size: BODY }] : []),
  ];
  const step = lines.length <= 5 ? 3.9 : 2.9;
  const partyHeight = 5.9;
  const ruled = (count: number): number => 4 + count * step + GAP; // the height of the box with so many lines

  const refs: Ref[] = doc.refs.map((ref) => {
    const width = textWidth(ref.label, 'regular', 1.85);
    return { ...ref, width, own: textWidth(ref.value, 'regular', 1.85) > (88.2 - 66.5 - width) * 1.15 };
  });
  const gstinHeight = 5.6;
  const titleHeight = doc.subtitle ? 6.5 : 4.7;
  const numbers = 8.7;
  const numbersTop = top + gstinHeight + 0.3 + titleHeight + 0.4;
  const refsHeight = refs.reduce((sum, ref) => sum + (ref.own ? 5.8 : 3.1), 0);
  const bottom = Math.max(top + ruled(Math.max(4, lines.length)) + 0.5 + partyHeight, numbersTop + numbers + refsHeight + 1.1);

  // Left: the customer.
  const partyTop = bottom - partyHeight;
  const count = Math.floor((partyTop - 0.5 - top - ruled(0)) / step + 0.001);
  pen.box(0, top, PARTY_RIGHT, partyTop - 0.5 - top, { r: ROUND });
  pen.text(to.role, 1.5, top + 2.8, { size: BODY, ink: 'ink' });
  for (let i = 0; i < count; i += 1) {
    const y = top + 3.6 + i * step;
    if (i === 0) pen.text('M/s.', 4, y + step * 0.7, { size: BODY, ink: 'ink' });
    const line = lines[i];
    if (line) pen.text(line.text, 9.4, y + step * 0.7, line);
    pen.line(9.2, y + step * 0.91, PARTY_RIGHT - 1.4, y + step * 0.91, { weight: 0.16, dotted: true });
  }
  pen.box(0, partyTop, PARTY_RIGHT, partyHeight, { r: ROUND });
  const gstin = pen.text('Party GSTIN No. :', 1.2, partyTop + 2.4, { size: 1.9, ink: 'ink' });
  pen.text(to.gstin, 1.2 + (gstin?.width ?? 0) + 0.8, partyTop + 2.4, { size: 2, face: 'bold' });
  const state = pen.text('State :', 1.2, partyTop + 4.9, { size: 1.9, ink: 'ink' });
  pen.text(to.state, 1.2 + (state?.width ?? 0) + 0.8, partyTop + 4.9, { size: 2, face: 'bold', max: 52 });

  // Right: the numbers.
  const wide = WIDE - NUMBERS_LEFT;
  const centre = NUMBERS_LEFT + wide / 2;
  const titleTop = top + gstinHeight + 0.3;
  pen.box(NUMBERS_LEFT, top, wide, gstinHeight, { r: ROUND });
  pen.text(`GSTIN : ${doc.issuer.gstin}`, centre, top + gstinHeight / 2 + 1.08, { size: 3, face: 'bold', ink: 'ink', align: 'center', narrow: 0.86, max: wide - 2 });
  pen.box(NUMBERS_LEFT, titleTop, wide, titleHeight, { r: ROUND });
  pen.text(doc.title, centre, titleTop + 3.4, { size: 2.9, face: 'bold', ink: 'red', align: 'center', max: wide - 2 });
  pen.text(doc.subtitle, centre, titleTop + 5.7, { size: 1.75, face: 'bold', ink: 'red', align: 'center', max: wide - 2 });

  const left = NUMBERS_LEFT + 0.9;
  const right = WIDE - 0.9;
  pen.box(NUMBERS_LEFT, numbersTop, wide, bottom - numbersTop, { r: ROUND });
  pen.box(NUMBERS_LEFT, numbersTop, wide, numbers, { r: ROUND });
  pen.text('No.', left, numbersTop + 3.3, { size: BODY, face: 'bold', ink: 'ink' });
  pen.text(doc.number, left + 4.8, numbersTop + 3.3, { size: 2.6, face: 'bold', max: right - left - 4.8 });
  pen.text('Date', left, numbersTop + 7, { size: BODY, ink: 'ink' });
  pen.text(doc.issueDate, left + 5.2, numbersTop + 7, { size: BODY });
  pen.line(left + 4.9, numbersTop + 7.65, right, numbersTop + 7.65, { weight: 0.16, dotted: true });
  let y = numbersTop + numbers;
  for (const ref of refs) {
    const dateLeft = right - 7.9;
    const valueLeft = left + ref.width + 0.8;
    pen.text(ref.label, left, y + 2.4, { size: 1.85, ink: 'ink' });
    if (!ref.own) pen.text(ref.value, valueLeft, y + 2.4, { size: 1.85, max: dateLeft - 2.9 - valueLeft });
    pen.line(valueLeft - 0.2, y + 3, dateLeft - 2.6, y + 3, { weight: 0.16, dotted: true });
    pen.text('dt', dateLeft - 2.2, y + 2.4, { size: 1.85, ink: 'ink' });
    pen.text(ref.date, dateLeft + 0.2, y + 2.4, { size: 1.85, max: 7.6 });
    pen.line(dateLeft, y + 3, right, y + 3, { weight: 0.16, dotted: true });
    y += 3.1;
    if (ref.own) {
      pen.text(ref.value, left, y + 2.1, { size: 1.85, max: right - left });
      y += 2.7;
    }
  }
  return bottom;
}

// ---- Notes -----------------------------------------------------------------------
const NOTE = 1.9;
const NOTE_STEP = 2.5;
const NOTE_PADDING = 1.2;

interface NoteLine {
  label: string;
  text: string;
  indent: number;
  strong: boolean;
}

const noteLines = (doc: PrintDocument): NoteLine[] =>
  doc.notes.flatMap(({ label, value, strong = false }) => {
    const named = label ? `${label} :` : '';
    const indent = named ? textWidth(named, 'bold', NOTE) + 0.7 : 0;
    return wrap(value, strong ? 'bold' : 'regular', NOTE, 97 - indent).map((text, i) => ({ label: i === 0 ? named : '', text, indent, strong }));
  });

function notes(pen: Pen, lines: readonly NoteLine[], top: number): number {
  const height = lines.length * NOTE_STEP + NOTE_PADDING;
  pen.box(0, top, WIDE, height, { r: ROUND });
  for (const [i, line] of lines.entries()) {
    const y = top + NOTE_PADDING / 2 + i * NOTE_STEP + 1.85;
    pen.text(line.label, 1.4, y, { size: NOTE, face: 'bold', ink: line.strong ? 'red' : 'ink' });
    pen.text(line.text, 1.4 + line.indent, y, { size: NOTE, face: line.strong ? 'bold' : 'regular', ink: line.strong ? 'red' : 'black' });
  }
  return top + height;
}

// ---- Rows ------------------------------------------------------------------------
interface Row {
  no: number;
  item: PrintItem;
  description: string[];
  detail: string[];
  height: number;
}

function rowOf(item: PrintItem, i: number): Row {
  const description = wrap(item.description, 'regular', BODY, room(TEXT));
  const detail = wrap(item.detail, 'regular', DETAIL, room(TEXT));
  const text = description.length * STEP + detail.length * DETAIL_STEP;
  return { no: i + 1, item, description, detail, height: Math.max(ROW, text + 1.5, item.fourthNote || item.codeNote ? 4.8 : 0) };
}

function tableHead(pen: Pen, doc: PrintDocument, top: number): void {
  const { heads } = doc;
  const height = TABLE_HEAD - GAP;
  const title = (text: string, place: Column, y: number, narrow = 1): void => {
    pen.text(text, middle(place), y, { size: 1.95, face: 'bold', ink: 'ink', align: 'center', narrow, max: place.right - place.left - 0.6 });
  };
  for (const place of COLUMNS) pen.box(place.left, top, place.right - place.left, height, { r: 1, fill: 'tint' });
  const y = top + height / 2 + 0.7;
  title('SL. No.', NO, y, 0.86);
  title(heads.code, CODE, y, 0.86);
  title('PARTICULARS', TEXT, y);
  title(heads.third, THIRD, y);
  title(heads.fourth, FOURTH, y);
  if (heads.split) {
    title(heads.amount, AMOUNT, top + 2.5);
    title('Rs.', column(AMOUNT.left, 88), top + 4.9);
    title('P.', column(PAISE, WIDE), top + 4.9);
  } else {
    title(heads.amount, AMOUNT, y);
  }
}

/** Rupees and paise, each in its place. */
function money(pen: Pen, amount: string, y: number, size = BODY, bold = false): void {
  const [rupees = '', paise = ''] = amount.split('.');
  const face = bold ? 'bold' : 'regular';
  pen.text(rupees, PAISE - 0.5, y, { size, face, align: 'right', max: PAISE - AMOUNT.left - 1 });
  pen.text(paise, WIDE - 0.7, y, { size, face, align: 'right', max: WIDE - PAISE - 1.2 });
}

function drawRow(pen: Pen, doc: PrintDocument, row: Row, top: number): void {
  const { item } = row;
  const centre = top + row.height / 2;
  const base = centre + 0.75;
  pen.text(String(row.no), middle(NO), base, { size: BODY, align: 'center', max: room(NO) + 0.4 });

  pen.text(item.code, middle(CODE), item.codeNote ? centre - 0.2 : base, { size: BODY, align: 'center', max: room(CODE) });
  pen.text(item.codeNote, middle(CODE), centre + 1.75, { size: DETAIL, ink: 'grey', align: 'center', max: room(CODE) });

  let y = centre - (row.description.length * STEP + row.detail.length * DETAIL_STEP) / 2;
  for (const line of row.description) {
    pen.text(line, TEXT.left + 0.6, y + 1.92, { size: BODY });
    y += STEP;
  }
  for (const line of row.detail) {
    pen.text(line, TEXT.left + 0.6, y + 1.5, { size: DETAIL, ink: 'grey' });
    y += DETAIL_STEP;
  }

  const unit = textWidth(item.thirdNote, 'regular', 1.6);
  pen.text(item.third, THIRD.right - 0.5 - unit, base, { size: BODY, align: 'right', max: room(THIRD) - unit });
  pen.text(item.thirdNote, THIRD.right - 0.5, base, { size: 1.6, ink: 'grey', align: 'right' });

  pen.text(item.fourth, FOURTH.right - 0.5, item.fourthNote ? centre - 0.2 : base, { size: BODY, align: 'right', max: room(FOURTH) });
  pen.text(item.fourthNote, FOURTH.right - 0.5, centre + 1.75, { size: DETAIL, ink: 'grey', align: 'right', max: room(FOURTH) });

  if (item.amount !== null && doc.heads.split) money(pen, item.amount, base);
}

// ---- Under the rows: invoice -------------------------------------------------------
const FACT = 1.75;
const FACT_STEP = 2.35;

/** Names with their values, one after the other or each on a line of its own. Gives the height. */
function facts(pen: Pen, list: readonly LabelValue[], left: number, top: number, width: number, each = false): number {
  let x = left;
  let y = top;
  for (const { label, value } of list) {
    const indent = textWidth(label, 'bold', FACT) + 0.6;
    const lines = wrap(value, 'regular', FACT, width - indent);
    const taken = indent + textWidth(lines[0] ?? '', 'regular', FACT);
    if (x > left && (each || lines.length > 1 || x + taken > left + width)) {
      x = left;
      y += FACT_STEP;
    }
    pen.text(label, x, y + 1.7, { size: FACT, face: 'bold', ink: 'ink' });
    for (const [i, line] of lines.entries()) pen.text(line, x + indent, y + i * FACT_STEP + 1.7, { size: FACT });
    y += Math.max(0, lines.length - 1) * FACT_STEP;
    x += taken + 1.6;
  }
  return y + (x > left ? FACT_STEP : 0) - top;
}

/** Many rates make many rows: the more there are, the flatter. */
const sumHeight = (count: number): number => (count <= 10 ? 4.15 : count <= 15 ? 3.4 : 2.75);

const WORD = 2.1;
const WORD_STEP = 3.3;

interface Words {
  label: string;
  indent: number;
  lines: string[];
}
function wordsOf(doc: PrintDocument, width: number): Words | null {
  if (!doc.words) return null;
  const indent = textWidth(doc.words.label, 'bold', 2.25) + 0.9;
  return { label: doc.words.label, indent, lines: wrap(doc.words.value, 'bold', WORD, width, indent) };
}

function drawWords(pen: Pen, words: Words, left: number, right: number, top: number, least: number): number {
  const count = Math.max(least, words.lines.length);
  for (let i = 0; i < count; i += 1) {
    const y = top + i * WORD_STEP;
    const x = i === 0 ? left + words.indent : left;
    if (i === 0) pen.text(words.label, left, y + 2.1, { size: 2.25, face: 'bold', ink: 'ink' });
    pen.text(words.lines[i] ?? '', x, y + 2.1, { size: WORD, face: 'bold', max: right - x });
    pen.line(x, y + 2.75, right, y + 2.75, { weight: 0.16, dotted: true });
  }
  return count * WORD_STEP;
}

interface Closing {
  height: number;
  /** How far the last columns of the rows run on. */
  columns: number;
  draw: (pen: Pen, top: number) => void;
}

const TOTAL_BAR = 5.3;
const FOOT = 13.6;

function totalBar(pen: Pen, total: NonNullable<PrintDocument['total']>, top: number): void {
  pen.box(0, top, 54, TOTAL_BAR, { r: ROUND, fill: 'tint' });
  pen.text(total.label, 27, top + 3.45, { size: 2.25, face: 'bold', ink: 'ink', align: 'center', max: 50 });
  pen.box(54.9, top, WIDE - 54.9, TOTAL_BAR, { r: ROUND });
  const [rupees = '', paise = ''] = total.amount.split('.');
  const figure = pen.text(rupees, PAISE - 0.6, top + 3.6, { size: 2.7, face: 'bold', align: 'right', max: PAISE - 54.9 - 5 });
  pen.text(paise, WIDE - 0.6, top + 3.6, { size: 2.7, face: 'bold', align: 'right', max: WIDE - PAISE - 1 });
  pen.line(PAISE, top, PAISE, top + TOTAL_BAR, { weight: 0.1 });
  if (figure) pen.place(RUPEE, figure.x - 2.2, top + 1.75, 1.3);
}

function signature(pen: Pen, sign: PrintDocument['signatures'][number], left: number, right: number, top: number): void {
  const width = right - left;
  const centre = (left + right) / 2;
  pen.box(left, top, width, FOOT, { r: ROUND });
  if (!sign.own) {
    const name = fitted(sign.organisation, 'bold', 2, width - 2.4, 4.8);
    for (const [i, line] of name.lines.entries()) pen.text(line, left + 1.2, top + 2.7 + i * name.step, { size: name.size, face: 'bold', ink: 'ink' });
    pen.line(left + 1.2, top + FOOT - 3.6, right - 1.2, top + FOOT - 3.6, { weight: 0.16, dotted: true });
    pen.text([sign.role, sign.hint].filter(Boolean).join(' · '), left + 1.2, top + FOOT - 1.3, { size: 1.75, ink: 'ink', max: width - 2.4 });
    return;
  }
  const forWidth = textWidth('For ', 'regular', 1.95);
  const nameWidth = textWidth(sign.organisation, 'script', 2.25);
  if (forWidth + nameWidth <= width - 2) {
    const x = centre - (forWidth + nameWidth) / 2;
    pen.text('For', x, top + 2.9, { size: 1.95, ink: 'red' });
    pen.text(sign.organisation, x + forWidth, top + 2.9, { size: 2.25, face: 'script', ink: 'red' });
  } else {
    pen.text('For', centre, top + 2.4, { size: 1.95, ink: 'red', align: 'center' });
    const name = fitted(sign.organisation, 'script', 2.25, width - 2, 6.6);
    for (const [i, line] of name.lines.entries()) pen.text(line, centre, top + 4.9 + i * name.step, { size: name.size, face: 'script', ink: 'red', align: 'center' });
  }
  pen.text(sign.role, right - 1.2, top + FOOT - 1.3, { size: 1.75, ink: 'ink', align: 'right', max: width - 2.4 });
}

function bankBox(pen: Pen, bank: readonly LabelValue[], right: number, top: number): void {
  const line = 5.4;
  pen.box(0, top, right, FOOT, { r: ROUND });
  pen.text('E & O E', right - 1.6, top + FOOT - 1.3, { size: 1.75, ink: 'ink', align: 'right' });
  if (bank.length === 0) return;
  pen.line(line, top, line, top + FOOT);
  pen.text('BANK DETAILS', 3.25, top + FOOT / 2 + textWidth('BANK DETAILS', 'bold', 1.65) / 2, { size: 1.65, face: 'bold', ink: 'ink', up: true });
  const step = 2.85;
  let y = top + (FOOT - bank.length * step) / 2 + 2.05;
  for (const [i, row] of bank.entries()) {
    const last = i === bank.length - 1;
    pen.text(row.label, line + 1.6, y, { size: 1.95, face: 'bold', ink: 'red' });
    pen.text(`: ${row.value}`, 21.6, y, { size: 1.95, face: 'bold', ink: 'red', max: right - 21.6 - (last ? 9.6 : 1.4) });
    y += step;
  }
}

function invoiceClosing(doc: PrintDocument): Closing {
  const left = 1.3;
  const right = SPLIT - 1.3;
  const words = wordsOf(doc, right - left);
  const wordRows = Math.max(3, words?.lines.length ?? 0);
  const said = 1 + wordRows * WORD_STEP + GAP + facts(new Pen(), doc.facts, left, 0, right - left) + 0.9;
  const block = Math.max(doc.sums.length * sumHeight(doc.sums.length), said);
  const row = block / doc.sums.length; // as tall as what is said beside them
  const total = doc.total ? GAP + TOTAL_BAR : 0;
  return {
    height: block + total + GAP + FOOT,
    columns: block,
    draw: (pen, top) => {
      pen.box(0, top, SPLIT, block, { r: [0, ROUND, ROUND, ROUND] });
      const end = words ? drawWords(pen, words, left, right, top + 1, 3) : 0;
      facts(pen, doc.facts, left, top + 1 + end + GAP, right - left);

      let y = top;
      const size = Math.min(2.05, row * 0.5);
      for (const [i, sum] of doc.sums.entries()) {
        const base = y + row / 2 + size * 0.36;
        pen.text(sum.label, TEXT.right - 0.9, base, { size, ink: 'ink', align: 'right', max: TEXT.right - SPLIT - 1.6 });
        pen.text(sum.rate, THIRD.right - 0.5, base, { size, align: 'right', max: room(THIRD) });
        pen.text(sum.base, FOURTH.right - 0.5, base, { size: Math.min(1.65, size), ink: 'grey', align: 'right', max: room(FOURTH) });
        if (sum.amount !== null) money(pen, sum.amount, base, size);
        y += row;
        if (i < doc.sums.length - 1) pen.line(SPLIT, y, WIDE, y, { weight: 0.14 });
      }
      pen.line(SPLIT, y, TEXT.right, y);
      if (doc.total) totalBar(pen, doc.total, top + block + GAP);
      const foot = top + block + total + GAP;
      bankBox(pen, doc.bank, 58.2, foot);
      const [sign] = doc.signatures;
      if (sign) signature(pen, sign, 59, WIDE, foot);
    },
  };
}

// ---- Under the rows: challan --------------------------------------------------------
function challanClosing(doc: PrintDocument): Closing {
  const left = 1.3;
  const right = SPLIT - 1.3;
  const words = wordsOf(doc, right - left);
  const wordsHeight = words ? words.lines.length * WORD_STEP + 0.6 : 0;
  const row = 4.15;
  const said = 1 + wordsHeight + facts(new Pen(), doc.facts, left, 0, right - left, true) + 0.9;
  const block = Math.max(doc.rows.length * row, said);
  const total = doc.total ? GAP + TOTAL_BAR : 0;
  return {
    height: GAP + block + total + GAP + FOOT,
    columns: 0,
    draw: (pen, start) => {
      const top = start + GAP;
      pen.box(0, top, SPLIT, block, { r: ROUND });
      if (words) drawWords(pen, words, left, right, top + 1, 1);
      facts(pen, doc.facts, left, top + 1 + wordsHeight, right - left, true);

      const from = SPLIT + GAP;
      pen.box(from, top, WIDE - from, block, { r: ROUND });
      let y = top;
      for (const { label, value } of doc.rows) {
        const base = y + row / 2 + 0.75;
        const width = Math.min(34, textWidth(value, 'bold', 2.05));
        pen.text(label, from + 1.2, base, { size: 2.05, ink: 'ink', max: WIDE - from - 3.6 - width });
        pen.text(value, WIDE - 1.2, base, { size: 2.05, face: 'bold', align: 'right', max: width });
        y += row;
        if (y < top + block - 0.5) pen.line(from, y, WIDE, y, { weight: 0.14 });
      }
      if (doc.total) totalBar(pen, doc.total, top + block + GAP);
      const foot = top + block + total + GAP;
      const [first, second] = doc.signatures;
      if (first) signature(pen, first, 0, 49.6, foot);
      if (second) signature(pen, second, 50.4, WIDE, foot);
    },
  };
}

// ---- Pages -----------------------------------------------------------------------
const COPY_LINE = 2.4;
/** Room for "Continued on page 2". */
const CONTINUED = 2.4;

interface Page {
  pen: Pen;
  top: number;
  notes: NoteLine[];
  rows: Row[];
}

function sheetsOf(doc: PrintDocument): Sheet[] {
  const pages: Page[] = [];
  const open = (): Page => {
    const pen = new Pen();
    const top = pages.length === 0 ? parties(pen, doc, letterHead(pen, doc, COPY_LINE) + GAP) : shortHead(pen, doc, COPY_LINE);
    const page = { pen, top: top + GAP, notes: [], rows: [] };
    pages.push(page);
    return page;
  };

  // What goes on which page.
  let page = open();
  let y = page.top;
  for (const line of noteLines(doc)) {
    if (y + (page.notes.length === 0 ? NOTE_PADDING : 0) + NOTE_STEP > HIGH - GAP - CONTINUED) {
      page = open();
      y = page.top;
    }
    y += (page.notes.length === 0 ? NOTE_PADDING : 0) + NOTE_STEP;
    page.notes.push(line);
  }
  if (page.notes.length > 0) y += GAP;
  for (const row of doc.items.map(rowOf)) {
    if (y + (page.rows.length === 0 ? TABLE_HEAD : 0) + row.height > HIGH - CONTINUED) {
      page = open();
      y = page.top;
    }
    y += (page.rows.length === 0 ? TABLE_HEAD : 0) + row.height;
    page.rows.push(row);
  }
  const closing = doc.kind === 'invoice' ? invoiceClosing(doc) : challanClosing(doc);
  if (y + closing.height > HIGH) {
    const moved = page.rows.pop();
    page = open();
    y = page.top;
    if (moved) {
      page.rows.push(moved);
      y += TABLE_HEAD + moved.height;
    }
  }
  const height = page.rows.reduce((sum, row) => sum + row.height, 0);
  const free = Math.min(ROWS * ROW - height, HIGH - y - closing.height);
  const empty = Math.max(0, Math.floor((free + 0.001) / ROW));

  for (const [i, { pen, top, notes: noted, rows }] of pages.entries()) {
    const last = i === pages.length - 1;
    pen.text(doc.copyLabel.toUpperCase(), WIDE, 1.65, { size: 1.7, ink: 'ink', align: 'right' });
    if (pages.length > 1) pen.text(`Page ${i + 1} of ${pages.length}`, 0, 1.65, { size: 1.7, ink: 'ink' });
    const start = noted.length > 0 ? notes(pen, noted, top) + GAP : top;
    const end = rows.length > 0 ? table(pen, doc, rows, start, last ? empty : 0, last ? closing.columns : 0) : start;
    if (last) closing.draw(pen, end);
    else pen.text(`Continued on page ${i + 2}`, WIDE, end + 1.9, { size: 1.7, ink: 'ink', align: 'right' });
  }

  const name = doc.title.charAt(0) + doc.title.slice(1).toLowerCase();
  return pages.map(({ pen }, i) => ({
    key: `${doc.key}-${i + 1}`,
    label: `${name} ${doc.number}, ${doc.copyLabel}${pages.length > 1 ? `, page ${i + 1} of ${pages.length}` : ''}`,
    ops: pen.ops,
  }));
}

/** The rows with their frame; the last columns run on for `below`. Gives where the rows end. */
function table(pen: Pen, doc: PrintDocument, rows: readonly Row[], start: number, empty: number, below: number): number {
  const top = start + TABLE_HEAD;
  const bottom = top + rows.reduce((sum, row) => sum + row.height, 0) + empty * ROW;
  tableHead(pen, doc, start);

  if (doc.stamp) {
    const size = Math.min(11, (bottom - top) / 0.95);
    pen.text(doc.stamp, WIDE / 2, (top + bottom) / 2 + size * 0.36, { size, face: 'bold', ink: 'blush', align: 'center' });
  } else {
    const width = Math.min(25.9, ((bottom + below - top - 4) * VEL.width) / VEL.height);
    if (width > 10) pen.place(VEL, 43.9 - width / 2, top + 3.5, width);
  }

  for (const [i, place] of COLUMNS.entries()) {
    const runsOn = below > 0 && i > 2;
    const foot = below > 0 ? (runsOn ? 1 : 0) : 1;
    pen.box(place.left, top, place.right - place.left, bottom + (runsOn ? below : 0) - top, { r: [1, 1, foot, foot] });
  }
  if (doc.heads.split) pen.line(PAISE, top, PAISE, bottom + below, { weight: 0.1 });

  let y = top;
  const ends = [...rows.map((row) => row.height), ...Array.from({ length: empty }, () => ROW)];
  for (const row of rows) {
    drawRow(pen, doc, row, y);
    y += row.height;
  }
  y = top;
  for (const [i, height] of ends.entries()) {
    y += height;
    if (below > 0 || i < ends.length - 1) pen.line(0, y, WIDE, y, { weight: 0.14 });
  }
  return bottom;
}

export const billSheets = (documents: readonly PrintDocument[]): Sheet[] => documents.flatMap(sheetsOf);
