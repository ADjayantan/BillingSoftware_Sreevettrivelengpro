'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { Icon } from '../icon';

/** One box for everything. A plain form: it works before any script has loaded. The one on top also has the keys of the whole app. */
export function FindBox({ keys = false, className = '' }: { keys?: boolean; className?: string }) {
  const input = useRef<HTMLInputElement>(null);
  const router = useRouter();
  useEffect(() => {
    if (!keys) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.altKey && !event.ctrlKey && !event.metaKey && event.code === 'KeyN') {
        // A page with a new record of its own (useAltN) comes first, whoever was asked first.
        setTimeout(() => {
          if (!event.defaultPrevented) router.push('/billing');
        });
        return;
      }
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== 'k') return;
      event.preventDefault();
      input.current?.focus();
      input.current?.select();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [keys, router]);
  return (
    <form action="/find" role="search" className={`find-box ${className}`}>
      <input ref={input} type="search" name="q" maxLength={60} autoComplete="off" required placeholder="Find a bill, customer or product" aria-label="Find a bill, customer or product" />
      {keys ? <kbd className="kbd max-lg:hidden">Ctrl K</kbd> : null}
      <Icon name="search" />
    </form>
  );
}
