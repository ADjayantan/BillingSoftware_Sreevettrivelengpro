'use client';

import { useSyncExternalStore } from 'react';
import { deviceState, noQueue, onQueueNote, queueNote } from '@/lib/queue-note';
import { useConnection } from '../use-connection';

/** The connection, and what waits on this device. */
export function Net({ short = false, className = '' }: { short?: boolean; className?: string }) {
  const connection = useConnection();
  const { state, text } = deviceState(connection, useSyncExternalStore(onQueueNote, queueNote, noQueue));
  return (
    <p className={`net ${className}`} data-state={state} role="status">
      <span className="net-dot" aria-hidden />
      {short ? text.split(' · ')[0] : text}
    </p>
  );
}
