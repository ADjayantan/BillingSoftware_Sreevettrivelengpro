import 'server-only';
import { isAuthRetryableFetchError } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { ApiError, body, must, toApiError, unavailable } from '@/lib/api/http';
import {
  MarginCheckRequestSchema,
  MarginCheckResponseSchema,
  type MarginCheckRequest,
  type MarginCheckResponse,
} from '@/lib/gemini';
import { getCachedJwks } from '@/lib/supabase/jwks';
import { createClient } from '@/lib/supabase/server';

const NO_STORE = { 'cache-control': 'no-store' };
const LOW_MARGIN_TANGLISH =
  'Indha rate-la namma minimum margin kidaikkaadhu. Rate-a marubadiyum paarunga.';

interface Rational {
  num: bigint;
  den: bigint;
}

function parseRational(dec: string | number): Rational {
  const clean = String(dec).trim();
  const m = /^(\d+)(?:\.(\d+))?$/.exec(clean);
  if (!m) throw new Error(`Invalid decimal: ${clean}`);
  const whole = m[1]!;
  const frac = m[2] ?? '';
  return {
    num: BigInt(whole + frac),
    den: 10n ** BigInt(frac.length),
  };
}

function addRational(a: Rational, b: Rational): Rational {
  return { num: a.num * b.den + b.num * a.den, den: a.den * b.den };
}

function mulRational(a: Rational, b: Rational): Rational {
  return { num: a.num * b.num, den: a.den * b.den };
}

function isStrictlyLess(a: Rational, b: Rational): boolean {
  return a.num * b.den < b.num * a.den;
}

export interface StudCostRow {
  id: string;
  diameter_mm: number | string;
  length_mm: number | string;
  material_grade: string;
  unit_weight_kg: number | string;
  unit_weight_is_manual: boolean;
}

export interface MetalRateCostRow {
  material_grade: string;
  rate_per_kg: number | string;
}

/**
 * Pure rational margin evaluator matching `specs/ai-voice-test-cases.json` contract.
 * Checks `confirmed_amount * (1 - min_margin_pct/100) < per_quantity * (raw_rate + conversion_cost) * unit_mass`.
 */
export function evaluateMarginCheck(options: {
  input: MarginCheckRequest;
  studsById: ReadonlyMap<string, StudCostRow>;
  ratesByGrade: ReadonlyMap<string, Rational>;
  minGrossMarginPercent?: string;
  conversionCostInrPerKg?: string;
  hasLabourCostSchedule?: boolean;
}): MarginCheckResponse {
  const minMargin = parseRational(options.minGrossMarginPercent ?? '10.00');
  // retainFactor = 1 - (minMargin / 100) = (100*den - num) / (100*den)
  const retainFactor: Rational = {
    num: 100n * minMargin.den - minMargin.num,
    den: 100n * minMargin.den,
  };
  const conversionCost = parseRational(options.conversionCostInrPerKg ?? '12.00');
  const hasLabourSchedule = options.hasLabourCostSchedule ?? false;

  const margin_alerts: MarginCheckResponse['margin_alerts'] = [];
  const warnings: MarginCheckResponse['warnings'] = [];

  options.input.items.forEach((line, index) => {
    // Precedence 1: job_work without labour cost schedule
    if (options.input.bill_type === 'job_work' && !hasLabourSchedule) {
      warnings.push({ code: 'LABOUR_COST_UNAVAILABLE', line: index });
      return;
    }

    // Precedence 2: unresolved stud item
    const stud = line.stud_item_id ? options.studsById.get(line.stud_item_id) : undefined;
    if (!line.stud_item_id || !stud) {
      warnings.push({ code: 'ITEM_UNRESOLVED', line: index });
      return;
    }

    // Precedence 3: missing billing unit
    if (line.billing_unit === null) {
      warnings.push({ code: 'BILLING_UNIT_MISSING', line: index });
      return;
    }

    // Precedence 4: unconfirmed rate
    if (line.confirmed_rate === null) {
      warnings.push({ code: 'RATE_UNCONFIRMED', line: index });
      return;
    }

    // Precedence 5: unit mismatch between confirmed_rate.per_unit and line.billing_unit
    if (line.confirmed_rate.per_unit !== line.billing_unit) {
      warnings.push({ code: 'RATE_UNIT_MISMATCH', line: index });
      return;
    }

    const rawRate = options.ratesByGrade.get(stud.material_grade.trim().toUpperCase());
    if (!rawRate) {
      warnings.push({ code: 'ITEM_UNRESOLVED', line: index });
      return;
    }

    const costPerKg = addRational(rawRate, conversionCost);

    let unitMass: Rational;
    if (line.billing_unit === 'kg') {
      unitMass = { num: 1n, den: 1n };
    } else if (stud.unit_weight_is_manual) {
      unitMass = parseRational(stud.unit_weight_kg);
    } else {
      // Exact steel formula: (diameter_mm^2 / 162.2) * (length_mm / 1000) = (d^2 * l) / 162200
      const d = parseRational(stud.diameter_mm);
      const l = parseRational(stud.length_mm);
      const d2l = mulRational(mulRational(d, d), l);
      unitMass = { num: d2l.num, den: d2l.den * 162200n };
    }

    const unitCost = mulRational(costPerKg, unitMass);
    const perQty = parseRational(line.confirmed_rate.per_quantity);
    const requiredCostForN = mulRational(perQty, unitCost);

    const confirmedAmount = parseRational(line.confirmed_rate.amount_inr);
    const netRetainedForN = mulRational(confirmedAmount, retainFactor);

    if (isStrictlyLess(netRetainedForN, requiredCostForN)) {
      margin_alerts.push({
        code: 'LOW_MARGIN',
        line: index,
        warning_tanglish: LOW_MARGIN_TANGLISH,
      });
    }
  });

  return MarginCheckResponseSchema.parse({ margin_alerts, warnings });
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    if (request.headers.get('sec-fetch-site') === 'cross-site') {
      throw new ApiError(403, 'FORBIDDEN', 'Cross-site request refused');
    }
    const [supabase, jwks] = await Promise.all([createClient(), getCachedJwks()]);
    const { data: authData, error: authError } = await supabase.auth.getClaims(undefined, jwks ? { jwks } : undefined);
    if (isAuthRetryableFetchError(authError)) throw unavailable();
    if (authData === null) throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in again');

    const input = await body(request, MarginCheckRequestSchema);

    const ids = [...new Set(input.items.flatMap((item) => item.stud_item_id ?? []))];
    const [studRows, rateRows] = await Promise.all([
      ids.length === 0
        ? Promise.resolve([] as StudCostRow[])
        : Promise.resolve(
            supabase
              .from('stud_items')
              .select('id, diameter_mm, length_mm, material_grade, unit_weight_kg, unit_weight_is_manual')
              .in('id', ids)
              .eq('is_active', true)
              .not('diameter_mm', 'is', null), // studs only: nothing else has a metal cost to compare with
          ).then((res) => must(res) as StudCostRow[]),
      Promise.resolve(supabase.from('latest_metal_rates').select('material_grade, rate_per_kg')).then(
        (res) => must(res) as MetalRateCostRow[],
      ),
    ]);

    const studsById = new Map<string, StudCostRow>();
    for (const s of studRows) {
      studsById.set(s.id, s);
    }

    const ratesByGrade = new Map<string, Rational>();
    for (const r of rateRows) {
      ratesByGrade.set(r.material_grade.trim().toUpperCase(), parseRational(r.rate_per_kg));
    }

    const response = evaluateMarginCheck({
      input,
      studsById,
      ratesByGrade,
    });

    return NextResponse.json(response, { status: 200, headers: NO_STORE });
  } catch (error) {
    const apiErr = toApiError(error);
    return NextResponse.json(
      { error: { code: apiErr.code, message: apiErr.message } },
      { status: apiErr.status, headers: NO_STORE },
    );
  }
}
