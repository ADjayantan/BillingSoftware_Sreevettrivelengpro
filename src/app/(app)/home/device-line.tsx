'use client';

import { useSyncExternalStore } from 'react';
import { Icon } from '@/components/icon';
import { noQueue, onQueueNote, queueNote } from '@/lib/queue-note';

/** What still waits on this PC or phone: only the device itself knows. */
export function DeviceLine() {
  const { pending, attention } = useSyncExternalStore(onQueueNote, queueNote, noQueue);
  const waiting = pending + attention;
  return (
    <li className="flex items-center gap-3.5 border-b border-line py-3">
      <Icon name={waiting === 0 ? 'device' : 'clock'} className={`size-6 ${waiting === 0 ? 'text-accent' : 'text-due'}`} />
      <span className="min-w-0">
        <b className="block font-semibold">This device</b>
        <small className="block text-[13.5px] text-muted">{waiting === 0 ? 'Nothing is waiting to be sent' : `${waiting} bill${waiting === 1 ? '' : 's'} not sent yet`}</small>
      </span>
    </li>
  );
}
