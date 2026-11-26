'use client';

import { signOut } from '@/app/login/actions';
import { keepCompanyName } from '@/lib/company-name';
import { offlineEngine } from '@/lib/offline';
import { forgetShell } from '@/lib/service-worker';
import { Icon } from './icon';

/** Takes the customer copy, the company name and the offline page off the device before leaving. */
export function SignOut({ className = '' }: { className?: string }) {
  async function leave(): Promise<void> {
    const engine = await offlineEngine();
    const unsent = engine ? await engine.unsent().catch(() => 0) : 0;
    if (unsent > 0 && !window.confirm(`${unsent} bill${unsent === 1 ? ' is' : 's are'} still on this device. They stay here and go out when you sign in again. Sign out?`)) return;
    await engine?.forgetMasters().catch(() => undefined);
    await forgetShell();
    keepCompanyName('');
    await signOut();
  }
  return (
    <form action={leave}>
      <button className={className} type="submit"><Icon name="out" />Sign out</button>
    </form>
  );
}
