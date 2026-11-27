// AI fill, and what is left of it while Gemini fails: the real browser client, the real routes and
// SQL (PGlite). Only two wires are simulated: this PC to our server, and our server to Google.
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createClient as createSupabase, type SupabaseClient } from '@supabase/supabase-js';
import { api, isDown } from '@/lib/api-client';
import { connection, setConnection } from '@/lib/connection';
import { callGeminiJson, DealerRateParsedSchema, parseDealerRateMessage, type ParseBillResponse } from '@/lib/gemini';
import { ACTORS, createTestDb, type Actor } from './db/harness';
import { pgliteFetch } from './support/postgrest';

const spec = <T>(file: string): T => JSON.parse(readFileSync(new URL(`../specs/${file}`, import.meta.url), 'utf8')) as T;
const voice = spec<{ cases: { id: string; parse_bill: { request: { text: string }; expected: ParseBillResponse } }[] }>('ai-voice-test-cases.json').cases;
const seed = spec<{
  customers: { id: string; name: string; gstin: string; phone: string; state_code: string; credit_days: number; address: string; opening_balance: string }[];
  stud_items: {
    id: string; sku_code: string; diameter_mm: number; length_mm: number; thread_type: string; material_grade: string; hsn_sac: string;
    unit_weight_kg: string | null; default_rate_per_piece: string; default_rate_per_kg: string;
  }[];
}>('seed-data.json');

const KEY = 'test-gemini-key';
const SECRET = 'cron-secret-ai-fill-1234567890';
const DEALER = 'Vanakkam boss, Rs/kg: M.S round 58.25 | EN-8 84.25';
/** What the browser waits, and how much sooner the server has to be done with Google. */
const BROWSER_WAITS = 30_000;
const SPARE = 10_000;

type Wire = (init: RequestInit) => Promise<Response>;
let db: PGlite;
let google: Wire;
/** What reached Google. */
let asked: { path: string; body: { contents: { parts: { text: string }[] }[]; generationConfig: Record<string, unknown> } }[];
/** Answers instead of our server; null lets requests through. */
let between: Wire | null;
let logged: ReturnType<typeof vi.spyOn>;

function client(actor: Actor): SupabaseClient {
  const made = createSupabase('http://localhost', 'sb_publishable_test', {
    global: { fetch: pgliteFetch(db, () => actor) },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  made.auth.getClaims = (async () => ({ data: { claims: {} }, error: null })) as unknown as typeof made.auth.getClaims;
  return made;
}
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => client(ACTORS.staff) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => client(ACTORS.service) }));

type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;
const ROUTES: Record<string, () => Promise<Record<string, unknown>>> = {
  '/api/ai/parse-bill': () => import('@/app/api/ai/parse-bill/route'),
  '/api/metal-rates': () => import('@/app/api/metal-rates/route'),
  '/api/cron/metal-rates': () => import('@/app/api/cron/metal-rates/route'),
};

/** A request nobody answers, until whoever sent it gives up (as with fetch: at once, if it already has). */
const silence: Wire = (init) =>
  new Promise((_, reject) => {
    const giveUp = () => reject(init.signal?.reason as Error);
    if (init.signal?.aborted) giveUp();
    init.signal?.addEventListener('abort', giveUp);
  });

async function serve(path: string, init: RequestInit): Promise<Response> {
  if (between) return between(init);
  const handler = (await ROUTES[path]?.())?.[init.method ?? 'GET'] as Handler | undefined;
  if (!handler) throw new Error(`no route ${path}`);
  const request = new Request(new URL(path, 'http://localhost'), { ...init, signal: null }); // giving up in the browser does not stop the server
  return Promise.race([handler(request, { params: Promise.resolve({}) }), silence(init)]);
}

/** The server's wait for Google passes in a moment, and so do its pauses; the browser's 30 s stay. */
function hurryServer(): void {
  const limit = AbortSignal.timeout.bind(AbortSignal);
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => limit(ms <= BROWSER_WAITS - SPARE ? 200 : ms));
  const timer = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((work: () => void, ms?: number) => timer(work, Math.min(ms ?? 0, 2))) as typeof setTimeout);
}

const fill = (text: string) => api<ParseBillResponse>('/api/ai/parse-bill', 'POST', { text });

/** Words for the owner: no codes, no product names, nothing about computers. */
function expectPlain(message: string): void {
  expect(message).not.toMatch(/gemini|google|http|json|schema|api\b|error|code|\d/i);
  expect(message).toMatch(/^[A-Z].*type the bill below\.$/);
}

const refuses = (status: number, code: string, message: string): Wire => async () => Response.json({ error: { code: status, message, status: code } }, { status });
const answers = (answer: unknown, finishReason = 'STOP'): Wire => async () =>
  Response.json({
    candidates: [{ content: { parts: [{ text: typeof answer === 'string' ? answer : JSON.stringify(answer), thoughtSignature: 'c2ln' }], role: 'model' }, finishReason, index: 0 }],
    usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 200, totalTokenCount: 1100 },
    modelVersion: 'gemini-test',
    responseId: 'test',
  });

/** A note the built-in parser reads to the last number, and the draft the contract wants for it. */
const NOTE = voice.find(({ id }) => id === 'V05')!.parse_bill;
const FLAG = { code: 'AI_UNAVAILABLE', path: 'transcript' };

const FAILURES: Record<string, Wire> = {
  'the model is retired': refuses(404, 'NOT_FOUND', 'models/gemini-2.5-flash is no longer available to new users.'),
  'the quota is used up': refuses(429, 'RESOURCE_EXHAUSTED', 'You exceeded your current quota.'),
  'the model is overloaded': refuses(503, 'UNAVAILABLE', 'This model is currently experiencing high demand.'),
  'the key is refused': refuses(400, 'INVALID_ARGUMENT', 'API key not valid. Please pass a valid API key.'),
  'Google cannot be reached': async () => {
    throw new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }) });
  },
  'the connection is reset': async () => {
    throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
  },
  'Google never answers': silence,
  'the answer is not JSON': answers('Sure! Here is your bill:'),
  'the answer stops half way': answers('{"bill_type":"supply","items":[{"item_q', 'MAX_TOKENS'),
  'the answer brings its own total': answers({ ...NOTE.expected, grand_total: '1.00' }),
  'the question is blocked': async () => Response.json({ promptFeedback: { blockReason: 'OTHER' }, usageMetadata: { promptTokenCount: 900, totalTokenCount: 900 } }),
  'a web page answers instead': async () => new Response('<html>Sign in</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
};
const ways = Object.keys(FAILURES);

beforeAll(async () => {
  db = await createTestDb({ today: '2026-11-23' });
  for (const c of seed.customers) {
    await db.query(
      `insert into public.customers (id, name, gstin, phone, state_code, credit_days, address, opening_balance) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [c.id, c.name, c.gstin, c.phone.replace(/^\+91/, ''), c.state_code, c.credit_days, c.address, c.opening_balance],
    );
  }
  for (const s of seed.stud_items) {
    await db.query(
      `insert into public.stud_items (id, sku_code, diameter_mm, length_mm, thread_type, material_grade, hsn_sac, gst_rate_percent,
         unit_weight_kg, unit_weight_is_manual, default_rate_per_piece, default_rate_per_kg)
       values ($1, $2, $3, $4, $5, $6, $7, 18, $8, $9, $10, $11)`,
      [
        s.id, s.sku_code, s.diameter_mm, s.length_mm, s.thread_type.slice(0, 40), s.material_grade.toUpperCase(), s.hsn_sac,
        s.unit_weight_kg ?? (((s.diameter_mm * s.diameter_mm) / 162.2) * (s.length_mm / 1000)).toFixed(6), s.unit_weight_kg !== null,
        s.default_rate_per_piece, s.default_rate_per_kg,
      ],
    );
  }
});
afterAll(async () => {
  await db.close();
});
beforeEach(() => {
  asked = [];
  between = null;
  google = answers(NOTE.expected);
  setConnection('online');
  logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  for (const name of ['GEMINI_MODEL', 'GEMINI_API_KEY_PRIMARY', 'GEMINI_API_KEY_FALLBACK']) vi.stubEnv(name, '');
  vi.stubEnv('GEMINI_API_KEY', KEY);
  vi.stubEnv('CRON_SECRET', SECRET);
  vi.stubGlobal('fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    if (!url.startsWith('https://generativelanguage.googleapis.com/')) return serve(url, init);
    asked.push({ path: new URL(url).pathname, body: JSON.parse(String(init.body)) as (typeof asked)[number]['body'] });
    return google(init);
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the model', () => {
  const model = (): (string | undefined)[] => asked.map(({ path }) => /^\/v1beta\/models\/([^/]+):generateContent$/.exec(path)?.[1]);
  async function askBoth(): Promise<(string | undefined)[]> {
    await fill(NOTE.request.text);
    google = answers({ quotes: [], unpriced_mentions: [] });
    await parseDealerRateMessage({ rawText: DEALER });
    return model();
  }

  it.each(['', '   ', undefined])('is the same for bills and metal rates, and not the one Google has retired (GEMINI_MODEL %j)', async (name) => {
    vi.stubEnv('GEMINI_MODEL', name);
    const [bills, rates] = await askBoth();
    expect(bills).toMatch(/^gemini-[a-z0-9.-]+$/);
    expect(bills).not.toMatch(/^gemini-2/);
    expect(rates).toBe(bills);
  });

  it.each(['gemini-9-flash', '  gemini-9-flash\n', 'models/gemini-9-flash'])('can be changed without a release (%j)', async (name) => {
    vi.stubEnv('GEMINI_MODEL', name);
    expect(await askBoth()).toEqual(['gemini-9-flash', 'gemini-9-flash']);
  });

  it('cannot send the key to another address', async () => {
    vi.stubEnv('GEMINI_MODEL', '../../evil?x=');
    await fill(NOTE.request.text);
    expect(asked.map(({ path }) => path)).toEqual(['/v1beta/models/..%2F..%2Fevil%3Fx%3D:generateContent']);
  });
});

describe('what Gemini is asked for', () => {
  // Left to itself it invents its own names (line_items, unit_rate, grade): a real answer, no use to us.
  const told = async (send: () => Promise<unknown>) => {
    await send();
    return asked.at(-1)?.body.generationConfig;
  };

  it('is a bill draft with our names in it, every one of them, and nothing else', async () => {
    const item = ['item_query', 'stud_item_id', 'diameter', 'length_mm', 'material_grade', 'thread_type', 'quantity', 'billing_unit', 'rate_mention'];
    const config = await told(() => fill(NOTE.request.text));
    expect(config).toMatchObject({
      responseMimeType: 'application/json',
      responseJsonSchema: {
        type: 'object',
        required: ['bill_type', 'customer_query', 'customer_id', 'items', 'party_dc_no', 'delivery', 'warnings'],
        additionalProperties: false,
        properties: {
          bill_type: { enum: ['supply', 'job_work'] },
          items: { type: 'array', items: { required: item, additionalProperties: false } },
          delivery: { required: ['transport_mention', 'vehicle_no', 'freight_paid_by', 'delivery_charge', 'packing_charge'] },
        },
      },
    });
    expect(JSON.stringify(config)).not.toContain('AI_UNAVAILABLE'); // ours to say, not the AI's
  });

  it('may be no goods at all: nothing is to be made up to fill a list', async () => {
    expect(JSON.stringify(await told(() => fill(NOTE.request.text)))).not.toContain('minItems');
  });

  it('is metal rates with our names in them', async () => {
    google = answers({ quotes: [], unpriced_mentions: [] });
    expect(await told(() => parseDealerRateMessage({ rawText: DEALER }))).toMatchObject({
      responseMimeType: 'application/json',
      responseJsonSchema: {
        required: ['quotes', 'unpriced_mentions'],
        properties: {
          quotes: { items: { required: ['material_grade', 'kind', 'quoted_amount', 'quoted_unit'], properties: { material_grade: { enum: ['MS', 'EN8', 'EN19', 'SS 304', 'SS 316', 'BRASS'] } } } },
          unpriced_mentions: { items: { required: ['raw_fragment', 'reason'] } },
        },
      },
    });
  });
});

describe('asking Gemini', () => {
  const ask = (options: { timeoutMs?: number; maxAttempts?: number; baseDelayMs?: number }) =>
    callGeminiJson({ systemInstruction: 'test', userPrompt: 'test', schema: DealerRateParsedSchema, ...options });

  it('ends when its time is up, and does not start again', async () => {
    google = silence;
    await expect(ask({ timeoutMs: 20 })).rejects.toMatchObject({ name: 'GeminiError', code: 'TIMEOUT' });
    expect(asked).toHaveLength(1);
  }, 5000);

  it('has one limit for all its attempts together', async () => {
    google = async (init) => {
      await Promise.race([new Promise((resolve) => setTimeout(resolve, 40)), silence(init)]);
      return Response.json({}, { status: 503 });
    };
    await expect(ask({ timeoutMs: 60, maxAttempts: 5, baseDelayMs: 10 })).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(asked.length).toBeLessThan(5);
  }, 5000);

  it('keeps at it while Google is overloaded for a moment', async () => {
    let refused = 0;
    google = async (init) => {
      refused += 1;
      return (refused <= 4 ? FAILURES['the model is overloaded']! : answers({ quotes: [], unpriced_mentions: [] }))(init);
    };
    expect(await ask({ baseDelayMs: 1 })).toEqual({ quotes: [], unpriced_mentions: [] });
  });

  it('tries again after a lost connection, and names the failure when that does not help', async () => {
    let calls = 0;
    google = async () => {
      calls += 1;
      if (calls < 3) throw new TypeError('fetch failed');
      return answers({ quotes: [], unpriced_mentions: [] })({});
    };
    expect(await ask({ baseDelayMs: 1 })).toEqual({ quotes: [], unpriced_mentions: [] });
    google = FAILURES['the connection is reset']!;
    await expect(ask({ baseDelayMs: 1 })).rejects.toMatchObject({ name: 'GeminiError', code: 'NETWORK' });
  });

  it('asks once only, when asking again cannot help', async () => {
    for (const way of ['the model is retired', 'the key is refused', 'the answer is not JSON', 'the answer brings its own total']) {
      asked = [];
      google = FAILURES[way]!;
      await expect(ask({ baseDelayMs: 1 }), way).rejects.toMatchObject({ name: 'GeminiError' });
      expect(asked, way).toHaveLength(1);
    }
  });
});

describe('AI fill', () => {
  it('is the AI’s draft while Gemini answers', async () => {
    const draft = { ...NOTE.expected, customer_query: 'as the AI heard it' };
    google = answers(draft);
    expect(await fill(NOTE.request.text)).toEqual({ ok: true, data: draft });
    expect(logged).not.toHaveBeenCalled();
  });

  it.each(ways)('still fills the draft and stays online when %s', async (way) => {
    hurryServer();
    google = FAILURES[way]!;
    const reply = await fill(NOTE.request.text);
    expect(connection()).toBe('online');
    expect(reply).toEqual({ ok: true, data: { ...NOTE.expected, warnings: [FLAG, ...NOTE.expected.warnings] } });
  }, 5000);

  // V02 says its size twice; the others take back, repeat or only mention a number.
  const NOT_WHOLLY = new Set(['V02', 'V09', 'V13', 'V20', 'V25']);
  it.each(voice.map((one) => [one.id, one.parse_bill] as const))('without Gemini gives %s exactly, or says it cannot', async (id, { request, expected }) => {
    google = FAILURES['the model is retired']!;
    const reply = await fill(request.text);
    expect(connection()).toBe('online');
    if (!NOT_WHOLLY.has(id)) return expect(reply).toEqual({ ok: true, data: { ...expected, warnings: [FLAG, ...expected.warnings] } });
    expect(reply).toMatchObject({ ok: false, status: 422, code: 'AI_UNAVAILABLE' });
  });

  it('without Gemini fills a plain note that nobody wrote a sample of', async () => {
    google = FAILURES['the model is retired']!;
    expect(await fill('Vellaru supply, MS M8 x 45 mm full thread, 1,200 pcs, Rs 3.10 each. Packing 60')).toEqual({
      ok: true,
      data: {
        bill_type: 'supply', customer_query: 'Vellaru', customer_id: '9e753d0d-d603-5150-8569-d98969067bf6', party_dc_no: null,
        items: [{
          item_query: 'MS M8 x 45 mm full thread', stud_item_id: '891929ce-8768-54be-a558-14a6650c7ef4', diameter: 'M8', length_mm: '45', material_grade: 'MS',
          thread_type: 'full_thread', quantity: '1200', billing_unit: 'pcs', rate_mention: 'Rs 3.10 each',
        }],
        delivery: { transport_mention: null, vehicle_no: null, freight_paid_by: null, delivery_charge: null, packing_charge: { mention: 'Packing 60', amount_inr: '60.00' } },
        warnings: [FLAG],
      },
    });
  });

  it('without Gemini reads the example that the screen shows', async () => {
    google = FAILURES['the model is retired']!;
    expect(await fill('Vellaru-ku MS M8 x 45 mm full thread, 200 pcs, piece-ku 3.10')).toMatchObject({
      ok: true,
      data: {
        customer_id: '9e753d0d-d603-5150-8569-d98969067bf6',
        items: [{ stud_item_id: '891929ce-8768-54be-a558-14a6650c7ef4', quantity: '200', billing_unit: 'pcs', rate_mention: 'piece-ku 3.10' }],
        warnings: [FLAG],
      },
    });
  });

  // What the built-in parser makes of each is wrong without saying so: a line, a count, a charge
  // or a spec is missing from its draft, or the goods are not ours to sell.
  it.each([
    'Vellaru-ku supply, MS M8 x 45 mm, 200 pieces at 3.10 each, MS M10 x 60 mm, 100 pieces at 5.50 each',
    'Vellaru supply\nMS M8 x 45 mm 200 pcs\nMS M10 x 60 mm 100 pcs',
    'Vellaru supply, MS M8 x 45 mm 200 pcs + MS M8 x 45 mm 200 pcs',
    'Vellaru supply, MS M8 x 45 mm 80 pcs, no no 90 pcs at 3.10 each',
    'Vellaru supply MS M8 x 45 mm 200 pcs today 300 pcs tomorrow',
    'Vellaru supply, MS M14 x 100 mm 25 kg approx 200 pieces',
    'Vellaru supply MS M8 x 45 mm 200 pcs, 10% discount, 3.10 each',
    'Vellaru supply MS M8 x 45 mm 200 pcs, transport 350 party pay',
    'Vellaru supply MS M8 x 45 mm 2,000 pcs, thousand piece-ku 1,200',
    'Vellaru supply MS M8 x 45 mm 200 pcs, piece-ku 3.10 illa 3.20',
    'Vellaru supply MS M8 x 45 mm 200 pcs, Marudham supply MS M10 x 60 mm 100 pcs',
    'Vellaru supply MS M8 x 45 mm 200 pcs, double end',
    'Vellaru supply MS M8 x 45 mm 200 pcs at 3.10 each, brass nut kooda',
    'Vellaru supply MS M8 x 45 mm 200 pcs, illa vendaam',
    'Vellaru supply MS M8 x 45 mm irunooru piece, sorry paththu piece',
    'Vellaru supply MS M8 x 45 mm 200 pcs at 3.10 each, zinc plating',
    'Vellaru, rod avanga kuduthadhu, MS M10 x 60 mm 250 pieces, Rs 2.50 each',
    'Vellaru job-work MS M10 x 60 mm 250 pcs, 2.50 per piece',
  ])('without Gemini does not fill part of a bill: %s', async (text) => {
    google = FAILURES['the model is retired']!;
    const reply = await fill(text);
    expect(connection()).toBe('online');
    expect(reply).toMatchObject({ ok: false, status: 422, code: 'AI_UNAVAILABLE' });
    if (!reply.ok) expectPlain(reply.message);
  });

  it.each(['hello', 'Vellaru-ku bill podu', 'வெள்ளாறுக்கு எம்எஸ் எம்8 x 45 மிமீ 200 பீஸ்'])('asks for a note with goods in it, key or no key: %s', async (text) => {
    google = answers({ ...NOTE.expected, items: [] });
    for (const key of [KEY, '']) {
      vi.stubEnv('GEMINI_API_KEY', key);
      const reply = await fill(text);
      expect(connection()).toBe('online');
      expect(reply).toMatchObject({ ok: false, status: 422, code: 'NOT_UNDERSTOOD' });
      if (!reply.ok) expectPlain(reply.message);
    }
  });

  it('leaves the reason in the log, without the note, the customer or the key', async () => {
    google = FAILURES['the model is retired']!;
    await fill(NOTE.request.text);
    expect(logged).toHaveBeenCalledTimes(1);
    const line = JSON.stringify(logged.mock.calls);
    expect(line).toContain('UPSTREAM_HTTP');
    expect(line).toContain('404');
    for (const secret of [KEY, 'Bhavani', 'M20', 'no longer available']) expect(line).not.toContain(secret);
  });
});

describe('the dealer’s metal rates while Gemini is failing', () => {
  const rows = async (): Promise<number> => (await db.query<{ n: number }>('select count(*)::int as n from public.metal_rates')).rows[0]?.n ?? -1;

  it.each(ways)('stores nothing, and says it failed, when %s', async (way) => {
    hurryServer();
    google = FAILURES[way]!;
    const before = await rows();
    const { POST } = await import('@/app/api/cron/metal-rates/route');
    const response = await POST(
      new Request('http://localhost/api/cron/metal-rates', {
        method: 'POST',
        headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
        body: JSON.stringify({ source_message_id: `failing-${way}`, raw_message: DEALER }),
      }),
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: { code: 'INTERNAL' } });
    expect(await rows()).toBe(before);
  }, 5000);

  it.each(ways)('leaves the Rates page online when %s', async (way) => {
    hurryServer();
    google = FAILURES[way]!;
    const before = await rows();
    expect(await api('/api/metal-rates', 'POST', { raw_message: DEALER })).toMatchObject({ ok: false, status: 500, code: 'INTERNAL' });
    expect(connection()).toBe('online');
    expect(await rows()).toBe(before);
  }, 5000);

  it('keeps the first grade when it stands on the same line as "Rs/kg:" without a Gemini key', async () => {
    vi.stubEnv('GEMINI_API_KEY', '');
    expect(await parseDealerRateMessage({ rawText: DEALER })).toEqual({
      quotes: [
        { material_grade: 'MS', kind: 'absolute', quoted_amount: '58.25', quoted_unit: 'INR/kg' },
        { material_grade: 'EN8', kind: 'absolute', quoted_amount: '84.25', quoted_unit: 'INR/kg' },
      ],
      unpriced_mentions: [],
    });
    expect(
      await parseDealerRateMessage({
        rawText: '19/11 rod basic, Rs/kg: M.S round 58.25 | EN-8 84.25 | EN 19 116.50 | s.s.304 210.55',
      }),
    ).toEqual({
      quotes: [
        { material_grade: 'MS', kind: 'absolute', quoted_amount: '58.25', quoted_unit: 'INR/kg' },
        { material_grade: 'EN8', kind: 'absolute', quoted_amount: '84.25', quoted_unit: 'INR/kg' },
        { material_grade: 'EN19', kind: 'absolute', quoted_amount: '116.50', quoted_unit: 'INR/kg' },
        { material_grade: 'SS 304', kind: 'absolute', quoted_amount: '210.55', quoted_unit: 'INR/kg' },
      ],
      unpriced_mentions: [],
    });
  });
});

describe('what the browser concludes', () => {
  const AI = '/api/ai/parse-bill';
  /** The margin watch asks no AI: it is our own server and books, like any other page. */
  const ELSEWHERE = ['/api/customers', '/api/ai/margin-check'];
  const ours = (status: number, code: string): Wire => async () => Response.json({ error: { code, message: 'From our server.' } }, { status });
  const gateway = (status: number): Wire => async () => new Response('An error occurred with your deployment', { status });
  const portal: Wire = async () => new Response('<html>Sign in to Wi-Fi</html>', { status: 200, headers: { 'content-type': 'text/html' } });
  const unplugged: Wire = async () => {
    throw new TypeError('Failed to fetch');
  };
  /** The headers came, the rest of the answer does not. */
  const stalls: Wire = async (init) => {
    const body = new ReadableStream({ start: (controller) => init.signal?.addEventListener('abort', () => controller.error(init.signal?.reason)) });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const ask = async (path: string, wire: Wire, waits?: number) => {
    between = wire;
    return api(path, 'POST', { text: 'x' }, waits);
  };

  it.each([
    ['its function is stopped', gateway(504)], ['its function crashes', gateway(500)], ['the gateway gives up', gateway(502)],
    ['the platform is busy', gateway(503)], ['an older server blames Gemini', ours(503, 'UPSTREAM_HTTP')], ['the platform answers in JSON', ours(504, '504')],
  ])('AI fill failing is not the cloud being down: %s', async (_, wire) => {
    const reply = await ask(AI, wire);
    expect(connection()).toBe('online');
    expect(reply).toMatchObject({ ok: false, code: 'AI_UNAVAILABLE' });
    if (reply.ok) return;
    expectPlain(reply.message);
    expect(isDown(reply)).toBe(false);
  });

  it.each([['nothing comes', silence], ['half of it comes', stalls]])('AI fill taking too long is not the internet being gone: %s', async (_, wire) => {
    const reply = await ask(AI, wire, 20);
    expect(connection()).toBe('online');
    expect(reply).toMatchObject({ ok: false, code: 'AI_UNAVAILABLE' });
    if (!reply.ok) expectPlain(reply.message);
  }, 5000);

  it.each([AI, ...ELSEWHERE])('no network is no network, whatever was asked (%s)', async (path) => {
    expect(await ask(path, unplugged)).toMatchObject({ ok: false, code: 'OFFLINE' });
    expect(connection()).toBe('offline');
  });

  it.each([AI, ...ELSEWHERE])('our server saying that the cloud is down is believed, whatever was asked (%s)', async (path) => {
    expect(await ask(path, ours(503, 'UNAVAILABLE'))).toMatchObject({ ok: false, code: 'UNAVAILABLE' });
    expect(connection()).toBe('offline');
  });

  it.each([AI, ...ELSEWHERE])('a Wi-Fi sign-in page is no internet, whatever was asked (%s)', async (path) => {
    expect(await ask(path, portal)).toMatchObject({ ok: false, code: 'UNAVAILABLE' });
    expect(connection()).toBe('offline');
  });

  it.each([AI, ...ELSEWHERE])('a lost session is a lost session, whatever was asked (%s)', async (path) => {
    expect(await ask(path, ours(401, 'UNAUTHENTICATED'))).toMatchObject({ ok: false, code: 'UNAUTHENTICATED' });
    expect(connection()).toBe('signed_out');
  });

  it.each([
    ['502', gateway(502)], ['503', gateway(503)], ['504', gateway(504)], ['504 in JSON', ours(504, '504')], ['500 without JSON', gateway(500)],
  ])('everywhere else a gateway still means offline: %s', async (_, wire) => {
    for (const path of ELSEWHERE) {
      setConnection('online');
      expect(await ask(path, wire), path).toMatchObject({ ok: false, code: 'UNAVAILABLE' });
      expect(connection(), path).toBe('offline');
    }
  });

  it.each([['nothing comes', silence], ['half of it comes', stalls]])('everywhere else a dead line still means offline: %s', async (_, wire) => {
    for (const path of ELSEWHERE) {
      setConnection('online');
      expect((await ask(path, wire, 20)).ok, path).toBe(false);
      expect(connection(), path).toBe('offline');
    }
  }, 5000);
});
