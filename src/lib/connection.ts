/** Whether the cloud answered last time we asked. Browser-only state, shared by every screen. */

export type Connection = 'online' | 'offline' | 'signed_out';

let current: Connection = 'online';
const listeners = new Set<() => void>();

export const connection = (): Connection => current;

export function setConnection(next: Connection): void {
  if (next === current) return;
  current = next;
  for (const listener of listeners) listener();
}

export function onConnection(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
