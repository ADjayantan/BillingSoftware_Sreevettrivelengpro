/** Finds customers, studs and lots: from the cloud, or from this PC when the cloud is silent. */
import { api, isDown, type ApiResult } from './api-client';
import { connection } from './connection';
import { stateLabel } from './india';
import { trimZeros } from './money';
import { offlineEngine, type OfflineEngine } from './offline';
import type { Customer, JobWorkLot, StudItem } from './schemas/masters';

export interface Option<T> {
  key: string;
  label: string;
  detail?: string;
  value: T;
}

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

export async function searchCustomers(q: string): Promise<Option<Customer>[]> {
  const rows = await cloudOrCache(`/api/customers?${new URLSearchParams({ q }).toString()}`, (engine) => engine.cachedCustomers(q));
  return rows
    .filter((row) => row.is_active)
    .slice(0, 12)
    .map((row) => ({ key: row.id, label: row.name, detail: `${row.gstin ?? 'Unregistered'} · ${stateLabel(row.state_code)}${row.is_sez ? ' · SEZ' : ''}`, value: row }));
}

export async function searchStuds(q: string): Promise<Option<StudItem>[]> {
  if (q.trim() === '') return [];
  const rows = await cloudOrCache(`/api/stud-items?${new URLSearchParams({ q }).toString()}`, (engine) => engine.cachedStuds(q));
  return rows
    .filter((row) => row.is_active)
    .slice(0, 12)
    .map((row) => ({
      key: row.id, label: row.sku_code, value: row,
      detail: `${trimZeros(row.diameter_mm)} × ${trimZeros(row.length_mm)} mm · ${row.material_grade} · ₹${row.default_rate_per_piece ? `${trimZeros(row.default_rate_per_piece)}/pc` : row.default_rate_per_kg ? `${trimZeros(row.default_rate_per_kg)}/kg` : 'no rate'}`,
    }));
}

export const openLots = (customerId: string): Promise<JobWorkLot[]> =>
  cloudOrCache(`/api/job-work?customer_id=${customerId}&open=true`, (engine) => engine.cachedOpenLots(customerId));
