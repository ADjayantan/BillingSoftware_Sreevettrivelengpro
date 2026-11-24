/**
 * Writes the first change at once and later ones at most every `waitMs`, whatever the typing
 * speed, so a crash loses a fraction of a second. Writes never overtake each other.
 */
export interface Autosave<T> {
  push: (value: T) => void;
  /** Writes what is waiting; resolves when it is on disk. */
  flush: () => Promise<void>;
  /** Flushes nothing: drops what is waiting and lets a running write finish. */
  stop: () => Promise<void>;
}

export function autosave<T>(write: (value: T) => Promise<void>, waitMs = 300): Autosave<T> {
  let waiting: { value: T } | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let chain: Promise<void> = Promise.resolve();
  let last = -Infinity;
  let stopped = false;

  const flush = (): Promise<void> => {
    clearTimeout(timer);
    timer = undefined;
    const next = waiting;
    waiting = null;
    if (next) {
      last = performance.now();
      chain = chain.then(() => write(next.value)).catch(() => undefined);
    }
    return chain;
  };

  return {
    push(value) {
      if (stopped) return;
      waiting = { value };
      timer ??= setTimeout(() => void flush(), Math.max(0, last + waitMs - performance.now()));
    },
    flush,
    stop() {
      stopped = true;
      clearTimeout(timer);
      waiting = null;
      return chain;
    },
  };
}
