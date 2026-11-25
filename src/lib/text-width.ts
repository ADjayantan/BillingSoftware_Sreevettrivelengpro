/**
 * How wide a text is on the bill. Arial has the widths of Helvetica, so one table serves the
 * printer (Arial) and the PDF (Helvetica, which every reader has). Pure.
 */
export type Face = 'regular' | 'bold' | 'script';

/** From the space (32) to the tilde (126), in thousandths of the letter size. */
const ASCII: Readonly<Record<Face, readonly number[]>> = {
  regular: [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
    1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
    333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
  ],
  bold: [
    278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
    975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
    333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
  ],
  /** Times Bold Italic, for the name above the signature. */
  script: [
    250, 389, 555, 500, 500, 833, 778, 278, 333, 333, 500, 570, 250, 333, 250, 278, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 333, 333, 570, 570, 570, 500,
    832, 667, 667, 667, 722, 667, 667, 722, 778, 389, 500, 667, 611, 889, 722, 722, 611, 722, 667, 556, 611, 722, 667, 889, 667, 611, 611, 333, 278, 333, 570, 500,
    333, 500, 500, 444, 500, 444, 333, 500, 556, 278, 278, 500, 278, 778, 556, 500, 500, 500, 389, 389, 278, 556, 444, 667, 500, 444, 389, 348, 220, 348, 570,
  ],
};

const SIGNS: Readonly<Record<string, number>> = {
  ' ': 278, '×': 584, '÷': 549, '±': 549, '·': 333, '•': 350, '–': 556, '—': 1000, '…': 1000, '™': 1000, '‘': 278, '’': 278, '“': 500, '”': 500,
  '°': 400, '½': 834, '¼': 834, '¾': 834, '²': 333, '³': 333, 'µ': 576, 'Ø': 778, 'ø': 611, '₹': 556, '§': 556, '€': 556,
};

/** Letters the bill's own fonts do not have come from another font: near enough, as every piece of text is told its width. */
function elsewhere(char: string): number {
  if (/\p{M}/u.test(char)) return /\p{Mc}/u.test(char) ? 500 : /[஀-௿]/.test(char) ? 100 : 0;
  if (/\p{Cf}|\p{Cc}/u.test(char)) return 0;
  if (/[஀-௿ഀ-ൿ]/.test(char)) return 930; // Tamil, Malayalam
  return /[ऀ-෿]/.test(char) ? 700 : 900;
}

const known = new Map<string, number>();

function letterWidth(char: string, face: Face): number {
  const ascii = ASCII[face][char.charCodeAt(0) - 32];
  if (ascii !== undefined) return ascii;
  const key = face + char;
  let width = known.get(key);
  if (width === undefined) {
    const base = char.normalize('NFD').charAt(0);
    const plain = base === char ? undefined : ASCII[face][base.charCodeAt(0) - 32];
    width = SIGNS[char] ?? plain ?? elsewhere(char);
    if (known.size < 2000) known.set(key, width);
  }
  return width;
}

export function textWidth(text: string, face: Face, size: number): number {
  let total = 0;
  for (const char of text) total += letterWidth(char, face);
  return (total * size) / 1000;
}

/** The letters of a word, each with its signs: பொ is one. */
const letters = (word: string): string[] => word.match(/[\s\S]\p{M}*/gu) ?? [];

/** Lines of at most `width` (the first one shorter by `indent`), broken between words and where a line break was typed. */
export function wrap(text: string, face: Face, size: number, width: number, indent = 0): string[] {
  const lines: string[] = [];
  const fits = (line: string): boolean => textWidth(line, face, size) <= width - (lines.length === 0 ? indent : 0);
  for (const typed of text.split(/[\r\n]+/)) {
    let line = '';
    for (const word of typed.split(/[\s\p{Cc}]+/u).filter(Boolean)) {
      const longer = line === '' ? word : `${line} ${word}`;
      if (fits(longer)) {
        line = longer;
        continue;
      }
      if (line !== '') lines.push(line);
      line = '';
      for (const letter of letters(word)) {
        if (line !== '' && !fits(line + letter)) {
          lines.push(line);
          line = '';
        }
        line += letter;
      }
    }
    if (line !== '') lines.push(line);
  }
  return lines;
}
