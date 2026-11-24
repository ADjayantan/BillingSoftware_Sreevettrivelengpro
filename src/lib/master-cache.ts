/** A small copy of customers, studs and open lots, so billing can search with no internet. */
import type { Table } from 'dexie';
import type { ApiResult } from './api-client';
import type { CacheState, OfflineDb } from './offline-db';
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
  const full = !state || now - state.full_at >= DAY;
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
    await db.cache_state.put({ kind, as_of: asOf ?? new Date(now).toISOString(), full_at: full ? now : (state?.full_at ?? now), checked_at: now });
  });
  return true;
}

const RESULTS = 12;

// Cursors, not toArray(): a search never loads the whole table into memory.
export function cachedCustomers(db: OfflineDb, q: string): Promise<Customer[]> {
  const needle = q.trim().toLowerCase();
  return db.cached_customers.orderBy('name_lc').filter((row) => row.name_lc.includes(needle)).limit(RESULTS).toArray();
}

export function cachedStuds(db: OfflineDb, q: string): Promise<StudItem[]> {
  const needle = q.trim().toUpperCase();
  return db.cached_stud_items.orderBy('sku_code').filter((row) => row.sku_code.includes(needle)).limit(RESULTS).toArray();
}

export async function cachedOpenLots(db: OfflineDb, customerId: string): Promise<JobWorkLot[]> {
  const lots = await db.cached_lots.where('customer_id').equals(customerId).limit(50).toArray();
  return lots.sort((a, b) => b.party_dc_date.localeCompare(a.party_dc_date));
}
