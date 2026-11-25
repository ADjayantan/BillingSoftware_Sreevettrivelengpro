/**
 * A printed page as marks in its own units: text, lines, shapes. The frame inside the margins is
 * 100 wide, and A5 is the same drawing, smaller. components/sheets.tsx writes the marks as SVG for
 * the screen and the printer, sheet-pdf.ts as PDF for Drive. Pure.
 */
import { textWidth, type Face } from './text-width';

export const FRAME = { width: 100, height: 145.6 } as const;

/** Millimetres. `unit` is one unit of the frame. */
export const PAPERS = {
  a4: { width: 210, height: 297, margin: 10, unit: 1.9 },
  a5: { width: 148, height: 210, margin: 7, unit: 1.34 },
} as const;
export type Paper = keyof typeof PAPERS;

export const INKS = {
  ink: '#17694c', red: '#c42a43', black: '#111111', grey: '#3a3a3a', white: '#ffffff',
  /** Behind headings, the Vel behind the rows, the disc of the gear. */
  tint: '#cfe8da', vel: '#ddefe4', rose: '#f0a3ad', blush: '#f7d3d8',
} as const;
export type Ink = keyof typeof INKS;

export type Segment =
  | readonly ['M' | 'L', number, number]
  | readonly ['C', number, number, number, number, number, number]
  | readonly ['Z'];

export interface TextOp {
  kind: 'text';
  text: string;
  /** The left end of its base line; the lower end when it reads upwards. */
  x: number;
  y: number;
  size: number;
  face: Face;
  ink: Ink;
  /** It is made exactly this wide, whatever font the reader has. */
  width: number;
  up?: true;
  outline?: { ink: Ink; weight: number };
}
export interface LineOp {
  kind: 'line';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  weight: number;
  ink: Ink;
  dotted?: true;
}
export interface PathOp {
  kind: 'path';
  d: readonly Segment[];
  fill?: Ink;
  stroke?: Ink;
  weight?: number;
  round?: true;
}
export type Op = TextOp | LineOp | PathOp;

export interface Sheet {
  key: string;
  /** What it is, for a screen reader: 'Tax invoice INV/26-27/0001, page 1 of 2'. */
  label: string;
  ops: readonly Op[];
}

/** A picture in units of its own, placed on a page at any size. */
export interface Art {
  width: number;
  height: number;
  ops: readonly Op[];
}

export interface TextStyle {
  size: number;
  face?: Face;
  ink?: Ink;
  align?: 'left' | 'center' | 'right';
  /** Its room. A longer text gets smaller letters, then narrower ones; nothing is ever cut. */
  max?: number;
  /** Letters this much narrower than they are, as the headings of the printed book. */
  narrow?: number;
  /** Reads upwards. */
  up?: boolean;
  outline?: TextOp['outline'];
}

const LINE = 0.17;
/** Below this share of their size letters are not made smaller, only narrower. */
const SMALLEST = 0.7;
/** A quarter circle as a Bézier curve. */
const ARC = 0.5523;

export class Pen {
  readonly ops: Op[] = [];

  text(text: string, x: number, y: number, style: TextStyle): TextOp | null {
    const said = text.replace(/[\s\p{Cc}]+/gu, ' ').trim();
    if (said === '') return null;
    const { face = 'regular', ink = 'black', align = 'left', narrow = 1, max = Infinity, up, outline } = style;
    const natural = textWidth(said, face, style.size) * narrow;
    const size = natural > max ? style.size * Math.max(SMALLEST, max / natural) : style.size;
    const width = Math.min(max, (natural * size) / style.size);
    const op: TextOp = {
      kind: 'text', text: said, y, size, face, ink, width,
      x: align === 'left' ? x : align === 'right' ? x - width : x - width / 2,
      ...(up ? { up } : {}), ...(outline ? { outline } : {}),
    };
    this.ops.push(op);
    return op;
  }

  line(x1: number, y1: number, x2: number, y2: number, style: { weight?: number; ink?: Ink; dotted?: boolean } = {}): void {
    const { weight = LINE, ink = 'ink', dotted } = style;
    this.ops.push({ kind: 'line', x1, y1, x2, y2, weight, ink, ...(dotted ? { dotted } : {}) });
  }

  /** `r` is one radius for all corners, or top left, top right, bottom right, bottom left. */
  box(x: number, y: number, w: number, h: number, style: { r?: number | readonly [number, number, number, number]; fill?: Ink; stroke?: Ink | null; weight?: number } = {}): void {
    const { r = 0, fill, stroke = 'ink', weight = LINE } = style;
    const [a, b, c, d] = typeof r === 'number' ? [r, r, r, r] : r;
    const k = 1 - ARC;
    const right = x + w;
    const bottom = y + h;
    const path: Segment[] = [['M', x + a, y], ['L', right - b, y]];
    if (b > 0) path.push(['C', right - b * k, y, right, y + b * k, right, y + b]);
    path.push(['L', right, bottom - c]);
    if (c > 0) path.push(['C', right, bottom - c * k, right - c * k, bottom, right - c, bottom]);
    path.push(['L', x + d, bottom]);
    if (d > 0) path.push(['C', x + d * k, bottom, x, bottom - d * k, x, bottom - d]);
    if (a > 0) path.push(['L', x, y + a], ['C', x, y + a * k, x + a * k, y, x + a, y]);
    path.push(['Z']);
    this.ops.push({ kind: 'path', d: path, ...(fill ? { fill } : {}), ...(stroke ? { stroke, weight } : {}) });
  }

  place(art: Art, x: number, y: number, width: number): void {
    const k = width / art.width;
    for (const op of art.ops) this.ops.push(moved(op, x, y, k));
  }
}

function moved(op: Op, dx: number, dy: number, k: number): Op {
  if (op.kind === 'text') {
    const outline = op.outline && { ...op.outline, weight: op.outline.weight * k };
    return { ...op, x: dx + op.x * k, y: dy + op.y * k, size: op.size * k, width: op.width * k, ...(outline ? { outline } : {}) };
  }
  if (op.kind === 'line') return { ...op, x1: dx + op.x1 * k, y1: dy + op.y1 * k, x2: dx + op.x2 * k, y2: dy + op.y2 * k, weight: op.weight * k };
  const at = (value: number, i: number): number => (i % 2 === 0 ? dx : dy) + value * k;
  const d = op.d.map(([command, ...numbers]) => [command, ...(numbers as number[]).map(at)] as unknown as Segment);
  return { ...op, d, ...(op.weight === undefined ? {} : { weight: op.weight * k }) };
}
