/** How names, greetings and sums are shown on the screens. Representation only. Pure. */
import { istDate, monthName } from './india';
import { decimalToPaise, formatRupees } from './money';

/** Two letters that stand for a name, as on a name plate. */
export function initials(name: string): string {
  const words = name.split(/\s+/).map((word) => /[\p{L}\p{N}]/u.exec(word)?.[0] ?? '').filter(Boolean);
  return words.slice(0, 2).join('').toUpperCase() || ([...name.trim()][0] ?? '?');
}

/** By the clock on the wall in India. */
export function greeting(now: Date): string {
  const hour = new Date(now.getTime() + 330 * 60_000).getUTCHours();
  return hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

/** 'Wednesday, 25 November 2026' */
export function longDate(now: Date): string {
  const day = istDate(now);
  return `${WEEKDAYS[new Date(`${day}T00:00:00Z`).getUTCDay()] ?? ''}, ${Number(day.slice(8))} ${monthName(day)}`;
}

const LAKH = 10_000_000; // in paise
const CRORE = 100 * LAKH;

/** For a chart only: '₹6.84 L', '₹12.35 Cr'. */
export function shortRupees(paise: number): string {
  if (paise >= CRORE) return `₹${Number((paise / CRORE).toFixed(2))} Cr`;
  if (paise >= LAKH) return `₹${Number((paise / LAKH).toFixed(2))} L`;
  return formatRupees(Math.round(paise / 100) * 100);
}

/** The next 1, 2, 4, 8 or 10 times a power of ten: four steps divide it into round figures. */
function roundTop(most: number): number {
  let power = 100_000; // ₹1,000
  while (power * 10 < most) power *= 10;
  return ([1, 2, 4, 8].find((step) => step * power >= most) ?? 10) * power;
}

export interface SalesBars {
  top: number;
  ticks: { at: number; text: string }[];
  /** `share` of the full height. */
  bars: { name: string; share: number; text: string; title: string }[];
  label: string;
}

export function salesBars(months: readonly { month: string; total: string }[]): SalesBars {
  const sums = months.map(({ month, total }) => ({ month, paise: decimalToPaise(total) }));
  const top = roundTop(Math.max(0, ...sums.map(({ paise }) => paise)));
  const word = (month: string): string => monthName(month).split(' ')[0] ?? '';
  return {
    top,
    ticks: [0, 0.25, 0.5, 0.75, 1].map((at) => ({ at, text: at === 0 ? '0' : shortRupees(top * at) })),
    bars: sums.map(({ month, paise }) => ({ name: word(month).slice(0, 3), share: paise / top, text: shortRupees(paise), title: `${monthName(month)}: ${formatRupees(paise)}` })),
    label: `Sales by month: ${sums.map(({ month, paise }) => `${word(month)} ${formatRupees(paise)}`).join(', ')}`,
  };
}
