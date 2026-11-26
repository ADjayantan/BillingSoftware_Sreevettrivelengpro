'use client';

import { useState, useSyncExternalStore } from 'react';
import { desktopBridge, printAnswerText, readPrintAnswer, type DesktopBridge } from '@/lib/desktop';

const unchanging = (): (() => void) => () => undefined;
const onServer = (): null => null;

/** In a browser, the browser's print window. In the PC app, straight to the printer kept for this paper. */
export function PrintButton() {
  // Read after the page has loaded: the server's page and the first browser render stay the same.
  const bridge = useSyncExternalStore(unchanging, desktopBridge, onServer);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState('');

  async function send(to: DesktopBridge, choose: boolean): Promise<void> {
    setBusy(true);
    setSaid('');
    try {
      setSaid(printAnswerText(readPrintAnswer(await (choose ? to.choosePrinter() : to.print()))));
    } catch {
      setSaid(printAnswerText({ ok: false, reason: 'failed' }));
    } finally {
      setBusy(false);
    }
  }

  if (bridge === null) return <button type="button" className="btn btn-primary" autoFocus onClick={() => window.print()}>Print</button>;
  return (
    <>
      <button type="button" className="btn btn-primary" autoFocus disabled={busy} onClick={() => void send(bridge, false)}>Print</button>
      <button type="button" className="btn" disabled={busy} onClick={() => void send(bridge, true)}>Change printer</button>
      <span role="status" className="text-[14px]">{said}</span>
    </>
  );
}
