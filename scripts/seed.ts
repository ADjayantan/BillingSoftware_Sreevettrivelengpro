/**
 * Turns specs/seed-data.json into SQL for a DEMO project's SQL editor. No keys needed:
 *   npm run --silent seed:sql > seed.sql
 * Re-runnable (upserts by id in one transaction), and refuses once real bills exist.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { weightForPieces } from '../src/lib/billing-math.ts';
import { istDate } from '../src/lib/india.ts';

const decimal = z.string().regex(/^-?\d+(\.\d+)?$/);
const grade = z.string().trim().toUpperCase(); // the fixture says "Brass"; the schema stores BRASS
const instant = z.iso.datetime({ offset: true });

const seedFile = z.object({
  _meta: z.object({
    metal_rates: z.object({
      opening_comparator_date: z.iso.date(),
      opening_rates_inr_per_kg: z.record(z.string(), decimal),
    }),
  }),
  customers: z.array(
    z.object({
      id: z.uuid(), name: z.string(), gstin: z.string(), phone: z.string(), state_code: z.string(),
      credit_days: z.number().int(), address: z.string(), opening_balance: decimal,
    }),
  ),
  stud_items: z.array(
    z.object({
      id: z.uuid(), sku_code: z.string(), diameter_mm: z.number(), length_mm: z.number(), thread_type: z.string(),
      material_grade: grade, hsn_sac: z.string(), unit_weight_kg: decimal.nullable(),
      default_rate_per_piece: decimal, default_rate_per_kg: decimal,
    }),
  ),
  // change_delta and balance_weight_kg are generated columns; previous_rate_per_kg is derived.
  metal_rates: z.array(z.object({ id: z.uuid(), material_grade: grade, rate_per_kg: decimal, source: z.string(), recorded_at: instant })),
  job_work_ledger: z.array(
    z.object({
      id: z.uuid(), customer_id: z.uuid(), party_dc_no: z.string(), material_grade: grade, inward_weight_kg: decimal,
      outward_weight_kg: decimal, scrap_weight_kg: decimal, status: z.enum(['open', 'closed']), created_at: instant,
    }),
  ),
});

type Row = Record<string, string | number | boolean | null>;
export interface SeedTable {
  table: 'customers' | 'stud_items' | 'metal_rates' | 'job_work_ledger';
  rows: Row[];
}

/** A stable uuid for a row the file does not give one, so re-running upserts it. */
function stableId(name: string): string {
  const hex = createHash('sha256').update(`studflow-seed:${name}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function buildSeed(json: unknown): SeedTable[] {
  const seed = seedFile.parse(json);
  const { opening_comparator_date: openingDate, opening_rates_inr_per_kg: openingRates } = seed._meta.metal_rates;
  return [
    { table: 'customers', rows: seed.customers },
    {
      table: 'stud_items',
      rows: seed.stud_items.map(({ unit_weight_kg, ...stud }) => ({
        ...stud,
        unit_weight_kg:
          unit_weight_kg ?? weightForPieces({ diameter_mm: String(stud.diameter_mm), length_mm: String(stud.length_mm) }, 1),
        unit_weight_is_manual: unit_weight_kg !== null,
      })),
    },
    {
      table: 'metal_rates',
      rows: [
        ...Object.entries(openingRates).map(([name, rate]) => ({
          id: stableId(`opening:${name}`),
          material_grade: grade.parse(name),
          rate_per_kg: rate,
          source: 'Opening comparator',
          recorded_at: `${openingDate}T09:00:00+05:30`,
        })),
        ...seed.metal_rates,
      ],
    },
    {
      table: 'job_work_ledger',
      rows: seed.job_work_ledger.map(({ created_at, ...lot }) => ({ ...lot, party_dc_date: istDate(new Date(created_at)) })),
    },
  ];
}

const literal = (value: Row[string]): string =>
  value === null ? 'null' : typeof value === 'string' ? `'${value.replaceAll("'", "''")}'` : String(value);

export function seedSql(tables: SeedTable[]): string {
  const inserts = tables.map(({ table, rows }) => {
    const columns = Object.keys(rows[0] ?? {});
    const values = rows.map((row) => `  (${columns.map((column) => literal(row[column] ?? null)).join(', ')})`);
    const updates = columns.filter((column) => column !== 'id').map((column) => `${column} = excluded.${column}`);
    return `insert into public.${table} (${columns.join(', ')}) values\n${values.join(',\n')}\non conflict (id) do update set ${updates.join(', ')};`;
  });
  return [
    '-- Fictional training data. Demo project only.',
    'begin;',
    `do $$ begin if exists (select 1 from public.invoices) then raise exception 'Refusing to load demo data: this project already has bills'; end if; end $$;`,
    ...inserts,
    'commit;',
    '',
  ].join('\n\n');
}

if (process.argv[1]?.endsWith('seed.ts')) {
  const file = new URL('../specs/seed-data.json', import.meta.url);
  process.stdout.write(seedSql(buildSeed(JSON.parse(readFileSync(file, 'utf8')))));
}
