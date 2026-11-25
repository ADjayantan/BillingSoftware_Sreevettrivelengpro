/**
 * Drawn pages as a PDF file: the same marks as on the printer, in fonts every reader has, with no
 * library. The same pages give the same bytes. Pure.
 */
import { latin, pdfString } from './latin';
import { INKS, PAPERS, type Ink, type Op, type Paper, type Segment, type Sheet, type TextOp } from './sheet';
import { textWidth } from './text-width';

const POINTS = 72 / 25.4;
const FONTS = { regular: 'F1', bold: 'F2', script: 'F3' } as const;

const n = (value: number): string => {
  const text = value.toFixed(2);
  return text.replace(/\.?0+$/, '') === '-0' ? '0' : text.replace(/\.?0+$/, '');
};

const colour = (ink: Ink): string => [1, 3, 5].map((i) => n(parseInt(INKS[ink].slice(i, i + 2), 16) / 255)).join(' ');

/** From the frame (down, in units) to the page (up, in points). */
interface Place {
  x: (value: number) => number;
  y: (value: number) => number;
  unit: number;
}
function placeOn(paper: Paper): Place {
  const { height, margin, unit } = PAPERS[paper];
  return { x: (value) => (margin + value * unit) * POINTS, y: (value) => (height - margin - value * unit) * POINTS, unit: unit * POINTS };
}

function text(op: TextOp, place: Place): string {
  // Tamil in English letters may be shorter than its room: that is not filled.
  const natural = textWidth(latin(op.text), op.face, op.size);
  const narrow = natural > op.width ? (op.width / natural) * 100 : 100;
  const at = `${op.up ? '0 1 -1 0' : '1 0 0 1'} ${n(place.x(op.x))} ${n(place.y(op.y))} Tm`;
  const show = `(${pdfString(op.text)}) Tj`;
  const font = `/${FONTS[op.face]} ${n(op.size * place.unit)} Tf ${n(narrow)} Tz`;
  const outline = op.outline ? `BT ${font} ${colour(op.outline.ink)} RG ${n(op.outline.weight * place.unit)} w 1 Tr ${at} ${show} 0 Tr ET\n` : '';
  return `${outline}BT ${font} ${colour(op.ink)} rg ${at} ${show} ET`;
}

const path = (d: readonly Segment[], { x, y }: Place): string =>
  d.map(([command, ...numbers]) => {
    const points = (numbers as number[]).map((value, i) => n(i % 2 === 0 ? x(value) : y(value))).join(' ');
    return command === 'Z' ? 'h' : `${points} ${command.toLowerCase()}`;
  }).join(' ');

function mark(op: Op, place: Place): string {
  if (op.kind === 'text') return text(op, place);
  const { x, y, unit } = place;
  if (op.kind === 'line') {
    const weight = op.weight * unit;
    const line = `${colour(op.ink)} RG ${n(weight)} w ${n(x(op.x1))} ${n(y(op.y1))} m ${n(x(op.x2))} ${n(y(op.y2))} l S`;
    return op.dotted ? `1 J [0 ${n(weight * 2.4)}] 0 d ${line} 0 J [] 0 d` : line;
  }
  const paint = op.fill && op.stroke ? 'B' : op.fill ? 'f' : 'S';
  const inks = `${op.fill ? `${colour(op.fill)} rg ` : ''}${op.stroke ? `${colour(op.stroke)} RG ${n((op.weight ?? 0) * unit)} w ` : ''}`;
  return op.round ? `1 J ${inks}${path(op.d, place)} ${paint} 0 J` : `${inks}${path(op.d, place)} ${paint}`;
}

export function sheetsToPdf(sheets: readonly Sheet[], title: string, paper: Paper = 'a4'): Uint8Array {
  if (sheets.length === 0) throw new Error('A PDF needs at least one page');
  const place = placeOn(paper);
  const box = `[0 0 ${n(PAPERS[paper].width * POINTS)} ${n(PAPERS[paper].height * POINTS)}]`;

  // 1 catalogue, 2 pages, 3 to 5 fonts, 6 information, then a page and its marks for each sheet.
  const first = 7;
  const font = (name: string): string => `<< /Type /Font /Subtype /Type1 /BaseFont /${name} /Encoding /WinAnsiEncoding >>`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${sheets.map((_, i) => `${first + i * 2} 0 R`).join(' ')}] /Count ${sheets.length} >>`,
    font('Helvetica'), font('Helvetica-Bold'), font('Times-BoldItalic'),
    `<< /Title (${pdfString(title)}) /Producer (StudFlow) >>`,
    ...sheets.flatMap((sheet, i) => {
      const marks = sheet.ops.map((op) => mark(op, place)).join('\n');
      return [
        `<< /Type /Page /Parent 2 0 R /MediaBox ${box} /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> /Contents ${first + i * 2 + 1} 0 R >>`,
        `<< /Length ${marks.length} >>\nstream\n${marks}\nendstream`,
      ];
    }),
  ];

  // Everything is ASCII, so a letter is a byte and the offsets can be counted on the text.
  let file = '%PDF-1.4\n';
  const offsets = objects.map((object, i) => {
    const offset = file.length;
    file += `${i + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const table = file.length;
  file += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  file += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${table}\n%%EOF\n`;
  return new TextEncoder().encode(file);
}
