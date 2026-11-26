'use client';

import Link from 'next/link';
import { useRef, type ReactNode } from 'react';

/** The + menu. The browser opens, closes and covers it (popover); a click on a link only has to close it. */
export function MakeMenu({ children }: { children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={box} id="make-menu" popover="auto" className="sheet-menu" role="dialog" aria-label="Make something new"
      onClick={(event) => {
        if (event.target instanceof Element && event.target.closest('a')) box.current?.hidePopover();
      }}
    >
      {children}
    </div>
  );
}

export function MakeLink({ href, children }: { href: string; children: ReactNode }) {
  return <Link href={href} className="menu-link">{children}</Link>;
}
