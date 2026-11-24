/** The door to the offline engine. Everything behind it loads after the page is usable. */
import type * as Engine from './offline-client';

export type OfflineEngine = typeof Engine;

let loading: Promise<OfflineEngine | null> | null = null;

/** Null when this browser has no usable IndexedDB (private window, blocked, broken disk). */
export function offlineEngine(): Promise<OfflineEngine | null> {
  loading ??= (async () => {
    try {
      const engine = await import('./offline-client');
      return (await engine.ready()) ? engine : null;
    } catch {
      loading = null; // the chunk did not arrive: ask again next time
      return null;
    }
  })();
  return loading;
}
