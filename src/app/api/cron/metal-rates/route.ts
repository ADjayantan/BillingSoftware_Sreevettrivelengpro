import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { verifyCronAuth } from '@/app/api/cron/weekly-backup/route';
import {
  CANONICAL_METAL_GRADES,
  parseDealerRateMessage,
  type DealerRateParsed,
  type MetalGradeCanonical,
} from '@/lib/gemini';
import { createAdminClient } from '@/lib/supabase/admin';
import { sendTelegramAlert } from '@/lib/telegram';

const NO_STORE = { 'cache-control': 'no-store' };

export const DealerMessageInputSchema = z.object({
  source_channel: z.enum(['whatsapp', 'telegram', 'manual']).default('whatsapp'),
  source_conversation_id: z.string().trim().min(1).max(80).default('dealer-yard'),
  source_message_id: z.string().trim().min(1).max(80),
  received_at: z.string().trim().min(1).optional(),
  raw_message: z.string().trim().min(1).max(4000),
});

export type DealerMessageInput = z.infer<typeof DealerMessageInputSchema>;

export interface NormalizedMetalRateRow {
  material_grade: MetalGradeCanonical;
  rate_per_kg: string;
  previous_rate_per_kg: string | null;
  change_delta: string | null;
  triggered: boolean;
}

export interface MetalRateProcessResult {
  parsed_json: DealerRateParsed;
  normalized_rates: NormalizedMetalRateRow[];
  should_notify: boolean;
  telegram_text: string | null;
  telegram_sent: boolean;
  replayed: boolean;
}

const IST_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

function formatIstDayMonth(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  // Shift to IST (+05:30 = 330 minutes)
  const istMs = date.getTime() + 330 * 60 * 1000;
  const ist = new Date(istMs);
  const day = ist.getUTCDate();
  const month = IST_MONTHS[ist.getUTCMonth()] ?? 'Nov';
  return `${day} ${month}`;
}

function toCents(amount: string | number): number {
  const num = Number(amount);
  return Math.round(num * 100);
}

function formatTwoDecimals(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${(abs / 100).toFixed(2)}`;
}

export function formatMetalRateTelegramAlert(
  receivedAt: string,
  triggeredRows: readonly NormalizedMetalRateRow[],
): string | null {
  if (triggeredRows.length === 0) return null;

  const dayMon = formatIstDayMonth(receivedAt);
  const deltas = triggeredRows.map((r) => toCents(r.change_delta ?? '0'));
  const allPositive = deltas.every((d) => d > 0);
  const allNegative = deltas.every((d) => d < 0);

  const verb = allPositive
    ? 'Rod rate yeriduchu'
    : allNegative
      ? 'Rod rate kurainjirukku'
      : 'Rod rate maariyirukku';

  const header = `${dayMon} | ${verb} (₹/kg)`;

  const formattedItems = triggeredRows.map((row) => {
    const label = row.material_grade === 'BRASS' ? 'Brass' : row.material_grade;
    const deltaCents = toCents(row.change_delta ?? '0');
    const sign = deltaCents >= 0 ? '+₹' : '-₹';
    const absDelta = (Math.abs(deltaCents) / 100).toFixed(2);
    return `${label} ₹${row.rate_per_kg} (${sign}${absDelta})`;
  });

  const bodyLines: string[] = [];
  for (let i = 0; i < formattedItems.length; i += 2) {
    const pair = formattedItems.slice(i, i + 2);
    bodyLines.push(pair.join(' · '));
  }

  return [header, ...bodyLines, 'Pudhu quotation-ku indha rate-a paathukkonga.'].join('\n');
}

export function buildSourceKey(input: {
  source_channel: string;
  source_conversation_id: string;
  source_message_id: string;
}): string {
  const raw = `${input.source_channel}:${input.source_conversation_id}:${input.source_message_id}`;
  return raw.slice(0, 60);
}

/**
 * Processes a dealer metal-rate message end-to-end:
 * 1. Parses and validates quotes via Zod (`parseDealerRateMessage`)
 * 2. Deduplicates replayed `(source_channel, source_conversation_id, source_message_id)` messages
 * 3. Normalizes `INR/metric_tonne`, `delta_from_yesterday`, and `unchanged` against DB history
 * 4. Inserts into `public.metal_rates` (letting Postgres compute `previous_rate_per_kg` & `change_delta`)
 * 5. Evaluates active `public.alert_rules` and sends the Tanglish Telegram spike alert when triggered.
 */
export async function processDealerMetalRateMessage(options: {
  input: DealerMessageInput;
  db?: SupabaseClient;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  geminiFetchImpl?: typeof fetch;
}): Promise<MetalRateProcessResult> {
  const db = options.db ?? createAdminClient();
  const receivedAt = options.input.received_at ?? new Date().toISOString();
  const sourceKey = buildSourceKey(options.input);

  const parsed_json = await parseDealerRateMessage({
    rawText: options.input.raw_message,
    ...(options.env ? { env: options.env } : {}),
    ...(options.geminiFetchImpl ? { fetchImpl: options.geminiFetchImpl } : {}),
  });

  // Load active alert rules
  const { data: rulesData, error: rulesErr } = await db
    .from('alert_rules')
    .select('material_grade, threshold_rs_per_kg, telegram_chat_id, is_active')
    .eq('is_active', true);
  if (rulesErr) throw rulesErr;

  const rulesByGrade = new Map<
    string,
    { thresholdCents: number; telegram_chat_id: string }
  >();
  for (const r of (rulesData ?? []) as Array<{
    material_grade: string;
    threshold_rs_per_kg: string | number;
    telegram_chat_id: string;
  }>) {
    rulesByGrade.set(r.material_grade.trim().toUpperCase(), {
      thresholdCents: toCents(r.threshold_rs_per_kg),
      telegram_chat_id: r.telegram_chat_id,
    });
  }

  // Check if this message was already processed (replay deduplication)
  const { data: existingRows, error: existingErr } = await db
    .from('metal_rates')
    .select('material_grade, rate_per_kg, previous_rate_per_kg, change_delta')
    .eq('source', sourceKey);
  if (existingErr) throw existingErr;

  if (existingRows && existingRows.length > 0) {
    const existingByGrade = new Map<
      string,
      { rate_per_kg: string | number; previous_rate_per_kg: string | number | null; change_delta: string | number | null }
    >();
    for (const row of existingRows as Array<{
      material_grade: string;
      rate_per_kg: string | number;
      previous_rate_per_kg: string | number | null;
      change_delta: string | number | null;
    }>) {
      existingByGrade.set(row.material_grade.trim().toUpperCase(), row);
    }

    const normalized_rates: NormalizedMetalRateRow[] = [];
    for (const grade of CANONICAL_METAL_GRADES) {
      const row = existingByGrade.get(grade);
      if (!row) continue;
      const rule = rulesByGrade.get(grade);
      const deltaCents = row.change_delta !== null ? toCents(row.change_delta) : null;
      const triggered =
        rule !== undefined &&
        deltaCents !== null &&
        Math.abs(deltaCents) >= rule.thresholdCents;
      normalized_rates.push({
        material_grade: grade,
        rate_per_kg: formatTwoDecimals(toCents(row.rate_per_kg)),
        previous_rate_per_kg:
          row.previous_rate_per_kg !== null ? formatTwoDecimals(toCents(row.previous_rate_per_kg)) : null,
        change_delta: deltaCents !== null ? formatTwoDecimals(deltaCents) : null,
        triggered,
      });
    }

    const triggeredRows = normalized_rates.filter((r) => r.triggered);
    const should_notify = triggeredRows.length > 0;
    const telegram_text = formatMetalRateTelegramAlert(receivedAt, triggeredRows);

    return {
      parsed_json,
      normalized_rates,
      should_notify,
      telegram_text,
      telegram_sent: false,
      replayed: true,
    };
  }

  // Fetch predecessor rate for each grade prior to receivedAt
  const { data: historyRows, error: histErr } = await db
    .from('metal_rates')
    .select('material_grade, rate_per_kg, recorded_at')
    .order('recorded_at', { ascending: false });
  if (histErr) throw histErr;

  const receivedMs = Date.parse(receivedAt);
  const predecessorCentsByGrade = new Map<string, number>();
  for (const row of (historyRows ?? []) as Array<{
    material_grade: string;
    rate_per_kg: string | number;
    recorded_at?: string;
  }>) {
    if (row.recorded_at && Number.isFinite(receivedMs) && Date.parse(row.recorded_at) >= receivedMs) {
      continue;
    }
    const key = row.material_grade.trim().toUpperCase();
    if (!predecessorCentsByGrade.has(key)) {
      predecessorCentsByGrade.set(key, toCents(row.rate_per_kg));
    }
  }

  const normalized_rates: NormalizedMetalRateRow[] = [];

  for (const quote of parsed_json.quotes) {
    const grade = quote.material_grade;
    const prevCents = predecessorCentsByGrade.get(grade);
    let rateCents: number | null = null;

    if (quote.kind === 'absolute' && quote.quoted_amount !== null) {
      if (quote.quoted_unit === 'INR/metric_tonne') {
        rateCents = Math.round(Number(quote.quoted_amount) / 10);
      } else {
        rateCents = toCents(quote.quoted_amount);
      }
    } else if (quote.kind === 'delta_from_yesterday' && quote.quoted_amount !== null) {
      if (prevCents === undefined) continue;
      rateCents = prevCents + toCents(quote.quoted_amount);
    } else if (quote.kind === 'unchanged') {
      if (prevCents === undefined) continue;
      rateCents = prevCents;
    }

    if (rateCents === null || rateCents <= 0) continue;

    const rateStr = formatTwoDecimals(rateCents);
    const { data: insertedRows, error: insertErr } = await db
      .from('metal_rates')
      .insert({
        material_grade: grade,
        rate_per_kg: rateStr,
        source: sourceKey,
        recorded_at: receivedAt,
      })
      .select('material_grade, rate_per_kg, previous_rate_per_kg, change_delta');
    if (insertErr) throw insertErr;

    const inserted = (insertedRows?.[0] ?? null) as {
      material_grade: string;
      rate_per_kg: string | number;
      previous_rate_per_kg: string | number | null;
      change_delta: string | number | null;
    } | null;

    const actualRateCents = inserted ? toCents(inserted.rate_per_kg) : rateCents;
    const actualPrevCents =
      inserted && inserted.previous_rate_per_kg !== null
        ? toCents(inserted.previous_rate_per_kg)
        : prevCents ?? null;
    const actualDeltaCents =
      inserted && inserted.change_delta !== null
        ? toCents(inserted.change_delta)
        : actualPrevCents !== null
          ? actualRateCents - actualPrevCents
          : null;

    const rule = rulesByGrade.get(grade);
    const triggered =
      rule !== undefined &&
      actualDeltaCents !== null &&
      Math.abs(actualDeltaCents) >= rule.thresholdCents;

    normalized_rates.push({
      material_grade: grade,
      rate_per_kg: formatTwoDecimals(actualRateCents),
      previous_rate_per_kg: actualPrevCents !== null ? formatTwoDecimals(actualPrevCents) : null,
      change_delta: actualDeltaCents !== null ? formatTwoDecimals(actualDeltaCents) : null,
      triggered,
    });
  }

  const triggeredRows = normalized_rates.filter((r) => r.triggered);
  const should_notify = triggeredRows.length > 0;
  const telegram_text = formatMetalRateTelegramAlert(receivedAt, triggeredRows);

  let telegram_sent = false;
  if (should_notify && telegram_text) {
    const firstTriggeredRule = rulesByGrade.get(triggeredRows[0]!.material_grade);
    const sendRes = await sendTelegramAlert({
      text: telegram_text,
      chatId: firstTriggeredRule?.telegram_chat_id ?? null,
      ...(options.env ? { env: options.env } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
    telegram_sent = sendRes.sent;
  }

  return {
    parsed_json,
    normalized_rates,
    should_notify,
    telegram_text,
    telegram_sent,
    replayed: false,
  };
}

async function handleMetalRatesCron(request: Request): Promise<NextResponse> {
  const auth = verifyCronAuth(request);
  if (auth === 'unconfigured') {
    return NextResponse.json(
      { error: { code: 'NOT_READY', message: 'CRON_SECRET is not configured on the server' } },
      { status: 503, headers: NO_STORE },
    );
  }
  if (auth !== 'ok') {
    return NextResponse.json(
      { error: { code: 'UNAUTHENTICATED', message: 'Valid cron bearer token required' } },
      { status: 401, headers: NO_STORE },
    );
  }

  try {
    if (request.method === 'GET') {
      const db = createAdminClient();
      const { data: latest, error } = await db
        .from('latest_metal_rates')
        .select('material_grade, rate_per_kg, previous_rate_per_kg, change_delta, source, recorded_at')
        .order('material_grade');
      if (error) throw error;
      return NextResponse.json(
        { data: { status: 'ok', latest_rates: latest ?? [] } },
        { status: 200, headers: NO_STORE },
      );
    }

    let rawJson: unknown;
    try {
      rawJson = await request.json();
    } catch {
      return NextResponse.json(
        { error: { code: 'INVALID', message: 'The request is not valid JSON' } },
        { status: 400, headers: NO_STORE },
      );
    }

    const parsedInput = DealerMessageInputSchema.safeParse(rawJson);
    if (!parsedInput.success) {
      return NextResponse.json(
        { error: { code: 'INVALID', message: parsedInput.error.issues[0]?.message ?? 'Invalid dealer message input' } },
        { status: 400, headers: NO_STORE },
      );
    }

    const result = await processDealerMetalRateMessage({ input: parsedInput.data });
    return NextResponse.json({ data: result }, { status: 200, headers: NO_STORE });
  } catch (error) {
    console.error('metal-rates cron error', error instanceof Error ? error.name : typeof error);
    return NextResponse.json(
      { error: { code: 'INTERNAL', message: 'Failed to process metal rates' } },
      { status: 500, headers: NO_STORE },
    );
  }
}

export const GET = handleMetalRatesCron;
export const POST = handleMetalRatesCron;
