// The drawn pages as SVG (screen, printer) and as PDF (Drive): the same marks, in both, and
// nothing a customer's name or an odd letter could break.
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Sheets } from '@/components/sheets';
import { latin } from '@/lib/latin';
import { PAPERS, Pen, type Sheet } from '@/lib/sheet';
import { sheetsToPdf } from '@/lib/sheet-pdf';

const page = (draw: (pen: Pen) => void, key = 'a'): Sheet => {
  const pen = new Pen();
  draw(pen);
  return { key, label: `Page ${key}`, ops: pen.ops };
};
const sample = page((pen) => {
  pen.box(0, 0, 100, 145.6, { r: 1.4, fill: 'tint' });
  pen.line(0, 10, 100, 10, { dotted: true });
  pen.text('INV/26-27/0001', 10, 20, { size: 2.6, face: 'bold', ink: 'red' });
  pen.text('M12 × 80 mm (a\\b) ₹5 “x” · ½', 10, 30, { size: 2 });
  pen.text('BANK DETAILS', 3, 60, { size: 1.6, up: true });
  pen.text('S', 50, 50, { size: 5, ink: 'white', outline: { ink: 'red', weight: 0.4 } });
  pen.text('ஸ்ரீ முருகன்', 10, 40, { size: 2 });
});

describe('letters the PDF’s own fonts do not have', () => {
  it('Tamil is written in English letters, never left out', () => {
    expect(latin('முருகன் பொறியியல்')).toBe('Murukan Poriyiyal');
    expect(latin('கோயம்புத்தூர்')).toBe('Koyampuththoor');
    expect(latin('ஸ்ரீ வெற்றிவேல் Engg')).toBe('Sree Verrivel Engg');
    expect(latin('அவசரம் 2')).toBe('Avacharam 2');
    expect(latin('அவசரம்')).toMatch(/^[A-Za-z]+$/);
  });

  it('signs become what they mean, and what nobody knows a question mark', () => {
    expect(latin('₹1,239.00')).toBe('Rs.1,239.00');
    expect(latin('M12 × 80 · ½ “ok” – 5°C ± 2µ')).toBe('M12 × 80 · ½ “ok” – 5°C ± 2µ');
    expect(latin('Müller Ńowak ≤ 5 → 6 − 7')).toBe('Müller Nowak <= 5 -> 6 - 7');
    expect(latin('漢字 हिन्दी 👍 x')).toBe('? ? ? x');
    expect(latin('a\u0000b\tc​d')).toBe('a b cd');
    expect(latin('ﬁt １２ ⅓ x⁴ Ⅳ ™')).toBe('fit 12 1/3 x4 IV ™'); // copied from elsewhere
    expect(latin('')).toBe('');
  });
});

const pdfText = (bytes: Uint8Array): string => Buffer.from(bytes).toString('latin1');
/** Every shown string, with its escapes undone. */
const shown = (pdf: string): string[] =>
  [...pdf.matchAll(/\(((?:[^()\\]|\\.)*)\) Tj/g)].map(([, text = '']) => text.replace(/\\(\d{3}|.)/g, (_, code: string) => (code.length === 3 ? String.fromCharCode(parseInt(code, 8)) : code)));

describe('the PDF', () => {
  const bytes = sheetsToPdf([sample, page((pen) => pen.text('second', 1, 1, { size: 2 }), 'b')], 'INV/26-27/0001 (copy)');
  const pdf = pdfText(bytes);

  it('is a whole file: every object is where the table says', () => {
    expect(pdf.startsWith('%PDF-1.4\n')).toBe(true);
    expect(pdf.endsWith('%%EOF\n')).toBe(true);
    const start = Number(/startxref\n(\d+)\n/.exec(pdf)?.[1]);
    expect(pdf.slice(start, start + 4)).toBe('xref');
    const [, count = '0'] = /xref\n0 (\d+)\n/.exec(pdf) ?? [];
    const rows = pdf.slice(start).split('\n').slice(2, 2 + Number(count));
    expect(rows[0]).toBe('0000000000 65535 f ');
    for (const [i, row] of rows.entries()) {
      if (i === 0) continue;
      expect(row).toMatch(/^\d{10} 00000 n $/);
      expect(pdf.slice(Number(row.slice(0, 10))).startsWith(`${i} 0 obj\n`), `object ${i}`).toBe(true);
    }
    for (const [, length = '', stream = ''] of pdf.matchAll(/\/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/g)) expect(stream.length).toBe(Number(length));
    expect(pdf).toMatch(/trailer\n<< \/Size \d+ \/Root 1 0 R \/Info \d+ 0 R >>/);
  });

  it('is A4, one page for each sheet, in fonts every reader has', () => {
    expect(pdf).toContain('/Count 2 >>');
    expect(pdf.match(/\/MediaBox \[0 0 595\.28 841\.89\]/g)).toHaveLength(2);
    for (const font of ['Helvetica', 'Helvetica-Bold', 'Times-BoldItalic']) expect(pdf).toContain(`/BaseFont /${font} /Encoding /WinAnsiEncoding`);
    expect(pdf).toContain('/Title (INV/26-27/0001 \\(copy\\))');
  });

  it('says every text, whatever is in it', () => {
    expect(shown(pdf)).toEqual(['INV/26-27/0001', 'M12 × 80 mm (a\\b) Rs.5 \u0093x\u0094 · ½', 'BANK DETAILS', 'S', 'S', 'Sree Murukan', 'second']);
    expect(/[^\x00-\x7f]/.test(pdf)).toBe(false);
  });

  it('squeezes a text into its room, but never pulls it apart', () => {
    const scales = [...pdf.matchAll(/ ([\d.]+) Tz /g)].map(([, scale]) => Number(scale));
    expect(scales.length).toBeGreaterThan(5);
    expect(Math.max(...scales)).toBe(100);
    const squeezed = pdfText(sheetsToPdf([page((pen) => pen.text('HSN CODE', 1, 1, { size: 2, face: 'bold', narrow: 0.84 }))], 'x'));
    expect(squeezed).toContain(' 84 Tz ');
  });

  it('keeps every mark on the page', () => {
    for (const [, x, y] of pdf.matchAll(/ (-?[\d.]+) (-?[\d.]+) Tm/g)) {
      expect(Number(x)).toBeGreaterThanOrEqual(0);
      expect(Number(x)).toBeLessThanOrEqual(595.28);
      expect(Number(y)).toBeGreaterThanOrEqual(0);
      expect(Number(y)).toBeLessThanOrEqual(841.89);
    }
    expect(pdf).not.toMatch(/NaN|undefined|Infinity|e-\d/);
  });

  it('is made the same every time', () => {
    expect(sheetsToPdf([sample], 'x')).toEqual(sheetsToPdf([sample], 'x'));
  });

  it('needs something to show', () => {
    expect(() => sheetsToPdf([], 'x')).toThrow();
  });
});

describe('the page for screen and printer', () => {
  const html = (paper: 'a4' | 'a5', sheets: Sheet[] = [sample]): string => renderToStaticMarkup(createElement(Sheets, { sheets, paper }));

  it('has one picture for each sheet, in the size of the paper, with its name', () => {
    const markup = html('a5', [sample, page((pen) => pen.text('second', 1, 1, { size: 2 }), 'b')]);
    expect(markup).toContain('<div class="packet" data-paper="a5">');
    expect(markup.match(/<article class="sheet">/g)).toHaveLength(2);
    expect(markup.match(/<svg[^>]* viewBox="0 0 1480 2100"/g)).toHaveLength(2);
    expect(markup).toContain('aria-label="Page b"');
    expect(html('a4')).toContain('viewBox="0 0 2100 2970"');
  });

  it('A5 is the same drawing, smaller', () => {
    const at = (markup: string): number[] => [...markup.matchAll(/<text x="([\d.]+)" y="([\d.]+)"/g)].flatMap(([, x, y]) => [Number(x), Number(y)]);
    const [a4, a5] = [at(html('a4')), at(html('a5'))];
    expect(a5).toHaveLength(a4.length);
    for (const [i, value] of a4.entries()) {
      const inFrame = (value - PAPERS.a4.margin * 10) / PAPERS.a4.unit;
      expect((a5[i]! - PAPERS.a5.margin * 10) / PAPERS.a5.unit).toBeCloseTo(inFrame, 0);
    }
  });

  it('a name with markup is text', () => {
    const markup = html('a4', [page((pen) => pen.text('<img src=x onerror=alert(1)> & "q"', 1, 1, { size: 2 }))]);
    expect(markup).not.toContain('<img');
    expect(markup).toContain('&lt;img src=x onerror=alert(1)&gt; &amp;');
  });

  it('tells every text its width, so that no font can run over', () => {
    const markup = html('a4');
    for (const [, attributes = '', text = ''] of markup.matchAll(/<text ([^>]*)>([^<]*)<\/text>/g)) {
      if ([...text].length > 1) expect(attributes, text).toMatch(/textLength="[\d.]+" lengthAdjust="spacingAndGlyphs"/);
    }
    expect(markup).toContain('transform="rotate(-90 ');
    expect(markup).not.toMatch(/NaN|undefined|Infinity/);
  });

  it('letters stand as they are, whatever the language', () => {
    expect(html('a4')).toContain('>ஸ்ரீ முருகன்</text>');
    expect(html('a4')).toContain('M12 × 80 mm (a\\b) ₹5 “x” · ½');
  });
});

describe('print stylesheet', () => {
  const read = (path: string): string => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  it('is the spec CSS, and each paper has exactly its page rule', () => {
    const blocks = [...read('specs/print-templates.md').matchAll(/```css\n([\s\S]*?)```/g)].map((match) => (match[1] ?? '').trim());
    expect(blocks).toHaveLength(3);
    const css = read('src/app/invoices/[id]/print/print.css');
    expect(css).toContain(blocks[0]);
    expect(css).not.toContain('@page {');
    const source = read('src/app/invoices/[id]/print/page.tsx');
    for (const block of blocks.slice(1)) expect(source).toContain(block.split('\n').at(-1));
  });
});
