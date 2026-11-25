/**
 * Could these two be the same business? Never an answer, only a reason to ask the owner: the
 * same rules on the server and over this PC's copy. Pure.
 */

/** Words that say what kind of firm it is, not which one. */
const LEGAL_FORM = new Set(['PVT', 'PRIVATE', 'LTD', 'LIMITED', 'LLP', 'CO', 'COMPANY', 'THE', 'AND']);

/** One spelling for words people write in several ways. */
const SPELLINGS: Readonly<Record<string, string>> = {
  SHRI: 'SRI', SHREE: 'SRI', SREE: 'SRI',
  ENGG: 'ENGINEERING', ENGINEERS: 'ENGINEERING', ENGINEER: 'ENGINEERING', WORK: 'WORKS',
  FABRICATORS: 'FABRICATION', FABRICATOR: 'FABRICATION', FABRICATIONS: 'FABRICATION',
  INDUSTRY: 'INDUSTRIES', INDS: 'INDUSTRIES', ENTERPRISE: 'ENTERPRISES', TRADER: 'TRADERS', TRADING: 'TRADERS', FASTENER: 'FASTENERS', TOOL: 'TOOLS',
};

function words(name: string): string[] {
  const all = name
    .normalize('NFKC')
    .toUpperCase()
    .replace(/^\s*(M\/S\.?|MESSRS\.?)\s+/, '')
    .replace(/\(\s*P\s*\)/g, ' ')
    .replace(/&/g, ' AND ')
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ') // marks too: Tamil vowel signs are part of the word
    .split(' ')
    .filter(Boolean);
  const kept = all.filter((word) => !LEGAL_FORM.has(word));
  return kept.length > 0 ? kept : all;
}

/** For comparing by sound: 'M/s Vel Tool (P) Ltd' and 'VEL TOOLS' are both VELTOOLS. */
export const nameKey = (name: string): string => words(name).map((word) => SPELLINGS[word] ?? word).join('');

/** The same name but for punctuation, capitals and legal form. */
export const sameName = (a: string, b: string): boolean => words(a).join('') === words(b).join('');

/** Letters to add, drop or change to turn one into the other; stops counting past `limit`. */
function distance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const next = [i];
    for (let j = 1; j <= b.length; j += 1) {
      next.push(Math.min((row[j] ?? 0) + 1, (next[j - 1] ?? 0) + 1, (row[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1)));
    }
    row = next;
    if (Math.min(...row) > limit) return limit + 1;
  }
  return row[b.length] ?? limit + 1;
}

function soundsAlike(a: string, b: string): boolean {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short === long) return true;
  if (short.length >= 5 && long.startsWith(short)) return true; // 'Murugan' and 'Murugan Engineering Works'
  const slips = short.length >= 12 ? 2 : short.length >= 6 ? 1 : 0;
  return slips > 0 && distance(short, long, slips) <= slips;
}

const lastTen = (phone: string | null): string | null => {
  const digits = (phone ?? '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
};

/** Who the owner should look at before this becomes a new customer. `different`: ids already ruled out. */
export function lookAlikes<T extends { id: string; name: string; phone: string | null }>(
  typed: { name: string; phone: string | null },
  known: readonly T[],
  different: readonly string[] = [],
): T[] {
  const key = nameKey(typed.name);
  const phone = lastTen(typed.phone);
  return known.filter((one) => !different.includes(one.id) && (soundsAlike(key, nameKey(one.name)) || (phone !== null && phone === lastTen(one.phone))));
}
