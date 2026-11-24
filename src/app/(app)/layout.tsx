import Link from 'next/link';
import type { ReactNode } from 'react';
import { OfflineBar } from '@/components/offline-bar';
import { SignOut } from '@/components/sign-out';

const LINKS = [
  ['/billing', 'New bill'],
  ['/invoices', 'Bills'],
  ['/customers', 'Customers'],
  ['/stud-master', 'Studs'],
  ['/job-work', 'Job-work lots'],
  ['/company', 'Company'],
] as const;

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <header className="border-b border-line bg-card print:hidden">
        <nav aria-label="Main" className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-1 gap-y-1 px-3 py-2">
          <strong className="mr-3 text-lg">StudFlow</strong>
          {LINKS.map(([href, label]) => (
            <Link key={href} href={href} prefetch={false} className="rounded-md px-3 py-2 font-semibold hover:bg-paper">
              {label}
            </Link>
          ))}
          <SignOut />
        </nav>
      </header>
      <OfflineBar />
      <main className="mx-auto max-w-7xl px-3 py-4">{children}</main>
    </>
  );
}
