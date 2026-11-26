'use client';

import { useRouter } from 'next/navigation';
import { useState, useSyncExternalStore } from 'react';
import { api } from '@/lib/api-client';
import { desktopBridge } from '@/lib/desktop';
import { DRIVE_DISCONNECT_ASK, DRIVE_IN_PC_APP, disconnectedWord, type DriveState } from '@/lib/drive-words';

const unchanging = (): (() => void) => () => undefined;
const onServer = (): null => null;

/** The owner's Connect and Disconnect (specs/drive-button.md). */
export function DriveButtons({ state }: { state: DriveState }) {
  // Google signs in only in a real browser: the PC app sends it there (desktop/src/policy.ts).
  const inPcApp = useSyncExternalStore(unchanging, desktopBridge, onServer) !== null;
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState('');

  if (inPcApp) return <p className="mt-3 max-w-3xl text-muted">{DRIVE_IN_PC_APP}</p>;

  async function disconnect(): Promise<void> {
    if (!window.confirm(DRIVE_DISCONNECT_ASK)) return;
    setBusy(true);
    const reply = await api<{ state: DriveState }>('/api/drive/disconnect', 'POST');
    setBusy(false);
    setSaid(reply.ok ? disconnectedWord(reply.data.state) : reply.message);
    if (reply.ok) router.refresh();
  }

  return (
    <div className="mt-3 flex flex-wrap items-center gap-3">
      {/* A plain link, not <Link>: nothing may fetch this address ahead of the owner's click. */}
      <a className="btn btn-primary" href="/api/drive/connect">{state === 'off' ? 'Connect Google Drive' : 'Connect again'}</a>
      {state === 'button' ? <button type="button" className="btn" disabled={busy} onClick={() => void disconnect()}>Disconnect</button> : null}
      <span role="status" className="text-[14px]">{said}</span>
    </div>
  );
}
