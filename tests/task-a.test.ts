import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createClient as createSupabase, type SupabaseClient } from '@supabase/supabase-js';
import {
  ACTORS,
  createTestDb,
  intraStatePayload,
  newTempId,
  queryAs,
  seedCompanyProfile,
  syncInvoice,
  type Actor,
} from './db/harness';
import { pgliteFetch } from './support/postgrest';
import {
  callGeminiJson,
  GeminiError,
  ParseBillResponseSchema,
} from '@/lib/gemini';
import {
  processDealerMetalRateMessage,
  GET as metalRatesCronGet,
  POST as metalRatesCronPost,
} from '@/app/api/cron/metal-rates/route';
import {
  runPaymentRemindersCron,
  GET as remindersCronGet,
} from '@/app/api/cron/reminders/route';

const voiceFixture = JSON.parse(
  readFileSync(new URL('../specs/ai-voice-test-cases.json', import.meta.url), 'utf8'),
) as {
  cases: Array<{
    id: string;
    scenario: string;
    parse_bill: {
      request: { text: string };
      expected: unknown;
    };
    margin_check: {
      request: unknown;
      expected: unknown;
    };
  }>;
};

const metalRateFixture = JSON.parse(
  readFileSync(new URL('../specs/metal-rate-samples.json', import.meta.url), 'utf8'),
) as {
  context: {
    baseline_date: string;
    yesterday_rate_per_kg: Record<string, string>;
    owner_alert_rules: Array<{
      material_grade: string;
      threshold_rs_per_kg: string;
      telegram_chat_id: string;
      is_active: boolean;
    }>;
  };
  samples: Array<{
    case_id: string;
    scenario: string;
    source_channel: 'whatsapp' | 'telegram' | 'manual';
    source_conversation_id: string;
    source_message_id: string;
    received_at: string;
    raw_message: string;
    expected_parsed_json: unknown;
    expected_normalized_rates: unknown;
    should_notify: boolean;
    expected_telegram_text: string | null;
  }>;
};

const seedData = JSON.parse(
  readFileSync(new URL('../specs/seed-data.json', import.meta.url), 'utf8'),
) as {
  customers: Array<{
    id: string;
    name: string;
    gstin: string;
    phone: string;
    state_code: string;
    credit_days: number;
    address: string;
    opening_balance: string;
  }>;
  stud_items: Array<{
    id: string;
    sku_code: string;
    diameter_mm: number;
    length_mm: number;
    thread_type: string;
    material_grade: string;
    hsn_sac: string;
    unit_weight_kg: string | null;
    default_rate_per_piece: string;
    default_rate_per_kg: string;
  }>;
  metal_rates: Array<{
    id: string;
    material_grade: string;
    rate_per_kg: string;
    source: string;
    recorded_at: string;
  }>;
};

let db: PGlite;
const actor: Actor = ACTORS.staff;
let signedIn = true;

function makeSupabaseClient(asActorRole: Actor = actor): SupabaseClient {
  const client = createSupabase('http://localhost', 'sb_publishable_test', {
    global: { fetch: pgliteFetch(db, () => asActorRole) },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  client.auth.getClaims = (async () => ({
    data: signedIn ? { claims: {} } : null,
    error: null,
  })) as unknown as typeof client.auth.getClaims;
  return client;
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => makeSupabaseClient(actor),
}));

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => makeSupabaseClient(ACTORS.service),
}));

beforeAll(async () => {
  db = await createTestDb({ today: '2026-11-23' });
  await seedCompanyProfile(db);

  // Seed active customers from specs/seed-data.json
  for (const c of seedData.customers) {
    await db.query(
      `insert into public.customers (id, name, gstin, phone, state_code, credit_days, address, opening_balance, is_active)
       values ($1, $2, $3, $4, $5, $6, $7, $8, true)`,
      [c.id, c.name, c.gstin, c.phone.replace(/^\+91/, ''), c.state_code, c.credit_days, c.address, c.opening_balance],
    );
  }

  // Seed active stud_items from specs/seed-data.json
  for (const s of seedData.stud_items) {
    const isManual = s.unit_weight_kg !== null;
    const formulaWeight = Number(((s.diameter_mm * s.diameter_mm) / 162.2 * (s.length_mm / 1000)).toFixed(6));
    await db.query(
      `insert into public.stud_items (
         id, sku_code, diameter_mm, length_mm, thread_type, material_grade,
         hsn_sac, gst_rate_percent, unit_weight_kg, unit_weight_is_manual,
         default_rate_per_piece, default_rate_per_kg, is_active
       ) values ($1, $2, $3, $4, $5, $6, $7, 18, $8, $9, $10, $11, true)`,
      [
        s.id,
        s.sku_code,
        s.diameter_mm,
        s.length_mm,
        s.thread_type.slice(0, 40),
        s.material_grade.toUpperCase(),
        s.hsn_sac,
        s.unit_weight_kg ?? formulaWeight,
        isManual,
        s.default_rate_per_piece,
        s.default_rate_per_kg,
      ],
    );
  }
});

afterAll(async () => {
  await db.close();
});

async function resetMetalRatesTo18NovClose(): Promise<void> {
  // Temporarily run as table owner with replica mode to reset metal_rates & alert_rules cleanly between fixtures
  await db.transaction(async (tx) => {
    await tx.exec('set local session_replication_role = replica');
    await tx.exec('delete from public.metal_rates');
    await tx.exec('delete from public.alert_rules');
  });

  const yesterday = metalRateFixture.context.yesterday_rate_per_kg;
  for (const [grade, rate] of Object.entries(yesterday)) {
    await db.query(
      `insert into public.metal_rates (material_grade, rate_per_kg, source, recorded_at)
       values ($1, $2, 'seed-close-18-nov', '2026-11-18T09:00:00+05:30')`,
      [grade.toUpperCase(), rate],
    );
  }

  for (const rule of metalRateFixture.context.owner_alert_rules) {
    await db.query(
      `insert into public.alert_rules (material_grade, threshold_rs_per_kg, telegram_chat_id, is_active)
       values ($1, $2, $3, $4)`,
      [rule.material_grade.toUpperCase(), rule.threshold_rs_per_kg, rule.telegram_chat_id, rule.is_active],
    );
  }
}

describe('Task A · 1. Gemini Flash JSON client, retry backoff & strict math boundary', () => {
  it('retries HTTP 429 and 503 with exponential backoff and validates output with Zod', async () => {
    let calls = 0;
    const validReply = {
      bill_type: 'supply',
      customer_query: 'Vellaru',
      customer_id: '9e753d0d-d603-5150-8569-d98969067bf6',
      items: [
        {
          item_query: 'MS M8 x 45 mm full thread',
          stud_item_id: '891929ce-8768-54be-a558-14a6650c7ef4',
          diameter: 'M8',
          length_mm: '45',
          material_grade: 'MS',
          thread_type: 'full_thread',
          quantity: '200',
          billing_unit: 'pcs',
          rate_mention: 'piece-ku 3.10',
        },
      ],
      party_dc_no: null,
      delivery: {
        transport_mention: null,
        vehicle_no: null,
        freight_paid_by: null,
        delivery_charge: null,
        packing_charge: null,
      },
      warnings: [],
    };

    const mockFetch: typeof fetch = async () => {
      calls += 1;
      if (calls === 1) return new Response('rate limit', { status: 429 });
      if (calls === 2) return new Response('overloaded', { status: 503 });
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: JSON.stringify(validReply) }] } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    const result = await callGeminiJson({
      systemInstruction: 'test',
      userPrompt: 'test',
      schema: ParseBillResponseSchema,
      env: { NODE_ENV: 'test', GEMINI_API_KEY: 'test-gemini-key' },
      fetchImpl: mockFetch,
      baseDelayMs: 1,
    });

    expect(calls).toBe(3);
    expect(result).toEqual(validReply);
  });

  it('rejects AI output that attempts to inject calculated GST or grand_total fields', async () => {
    const poisonedAiOutput = {
      bill_type: 'supply',
      customer_query: 'Vellaru',
      customer_id: '9e753d0d-d603-5150-8569-d98969067bf6',
      items: [
        {
          item_query: 'MS M8 x 45 mm',
          stud_item_id: '891929ce-8768-54be-a558-14a6650c7ef4',
          diameter: 'M8',
          length_mm: '45',
          material_grade: 'MS',
          thread_type: null,
          quantity: '200',
          billing_unit: 'pcs',
          rate_mention: '3.10',
        },
      ],
      party_dc_no: null,
      delivery: {
        transport_mention: null,
        vehicle_no: null,
        freight_paid_by: null,
        delivery_charge: null,
        packing_charge: null,
      },
      warnings: [],
      cgst: '55.80',
      sgst: '55.80',
      grand_total: '731.60',
    };

    const mockFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: JSON.stringify(poisonedAiOutput) }] } }],
        }),
        { status: 200 },
      );

    await expect(
      callGeminiJson({
        systemInstruction: 'test',
        userPrompt: 'test',
        schema: ParseBillResponseSchema,
        env: { NODE_ENV: 'test', GEMINI_API_KEY: 'test-gemini-key' },
        fetchImpl: mockFetch,
        baseDelayMs: 1,
      }),
    ).rejects.toThrow(GeminiError);
  });

  it('enforces authentication and same-site guards on /api/ai/parse-bill and /api/ai/margin-check', async () => {
    const parseRoute = await import('@/app/api/ai/parse-bill/route');
    const marginRoute = await import('@/app/api/ai/margin-check/route');

    signedIn = false;
    const unauthParse = await parseRoute.POST(
      new Request('http://localhost/api/ai/parse-bill', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'Vellaru-ku MS M8 x 45 mm 100 pcs' }),
      }),
    );
    expect(unauthParse.status).toBe(401);

    const unauthMargin = await marginRoute.POST(
      new Request('http://localhost/api/ai/margin-check', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bill_type: 'supply', items: [] }),
      }),
    );
    expect(unauthMargin.status).toBe(401);
    signedIn = true;

    const crossSite = await parseRoute.POST(
      new Request('http://localhost/api/ai/parse-bill', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
        body: JSON.stringify({ text: 'Vellaru-ku MS M8 x 45 mm 100 pcs' }),
      }),
    );
    expect(crossSite.status).toBe(403);
  });
});

describe('Task A · 2. Live Billing AI Contract (V01–V25 from specs/ai-voice-test-cases.json)', () => {
  beforeAll(async () => {
    await resetMetalRatesTo18NovClose();
  });

  it.each(voiceFixture.cases.map((c) => [c.id, c.scenario, c] as const))(
    '%s: %s (parse-bill + margin-check exact deep equality)',
    async (_id, _scenario, testCase) => {
      const parseRoute = await import('@/app/api/ai/parse-bill/route');
      const marginRoute = await import('@/app/api/ai/margin-check/route');

      const parseResponse = await parseRoute.POST(
        new Request('http://localhost/api/ai/parse-bill', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(testCase.parse_bill.request),
        }),
      );
      expect(parseResponse.status).toBe(200);
      expect(parseResponse.headers.get('cache-control')).toBe('no-store');
      const parseBody: unknown = await parseResponse.json();
      expect(parseBody).toEqual(testCase.parse_bill.expected);

      const marginResponse = await marginRoute.POST(
        new Request('http://localhost/api/ai/margin-check', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(testCase.margin_check.request),
        }),
      );
      expect(marginResponse.status).toBe(200);
      expect(marginResponse.headers.get('cache-control')).toBe('no-store');
      const marginBody: unknown = await marginResponse.json();
      expect(marginBody).toEqual(testCase.margin_check.expected);
    },
  );
});

describe('Task A · 3. Metal Rates Cron & Spike Alerts (MR-01–MR-10 from specs/metal-rate-samples.json)', () => {
  it.each(metalRateFixture.samples.map((s) => [s.case_id, s.scenario, s] as const))(
    '%s: %s',
    async (_caseId, _scenario, sample) => {
      await resetMetalRatesTo18NovClose();

      const sentMessages: Array<{ chatId: string; text: string }> = [];
      const mockTelegramFetch: typeof fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as { chat_id: string; text: string };
        sentMessages.push({ chatId: body.chat_id, text: body.text });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      };

      const result = await processDealerMetalRateMessage({
        input: {
          source_channel: sample.source_channel,
          source_conversation_id: sample.source_conversation_id,
          source_message_id: sample.source_message_id,
          received_at: sample.received_at,
          raw_message: sample.raw_message,
        },
        db: makeSupabaseClient(ACTORS.service),
        env: {
          NODE_ENV: 'test',
          TELEGRAM_BOT_TOKEN: 'test-bot-token',
          TELEGRAM_OWNER_CHAT_ID: '-1000000000000',
        },
        fetchImpl: mockTelegramFetch,
      });

      expect(result.parsed_json).toEqual(sample.expected_parsed_json);
      expect(result.normalized_rates).toEqual(sample.expected_normalized_rates);
      expect(result.should_notify).toBe(sample.should_notify);
      expect(result.telegram_text).toBe(sample.expected_telegram_text);

      if (sample.should_notify) {
        expect(sentMessages).toHaveLength(1);
        expect(sentMessages[0]?.text).toBe(sample.expected_telegram_text);
      } else {
        expect(sentMessages).toHaveLength(0);
      }
    },
  );

  it('deduplicates replayed dealer messages by (source_channel, source_conversation_id, source_message_id)', async () => {
    await resetMetalRatesTo18NovClose();
    const sample = metalRateFixture.samples[9]!; // MR-10 (6 grades trigger)
    let telegramCalls = 0;
    const mockTelegramFetch: typeof fetch = async () => {
      telegramCalls += 1;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    const first = await processDealerMetalRateMessage({
      input: {
        source_channel: sample.source_channel,
        source_conversation_id: sample.source_conversation_id,
        source_message_id: sample.source_message_id,
        received_at: sample.received_at,
        raw_message: sample.raw_message,
      },
      db: makeSupabaseClient(ACTORS.service),
      env: { NODE_ENV: 'test', TELEGRAM_BOT_TOKEN: 'test-bot-token' },
      fetchImpl: mockTelegramFetch,
    });
    expect(first.replayed).toBe(false);
    expect(telegramCalls).toBe(1);

    const { rows: countAfterFirst } = await db.query<{ n: number }>(
      'select count(*)::int as n from public.metal_rates',
    );

    const second = await processDealerMetalRateMessage({
      input: {
        source_channel: sample.source_channel,
        source_conversation_id: sample.source_conversation_id,
        source_message_id: sample.source_message_id,
        received_at: sample.received_at,
        raw_message: sample.raw_message,
      },
      db: makeSupabaseClient(ACTORS.service),
      env: { NODE_ENV: 'test', TELEGRAM_BOT_TOKEN: 'test-bot-token' },
      fetchImpl: mockTelegramFetch,
    });
    expect(second.replayed).toBe(true);
    expect(second.normalized_rates).toEqual(sample.expected_normalized_rates);
    expect(telegramCalls).toBe(1); // No duplicate Telegram message sent

    const { rows: countAfterSecond } = await db.query<{ n: number }>(
      'select count(*)::int as n from public.metal_rates',
    );
    expect(countAfterSecond[0]?.n).toBe(countAfterFirst[0]?.n);
  });
});

describe('Task A · 4. Payment Reminders Cron & CRON_SECRET Auth Guards', () => {
  const SECRET = 'cron-secret-task-a-1234567890';

  it('protects /api/cron/metal-rates and /api/cron/reminders with constant-time CRON_SECRET check', async () => {
    const prev = process.env.CRON_SECRET;
    try {
      delete process.env.CRON_SECRET;
      const unconf1 = await metalRatesCronGet(new Request('http://localhost/api/cron/metal-rates'));
      const unconf2 = await remindersCronGet(new Request('http://localhost/api/cron/reminders'));
      expect(unconf1.status).toBe(503);
      expect(unconf2.status).toBe(503);

      process.env.CRON_SECRET = SECRET;
      const wrong1 = await metalRatesCronPost(
        new Request('http://localhost/api/cron/metal-rates', {
          method: 'POST',
          headers: { authorization: 'Bearer wrong-token-value-12345' },
        }),
      );
      const wrong2 = await remindersCronGet(
        new Request('http://localhost/api/cron/reminders', {
          headers: { authorization: 'Bearer wrong-token-value-12345' },
        }),
      );
      expect(wrong1.status).toBe(401);
      expect(wrong2.status).toBe(401);

      const okGet = await metalRatesCronGet(
        new Request('http://localhost/api/cron/metal-rates', {
          headers: { authorization: `Bearer ${SECRET}` },
        }),
      );
      expect(okGet.status).toBe(200);
    } finally {
      if (prev === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = prev;
    }
  });

  it('groups due (0d), 7d overdue, 15d overdue, suppresses wa.me when phone is missing, and deduplicates same-day runs', async () => {
    const vellaruId = '9e753d0d-d603-5150-8569-d98969067bf6';
    const marudhamId = '9f085e9c-20f5-5a83-9c7a-26fdb5a186e3';
    const studId = '891929ce-8768-54be-a558-14a6650c7ef4';

    // Create a customer without phone to test missing-phone wa.me suppression
    const [noPhoneCustomer] = await queryAs<{ id: string }>(
      db,
      ACTORS.staff,
      `insert into public.customers (name, state_code, credit_days)
       values ('Walk-in Counter Buyer', '33', 0) returning id`,
    );

    const md = {
      tnCustomerId: vellaruId,
      kaCustomerId: marudhamId,
      studItemId: studId,
    };

    // 1. Due today (2026-11-23, 0 days overdue) with Drive PDF link
    const dueToday = await syncInvoice(
      db,
      ACTORS.staff,
      intraStatePayload(md, {
        client_temp_id: newTempId(),
        invoice_date: '2026-11-01',
        due_date: '2026-11-23',
      }),
    );
    await queryAs(
      db,
      ACTORS.service,
      `update public.invoices set pdf_drive_url = 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456/view' where id = $1`,
      [dueToday.invoice_id],
    );

    // 2. 7 days overdue (due 2026-11-16)
    const overdue7 = await syncInvoice(
      db,
      ACTORS.staff,
      intraStatePayload(md, {
        client_temp_id: newTempId(),
        customer_id: marudhamId,
        invoice_date: '2026-11-01',
        due_date: '2026-11-16',
      }),
    );

    // 3. 15 days overdue (due 2026-11-08)
    const overdue15 = await syncInvoice(
      db,
      ACTORS.staff,
      intraStatePayload(md, {
        client_temp_id: newTempId(),
        invoice_date: '2026-10-25',
        due_date: '2026-11-08',
      }),
    );

    // 4. Missing-phone customer due today (2026-11-23)
    const missingPhoneBill = await syncInvoice(
      db,
      ACTORS.staff,
      intraStatePayload(md, {
        client_temp_id: newTempId(),
        customer_id: noPhoneCustomer!.id,
        invoice_date: '2026-11-23',
        due_date: '2026-11-23',
      }),
    );

    // 5. Future due date (due 2026-11-30) -> must NOT be included
    await syncInvoice(
      db,
      ACTORS.staff,
      intraStatePayload(md, {
        client_temp_id: newTempId(),
        invoice_date: '2026-11-20',
        due_date: '2026-11-30',
      }),
    );

    // 6. Cancelled invoice (due 2026-11-16) -> must NOT be included
    const cancelledBill = await syncInvoice(
      db,
      ACTORS.staff,
      intraStatePayload(md, {
        client_temp_id: newTempId(),
        invoice_date: '2026-11-01',
        due_date: '2026-11-16',
      }),
    );
    await queryAs(
      db,
      ACTORS.owner,
      `update public.invoices set cancelled_at = now(), cancellation_reason = 'Wrong buyer' where id = $1`,
      [cancelledBill.invoice_id],
    );

    const digests: string[] = [];
    const mockTelegramFetch: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { text: string };
      digests.push(body.text);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    const firstRun = await runPaymentRemindersCron({
      db: makeSupabaseClient(ACTORS.service),
      todayIst: '2026-11-23',
      env: {
        NODE_ENV: 'test',
        TELEGRAM_BOT_TOKEN: 'test-bot-token',
        TELEGRAM_OWNER_CHAT_ID: '-1000000000000',
      },
      fetchImpl: mockTelegramFetch,
    });

    expect(firstRun.total_eligible).toBe(4);
    expect(firstRun.tiers.due.map((c) => c.invoice_id)).toEqual([
      dueToday.invoice_id,
      missingPhoneBill.invoice_id,
    ]);
    expect(firstRun.tiers.overdue_7.map((c) => c.invoice_id)).toEqual([overdue7.invoice_id]);
    expect(firstRun.tiers.overdue_15.map((c) => c.invoice_id)).toEqual([overdue15.invoice_id]);

    // Verify wa.me links and Drive PDF inclusion
    const dueCandidate = firstRun.tiers.due.find((c) => c.invoice_id === dueToday.invoice_id)!;
    expect(dueCandidate.whatsapp_url).toMatch(/^https:\/\/wa\.me\/919000009101\?text=/);
    expect(dueCandidate.whatsapp_message).toContain('https://drive.google.com/file/d/');

    // Verify missing phone suppresses wa.me link and adds fallback note in digest
    const noPhoneCandidate = firstRun.tiers.due.find((c) => c.invoice_id === missingPhoneBill.invoice_id)!;
    expect(noPhoneCandidate.whatsapp_url).toBeNull();
    expect(noPhoneCandidate.missing_phone).toBe(true);
    expect(firstRun.telegram_digest).toContain('Missing phone — call or update customer card');
    expect(digests).toHaveLength(1);

    // Second run on the same day must deduplicate all 4 stage reminders
    const secondRun = await runPaymentRemindersCron({
      db: makeSupabaseClient(ACTORS.service),
      todayIst: '2026-11-23',
      env: {
        NODE_ENV: 'test',
        TELEGRAM_BOT_TOKEN: 'test-bot-token',
        TELEGRAM_OWNER_CHAT_ID: '-1000000000000',
      },
      fetchImpl: mockTelegramFetch,
    });

    expect(secondRun.total_eligible).toBe(0);
    expect(secondRun.skipped_already_sent).toBe(4);
    expect(secondRun.telegram_sent).toBe(false);
    expect(digests).toHaveLength(1);
  });
});
