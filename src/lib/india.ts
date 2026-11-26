/** Indian business facts: GSTIN, GST state codes, IST calendar dates. Pure. */

const GSTIN_DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Shape plus the mod-36 check character; mirrors private.is_valid_gstin in the database. */
export function isValidGstin(gstin: string): boolean {
  if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3}$/.test(gstin)) return false;
  let total = 0;
  for (let i = 0; i < 14; i += 1) {
    const product = GSTIN_DIGITS.indexOf(gstin.charAt(i)) * (i % 2 === 0 ? 1 : 2);
    total += Math.floor(product / 36) + (product % 36);
  }
  return gstin.charAt(14) === GSTIN_DIGITS.charAt((36 - (total % 36)) % 36);
}

export const GST_STATES: Readonly<Record<string, string>> = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand',
  '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim',
  '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya',
  '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh',
  '24': 'Gujarat', '26': 'Dadra and Nagar Haveli and Daman and Diu', '27': 'Maharashtra', '29': 'Karnataka',
  '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh',
  '96': 'Other Country', '97': 'Other Territory',
};

export const stateLabel = (code: string): string => `${GST_STATES[code] ?? 'State'} (${code})`;

/** The state that decides the tax heads. SEZ supplies are inter-State wherever the unit is. */
export const taxStateCode = (customer: { state_code: string; is_sez: boolean }): string =>
  customer.is_sez ? '97' : customer.state_code;

/** The IST calendar date of an instant, as YYYY-MM-DD. India has no DST: always UTC+5:30. */
export function istDate(instant: Date): string {
  return new Date(instant.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}

const utcDay = (isoDate: string): number => Date.parse(`${isoDate}T00:00:00Z`);

export function addDays(isoDate: string, days: number): string {
  return new Date(utcDay(isoDate) + days * 86_400_000).toISOString().slice(0, 10);
}

export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((utcDay(toIso) - utcDay(fromIso)) / 86_400_000);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** '2026-11-23' -> '23 Nov 2026' */
export function formatDate(isoDate: string): string {
  const [year = '', month = '', day = ''] = isoDate.slice(0, 10).split('-');
  return `${Number(day)} ${MONTHS[Number(month) - 1] ?? ''} ${year}`;
}

/** '2026-11-03' -> '03.11.26', for the dt of the bill */
export const shortDate = (isoDate: string): string => isoDate.slice(2, 10).split('-').reverse().join('.');

const MOBILE = /^(\+91)?([6-9]\d{4})(\d{5})$/;
export const isMobile = (phone: string): boolean => MOBILE.test(phone);

/** '9876543210' -> '98765 43210'. Where the code of a landline ends nobody can tell: left as it is. */
export const formatPhone = (phone: string): string => {
  const parts = MOBILE.exec(phone);
  return parts ? parts.slice(1).filter(Boolean).join(' ') : phone;
};

const LONG_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] as const;

/** '2026-11-01' -> 'November 2026' */
export const monthName = (isoDate: string): string => `${LONG_MONTHS[Number(isoDate.slice(5, 7)) - 1] ?? ''} ${isoDate.slice(0, 4)}`;

/** The month of a day and those before it: ['2026-11', '2026-10', …]. */
export function lastMonths(isoDate: string, count: number): string[] {
  const first = Number(isoDate.slice(0, 4)) * 12 + Number(isoDate.slice(5, 7)) - 1;
  return Array.from({ length: count }, (_, back) => `${Math.floor((first - back) / 12)}-${String(((first - back) % 12) + 1).padStart(2, '0')}`);
}

/** '24 Nov, 10:32 am' in India time, for "when was this typed". */
export const formatTime = (epochMs: number): string =>
  new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(epochMs);
