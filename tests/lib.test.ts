import { describe, expect, it } from 'vitest';
import { calculateInvoiceDetail } from '@/lib/billing-math';
import { addDays, daysBetween, formatDate, formatPhone, isMobile, istDate, isValidGstin, shortDate } from '@/lib/india';
import { decimalToPaise, formatInr, paiseToDecimal, parseRupees, rupeesInWords, trimZeros } from '@/lib/money';
import { parsePublicEnv } from '@/lib/schemas/public-env';
import { invoiceSummaryText, reminderStage, reminderText, whatsappDrafts, whatsappLink } from '@/lib/whatsapp';

describe('money', () => {
  it.each([['104.25', 10425], ['0', 0], ['7', 700], ['1.5', 150], ['', null], ['1.005', null], ['-1', null], ['1e3', null], ['1,000', null], ['.5', null]])(
    'parses %j as %j paise', (text, paise) => expect(parseRupees(text)).toBe(paise));
  it('round-trips signed decimals', () => {
    expect(paiseToDecimal(-8)).toBe('-0.08');
    expect(decimalToPaise('-0.40')).toBe(-40);
    expect(Object.is(decimalToPaise('-0.00'), 0)).toBe(true);
    expect(trimZeros('12.500000')).toBe('12.5');
    expect(trimZeros('100')).toBe('100');
  });
  it.each([[0, '₹0.00'], [99_999, '₹999.99'], [10_000_000, '₹1,00,000.00'], [1_234_567_890, '₹1,23,45,678.90'], [-40, '-₹0.40']])(
    'groups %i paise the Indian way', (paise, text) => expect(formatInr(paise)).toBe(text));
  it.each([
    [0, 'Rupees Zero Only'],
    [12_345_600, 'Rupees One Lakh Twenty-Three Thousand Four Hundred Fifty-Six Only'],
    [500_050, 'Rupees Five Thousand and Fifty Paise Only'],
    [123_900, 'Rupees One Thousand Two Hundred Thirty-Nine Only'],
    [1_234_567_890, 'Rupees One Crore Twenty-Three Lakh Forty-Five Thousand Six Hundred Seventy-Eight and Ninety Paise Only'],
    [10_000_000_000_00, 'Rupees One Thousand Crore Only'],
    [1_100, 'Rupees Eleven Only'],
    [5, 'Rupees Zero and Five Paise Only'],
  ])('spells %i paise', (paise, words) => expect(rupeesInWords(paise)).toBe(words));
});

describe('India facts', () => {
  it('validates GSTINs like the database does', () => {
    expect(isValidGstin('27AAPFU0939F1ZV')).toBe(true);
    expect(isValidGstin('27AAPFU0939F1ZO')).toBe(false);
    expect(isValidGstin('')).toBe(false);
  });
  it('uses IST calendar dates', () => {
    expect(istDate(new Date('2027-03-31T18:29:59Z'))).toBe('2027-03-31');
    expect(istDate(new Date('2027-03-31T18:30:00Z'))).toBe('2027-04-01');
    expect(addDays('2028-02-28', 2)).toBe('2028-03-01');
    expect(daysBetween('2026-11-20', '2026-12-05')).toBe(15);
    expect(formatDate('2026-11-03')).toBe('3 Nov 2026');
    expect(shortDate('2026-11-03')).toBe('03.11.26');
  });
  it('writes a mobile number as it is read, and leaves others alone', () => {
    expect(formatPhone('9876543210')).toBe('98765 43210');
    expect(formatPhone('+919876543210')).toBe('+91 98765 43210');
    expect([isMobile('9876543210'), isMobile('+919876543210')]).toEqual([true, true]);
    for (const other of ['04221234567', '08022223333', '+14155550100', '1234567890']) {
      expect(formatPhone(other)).toBe(other);
      expect(isMobile(other)).toBe(false);
    }
  });
});

describe('per-line GST', () => {
  it('always adds up to the bucket-rounded invoice GST', () => {
    const line = { billing_unit: 'pcs' as const, quantity: '1', unit_rate_paise: 3, tax_rate_percent: '18' };
    const { amounts, lines, charges, rates } = calculateInvoiceDetail({
      bill_type: 'supply', state_code: '33', lines: [line, { ...line, tax_rate_percent: '18.00' }, line],
      packing_charge_paise: 4, delivery_charge_paise: 0, delivery_taxable: false, freight_paid_by: 'seller',
    });
    expect(amounts.cgst_paise).toBe(1); // 13 paise x 9% = 1.17
    expect(lines.reduce((sum, l) => sum + l.cgst_paise, 0) + charges.cgst_paise).toBe(amounts.cgst_paise);
    expect(rates).toEqual([{ tax_rate_percent: '18', taxable_paise: 13, cgst_paise: 1, sgst_paise: 1, igst_paise: 0 }]);
  });
});

describe('WhatsApp', () => {
  const facts = { recipientName: 'Murugan & Co', companyName: 'Demo Studs', invoiceNo: 'INV/26-27/0001', invoiceDate: '2026-11-23', dueDate: '2026-12-23', balancePaise: 12_458_050 };
  it('uses a stage only on its exact day', () => {
    expect(['2026-12-22', '2026-12-23', '2026-12-24', '2026-12-30', '2027-01-07'].map((d) => reminderStage('2026-12-23', d))).toEqual([null, 'due', null, 'overdue_7', 'overdue_15']);
  });
  it('fills the approved wording, in English, and encodes it once', () => {
    const text = reminderText('due', facts);
    expect(text).toBe('Hello Murugan & Co, a friendly reminder from Demo Studs. The balance of ₹1,24,580.50 on invoice INV/26-27/0001 (23 Nov 2026) is due today, 23 Dec 2026. If you’ve already paid, please share the payment reference so we can update our records. Thank you.');
    for (const stage of ['due', 'overdue_7', 'overdue_15'] as const) expect(reminderText(stage, facts)).not.toMatch(/\{\{|undefined|vanakkam|irukku|nandri/i);
    for (const today of ['2026-12-01', '2026-12-23', '2026-12-30', '2027-01-07']) expect(whatsappDrafts('98765 43210', today, facts).map(({ label }) => label)).toEqual(['WhatsApp']);
    expect(whatsappDrafts(null, '2026-12-23', facts)).toEqual([]);
    const link = new URL(whatsappLink('+91 90000 09101', text)!);
    expect(link.origin + link.pathname).toBe('https://wa.me/919000009101');
    expect(link.searchParams.get('text')).toBe(text);
    expect(whatsappLink('9876543210', invoiceSummaryText(facts))).toMatch(/^https:\/\/wa\.me\/919876543210\?text=/);
    expect(whatsappLink(null, 'x')).toBeNull();
  });
});

describe('public environment', () => {
  const ok = { supabaseUrl: 'https://x.supabase.co', supabasePublishableKey: 'sb_publishable_abc' };
  it('refuses a secret key in a public variable, without echoing it', () => {
    expect(parsePublicEnv(ok)).toEqual(ok);
    const jwt = `h.${Buffer.from('{"role":"service_role"}').toString('base64url')}.s`;
    for (const key of ['sb_secret_hunter2', jwt]) {
      expect(() => parsePublicEnv({ ...ok, supabasePublishableKey: key })).toThrow(/never be public/);
      try { parsePublicEnv({ ...ok, supabasePublishableKey: key }); } catch (error) { expect(String(error)).not.toContain(key); }
    }
  });
});
