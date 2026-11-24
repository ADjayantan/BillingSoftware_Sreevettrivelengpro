'use client';

import { signOut } from '@/app/login/actions';
import { offlineEngine } from '@/lib/offline';
import { forgetShell } from '@/lib/service-worker';

/** Takes the customer copy and the offline page off the PC before leaving. */
export function SignOut() {
  async function leave(): Promise<void> {
    const engine = await offlineEngine();
    const unsent = engine ? await engine.unsent().catch(() => 0) : 0;
    if (unsent > 0 && !window.confirm(`${unsent} bill(s) on this PC are not sent yet. They stay here and go out at the next sign-in. Sign out?`)) return;
    await engine?.forgetMasters().catch(() => undefined);
    await forgetShell();
    await signOut();
  }
  return (
    <form action={leave} className="ml-auto">
      <button className="rounded-md px-3 py-2 text-muted" type="submit">Sign out</button>
    </form>
  );
}
