// Measuring and drawing for the printed bill (specs/own-bill.md). Pure.
import { describe, expect, it } from 'vitest';
import { GEAR, VEL } from '@/lib/bill-art';
import { FRAME, INKS, PAPERS, Pen, type Op, type PathOp } from '@/lib/sheet';
import { textWidth, wrap } from '@/lib/text-width';

describe('how wide a text is', () => {
  it('has the widths of Helvetica, which are those of Arial', () => {
    expect(textWidth('0123456789', 'regular', 1)).toBeCloseTo(5.56, 6);
    expect(textWidth('Rupees', 'bold', 1)).toBeCloseTo(3.612, 6); // 722 + 611 + 611 + 3 × 556
    expect(textWidth('Products', 'script', 1)).toBeCloseTo(3.667, 6);
    expect(textWidth('M12 × 80 mm · ½”', 'regular', 10)).toBeCloseTo(83.64, 6);
    expect(textWidth('', 'bold', 9)).toBe(0);
    expect(textWidth('Müller', 'regular', 1)).toBe(textWidth('Muller', 'regular', 1));
  });

  it('comes close for Tamil, where the letters are the browser’s', () => {
    // Measured with Nirmala UI, the Tamil of Windows.
    for (const [text, measured] of [['முருகன் பொறியியல்', 11.51], ['கோயம்புத்தூர்', 8.11], ['ஸ்ரீ வெற்றிவேல் இன்ஜினியரிங்', 16.64], ['சேலம் ஸ்டீல்ஸ்', 8.39], ['அவசரம்', 4.66]] as const) {
      expect(textWidth(text, 'regular', 1) / measured, text).toBeGreaterThan(0.9);
      expect(textWidth(text, 'regular', 1) / measured, text).toBeLessThan(1.12);
    }
    expect(textWidth('漢', 'regular', 1)).toBeGreaterThan(0.5);
    expect(textWidth('á', 'regular', 1)).toBeCloseTo(textWidth('á', 'regular', 1), 1);
  });
});

describe('breaking a text into lines', () => {
  const squash = (text: string): string => text.replace(/\s+/g, '');
  it('keeps every letter and every line inside', () => {
    for (const text of [
      'SS 316 double-end stud with collar, hot-dip galvanised, M24 × 480 mm, thread length 60 mm at each end as per drawing VPC-1202',
      'Plot 88, KIADB Phase 2,\nTumakuru Road,\r\nNelamangala', 'x'.repeat(300), `A ${'y'.repeat(90)} B`, '  spaces   inside  ', 'முருகன் பொறியியல் கோயம்புத்தூர்',
    ]) {
      const lines = wrap(text, 'regular', 2.1, 36);
      expect(squash(lines.join('')), text).toBe(squash(text));
      for (const line of lines) {
        expect(textWidth(line, 'regular', 2.1), line).toBeLessThanOrEqual(36);
        expect(line).toBe(line.trim());
        expect(line).not.toBe('');
      }
    }
  });

  it('breaks between words, and starts a new line where one was typed', () => {
    expect(wrap('one two three', 'regular', 1, textWidth('one two', 'regular', 1))).toEqual(['one two', 'three']);
    expect(wrap('12 SIDCO\nCoimbatore', 'regular', 1, 100)).toEqual(['12 SIDCO', 'Coimbatore']);
    expect(wrap('12 SIDCO,\n\n  Coimbatore ', 'regular', 1, 100)).toEqual(['12 SIDCO,', 'Coimbatore']);
    expect(wrap('', 'regular', 1, 100)).toEqual([]);
    expect(wrap('   \n ', 'regular', 1, 100)).toEqual([]);
  });

  it('can leave room for a name at the start of the first line', () => {
    const width = textWidth('one two', 'regular', 1);
    expect(wrap('one two three', 'regular', 1, width, textWidth('two', 'regular', 1))).toEqual(['one', 'two', 'three']);
    expect(wrap('one two', 'regular', 1, width, 0.1)).toEqual(['one', 'two']);
  });

  it('never loops on a letter that is wider than the line', () => {
    expect(wrap('WWW', 'bold', 10, 1)).toEqual(['W', 'W', 'W']);
  });

  it('does not split a letter from its signs', () => {
    for (const line of wrap('பொறியியல்'.repeat(6), 'regular', 2, 12)) expect(line, line).not.toMatch(/^\p{M}/u);
    expect(wrap('👍'.repeat(30), 'regular', 2, 12).join('')).toBe('👍'.repeat(30));
  });
});

describe('the pen', () => {
  it('puts a text left, right or in the middle', () => {
    const pen = new Pen();
    const width = textWidth('12.50', 'regular', 2);
    expect(pen.text('12.50', 10, 5, { size: 2 })).toMatchObject({ x: 10, y: 5, width, size: 2, face: 'regular', ink: 'black' });
    expect(pen.text('12.50', 10, 5, { size: 2, align: 'right' })?.x).toBeCloseTo(10 - width, 9);
    expect(pen.text('12.50', 10, 5, { size: 2, align: 'center' })?.x).toBeCloseTo(10 - width / 2, 9);
    expect(pen.ops).toHaveLength(3);
  });

  it('leaves out what is empty, and tidies spaces', () => {
    const pen = new Pen();
    expect(pen.text('  ', 1, 1, { size: 2 })).toBeNull();
    expect(pen.ops).toEqual([]);
    expect(pen.text(' a\n b ', 1, 1, { size: 2 })?.text).toBe('a b');
  });

  it('keeps a text inside its room: smaller first, then narrower, never cut', () => {
    const pen = new Pen();
    const roomy = pen.text('1,174.00', 0, 0, { size: 2.1, max: 12 });
    expect(roomy).toMatchObject({ size: 2.1 });
    const tight = pen.text('12,03,72,319', 0, 0, { size: 2.1, max: 10 })!;
    expect(tight.width).toBeLessThanOrEqual(10);
    expect(tight.size).toBeLessThan(2.1);
    expect(tight.size).toBeGreaterThanOrEqual(2.1 * 0.7);
    const long = pen.text('x'.repeat(120), 0, 0, { size: 2, max: 20, align: 'right' })!;
    expect(long).toMatchObject({ text: 'x'.repeat(120), width: 20, x: -20 });
    expect(long.size).toBeCloseTo(1.4, 9);
  });

  it('can set a heading narrower than its letters are', () => {
    const op = new Pen().text('HSN CODE', 0, 0, { size: 2, face: 'bold', narrow: 0.84 })!;
    expect(op.width).toBeCloseTo(textWidth('HSN CODE', 'bold', 2) * 0.84, 9);
  });

  it('draws a box that closes, with only the corners that are round', () => {
    const pen = new Pen();
    pen.box(1, 2, 10, 5, { r: [1, 0, 2, 0], fill: 'tint' });
    const [op] = pen.ops as [PathOp];
    expect(op).toMatchObject({ kind: 'path', fill: 'tint', stroke: 'ink' });
    expect(op.d.map(([command]) => command).join('')).toBe('MLLCLLCZ');
    const numbers = op.d.flatMap(([, ...rest]) => rest as number[]);
    expect(Math.min(...numbers.filter((_, i) => i % 2 === 0))).toBe(1);
    expect(Math.max(...numbers.filter((_, i) => i % 2 === 0))).toBe(11);
    expect(Math.min(...numbers.filter((_, i) => i % 2 === 1))).toBe(2);
    expect(Math.max(...numbers.filter((_, i) => i % 2 === 1))).toBe(7);
    pen.box(0, 0, 4, 4);
    expect((pen.ops[1] as PathOp).d.map(([command]) => command).join('')).toBe('MLLLZ');
  });

  it('places a drawing in the size that is asked for', () => {
    for (const art of [GEAR, VEL]) {
      const pen = new Pen();
      pen.place(art, 20, 30, 11);
      const k = 11 / art.width;
      for (const op of pen.ops) {
        if (op.kind !== 'path') continue;
        for (const [, ...numbers] of op.d) {
          for (let i = 0; i < numbers.length; i += 2) {
            expect(numbers[i]!).toBeGreaterThanOrEqual(20 - 0.01);
            expect(numbers[i]!).toBeLessThanOrEqual(31 + 0.01);
            expect(numbers[i + 1]!).toBeGreaterThanOrEqual(30 - 0.01);
            expect(numbers[i + 1]!).toBeLessThanOrEqual(30 + art.height * k + 0.01);
          }
        }
      }
    }
    const letters = (art: { ops: readonly Op[] }) => art.ops.flatMap((op) => (op.kind === 'text' ? [op.text] : [])).join('');
    expect(letters(GEAR)).toBe('SVEPV');
    expect(letters(VEL)).toBe('');
  });
});

describe('the papers', () => {
  it('hold the frame inside their margins', () => {
    for (const paper of Object.values(PAPERS)) {
      expect(FRAME.width * paper.unit + 2 * paper.margin).toBeCloseTo(paper.width, 9);
      expect(FRAME.height * paper.unit + 2 * paper.margin).toBeLessThanOrEqual(paper.height);
    }
  });

  it('every ink is dark enough to read on white, or only a tint behind text', () => {
    const luminance = (hex: string): number => {
      const [r, g, b] = [1, 3, 5].map((i) => {
        const c = parseInt(hex.slice(i, i + 2), 16) / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      }) as [number, number, number];
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const contrast = (a: string, b: string): number => {
      const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
      return (high + 0.05) / (low + 0.05);
    };
    for (const ink of ['ink', 'red', 'black', 'grey'] as const) expect(contrast(INKS[ink], '#ffffff'), ink).toBeGreaterThan(4.5);
    expect(contrast(INKS.ink, INKS.tint)).toBeGreaterThan(4.5); // headings on their tint
    for (const ink of ['ink', 'black', 'grey'] as const) expect(contrast(INKS[ink], INKS.vel), ink).toBeGreaterThan(4.5); // the Vel is behind the rows
  });
});
