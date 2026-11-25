/**
 * A PDF's own fonts know the letters of Western Europe. For everything else there is the nearest
 * that can be read: Tamil in English letters, ₹ as Rs. Pure.
 */

/** The letters of WinAnsi that do not stand at their own number. */
const PLACED: Readonly<Record<string, number>> = {
  '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, 'ˆ': 0x88, '‰': 0x89, 'Š': 0x8a, '‹': 0x8b, 'Œ': 0x8c, 'Ž': 0x8e,
  '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '˜': 0x98, '™': 0x99, 'š': 0x9a, '›': 0x9b, 'œ': 0x9c, 'ž': 0x9e, 'Ÿ': 0x9f,
};

function winAnsi(char: string): number | null {
  const code = char.codePointAt(0) ?? 0;
  if ((code >= 0x20 && code < 0x7f) || (code >= 0xa1 && code <= 0xff)) return code;
  return PLACED[char] ?? null;
}

const MEANS: Readonly<Record<string, string>> = {
  '₹': 'Rs.', '≤': '<=', '≥': '>=', '≠': '!=', '≈': '~', '→': '->', '←': '<-', '′': "'", '″': '"', 'μ': 'µ', '⌀': 'Ø', '∅': 'Ø',
  ' ': ' ', '‐': '-', '‑': '-', '―': '-', '−': '-', '⁄': '/',
};
const UNKNOWN = '�';

/** The same letter in a plainer form (ﬁ, １, ⅓, Ń), or what the sign means. */
const plainer = (char: string): string =>
  [...char.normalize('NFKD').replace(/\p{M}/gu, '')].map((part) => (winAnsi(part) === null ? MEANS[part] ?? UNKNOWN : part)).join('');

const CONSONANT: Readonly<Record<string, string>> = {
  க: 'k', ங: 'ng', ச: 'ch', ஞ: 'nj', ட: 't', ண: 'n', த: 'th', ந: 'n', ப: 'p', ம: 'm', ய: 'y', ர: 'r', ல: 'l', வ: 'v', ழ: 'zh', ள: 'l', ற: 'r', ன: 'n',
  ஜ: 'j', ஶ: 'sh', ஷ: 'sh', ஸ: 's', ஹ: 'h',
};
const VOWEL: Readonly<Record<string, string>> = {
  அ: 'a', ஆ: 'aa', இ: 'i', ஈ: 'ee', உ: 'u', ஊ: 'oo', எ: 'e', ஏ: 'e', ஐ: 'ai', ஒ: 'o', ஓ: 'o', ஔ: 'au', ஃ: 'h',
};
/** After a consonant, instead of the a it has by itself. */
const SIGN: Readonly<Record<string, string>> = {
  'ா': 'aa', 'ி': 'i', 'ீ': 'ee', 'ு': 'u', 'ூ': 'oo', 'ெ': 'e', 'ே': 'e', 'ை': 'ai', 'ொ': 'o', 'ோ': 'o', 'ௌ': 'au', '்': '',
};

function tamil(word: string): string {
  let out = '';
  for (let i = 0; i < word.length; i += 1) {
    const char = word.charAt(i);
    const consonant = CONSONANT[char];
    if (consonant === undefined) {
      const code = char.charCodeAt(0);
      out += VOWEL[char] ?? (code >= 0x0be6 && code <= 0x0bef ? String(code - 0x0be6) : '');
      continue;
    }
    const sign = SIGN[word.charAt(i + 1)];
    out += consonant + (sign ?? 'a');
    if (sign !== undefined) i += 1;
  }
  return out.charAt(0).toUpperCase() + out.slice(1);
}

export function latin(text: string): string {
  return text
    .normalize('NFC')
    .replace(/\p{Cf}/gu, '')
    .replace(/[஀-௿]+/g, tamil)
    .replace(/\p{Cc}/gu, ' ')
    .replace(/[\s\S]/gu, (char) => (winAnsi(char) === null ? MEANS[char] ?? plainer(char) : char))
    .replace(/�+/g, '?');
}

/** The text as it stands between the brackets of a PDF string: plain ASCII, whatever is in it. */
export const pdfString = (text: string): string =>
  [...latin(text)]
    .map((char) => {
      const code = winAnsi(char) ?? 0x3f;
      if (char === '(' || char === ')' || char === '\\') return `\\${char}`;
      return code < 0x7f ? char : `\\${code.toString(8).padStart(3, '0')}`;
    })
    .join('');
