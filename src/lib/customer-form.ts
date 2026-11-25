/** A new customer while it is typed inside a bill, and what is made of it. Pure. */
import { GST_STATES, isValidGstin } from './india';
import type { Customer } from './schemas/masters';

export interface CustomerForm {
  /** The customer's id in the books too: minted here, kept through crashes, retries and edits. */
  id: string;
  name: string;
  registered: boolean;
  gstin: string;
  /** For a buyer without a GSTIN; otherwise the GSTIN says it. */
  state: string;
  address: string;
  phone: string;
  isSez: boolean;
  creditDays: string;
  openingBalance: string;
  /** "More details" is open. */
  more: boolean;
  /** Look-alikes the owner has said are somebody else. */
  differentFrom: string[];
}

export const newCustomer = (id: string, name = ''): CustomerForm => ({
  id, name: name.trim(), registered: false, gstin: '', state: '33', address: '', phone: '', isSez: false, creditDays: '30', openingBalance: '0', more: false, differentFrom: [],
});

/** With what was typed in the search, which finds people by name, phone and GSTIN alike. */
export function newCustomerFrom(id: string, typed: string): CustomerForm {
  const gstin = cleanGstin(typed);
  if (isValidGstin(gstin)) return { ...newCustomer(id), registered: true, gstin };
  return isPhone(typed) ? { ...newCustomer(id), phone: typed.trim() } : newCustomer(id, typed);
}

/** One kept in a draft, perhaps by an older version: complete, or null if unusable. */
export function reviveCustomer(stored: unknown): CustomerForm | null {
  if (typeof stored !== 'object' || stored === null) return null;
  const kept = stored as Partial<CustomerForm>;
  return typeof kept.id === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(kept.id) ? { ...newCustomer(kept.id), ...kept } : null;
}

export const cleanGstin = (typed: string): string => typed.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 15);

export function gstinHint(gstin: string): string | null {
  if (gstin === '') return null;
  const missing = 15 - gstin.length;
  if (missing > 0) return `${missing} more character${missing === 1 ? '' : 's'}`;
  return isValidGstin(gstin) ? null : 'Not a valid GSTIN: check each character';
}

export const stateOf = (form: CustomerForm): string => (form.registered && form.gstin.slice(0, 2) in GST_STATES ? form.gstin.slice(0, 2) : form.state);

const cleanPhone = (phone: string): string => phone.replace(/[\s-]/g, '');
const isPhone = (typed: string): boolean => /^\+?\d{10,15}$/.test(cleanPhone(typed));

export type CustomerField = 'name' | 'gstin' | 'state' | 'address' | 'phone' | 'creditDays' | 'openingBalance';

/** The first box a person has to look at: what is empty, or a default that is theirs to confirm. */
export function firstField(form: CustomerForm): CustomerField {
  if (form.name.trim() === '') return 'name';
  if (!form.registered) return 'state';
  if (form.gstin === '') return 'gstin';
  return form.address.trim() === '' ? 'address' : 'phone';
}

/** The first thing that is missing or wrong, and where it is. */
export function customerProblem(form: CustomerForm): { field: CustomerField; message: string } | null {
  const name = form.name.trim();
  if (name === '') return { field: 'name', message: 'Type the customer’s name' };
  if (name.length > 120) return { field: 'name', message: 'The name is too long' };
  if (form.registered) {
    if (form.gstin === '') return { field: 'gstin', message: 'Type the GSTIN' };
    const hint = gstinHint(form.gstin);
    if (hint) return { field: 'gstin', message: hint };
    if (form.address.trim() === '') return { field: 'address', message: 'A GST-registered customer needs an address' };
  }
  if (form.address.trim().length > 500) return { field: 'address', message: 'The address is too long' };
  if (form.phone.trim() !== '' && !isPhone(form.phone)) return { field: 'phone', message: 'A phone number has 10 digits' };
  if (!/^\d{1,3}$/.test(form.creditDays.trim()) || Number(form.creditDays) > 365) return { field: 'creditDays', message: 'Credit days: 0 to 365' };
  if (form.openingBalance.trim() !== '' && !/^-?\d{1,11}(\.\d{1,2})?$/.test(form.openingBalance.trim())) return { field: 'openingBalance', message: 'Opening balance: an amount with at most 2 decimals' };
  return null;
}

/** What is sent to the books. Only for a form without a problem. */
export const customerBody = (form: CustomerForm) => ({
  id: form.id,
  different_from: form.differentFrom,
  name: form.name.trim(),
  gstin: form.registered ? form.gstin : '',
  phone: cleanPhone(form.phone),
  state_code: stateOf(form),
  is_sez: form.registered && form.isSez,
  credit_days: Number(form.creditDays),
  address: form.address.trim(),
  opening_balance: form.openingBalance.trim() || '0',
  is_active: true,
});
export type CustomerBody = ReturnType<typeof customerBody>;

/** The customer as this bill uses it until the books have it. */
export function localCustomer(form: CustomerForm): Customer {
  const body = customerBody(form);
  return {
    id: body.id, name: body.name, gstin: body.gstin || null, phone: body.phone || null, state_code: body.state_code, is_sez: body.is_sez,
    credit_days: body.credit_days, address: body.address || null, opening_balance: body.opening_balance, is_active: true,
  };
}
