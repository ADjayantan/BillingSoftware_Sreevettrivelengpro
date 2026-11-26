import Link from 'next/link';
import { MENU } from '@/components/frame/menu';
import { Icon } from '@/components/icon';
import { PageHead } from '@/components/page-head';
import { SignOut } from '@/components/sign-out';

/** The whole menu, for a phone. */
export default function MorePage() {
  return (
    <>
      <PageHead title="Everything" />
      <div className="grid grid-cols-3 gap-2.5 sm:grid-cols-4">
        {MENU.flatMap(({ entries }) => entries).map(({ href, label, icon }) => (
          <Link key={href} href={href} prefetch={false} className="card grid justify-items-center gap-2 px-1.5 py-4 text-center text-[14.5px] font-semibold">
            <span className="grid size-11 place-items-center rounded-full bg-soft text-accent"><Icon name={icon} className="size-6" /></span>
            {label}
          </Link>
        ))}
      </div>
      <div className="mt-4"><SignOut className="btn" /></div>
    </>
  );
}
