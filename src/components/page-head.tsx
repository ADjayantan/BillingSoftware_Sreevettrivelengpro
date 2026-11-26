import Link from 'next/link';
import type { ReactNode } from 'react';

/** The way here, for pages below another one. */
export function Trail({ steps, here }: { steps: readonly (readonly [href: string, label: string])[]; here: string }) {
  return (
    <nav aria-label="The way here" className="trail">
      {steps.map(([href, label]) => <span key={href} className="flex gap-2"><Link href={href} prefetch={false}>{label}</Link><span aria-hidden>/</span></span>)}
      <b className="font-semibold text-ink-2 wrap-anywhere">{here}</b>
    </nav>
  );
}

/** The top of a page: what it is, one line about it, and what can be done here. */
export function PageHead({ title, note, children }: { title: ReactNode; note?: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end gap-x-4 gap-y-3 max-side:mb-4">
      <div className="min-w-0">
        <h1 className="page-title flex flex-wrap items-center gap-x-3 gap-y-1 wrap-anywhere">{title}</h1>
        {note ? <p className="mt-0.5 text-[14.5px] text-muted wrap-anywhere">{note}</p> : null}
      </div>
      {children ? <div className="ml-auto flex flex-wrap items-center gap-2.5 max-side:ml-0 max-side:w-full">{children}</div> : null}
    </div>
  );
}
