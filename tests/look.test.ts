// The words and shapes of the screens (specs/new-look.md). Pure.
import { describe, expect, it } from 'vitest';
import { billState } from '@/lib/bill-state';
import { lastMonths } from '@/lib/india';
import { greeting, initials, longDate, salesBars, shortRupees } from '@/lib/look';
import { formatRupees, rateText } from '@/lib/money';

const TODAY = '2026-11-25';
const open = (due_date: string, payment_status: 'unpaid' | 'partial' | 'paid' = 'unpaid', cancelled = false) => billState({ due_date, payment_status, cancelled }, TODAY);

describe('the state of a bill, in words', () => {
  it.each([
    ['2026-11-25', { kind: 'due', text: 'Due today' }],
    ['2026-11-26', { kind: 'due', text: 'Due tomorrow' }],
    ['2026-12-25', { kind: 'due', text: 'Due in 30 days' }],
    ['2026-11-24', { kind: 'late', text: '1 day late' }],
    ['2026-11-04', { kind: 'late', text: '21 days late' }],
    ['2025-11-25', { kind: 'late', text: '365 days late' }],
  ])('due %s', (due, state) => {
    expect(open(due)).toEqual(state);
  });

  it('late comes before part paid, and paid and cancelled before both', () => {
    expect(open('2026-12-01', 'partial')).toEqual({ kind: 'part', text: 'Part paid' });
    expect(open('2026-11-20', 'partial')).toEqual({ kind: 'late', text: '5 days late' });
    expect(open('2026-11-20', 'paid')).toEqual({ kind: 'paid', text: 'Paid' });
    expect(open('2026-11-20', 'unpaid', true)).toEqual({ kind: 'off', text: 'Cancelled' });
  });
});

describe('the two letters of a name', () => {
  it.each([
    ['Kongu Pump Works', 'KP'], ['annai tools', 'AT'], ['Vel', 'V'], ['  Sri   Balaji Fabricators ', 'SB'], ['M/s. Kongu', 'MK'], ['3M India', '3I'],
    ['(New) Star Co', 'NS'], ['முருகன் டூல்ஸ்', 'மட'], ['–', '–'], ['', '?'],
  ])('%j → %s', (name, letters) => {
    expect(initials(name)).toBe(letters);
  });
});

describe('the greeting', () => {
  it.each([['2026-11-25T00:30:00Z', 'Good morning'], ['2026-11-25T06:29:00Z', 'Good morning'], ['2026-11-25T06:30:00Z', 'Good afternoon'], ['2026-11-25T11:30:00Z', 'Good evening'], ['2026-11-25T20:00:00Z', 'Good morning']])('at %s is the Indian one', (at, words) => {
    expect(greeting(new Date(at))).toBe(words);
  });
});

describe('amounts on cards', () => {
  it('drop only .00', () => {
    expect([0, 100, 4273000, 31248050, 99999999999].map(formatRupees)).toEqual(['₹0', '₹1', '₹42,730', '₹3,12,480.50', '₹99,99,99,999.99']);
    expect(formatRupees(-4273000)).toBe('-₹42,730');
  });

  it('rates have two decimals, or more when they need them', () => {
    expect(['116.5000', '3.1', '58', '0.125000', '1000.00', '0'].map(rateText)).toEqual(['116.50', '3.10', '58.00', '0.125', '1000.00', '0.00']);
  });

  it('are short on a chart', () => {
    expect([0, 95000, 9999900, 10000000, 68421500, 1000000000, 12345678900].map(shortRupees)).toEqual(['₹0', '₹950', '₹99,999', '₹1 L', '₹6.84 L', '₹1 Cr', '₹12.35 Cr']);
  });
});

describe('sales of six months', () => {
  const months = (...totals: string[]) => totals.map((total, i) => ({ month: `2026-0${i + 4}-01`, total }));

  it('stand on zero and reach to a round top', () => {
    const { top, ticks, bars } = salesBars(months('412000.00', '536000.00', '0.00', '621000.00', '610870.00', '684215.00'));
    expect(top).toBe(80000000);
    expect(ticks.map(({ text }) => text)).toEqual(['0', '₹2 L', '₹4 L', '₹6 L', '₹8 L']);
    expect(bars.map(({ name }) => name)).toEqual(['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep']);
    expect(bars.map(({ share }) => Number(share.toFixed(3)))).toEqual([0.515, 0.67, 0, 0.776, 0.764, 0.855]);
    expect(bars.at(-1)).toMatchObject({ text: '₹6.84 L', title: 'September 2026: ₹6,84,215' });
  });

  it.each([['0.00', 100000], ['0.01', 100000], ['999.00', 100000], ['1000.00', 100000], ['1001.00', 200000], ['2500.00', 400000], ['4100.00', 800000], ['8100.00', 1000000], ['99999999.99', 10000000000]])('a best month of %s has the top %d', (total, top) => {
    const drawn = salesBars(months('0.00', '0.00', '0.00', '0.00', '0.00', total));
    expect(drawn.top).toBe(top);
    for (const { share } of drawn.bars) expect(share).toBeGreaterThanOrEqual(0);
    for (const { share } of drawn.bars) expect(share).toBeLessThanOrEqual(1);
  });

  it('say the figures to somebody who cannot see them', () => {
    expect(salesBars(months('0.00', '0.00', '0.00', '0.00', '0.00', '1770.00')).label).toBe('Sales by month: April ₹0, May ₹0, June ₹0, July ₹0, August ₹0, September ₹1,770');
  });
});

describe('days and months', () => {
  it('the months before, across the year', () => {
    expect(lastMonths('2027-02-28', 4)).toEqual(['2027-02', '2027-01', '2026-12', '2026-11']);
    expect(lastMonths('2026-12-01', 2)).toEqual(['2026-12', '2026-11']);
  });

  it('the long date is the Indian one', () => {
    expect(longDate(new Date('2026-11-24T18:29:00Z'))).toBe('Tuesday, 24 November 2026');
    expect(longDate(new Date('2026-11-24T18:30:00Z'))).toBe('Wednesday, 25 November 2026');
  });
});
