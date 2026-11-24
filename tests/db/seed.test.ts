import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { buildSeed, seedSql } from '../../scripts/seed';
import { weightForPieces } from '../../src/lib/billing-math';
import { ACTORS, createTestDb, intraStatePayload, pgError, queryAs, seedMasterData, syncInvoice } from './harness';

const json = JSON.parse(readFileSync(new URL('../../specs/seed-data.json', import.meta.url), 'utf8'));

describe('demo seed', () => {
  const tables = buildSeed(json);
  let db: PGlite;
  beforeAll(async () => {
    db = await createTestDb();
    await db.exec(`set role supabase_postgres; ${seedSql(tables)} reset role;`); // as the SQL editor runs it
  });
  afterAll(async () => {
    await db.close();
  });

  it('loads every row and is re-runnable', async () => {
    const counts = async () =>
      (
        await db.query(`select (select count(*) from public.customers)::int as customers, (select count(*) from public.stud_items)::int as studs,
                               (select count(*) from public.metal_rates)::int as rates, (select count(*) from public.job_work_ledger)::int as lots`)
      ).rows[0];
    const expected = { customers: 8, studs: 15, rates: 66, lots: 3 };
    expect(await counts()).toEqual(expected);
    await db.exec(seedSql(tables));
    expect(await counts()).toEqual(expected);
  });

  it('computes a missing unit weight by the formula and keeps a measured one', async () => {
    const studs = await queryAs<{ sku_code: string; w: string; manual: boolean; d: string; l: string }>(
      db,
      ACTORS.staff,
      `select sku_code, unit_weight_kg::text as w, unit_weight_is_manual as manual, trim_scale(diameter_mm)::text as d, trim_scale(length_mm)::text as l from public.stud_items`,
    );
    const source = new Map<string, string | null>(json.stud_items.map((s: { sku_code: string; unit_weight_kg: string | null }) => [s.sku_code, s.unit_weight_kg]));
    for (const stud of studs) {
      const given = source.get(stud.sku_code) ?? null;
      expect(stud.manual, stud.sku_code).toBe(given !== null);
      expect(stud.w).toBe(given ?? weightForPieces({ diameter_mm: stud.d, length_mm: stud.l }, 1));
    }
    expect(studs.filter((s) => !s.manual)).toHaveLength(10);
  });

  it('seeds the opening rates first, so derived changes match the fixture', async () => {
    expect(tables[2]!.rows.slice(0, 6).map((r) => r.material_grade)).toEqual(['MS', 'EN8', 'EN19', 'SS 304', 'SS 316', 'BRASS']);
    const rates = await queryAs<{ id: string; delta: string; previous: string }>(
      db,
      ACTORS.staff,
      `select id, round(change_delta, 2)::text as delta, round(previous_rate_per_kg, 2)::text as previous from public.metal_rates where source <> 'Opening comparator'`,
    );
    const stored = new Map(rates.map((r) => [r.id, r]));
    for (const rate of json.metal_rates) {
      expect(stored.get(rate.id), `${rate.material_grade} ${rate.recorded_at}`).toMatchObject({ delta: rate.change_delta, previous: rate.previous_rate_per_kg });
    }
  });

  it('omits generated columns and dates each lot from its IST created_at', async () => {
    for (const { rows } of tables) {
      for (const row of rows) {
        expect(row).not.toHaveProperty('change_delta');
        expect(row).not.toHaveProperty('balance_weight_kg');
      }
    }
    const lots = await queryAs(db, ACTORS.staff, `select party_dc_no, party_dc_date::text as dated, balance_weight_kg::text as balance, status from public.job_work_ledger order by 2`);
    expect(lots).toEqual([
      { party_dc_no: 'VPC/26-27/0168', dated: '2026-11-09', balance: '0.000', status: 'closed' },
      { party_dc_no: 'BMS/26-27/0074', dated: '2026-11-12', balance: '72.250', status: 'open' },
      { party_dc_no: 'PVF/26-27/0106', dated: '2026-11-16', balance: '0.000', status: 'closed' },
    ]);
    // 00:30 IST is still the previous day in UTC.
    const late = structuredClone(json);
    late.job_work_ledger[0].created_at = '2026-11-10T00:30:00+05:30';
    expect(buildSeed(late)[3]!.rows[0]!.party_dc_date).toBe('2026-11-10');
  });

  it('refuses a project that already has bills', async () => {
    const live = await createTestDb();
    try {
      await syncInvoice(live, ACTORS.staff, intraStatePayload(await seedMasterData(live)));
      expect((await pgError(live.exec(seedSql(tables)))).message).toMatch(/already has bills/);
      await live.exec('rollback');
    } finally {
      await live.close();
    }
  });
});
