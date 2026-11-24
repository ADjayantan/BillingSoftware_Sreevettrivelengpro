import { listQuery } from '@/lib/schemas/common';

/** Search params from the URL bar are untrusted too; a bad one falls back to page 1. */
export async function pageQuery(searchParams: Promise<Record<string, string | string[] | undefined>>): Promise<{ q: string; page: number }> {
  const result = listQuery.safeParse(await searchParams);
  return result.success ? result.data : { q: '', page: 1 };
}
