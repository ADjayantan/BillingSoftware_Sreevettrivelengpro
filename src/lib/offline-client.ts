/** Browser wiring of the offline engine: one database, one sync at a time, quiet refreshes. */
import { liveQuery } from 'dexie';
import { api } from './api-client';
import type { Autosave } from './autosave';
import type { BillForm } from './bill-form';
import { connection, onConnection, setConnection } from './connection';
import * as store from './offline-db';
import { drainQueue, type DrainResult } from './offline-sync';
import * as masters from './master-cache';
import type { BillDraftInput } from './schemas/invoices';

const db = new store.OfflineDb();
const OPEN_TIMEOUT = 4000;

export async function ready(): Promise<boolean> {
  const opened = db.open().then(() => true, () => false);
  const late = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), OPEN_TIMEOUT));
  const ok = await Promise.race([opened, late]);
  // Ask the browser not to evict unsent bills when the disk fills up.
  if (ok) void navigator.storage?.persist?.().catch(() => false);
  return ok;
}

// ---- Locks: across tabs, released by the browser even if a tab crashes -------
const hasLocks = (): boolean => typeof navigator !== 'undefined' && 'locks' in navigator;

async function exclusively<T>(name: string, work: () => Promise<T>): Promise<T> {
  return hasLocks() ? ((await navigator.locks.request(name, work)) as T) : work();
}

/**
 * Marks a draft as open in this tab. Null: another tab has it. The short wait lets a page that
 * is just being closed or reloaded let go first.
 */
function holdDraft(tempId: string): Promise<(() => void) | null> {
  if (!hasLocks()) return Promise.resolve(() => undefined);
  return new Promise((resolve, reject) => {
    navigator.locks
      .request(`studflow-draft-${tempId}`, { signal: AbortSignal.timeout(250) }, () => new Promise<void>((release) => resolve(release)))
      .catch((error: unknown) => (error instanceof DOMException ? resolve(null) : reject(error)));
  });
}

// ---- Drafts ------------------------------------------------------------------
export interface OpenedDraft {
  record: store.DraftRecord | null;
  release: () => void;
}

/** The bill to show: the one asked for, else the newest not open in another tab. */
export async function openDraft(wanted: string | null, freshId: string): Promise<OpenedDraft> {
  const records = await store.listDrafts(db);
  const ordered = wanted ? [...records.filter((r) => r.temp_id === wanted), ...records.filter((r) => r.temp_id !== wanted)] : records;
  for (const record of ordered) {
    const release = await holdDraft(record.temp_id);
    if (release) return { record, release };
  }
  return { record: null, release: (await holdDraft(freshId)) ?? (() => undefined) };
}

export const newDraftLock = async (tempId: string): Promise<() => void> => (await holdDraft(tempId)) ?? (() => undefined);
export const saveDraft = (form: BillForm): Promise<void> => store.saveDraft(db, form);
export const deleteDraft = (tempId: string): Promise<void> => store.deleteDraft(db, tempId);

let active: Autosave<BillForm> | null = null;
export const setActiveSaver = (saver: Autosave<BillForm> | null): void => {
  active = saver;
};
/** Before leaving the page on purpose. */
export const flushDraft = (): Promise<void> => active?.flush() ?? Promise.resolve();

// ---- Queue and sync ----------------------------------------------------------
export const enqueue = (bill: { form: BillForm; draft: BillDraftInput; customer: string; total_paise: number }): Promise<void> => store.enqueueBill(db, bill);
export const reopen = (tempId: string): Promise<boolean> => store.reopenBill(db, tempId);
export const dismiss = (tempId: string): Promise<void> => store.dismissBill(db, tempId);
export const isReopenable = store.isReopenable;
export const forgetMasters = (): Promise<void> => store.forgetMasters(db);
export const unsent = async (): Promise<number> => (await store.queueSummary(db)).pending + (await db.drafts.count());

const send = (draft: BillDraftInput) => api<{ invoice_id: string; invoice_no: string; dc_no: string }>('/api/invoices/sync', 'POST', draft);

let running: Promise<DrainResult> | null = null;
let again = false;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let failures = 0;

/** Calls made during a run fold into one more run, so a bill queued meanwhile is not missed. */
export function syncNow(): Promise<DrainResult> {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    let result: DrainResult;
    do {
      again = false;
      result = await exclusively('studflow-sync', () => drainQueue(db, send));
    } while (again);
    scheduleRetry(result);
    return result;
  })().finally(() => {
    running = null;
  });
  return running;
}

function scheduleRetry(result: DrainResult): void {
  clearTimeout(retryTimer);
  if (result.stopped === 'done') {
    failures = 0;
    return;
  }
  if (result.stopped === 'signed_out') return; // only a sign-in helps
  failures += 1;
  retryTimer = setTimeout(() => void syncNow(), Math.min(300_000, 15_000 * 2 ** Math.min(failures - 1, 5)));
}

// ---- Watching ----------------------------------------------------------------
export function watchQueue(next: (summary: store.QueueSummary) => void): () => void {
  const subscription = liveQuery(() => store.queueSummary(db)).subscribe({ next, error: () => undefined });
  return () => subscription.unsubscribe();
}

export function watchBill(tempId: string, next: (item: store.QueueRecord | undefined) => void): () => void {
  const subscription = liveQuery(() => store.queuedBill(db, tempId)).subscribe({ next, error: () => undefined });
  return () => subscription.unsubscribe();
}

export function watchDrafts(next: (drafts: store.DraftRecord[]) => void): () => void {
  const subscription = liveQuery(() => store.listDrafts(db)).subscribe({ next, error: () => undefined });
  return () => subscription.unsubscribe();
}

// ---- Masters -----------------------------------------------------------------
export const cachedCustomers = (q: string) => masters.cachedCustomers(db, q);
export const cachedStuds = (q: string) => masters.cachedStuds(db, q);
export const cachedOpenLots = (customerId: string) => masters.cachedOpenLots(db, customerId);

const REFRESH_EVERY = 10 * 60_000;
let refreshing = false;

async function refreshMasters(): Promise<void> {
  if (refreshing || connection() !== 'online') return;
  refreshing = true;
  try {
    const states = await db.cache_state.toArray();
    if (states.length === 3 && states.every((state) => Date.now() - state.checked_at < REFRESH_EVERY)) return;
    await exclusively('studflow-masters', () =>
      masters.refreshMasters(db, (kind, since, after) =>
        api(`/api/offline-cache?${new URLSearchParams({ kind, ...(since ? { since } : {}), ...(after ? { after } : {}) }).toString()}`),
      ),
    );
  } catch {
    // Quiet: billing works without it, and the next round tries again.
  } finally {
    refreshing = false;
  }
}

// ---- Life cycle --------------------------------------------------------------
const PROBE_EVERY = 15_000;

/** Started once by the status bar; returns the stop function. */
export function start(): () => void {
  const probe = async (): Promise<void> => {
    if (connection() === 'offline') await api('/api/ping', 'GET', undefined, 8000);
  };
  const cameBack = (): void => {
    if (connection() !== 'online') return;
    void syncNow();
    void refreshMasters();
  };
  const onOnline = (): void => void probe().then(() => syncNow());
  const onOffline = (): void => setConnection('offline');
  const onHide = (): void => {
    if (document.visibilityState === 'hidden') void flushDraft();
  };
  const stopWatching = onConnection(cameBack);
  const prober = setInterval(() => void probe(), PROBE_EVERY);
  const refresher = setInterval(() => void refreshMasters(), REFRESH_EVERY);
  if (navigator.onLine === false) onOffline();
  window.addEventListener('offline', onOffline);
  window.addEventListener('online', onOnline);
  window.addEventListener('pagehide', onHide);
  document.addEventListener('visibilitychange', onHide);
  void syncNow();
  void refreshMasters();
  return () => {
    stopWatching();
    clearInterval(prober);
    clearInterval(refresher);
    clearTimeout(retryTimer);
    window.removeEventListener('offline', onOffline);
    window.removeEventListener('online', onOnline);
    window.removeEventListener('pagehide', onHide);
    document.removeEventListener('visibilitychange', onHide);
  };
}
