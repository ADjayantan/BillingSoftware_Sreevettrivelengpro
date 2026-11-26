import Link from 'next/link';

type Params = Record<string, string | undefined>;

const search = (params: Params): string => new URLSearchParams(Object.entries(params).filter((entry): entry is [string, string] => Boolean(entry[1]))).toString();

export function Pager({ path, page, hasMore, params = {} }: { path: string; page: number; hasMore: boolean; params?: Params }) {
  const to = (target: number): string => `${path}?${search({ ...params, page: String(target) })}`;
  if (page === 1 && !hasMore) return null;
  return (
    <nav aria-label="Pages" className="flex flex-wrap items-center gap-2.5 border-t border-line px-5 py-3.5 max-side:px-0">
      <span className="mr-auto text-[14.5px] text-muted">Page {page}</span>
      {page > 1 ? <Link className="btn btn-small" href={to(page - 1)}>Back</Link> : null}
      {hasMore ? <Link className="btn btn-small" href={to(page + 1)}>Next</Link> : null}
    </nav>
  );
}

/** A plain form: finding works before any script has loaded. `keep` goes along. */
export function SearchBox({ path, q, label, keep = {} }: { path: string; q: string; label: string; keep?: Params }) {
  return (
    <form action={path} role="search" className="flex min-w-0 flex-1 gap-2">
      {Object.entries(keep).map(([name, value]) => (value ? <input key={name} type="hidden" name={name} value={value} /> : null))}
      <input className="field min-w-0" type="search" name="q" maxLength={60} defaultValue={q} placeholder={label} aria-label={label} />
      <button className="btn" type="submit">Find</button>
    </form>
  );
}
