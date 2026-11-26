/** How many bills wait on this device: told by the offline bar, shown in the menu and on Home. */

export interface QueueNote {
  /** Waiting to go. */
  pending: number;
  /** Waiting for a person. */
  attention: number;
}

const NOTHING: QueueNote = { pending: 0, attention: 0 };
let current = NOTHING;
const listeners = new Set<() => void>();

export const queueNote = (): QueueNote => current;
/** For the server, which has no device. */
export const noQueue = (): QueueNote => NOTHING;

export function setQueueNote({ pending, attention }: QueueNote): void {
  if (pending === current.pending && attention === current.attention) return;
  current = { pending, attention };
  for (const listener of listeners) listener();
}

export function onQueueNote(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const bills = (count: number): string => `${count} bill${count === 1 ? '' : 's'}`;

/** One line about this device, the most important thing first. */
export function deviceState(connection: 'online' | 'offline' | 'signed_out', { pending, attention }: QueueNote): { state: 'ok' | 'wait' | 'offline' | 'attention'; text: string } {
  if (attention > 0) return { state: 'attention', text: `${bills(attention)} need${attention === 1 ? 's' : ''} you` };
  if (connection === 'signed_out') return { state: 'attention', text: 'Signed out' };
  if (connection === 'offline') return { state: 'offline', text: pending > 0 ? `No internet · ${bills(pending)} kept here` : 'No internet · billing works' };
  if (pending > 0) return { state: 'wait', text: `Sending ${bills(pending)}` };
  return { state: 'ok', text: 'Online · all saved' };
}
