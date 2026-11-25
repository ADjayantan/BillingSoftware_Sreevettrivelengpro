/** A small copy of customers, products and open lots, so billing can search with no internet. */
import type { Table } from 'dexie';
import type { ApiResult } from './api-client';
import { localCustomer, reviveCustomer, type CustomerForm } from './customer-form';
import { lookAlikes } from './customer-match';
import type { CacheState, OfflineDb } from './offline-db';
import { findRank, revivedProduct } from './products';
import type { Customer, JobWorkLot, StudItem } from './schemas/masters';

type Kind = CacheState['kind'];
export type FetchMasters = (
  kind: Kind,
  since: string | null,
  after: string | null,
) => Promise<ApiResult<{ rows: { id: string }[]; next: string | null; as_of: string }>>;

/** Hard ceilings: the copy is for billing through an outage, not a mirror. */
export const LIMITS: Record<Kind, number> = { customers: 3000, stud_items: 3000, lots: 1000 };
const KINDS: readonly Kind[] = ['customers', 'stud_items', 'lots'];
/** Raise a kind's number when its rows get new columns: PCs then fetch all of it again, once. */
const SHAPE: Record<Kind, number> = { customers: 1, stud_items: 2, lots: 1 };
const DAY = 86_400_000;
/** Transactions that commit late, and small clock differences, fall inside this. */
const OVERLAP = 5 * 60_000;

const isLive = (kind: Kind, row: object): boolean =>
  kind === 'lots' ? (row as JobWorkLot).status === 'open' : (row as Customer | StudItem).is_active;

const tableOf = (db: OfflineDb, kind: Kind): Table<{ id: string; pass: number }, string> =>
  (kind === 'customers' ? db.cached_customers : kind === 'stud_items' ? db.cached_stud_items : db.cached_lots) as unknown as Table<{ id: string; pass: number }, string>;

/** Once a day everything (that is how deletions are noticed), in between only what changed. */
export async function refreshMasters(db: OfflineDb, fetchPage: FetchMasters, now = Date.now()): Promise<boolean> {
  for (const kind of KINDS) if (!(await refreshKind(db, kind, fetchPage, now))) return false;
  return true;
}

async function refreshKind(db: OfflineDb, kind: Kind, fetchPage: FetchMasters, now: number): Promise<boolean> {
  const table = tableOf(db, kind);
  const state = await db.cache_state.get(kind);
  const full = !state || (state.shape ?? 1) !== SHAPE[kind] || now - state.full_at >= DAY;
  const since = full ? null : new Date(Date.parse(state.as_of) - OVERLAP).toISOString();
  let after: string | null = null;
  let asOf: string | null = null;
  let kept = 0;
  do {
    const page = await fetchPage(kind, since, after);
    if (!page.ok) return false; // what is cached stays usable; the next refresh starts over
    asOf ??= page.data.as_of;
    const live = page.data.rows.filter((row) => isLive(kind, row)).slice(0, Math.max(0, LIMITS[kind] - kept));
    const gone = page.data.rows.filter((row) => !isLive(kind, row)).map((row) => row.id);
    kept += live.length;
    await db.transaction('rw', table, async () => {
      await table.bulkPut(live.map((row) => ({ ...row, pass: now, ...(kind === 'customers' ? { name_lc: (row as Customer).name.toLowerCase() } : {}) })));
      await table.bulkDelete(gone);
    });
    after = kept >= LIMITS[kind] ? null : page.data.next;
  } while (after !== null);
  await db.transaction('rw', table, db.cache_state, async () => {
    if (full) await table.filter((row) => row.pass !== now).delete();
    await db.cache_state.put({ kind, shape: SHAPE[kind], as_of: asOf ?? new Date(now).toISOString(), full_at: full ? now : (state?.full_at ?? now), checked_at: now });
  });
  return true;
}

/** A product saved on this PC is in its copy at once: the internet may go before the next refresh. */
export async function keepProduct(db: OfflineDb, product: StudItem): Promise<void> {
  if (!product.is_active) return forgetProduct(db, product.id);
  await db.cached_stud_items.put({ ...product, pass: 0 });
}

export const forgetProduct = (db: OfflineDb, id: string): Promise<void> => db.cached_stud_items.delete(id);

/** A customer the books have just taken from this PC, likewise. */
export async function keepCustomer(db: OfflineDb, customer: Customer): Promise<void> {
  if (!customer.is_active) return db.cached_customers.delete(customer.id);
  await db.cached_customers.put({ ...customer, name_lc: customer.name.toLowerCase(), pass: 0 });
}

const RESULTS = 12;

/** The same three things the cloud looks at: name, phone and GSTIN. */
function customerHas(q: string): (customer: Customer) => boolean {
  const needle = q.trim().toLowerCase();
  return (one) => [one.name, one.phone, one.gstin].some((text) => text?.toLowerCase().includes(needle));
}

// Cursors, not toArray(): a search never loads the whole table into memory.
export function cachedCustomers(db: OfflineDb, q: string): Promise<Customer[]> {
  return db.cached_customers.orderBy('name_lc').filter(customerHas(q)).limit(RESULTS).toArray();
}

const unsynced = async (db: OfflineDb): Promise<Customer[]> =>
  (await db.new_customers.where('status').anyOf('pending', 'review').toArray()).flatMap((one) => {
    const form = reviveCustomer(one.form); // null: damaged, and must not hide the others
    return form ? [localCustomer(form)] : [];
  });

/** New customers that only this device has. */
export const unsyncedCustomers = async (db: OfflineDb, q: string): Promise<Customer[]> => (await unsynced(db)).filter(customerHas(q)).slice(0, RESULTS);

/** Who this new customer may already be, as far as this device knows. */
export async function knownMatches(db: OfflineDb, form: CustomerForm): Promise<{ gstin: Customer | null; alike: Customer[] }> {
  const typed = localCustomer(form);
  let gstin: Customer | null = null;
  const alike = new Map<string, Customer>();
  const look = (one: Customer): void => {
    if (one.id === form.id) return;
    if (typed.gstin !== null && one.gstin === typed.gstin) gstin ??= one;
    if (alike.size < 10 && lookAlikes(typed, [one], form.differentFrom).length > 0) alike.set(one.id, one);
  };
  (await unsynced(db)).forEach(look);
  await db.cached_customers.each(look);
  return { gstin, alike: [...alike.values()] };
}

/** The same order as the cloud gives: the ID typed, an own code, then by ID. */
export async function cachedStuds(db: OfflineDb, q: string): Promise<StudItem[]> {
  const best: { row: StudItem; rank: number }[] = [];
  await db.cached_stud_items.each((kept) => {
    const row = revivedProduct(kept);
    const rank = findRank(row, q);
    if (rank > 2) return;
    const at = best.findIndex((other) => other.rank > rank || (other.rank === rank && other.row.product_no > row.product_no));
    best.splice(at < 0 ? best.length : at, 0, { row, rank });
    if (best.length > RESULTS) best.pop();
  });
  return best.map(({ row }) => row);
}

export async function cachedOpenLots(db: OfflineDb, customerId: string): Promise<JobWorkLot[]> {
  const lots = await db.cached_lots.where('customer_id').equals(customerId).limit(50).toArray();
  return lots.sort((a, b) => b.party_dc_date.localeCompare(a.party_dc_date));
}
