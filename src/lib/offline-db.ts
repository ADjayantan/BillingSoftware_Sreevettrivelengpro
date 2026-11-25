/**
 * The device's own store (IndexedDB). Only four things live here: bills being typed, bills
 * waiting for their number, new customers the books may not have yet, and a small copy of the
 * masters. Never issued invoices.
 * Client only, and always loaded lazily (src/lib/offline.ts): Dexie is not first-load JS.
 */
import Dexie, { type EntityTable, type Table } from 'dexie';
import type { BillForm } from './bill-form';
import { localCustomer, type CustomerForm } from './customer-form';
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
 * review   → never sent: its new customer needs the owner's choice first
 */
export type QueueStatus = 'pending' | 'synced' | 'conflict' | 'rejected' | 'review';

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
  /** Something done on the owner's behalf that stays visible after the bill is issued. */
  note?: string;
  issued: IssuedBill | null;
  settled_at: number | null;
  /** Byte-identical on every resend. Dropped once issued. */
  draft: BillDraftInput | null;
  form: BillForm | null;
}

/**
 * pending → not in the books, as far as is known: goes before any bill that uses it
 * created → in the books, under this id
 * review  → the books know somebody like this, or refuse the details: the owner chooses
 * merged  → was somebody the books already had (`merged_into`)
 */
export type NewCustomerStatus = 'pending' | 'created' | 'review' | 'merged';

export interface NewCustomerRecord {
  id: string;
  status: NewCustomerStatus;
  form: CustomerForm;
  /** Why it is in review: the same GSTIN, a similar name or phone, or (null) the details themselves. */
  reason: 'gstin' | 'similar' | null;
  candidates: Customer[];
  merged_into: Customer | null;
  message: string | null;
  created_at: number;
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
  /** Which columns the copied rows have (master-cache.ts); absent before products had IDs. */
  shape?: number;
}

export class OfflineDb extends Dexie {
  drafts!: Table<DraftRecord, string>;
  offline_queue!: EntityTable<QueueRecord, 'seq'>;
  cached_customers!: Table<CachedCustomer, string>;
  cached_stud_items!: Table<CachedStud, string>;
  cached_lots!: Table<CachedLot, string>;
  cache_state!: Table<CacheState, string>;
  new_customers!: Table<NewCustomerRecord, string>;

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
    // A table more and nothing else: drafts and queues are not touched, and a tab that still
    // runs the older version goes on working.
    this.version(2).stores({ new_customers: 'id, status' });
  }
}

const KEEP_SYNCED = 20;
/** Longer than a bill may be back-dated, so no waiting bill can still need one. */
const KEEP_SETTLED_CUSTOMERS = 45 * 86_400_000;

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
  item.form !== null && (item.status === 'rejected' || item.status === 'review' || (item.status === 'pending' && item.attempts === 0));

/** Back to a draft under the SAME id, so even a wrong guess can never issue it twice. */
export async function reopenBill(db: OfflineDb, tempId: string, now = Date.now()): Promise<boolean> {
  return db.transaction('rw', db.drafts, db.offline_queue, db.new_customers, async () => {
    const item = await queuedBill(db, tempId);
    if (!item || !item.form || !isReopenable(item)) return false;
    // A customer that needs a look comes back as the form it was typed in.
    const typed = item.form.customer ? await db.new_customers.get(item.form.customer.id) : undefined;
    const form: BillForm = typed?.status === 'review' ? { ...item.form, customer: null, customerText: typed.form.name, newCustomer: typed.form } : item.form;
    await db.drafts.put({ temp_id: tempId, form, updated_at: now });
    await db.offline_queue.delete(item.seq);
    return true;
  });
}

/** Clears a settled entry from the list. A bill the books do not have can never be dismissed. */
export async function dismissBill(db: OfflineDb, tempId: string): Promise<void> {
  await db.offline_queue.where('temp_id').equals(tempId).and((item) => item.status !== 'pending' && item.status !== 'review').delete();
}

export async function pruneSynced(db: OfflineDb, now = Date.now()): Promise<void> {
  const synced = await db.offline_queue.where('status').equals('synced').primaryKeys();
  await db.offline_queue.bulkDelete(synced.slice(0, Math.max(0, synced.length - KEEP_SYNCED)));
  await db.new_customers.where('status').anyOf('created', 'merged').and((one) => now - one.created_at > KEEP_SETTLED_CUSTOMERS).delete();
}

export interface QueueSummary {
  pending: number;
  attention: number;
  /** Newest first. */
  items: QueueRecord[];
  /** New customers the owner has to decide about, with or without a bill. */
  reviews: NewCustomerRecord[];
}

const customerIdOf = (item: QueueRecord): string | null => item.draft?.customer_id ?? item.form?.customer?.id ?? null;

export async function queueSummary(db: OfflineDb): Promise<QueueSummary> {
  const [pending, needsPerson, newest, reviews] = await Promise.all([
    db.offline_queue.where('status').equals('pending').count(),
    db.offline_queue.where('status').anyOf('conflict', 'rejected', 'review').toArray(),
    db.offline_queue.orderBy('seq').reverse().limit(50).toArray(),
    db.new_customers.where('status').equals('review').toArray(),
  ]);
  // What needs a person is always listed, however old.
  const shown = new Map([...needsPerson, ...newest].map((item) => [item.seq, item]));
  const withBill = new Set(needsPerson.map(customerIdOf));
  return {
    pending,
    attention: needsPerson.length + reviews.filter((one) => !withBill.has(one.id)).length,
    items: [...shown.values()].sort((a, b) => b.seq - a.seq),
    reviews,
  };
}

// ---- New customers -----------------------------------------------------------
/** Never-sent bills of this customer: the only ones whose customer may still change. */
const unsentOf = (db: OfflineDb, customerId: string) =>
  db.offline_queue.where('status').anyOf('pending', 'review').and((item) => item.attempts === 0 && customerIdOf(item) === customerId);

/**
 * Saves a new customer on this device; the sync sends it before any of its bills. Gives the
 * customer to bill: one the books have is not typed over, and one that was joined stays joined.
 */
export async function saveNewCustomer(db: OfflineDb, form: CustomerForm, now = Date.now()): Promise<Customer> {
  return db.transaction('rw', db.new_customers, db.offline_queue, async () => {
    const known = await db.new_customers.get(form.id);
    if (known?.status === 'merged' && known.merged_into) return known.merged_into;
    if (known?.status === 'created') return localCustomer(known.form);
    await db.new_customers.put({ id: form.id, status: 'pending', form, reason: null, candidates: [], merged_into: null, message: null, created_at: known?.created_at ?? now });
    await unsentOf(db, form.id).modify({ status: 'pending', message: null });
    return localCustomer(form);
  });
}

/** The books have it, under this id: its bills may go. */
export async function markCreated(db: OfflineDb, id: string, sent?: CustomerForm): Promise<void> {
  await db.transaction('rw', db.new_customers, db.offline_queue, async () => {
    const changed = await db.new_customers.where('id').equals(id).and((one) => one.status === 'pending' || one.status === 'review')
      .modify({ status: 'created', reason: null, candidates: [], message: null, ...(sent ? { form: sent } : {}) });
    if (changed > 0) await unsentOf(db, id).modify({ status: 'pending', message: null });
  });
}

/** Takes one that needs a decision off this device, unless a bill is for it. */
export async function dropNewCustomer(db: OfflineDb, id: string): Promise<void> {
  await db.transaction('rw', db.new_customers, db.offline_queue, db.drafts, async () => {
    const drafts = await db.drafts.filter(({ form }) => form.customer?.id === id || form.newCustomer?.id === id).count();
    if (drafts + (await unsentOf(db, id).count()) === 0) await db.new_customers.where('id').equals(id).and((one) => one.status === 'review').delete();
  });
}

/** It needs the owner: its bills wait with it, whole. */
export async function holdForReview(db: OfflineDb, id: string, why: Pick<NewCustomerRecord, 'reason' | 'candidates'> & { message: string }): Promise<void> {
  await db.transaction('rw', db.new_customers, db.offline_queue, async () => {
    const changed = await db.new_customers.where('id').equals(id).and((one) => one.status === 'pending' || one.status === 'review').modify({ status: 'review', ...why });
    if (changed > 0) await unsentOf(db, id).modify({ status: 'review', message: why.message });
  });
}

/** "That is the same customer": its unsent bills and drafts become that customer's. */
export async function joinCustomer(db: OfflineDb, id: string, customer: Customer, note?: string): Promise<void> {
  await db.transaction('rw', db.new_customers, db.offline_queue, db.drafts, async () => {
    const changed = await db.new_customers.where('id').equals(id).and((one) => one.status !== 'created').modify({ status: 'merged', merged_into: customer, reason: null, candidates: [], message: null });
    if (changed === 0) return; // the books have it under its own id after all
    await unsentOf(db, id).modify((item) => {
      moveTo(item, customer);
      item.status = 'pending';
      item.message = null;
      if (note !== undefined) item.note = note;
    });
    await db.drafts.filter((draft) => draft.form.customer?.id === id).modify((draft) => {
      draft.form = withCustomer(draft.form, customer);
    });
  });
}

const withCustomer = (form: BillForm, customer: Customer): BillForm => ({ ...form, customer, customerText: customer.name });

/** The bill as this customer's. Only ever for one that was never sent. */
export function moveTo(item: QueueRecord, customer: Customer): void {
  item.customer = customer.name;
  if (item.draft) item.draft = { ...item.draft, customer_id: customer.id };
  if (item.form) item.form = withCustomer(item.form, customer);
}

/** "No, somebody else": it goes to the books with these candidates ruled out. */
export async function differentCustomer(db: OfflineDb, id: string): Promise<void> {
  await db.transaction('rw', db.new_customers, db.offline_queue, async () => {
    const changed = await db.new_customers.where('id').equals(id).and((one) => one.status === 'review').modify((one) => {
      one.form = { ...one.form, differentFrom: [...new Set([...one.form.differentFrom, ...one.candidates.map((candidate) => candidate.id)])] };
      Object.assign(one, { status: 'pending', reason: null, candidates: [], message: null });
    });
    if (changed > 0) await unsentOf(db, id).modify({ status: 'pending', message: null });
  });
}

/** Signing out takes the customers off a shared PC. What the books do not have yet stays: losing it is worse. */
export async function forgetMasters(db: OfflineDb): Promise<void> {
  await db.transaction('rw', [db.cached_customers, db.cached_stud_items, db.cached_lots, db.cache_state, db.new_customers], async () => {
    await Promise.all([
      db.cached_customers.clear(), db.cached_stud_items.clear(), db.cached_lots.clear(), db.cache_state.clear(),
      db.new_customers.where('status').anyOf('created', 'merged').delete(),
    ]);
  });
}
