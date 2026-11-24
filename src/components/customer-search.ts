import { api } from '@/lib/api-client';
import { stateLabel } from '@/lib/india';
import type { Customer } from '@/lib/schemas/masters';
import type { Option } from './typeahead';

export async function searchCustomers(q: string): Promise<Option<Customer>[]> {
  const result = await api<{ rows: Customer[] }>(`/api/customers?${new URLSearchParams({ q }).toString()}`);
  if (!result.ok) return [];
  return result.data.rows
    .filter((row) => row.is_active)
    .slice(0, 12)
    .map((row) => ({ key: row.id, label: row.name, detail: `${row.gstin ?? 'Unregistered'} · ${stateLabel(row.state_code)}${row.is_sez ? ' · SEZ' : ''}`, value: row }));
}
