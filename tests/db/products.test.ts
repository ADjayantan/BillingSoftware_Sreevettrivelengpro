// 005: the stud table becomes the product list. An ID from the database for every product, a
// name, and a size only for studs (specs/company-products.md).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import {
  ACTORS,
  createTestDb,
  goodsLine,
  intraStatePayload,
  migrationFiles,
  pgError,
  queryAs,
  seedMasterData,
  syncInvoice,
  type Actor,
  type MasterData,
} from './harness';

interface Saved {
  id: string;
  product_no: number;
  sku_code: string;
  search_text: string;
}

const STUD = { diameter_mm: 8, length_mm: 45, thread_type: 'Full thread', material_grade: 'MS', unit_weight_kg: '0.017756' };

let db: PGlite;
let md: MasterData;
beforeAll(async () => {
  db = await createTestDb();
  md = await seedMasterData(db);
});
afterAll(async () => {
  await db.close();
});

async function insert(facts: Record<string, unknown>, actor: Actor = ACTORS.staff): Promise<Saved> {
  const names = Object.keys(facts);
  const rows = await queryAs<Saved>(
    db,
    actor,
    `insert into public.stud_items (${names.join(', ')}) values (${names.map((_, i) => `$${i + 1}`).join(', ')})
     returning id, product_no, sku_code, search_text`,
    Object.values(facts),
  );
  return rows[0]!;
}
/** A product as the app saves it: HSN and GST % typed. */
const add = (facts: Record<string, unknown>) => insert({ hsn_sac: '731816', gst_rate_percent: '18', ...facts });
const edit = async (id: string, set: string, params: unknown[] = [], actor: Actor = ACTORS.staff): Promise<Saved> =>
  (await queryAs<Saved>(db, actor, `update public.stud_items set ${set} where id = $1 returning id, product_no, sku_code, search_text`, [id, ...params]))[0]!;

describe('product ID', () => {
  it('is the next number, for a stud and for anything else', async () => {
    const nut = await add({ name: 'Hex nut M12 GI' });
    const stud = await add({ ...STUD, sku_code: 'MS-M8-45-FT' });
    const washer = await add({ name: 'Washer M12' });
    expect([stud.product_no, washer.product_no]).toEqual([nut.product_no + 1, nut.product_no + 2]);
  });

  it('is never given again, even when its product is deleted', async () => {
    const gone = await add({ name: 'Short-lived' });
    expect(await queryAs(db, ACTORS.owner, 'delete from public.stud_items where id = $1 returning id', [gone.id])).toHaveLength(1);
    expect((await add({ name: 'After it' })).product_no).toBe(gone.product_no + 1);
  });

  it('cannot be typed or changed by anyone', async () => {
    expect((await pgError(add({ name: 'Typed', product_no: 900 }))).code).toBe('428C9');
    const product = await add({ name: 'Fixed' });
    for (const actor of [ACTORS.staff, ACTORS.owner, ACTORS.sqlEditor]) {
      expect((await pgError(edit(product.id, 'product_no = 900', [], actor))).code).toBe('428C9');
      expect((await edit(product.id, 'product_no = default', [], actor)).product_no).toBe(product.product_no);
    }
  });

  it.each([[1, 'P0001'], [42, 'P0042'], [9999, 'P9999'], [10000, 'P10000'], [2147483647, 'P2147483647']])('%i is written %s', async (no, code) => {
    const { rows } = await db.query<{ code: string }>('select private.product_code($1) as code', [no]);
    expect(rows[0]?.code).toBe(code);
  });
});

describe('own code', () => {
  const idOf = (product: Saved): string => `P${String(product.product_no).padStart(4, '0')}`;

  it('is the product ID when nobody gave one, on saving and on editing', async () => {
    for (const nothing of [null, '', '   ']) {
      const product = await add({ name: 'No code', sku_code: nothing });
      expect(product.sku_code).toBe(idOf(product));
    }
    const untold = await add({ name: 'Column not even named' });
    expect(untold.sku_code).toBe(idOf(untold));
    const named = await add({ name: 'Had one', sku_code: 'HAD-1' });
    expect((await edit(named.id, 'sku_code = $2', [''])).sku_code).toBe(idOf(named));
  });

  it('may not look like the ID of another product, taken or not', async () => {
    const own = await add({ name: 'Own ID' });
    for (const code of ['P0099', 'P99', 'P0', 'P123456']) {
      expect(await pgError(add({ name: 'Borrowed', sku_code: code }))).toMatchObject({ code: '23514', message: expect.stringContaining('stud_items_own_code') });
      expect((await pgError(edit(own.id, 'sku_code = $2', [code]))).code).toBe('23514');
    }
    expect((await edit(own.id, 'sku_code = $2', [own.sku_code])).sku_code).toBe(own.sku_code);
    expect((await add({ name: 'Pin', sku_code: 'P7A' })).sku_code).toBe('P7A');
    expect((await add({ name: 'Pin', sku_code: 'PIN-7' })).sku_code).toBe('PIN-7');
  });

  it('stays unique', async () => {
    await add({ name: 'First', sku_code: 'SAME-1' });
    expect(await pgError(add({ name: 'Second', sku_code: 'SAME-1' }))).toMatchObject({ code: '23505', message: expect.stringContaining('stud_items_sku_code_key') });
  });
});

describe('what a product must have', () => {
  const refused = async (facts: Record<string, unknown>) => expect(await pgError(add(facts)), JSON.stringify(facts)).toMatchObject({ code: '23514' });

  it('is a name, or the whole size of a stud', async () => {
    await add({ name: 'Only a name' });
    await add({ ...STUD });
    await add({ ...STUD, name: 'Both' });
    await refused({});
    await refused({ name: '   ' });
    await refused({ name: 'x'.repeat(121) });
  });

  it('is never part of a size', async () => {
    for (const missing of ['diameter_mm', 'length_mm', 'thread_type', 'material_grade', 'unit_weight_kg'] as const) {
      const part: Record<string, unknown> = { name: 'Named all the same', ...STUD };
      delete part[missing];
      await refused(part);
    }
  });

  it('is a weight only from the formula of a stud, or weighed', async () => {
    const weighed = await add({ name: 'Nut', unit_weight_kg: '0.0125', unit_weight_is_manual: true });
    expect(weighed.product_no).toBeGreaterThan(0);
    await refused({ name: 'Nut', unit_weight_kg: '0.0125' }); // no size to compute it from
    await refused({ name: 'Nut', unit_weight_is_manual: true }); // weighed, but what?
    await refused({ name: 'Nut', unit_weight_kg: 'NaN', unit_weight_is_manual: true });
    await refused({ name: 'Nut', unit_weight_kg: '0', unit_weight_is_manual: true });
    await refused({ ...STUD, unit_weight_kg: '0.5' }); // not what 8 × 45 weighs
  });

  it('is an HSN and a GST % somebody gave: neither is assumed', async () => {
    expect((await pgError(insert({ name: 'No GST', hsn_sac: '731816' }))).code).toBe('23502');
    expect((await pgError(insert({ name: 'No HSN', gst_rate_percent: '18' }))).code).toBe('23502');
    expect((await pgError(add({ name: 'Bad GST', gst_rate_percent: '118' }))).code).toBe('23514');
  });
});

describe('finding', () => {
  it('reads name, code and size in one text that follows every edit', async () => {
    const stud = await add({ ...STUD, name: 'Stud for Vel', sku_code: 'VEL-1', length_mm: '45.5', unit_weight_kg: '0.017953' });
    expect(stud.search_text).toBe('STUD FOR VEL VEL-1 M8X45.5 MS');
    expect((await edit(stud.id, "name = 'New name', material_grade = 'EN8'")).search_text).toBe('NEW NAME VEL-1 M8X45.5 EN8');
    const nut = await add({ name: 'Hex nut' });
    expect(nut.search_text).toBe(`HEX NUT ${nut.sku_code}`);
    expect((await add({ ...STUD, sku_code: 'NO-NAME' })).search_text).toBe('NO-NAME M8X45 MS');
  });
});

describe('a product on a bill', () => {
  it('needs no size or weight, and cannot be deleted afterwards', async () => {
    const nut = await add({ name: 'Billed nut' });
    const bill = await syncInvoice(db, ACTORS.staff, intraStatePayload(md, { items: [goodsLine(md, { stud_item_id: nut.id, description: 'Billed nut', total_weight_kg: null })] }));
    const lines = await queryAs(db, ACTORS.staff, 'select stud_item_id, total_weight_kg from public.invoice_items where invoice_id = $1', [bill.invoice_id]);
    expect(lines).toEqual([{ stud_item_id: nut.id, total_weight_kg: null }]);
    expect((await pgError(queryAs(db, ACTORS.owner, 'delete from public.stud_items where id = $1', [nut.id]))).code).toBe('23503');
  });

  it('does not change when the product does', async () => {
    const nut = await add({ name: 'Nut before' });
    const bill = await syncInvoice(db, ACTORS.staff, intraStatePayload(md, { items: [goodsLine(md, { stud_item_id: nut.id, description: 'Nut before', total_weight_kg: null })] }));
    await edit(nut.id, "name = 'Nut after', gst_rate_percent = 5, hsn_sac = '7326'");
    const lines = await queryAs(db, ACTORS.staff, 'select description, hsn_sac, tax_rate_percent::text as gst from public.invoice_items where invoice_id = $1', [bill.invoice_id]);
    expect(lines).toEqual([{ description: 'Nut before', hsn_sac: '7318', gst: '18.00' }]);
  });

  it('keeps every edit in the log, with the ID and the name', async () => {
    const nut = await add({ name: 'Logged before' });
    await edit(nut.id, "name = 'Logged after'");
    const { rows } = await db.query<{ old: unknown; new: unknown }>(
      `select old_row -> 'name' as old, new_row -> 'name' as new from private.audit_log where row_id = $1 and (old_row ->> 'product_no')::int = $2`,
      [nut.id, nut.product_no],
    );
    expect(rows).toEqual([{ old: 'Logged before', new: 'Logged after' }]);
  });
});

describe('the migration', () => {
  it('numbers the studs that are already there and leaves everything else about them', async () => {
    const live = await createTestDb({ upTo: '004' });
    try {
      const before = await seedMasterData(live);
      await live.exec(`
        insert into public.stud_items (sku_code, diameter_mm, length_mm, thread_type, material_grade, unit_weight_kg, unit_weight_is_manual)
        values ('BRASS-1', 10, 100, 'Metric', 'BRASS', 0.0669, true)`);
      const bill = await syncInvoice(live, ACTORS.staff, intraStatePayload(before));
      const rows = async () => (await live.query<Record<string, unknown>>('select * from public.stud_items order by created_at, sku_code')).rows;
      const old = await rows();

      const products = migrationFiles().find(({ name }) => name.startsWith('005'));
      await live.exec(`set role supabase_postgres; ${products?.sql ?? ''}; reset role;`);

      const now = await rows();
      expect(now).toHaveLength(2);
      now.forEach((row, i) => expect(row).toMatchObject(old[i]!));
      expect(now.map((row) => row.product_no).sort()).toEqual([1, 2]);
      expect(now.map((row) => row.name)).toEqual([null, null]);
      const lines = await queryAs(live, ACTORS.staff, 'select stud_item_id from public.invoice_items where invoice_id = $1', [bill.invoice_id]);
      expect(lines).toEqual([{ stud_item_id: before.studItemId }]);

      // What the version before this one sends.
      const saved = await queryAs<{ product_no: number }>(
        live,
        ACTORS.staff,
        `insert into public.stud_items (sku_code, diameter_mm, length_mm, thread_type, material_grade, hsn_sac, gst_rate_percent,
                                        unit_weight_kg, unit_weight_is_manual, default_rate_per_piece, default_rate_per_kg, is_active)
         values ('OLD-APP', 8, 45, 'Full thread', 'MS', '731815', 18, 0.017756, false, 3.1, null, true) returning product_no`,
      );
      expect(saved).toEqual([{ product_no: 3 }]);
    } finally {
      await live.close();
    }
  });

  it.each(['none', 'legacy-grant-all'] as const)('gives no API role the ID counter (platform default: %s)', async (platformGrants) => {
    const other = await createTestDb({ platformGrants });
    try {
      const { rows } = await other.query(`
        select c.relname, r.role, p.priv
          from pg_class c cross join unnest(array['anon', 'authenticated', 'service_role']) as r(role)
         cross join unnest(array['USAGE', 'SELECT', 'UPDATE']) as p(priv)
         where c.relnamespace in ('public'::regnamespace, 'private'::regnamespace) and c.relkind = 'S' and has_sequence_privilege(r.role, c.oid, p.priv)`);
      expect(rows).toEqual([]);
      const counters = await other.query<{ relname: string }>(`select relname from pg_class where relnamespace = 'public'::regnamespace and relkind = 'S'`);
      expect(counters.rows).toEqual([{ relname: 'stud_items_product_no_seq' }]);
    } finally {
      await other.close();
    }
  });
});
