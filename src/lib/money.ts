/**
 * Exact conversions between decimal strings and integer paise, and how they are shown.
 * Representation only: amounts are computed in billing-math.ts.
 */

/** '104.25' -> 10425. Null when it is not a plain amount with at most two decimals. */
export function parseRupees(text: string): number | null {
  const match = /^(\d{1,13})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!match) return null;
  const paise = Number(`${match[1] ?? ''}${(match[2] ?? '').padEnd(2, '0')}`);
  return Number.isSafeInteger(paise) ? paise : null;
}

/** 10425 -> '104.25'; -8 -> '-0.08' */
export function paiseToDecimal(paise: number): string {
  if (!Number.isSafeInteger(paise)) throw new RangeError('paise must be a safe integer');
  const digits = Math.abs(paise).toString().padStart(3, '0');
  return `${paise < 0 ? '-' : ''}${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

/** Any signed decimal from the database ('1770', '-0.40', '1770.00') -> paise. */
export function decimalToPaise(decimal: string): number {
  const negative = decimal.startsWith('-');
  const paise = parseRupees(negative ? decimal.slice(1) : decimal);
  if (paise === null) throw new RangeError('not a rupee amount');
  return negative && paise !== 0 ? -paise : paise;
}

/** Indian grouping: 123456789 (paise) -> '12,34,567.89' */
export function formatPaise(paise: number): string {
  const [whole = '0', decimals = '00'] = paiseToDecimal(Math.abs(paise)).split('.');
  const head = whole.slice(0, -3);
  const grouped = head ? `${head.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${whole.slice(-3)}` : whole;
  return `${paise < 0 ? '-' : ''}${grouped}.${decimals}`;
}

export const formatInr = (paise: number): string => `${paise < 0 ? '-' : ''}₹${formatPaise(Math.abs(paise))}`;

/** '12.500000' -> '12.5', '100.00' -> '100' */
export const trimZeros = (decimal: string): string =>
  decimal.includes('.') ? decimal.replace(/0+$/, '').replace(/\.$/, '') : decimal;

const ONES = [
  '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
  'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen',
] as const;
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'] as const;

function twoDigits(n: number): string {
  if (n < 20) return ONES[n] ?? '';
  const ones = ONES[n % 10] ?? '';
  return `${TENS[Math.floor(n / 10)] ?? ''}${ones ? `-${ones}` : ''}`;
}

/** Lakh/crore grouping; crores recurse, so any safe integer reads correctly. */
function wholeInWords(n: number): string {
  const parts: string[] = [];
  const crore = Math.floor(n / 1_00_00_000);
  const lakh = Math.floor((n % 1_00_00_000) / 1_00_000);
  const thousand = Math.floor((n % 1_00_000) / 1_000);
  const hundred = Math.floor((n % 1_000) / 100);
  const rest = n % 100;
  if (crore) parts.push(`${wholeInWords(crore)} Crore`);
  if (lakh) parts.push(`${twoDigits(lakh)} Lakh`);
  if (thousand) parts.push(`${twoDigits(thousand)} Thousand`);
  if (hundred) parts.push(`${ONES[hundred] ?? ''} Hundred`);
  if (rest) parts.push(twoDigits(rest));
  return parts.join(' ');
}

/** 12345600 -> 'Rupees One Lakh Twenty-Three Thousand Four Hundred Fifty-Six Only' */
export function rupeesInWords(paise: number): string {
  if (!Number.isSafeInteger(paise) || paise < 0) throw new RangeError('amount in words needs non-negative whole paise');
  const rupees = Math.floor(paise / 100);
  const rest = paise % 100;
  const whole = rupees === 0 ? 'Zero' : wholeInWords(rupees);
  return `Rupees ${whole}${rest ? ` and ${twoDigits(rest)} Paise` : ''} Only`;
}
