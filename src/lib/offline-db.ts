/**
 * The device's own store (IndexedDB). Only three things live here: bills being typed, bills
 * waiting for their number, and a small copy of the masters. Never issued invoices.
 * Client only, and always loaded lazily (src/lib/offline.ts): Dexie is not first-load JS.
 */
import Dexie, { type EntityTable, type Table } from 'dexie';
import type { BillForm } from './bill-form';
import type { BillDraftInput, IssuedBill } from './schemas/invoices';
import type { Customer, JobWorkLot, StudItem } from './schemas/masters';

export interface DraftRecord {
  temp_id: string;
  form: BillForm;
  updated_at: number;
}

/**
 * pending  → not answered yet; resent until it is
 * synced   → issued, number known
 * conflict → the books already hold this bill, with different content: the issued one stands
 * rejected → refused, and the server confirmed it has no invoice: fix and save again
 */
export type QueueStatus = 'pending' | 'synced' | 'conflict' | 'rejected';

export interface QueueRecord {
  seq: number;
  temp_id: string;
  status: QueueStatus;
  customer: string;
  total_paise: number;
  created_at: number;
  /** Times sent. Zero means the server cannot have seen it. */
  attempts: number;
  message: string | null;
  issued: IssuedBill | null;
  settled_at: number | null;
  /** Byte-identical on every resend. Dropped once issued. */
  draft: BillDraftInput | null;
  form: BillForm | null;
}

export type CachedCustomer = Customer & { name_lc: string; pass: number };
export type CachedStud = StudItem & { pass: number };
export type CachedLot = JobWorkLot & { pass: number };
export interface CacheState {
  kind: 'customers' | 'stud_items' | 'lots';
  /** Server time of the last completed pass; the next one asks for changes since. */
  as_of: string;
  full_at: number;
  checked_at: number;
}

export class OfflineDb extends Dexie {
  drafts!: Table<DraftRecord, string>;
  offline_queue!: EntityTable<QueueRecord, 'seq'>;
  cached_customers!: Table<CachedCustomer, string>;
  cached_stud_items!: Table<CachedStud, string>;
  cached_lots!: Table<CachedLot, string>;
  cache_state!: Table<CacheState, string>;

  constructor(name = 'studflow') {
    // Chrome's default commit may still be in the OS buffer when the power goes: flush it.
    super(name, { chromeTransactionDurability: 'strict' });
    this.version(1).stores({
      drafts: 'temp_id, updated_at',
      offline_queue: '++seq, &temp_id, status',
      cached_customers: 'id, name_lc',
      cached_stud_items: 'id, sku_code',
      cached_lots: 'id, customer_id',
      cache_state: 'kind',
    });
  }
}

const KEEP_SYNCED = 20;

// ---- Drafts ------------------------------------------------------------------
/** A late autosave must never bring back a draft that is already in the queue. */
export async function saveDraft(db: OfflineDb, form: BillForm, now = Date.now()): Promise<void> {
  await db.transaction('rw', db.drafts, db.offline_queue, async () => {
    if ((await db.offline_queue.where('temp_id').equals(form.tempId).count()) > 0) return;
    await db.drafts.put({ temp_id: form.tempId, form, updated_at: now });
  });
}

export const deleteDraft = (db: OfflineDb, tempId: string): Promise<void> => db.drafts.delete(tempId);

/** Newest first: after a crash, the bill that was on screen. */
export const listDrafts = (db: OfflineDb): Promise<DraftRecord[]> => db.drafts.orderBy('updated_at').reverse().limit(50).toArray();

// ---- Queue -------------------------------------------------------------------
/** Draft out, queue in: one transaction, so a crash leaves the bill in exactly one place. */
export async function enqueueBill(
  db: OfflineDb,
  bill: { form: BillForm; draft: BillDraftInput; customer: string; total_paise: number },
  now = Date.now(),
): Promise<void> {
  await db.transaction('rw', db.drafts, db.offline_queue, async () => {
    await db.offline_queue.add({
      temp_id: bill.form.tempId, status: 'pending', customer: bill.customer, total_paise: bill.total_paise, created_at: now, attempts: 0,
      message: null, issued: null, settled_at: null, draft: bill.draft, form: bill.form,
    });
    await db.drafts.delete(bill.form.tempId);
  });
}

export const queuedBill = (db: OfflineDb, tempId: string): Promise<QueueRecord | undefined> => db.offline_queue.where('temp_id').equals(tempId).first();

/** May the bill go back to the form? Only if the server cannot hold it. */
export const isReopenable = (item: QueueRecord): boolean =>
  item.form !== null && (item.status === 'rejected' || (item.status === 'pending' && item.attempts === 0));

/** Back to a draft under the SAME id, so even a wrong guess can never issue it twice. */
export async function reopenBill(db: OfflineDb, tempId: string, now = Date.now()): Promise<boolean> {
  return db.transaction('rw', db.drafts, db.offline_queue, async () => {
    const item = await queuedBill(db, tempId);
    if (!item || !item.form || !isReopenable(item)) return false;
    await db.drafts.put({ temp_id: tempId, form: item.form, updated_at: now });
    await db.offline_queue.delete(item.seq);
    return true;
  });
}

/** Clears a settled entry from the list. A bill still waiting can never be dismissed. */
export async function dismissBill(db: OfflineDb, tempId: string): Promise<void> {
  await db.offline_queue.where('temp_id').equals(tempId).and((item) => item.status !== 'pending').delete();
}

export async function pruneSynced(db: OfflineDb): Promise<void> {
  const synced = await db.offline_queue.where('status').equals('synced').primaryKeys();
  await db.offline_queue.bulkDelete(synced.slice(0, Math.max(0, synced.length - KEEP_SYNCED)));
}

export interface QueueSummary {
  pending: number;
  attention: number;
  /** Newest first. */
  items: QueueRecord[];
}

export async function queueSummary(db: OfflineDb): Promise<QueueSummary> {
  const [pending, conflicts, rejected, newest] = await Promise.all([
    db.offline_queue.where('status').equals('pending').count(),
    db.offline_queue.where('status').equals('conflict').toArray(),
    db.offline_queue.where('status').equals('rejected').toArray(),
    db.offline_queue.orderBy('seq').reverse().limit(50).toArray(),
  ]);
  // What needs a person is always listed, however old.
  const shown = new Map([...conflicts, ...rejected, ...newest].map((item) => [item.seq, item]));
  return { pending, attention: conflicts.length + rejected.length, items: [...shown.values()].sort((a, b) => b.seq - a.seq) };
}

/** Signing out takes the customers off a shared PC. Unsent bills stay: losing one is worse. */
export async function forgetMasters(db: OfflineDb): Promise<void> {
  await db.transaction('rw', [db.cached_customers, db.cached_stud_items, db.cached_lots, db.cache_state], async () => {
    await Promise.all([db.cached_customers.clear(), db.cached_stud_items.clear(), db.cached_lots.clear(), db.cache_state.clear()]);
  });
}
