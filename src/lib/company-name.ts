/**
 * The company name in the menu. The frame around every page is also around the static billing
 * page, so it has no data: the name is asked for once and kept on this device, like the
 * customer copy, and goes with it at sign-out.
 */
import { api } from './api-client';

const KEY = 'studflow-company';
const listeners = new Set<() => void>();
let known: string | null = null;
let asked = false;

const store = (): Storage | null => {
  try {
    return window.localStorage;
  } catch {
    return null; // blocked: the name is asked for on every visit
  }
};

function set(name: string | null): void {
  if (name === known) return;
  known = name;
  for (const listener of listeners) listener();
}

/** '' until it is known. */
export function companyName(): string {
  known ??= store()?.getItem(KEY) ?? null;
  return known ?? '';
}

export function onCompanyName(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** After the page is usable, once per visit. */
export async function askCompanyName(): Promise<void> {
  if (asked) return;
  asked = true;
  const reply = await api<{ legal_name: string } | null>('/api/company');
  if (!reply.ok) {
    asked = false;
    return;
  }
  keepCompanyName(reply.data?.legal_name ?? '');
}

export function keepCompanyName(name: string): void {
  try {
    if (name === '') store()?.removeItem(KEY);
    else store()?.setItem(KEY, name);
  } catch {
    // full: it stays for this visit
  }
  set(name);
}
