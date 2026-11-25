/** What "Save & use in this bill" does: the books when they answer, this device when they do not. */
import { api, isDown, type ApiResult } from './api-client';
import { connection } from './connection';
import { customerBody, type CustomerForm } from './customer-form';
import type { NewCustomerRecord } from './offline-db';
import type { Customer } from './schemas/masters';

/** The parts of the offline engine this needs. */
export interface AddEngine {
  knownMatches: (form: CustomerForm) => Promise<{ gstin: Customer | null; alike: Customer[] }>;
  saveNewCustomer: (form: CustomerForm) => Promise<Customer>;
  keepCustomer: (customer: Customer) => Promise<void>;
  newCustomer: (id: string) => Promise<NewCustomerRecord | undefined>;
}

export interface Match {
  reason: 'gstin' | 'similar';
  candidates: Customer[];
}

export type Added =
  /** `here`: only on this device so far. */
  | { customer: Customer; here: boolean }
  /** The owner says who it is. */
  | { match: Match }
  | { problem: string };

/** Long enough for slow mobile data; after that the device keeps it, under the same id. */
const TIMEOUT = 8000;

const isSilent = (): boolean => connection() === 'offline' || (typeof navigator !== 'undefined' && navigator.onLine === false);

function matchOf(result: { code: string; details?: Record<string, unknown> }): Match | null {
  const details = result.details as { existing?: Customer; candidates?: Customer[] } | undefined;
  if (result.code === 'CUSTOMER_EXISTS' && details?.existing) return { reason: 'gstin', candidates: [details.existing] };
  if (result.code === 'CUSTOMER_SIMILAR' && details?.candidates?.length) return { reason: 'similar', candidates: details.candidates };
  return null;
}

export async function addCustomer(form: CustomerForm, engine: AddEngine | null): Promise<Added> {
  const result = isSilent() ? null : await api<Customer>('/api/customers', 'POST', customerBody(form), TIMEOUT);
  if (result?.ok) {
    await engine?.keepCustomer(result.data).catch(() => undefined); // the copy is a convenience
    return { customer: result.data, here: false };
  }
  if (result) {
    const match = matchOf(result);
    if (match) return { match };
    if (!isDown(result) && result.code !== 'UNAUTHENTICATED') return { problem: result.message };
  }
  if (!engine) return { problem: 'This browser cannot keep a customer: a new one needs the internet.' };
  // Signed out: the copy must not answer in place of the books. They are asked at the next sign-in.
  if (result?.code !== 'UNAUTHENTICATED') {
    const known = await engine.knownMatches(form);
    if (known.gstin) return { match: { reason: 'gstin', candidates: [known.gstin] } };
    if (known.alike.length > 0) return { match: { reason: 'similar', candidates: known.alike } };
  }
  return { customer: await engine.saveNewCustomer(form), here: true };
}

type Changed = { customer: Customer } | { problem: string };

/** One change to what the books have now, not to the copy this screen happens to hold. */
async function change(id: string, over: Partial<Customer>): Promise<Changed> {
  const fresh = await api<Customer>(`/api/customers/${id}`, 'GET', undefined, TIMEOUT);
  const saved: ApiResult<Customer> = fresh.ok ? await api<Customer>(`/api/customers/${id}`, 'PUT', { ...fresh.data, ...over }, TIMEOUT) : fresh;
  if (saved.ok) return { customer: saved.data };
  return { problem: isDown(saved) ? 'This needs the internet. Nothing in the bill is lost.' : saved.message };
}

/** An address typed in the bill: for a customer only this device has, it works offline too. */
export async function addressSaved(customer: Customer, address: string, engine: AddEngine | null): Promise<Changed> {
  const here = await engine?.newCustomer(customer.id);
  if (engine && here && (here.status === 'pending' || here.status === 'review')) {
    return { customer: await engine.saveNewCustomer({ ...here.form, address: address.trim() }) };
  }
  const saved = await change(customer.id, { address: address.trim() });
  if ('customer' in saved) await engine?.keepCustomer(saved.customer).catch(() => undefined);
  return saved;
}

/** A customer that was switched off is switched on again by being billed. */
export const switchedOn = async (customer: Customer): Promise<Changed> => (customer.is_active ? { customer } : change(customer.id, { is_active: true }));
