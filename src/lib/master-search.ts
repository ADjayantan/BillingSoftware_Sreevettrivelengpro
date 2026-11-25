/** Finds customers, products and lots: from the cloud, or from this PC when the cloud is silent. */
import { api, isDown, type ApiResult } from './api-client';
import { connection } from './connection';
import { stateLabel } from './india';
import { offlineEngine, type OfflineEngine } from './offline';
import { findRank, isStud, productDetail, productLabel, typedProductNo } from './products';
import type { Customer, JobWorkLot, StudItem } from './schemas/masters';

export interface Option<T> {
  key: string;
  label: string;
  detail?: string;
  value: T;
  /** A guess at what was typed, not it: Enter alone never takes one. */
  loose?: true;
}

/** More than this is not a list to choose from. */
const SHOWN = 12;

/** Long enough for slow mobile data, short enough not to stall typing. */
const SEARCH_TIMEOUT = 4000;

/** Known to be offline: do not make every keystroke wait for a timeout. A probe notices the return. */
const skipCloud = (): boolean => connection() === 'offline' || (typeof navigator !== 'undefined' && navigator.onLine === false);

async function cloudOrCache<T>(path: string, cached: (engine: OfflineEngine) => Promise<T[]>): Promise<T[]> {
  if (!skipCloud()) {
    const result: ApiResult<{ rows: T[] }> = await api(path, 'GET', undefined, SEARCH_TIMEOUT);
    if (result.ok) return result.data.rows;
    // "Signed out" or "not allowed" is an answer, and the copy on this PC must not get around it.
    if (!isDown(result) && result.status < 500) return [];
  }
  const engine = await offlineEngine();
  if (!engine) return [];
  try {
    return await cached(engine);
  } catch {
    return [];
  }
}

export const customerDetail = (customer: Customer): string =>
  `${customer.gstin ?? 'Unregistered'} · ${stateLabel(customer.state_code)}${customer.is_sez ? ' · SEZ' : ''}`;

export async function searchCustomers(q: string): Promise<Option<Customer>[]> {
  const [rows, here] = await Promise.all([
    cloudOrCache(`/api/customers?${new URLSearchParams({ q }).toString()}`, (engine) => engine.cachedCustomers(q)),
    offlineEngine().then((engine) => engine?.unsyncedCustomers(q) ?? []).catch(() => []),
  ]);
  const waiting = new Set(here.map((customer) => customer.id));
  return [
    ...here.map((customer) => ({ key: customer.id, label: customer.name, detail: `${customerDetail(customer)} · new, saved on this device`, value: customer })),
    ...rows
      .filter((row) => row.is_active && !waiting.has(row.id))
      .map((row) => ({ key: row.id, label: row.name, detail: customerDetail(row), value: row })),
  ].slice(0, SHOWN);
}

export async function searchStuds(q: string): Promise<Option<StudItem>[]> {
  if (q.trim() === '') return [];
  const rows = await cloudOrCache(`/api/stud-items?${new URLSearchParams({ q }).toString()}`, (engine) => engine.cachedStuds(q));
  const byId = typedProductNo(q) !== null;
  return rows
    .filter((row) => row.is_active)
    .map((row) => ({ row, rank: findRank(row, q) }))
    .sort((a, b) => a.rank - b.rank) // stable: within a rank they stay in ID order
    .slice(0, SHOWN)
    .map(({ row, rank }) => ({
      key: row.id, label: productLabel(row), detail: productDetail(row), value: row,
      // Somebody who typed a number means that ID, not whatever has the number in its name.
      ...(byId && rank >= 2 ? { loose: true as const } : {}),
    }));
}

/** For AI fill: the one stud whose own code has these words in it. Null when there are none or several. */
export async function onlyStudByCode(words: string): Promise<StudItem | null> {
  const options = await searchStuds(words);
  if (options.length === SHOWN) return null; // cut short: there may be others
  const found = options.filter(({ value }) => isStud(value) && value.sku_code.includes(words.trim().toUpperCase()));
  return found.length === 1 ? (found[0]?.value ?? null) : null;
}

export const openLots = (customerId: string): Promise<JobWorkLot[]> =>
  cloudOrCache(`/api/job-work?customer_id=${customerId}&open=true`, (engine) => engine.cachedOpenLots(customerId));
