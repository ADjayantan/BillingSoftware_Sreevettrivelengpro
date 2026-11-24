import 'server-only';

/** What to ask for at a time: Supabase's own "Max rows". */
export const PAGE_ROWS = 1000;

/**
 * Every row a query matches. Supabase cuts each answer at its "Max rows" setting (1000) and says
 * nothing, so one request is never known to be the whole table. Walks by id, which rows added
 * meanwhile cannot shift, and stops only at an empty page: a short one may just be a lower setting.
 */
export async function readAllRows<T extends { id: string }>(
  page: (after: string | null) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<T[]> {
  const rows: T[] = [];
  for (;;) {
    const { data, error } = await page(rows.at(-1)?.id ?? null);
    if (error) throw error;
    if (!data?.length) return rows;
    rows.push(...data);
  }
}
