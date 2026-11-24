import Link from 'next/link';

export function Pager({ path, q, page, hasMore }: { path: string; q: string; page: number; hasMore: boolean }) {
  const to = (target: number) => `${path}?${new URLSearchParams({ ...(q ? { q } : {}), page: String(target) }).toString()}`;
  if (page === 1 && !hasMore) return null;
  return (
    <nav aria-label="Pages" className="mt-3 flex gap-3">
      {page > 1 ? <Link className="btn" href={to(page - 1)}>← Newer</Link> : null}
      {hasMore ? <Link className="btn" href={to(page + 1)}>More →</Link> : null}
    </nav>
  );
}

export function SearchBox({ path, q, label }: { path: string; q: string; label: string }) {
  return (
    <form action={path} role="search" className="flex gap-2">
      <input className="field" type="search" name="q" defaultValue={q} placeholder={label} aria-label={label} />
      <button className="btn" type="submit">Find</button>
    </form>
  );
}
