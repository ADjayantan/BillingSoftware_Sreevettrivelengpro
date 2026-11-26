'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

/** A link of the menu that knows when its page is open. */
export function NavLink({ href, className, children }: { href: string; className: string; children: ReactNode }) {
  const path = usePathname();
  const here = path === href || path.startsWith(`${href}/`);
  return <Link href={href} prefetch={false} className={className} {...(here ? { 'aria-current': 'page' as const } : {})}>{children}</Link>;
}
