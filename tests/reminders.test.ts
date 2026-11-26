// Payment reminders: a bill counts as reminded only once Telegram has taken the message, and
// no bill is out of reach because there are many. Real SQL (PGlite); only Telegram is a fake.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createClient as createSupabase, type SupabaseClient } from '@supabase/supabase-js';
import { GET, runPaymentRemindersCron } from '@/app/api/cron/reminders/route';
import { ACTORS, createTestDb, intraStatePayload, seedMasterData, syncInvoice, type MasterData, type Payload } from './db/harness';
import { pgliteFetch } from './support/postgrest';

const TODAY = '2026-11-23';
const ENV = { NODE_ENV: 'test' as const, TELEGRAM_BOT_TOKEN: 'test-bot-token', TELEGRAM_OWNER_CHAT_ID: '1000' };

let db: PGlite;
let md: MasterData;

/** Answers as Telegram does, its length limit included. */
class FakeTelegram {
  readonly messages: string[] = [];
  calls = 0;
  /** Answers to give first: a status, or a dropped connection. */
  next: (number | 'dropped')[] = [];
  /** Takes this many messages, then nothing gets through. */
  takes = Infinity;

  readonly fetch: typeof fetch = async (input, init) => {
    this.calls += 1;
    const { text } = JSON.parse(String(init?.body)) as { text: string };
    const answer = this.next.shift();
    if (answer === 'dropped' || this.messages.length >= this.takes) throw new TypeError(`request to ${String(input)} failed`);
    if (answer === 429) return Response.json({ ok: false, parameters: { retry_after: 7 } }, { status: 429 });
    if (answer !== undefined && answer !== 200) return Response.json({ ok: false }, { status: answer });
    if (text.length > 4096) return Response.json({ ok: false, description: 'Bad Request: message is too long' }, { status: 400 });
    this.messages.push(text);
    return Response.json({ ok: true });
  };

  /** How often a bill was listed, over everything delivered. */
  timesListed(invoiceNo: string): number {
    return this.messages.join('\n').split(`• ${invoiceNo} `).length - 1;
  }
}

function client(options: { maxRows?: number; wire?: (real: typeof fetch) => typeof fetch } = {}): SupabaseClient {
  const real = pgliteFetch(db, () => ACTORS.service, options.maxRows);
  return createSupabase('http://localhost', 'sb_secret_test', {
    global: { fetch: options.wire ? options.wire(real) : real },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => client() }));

const issue = (dueDate: string, overrides: Payload = {}) =>
  syncInvoice(db, ACTORS.staff, intraStatePayload(md, { invoice_date: '2026-11-01', due_date: dueDate, ...overrides }));

async function issueMany(count: number, dueDate: string): Promise<string[]> {
  const numbers: string[] = [];
  for (let i = 0; i < count; i++) numbers.push((await issue(dueDate)).invoice_no);
  return numbers;
}

async function remind(telegram: FakeTelegram, options: { env?: NodeJS.ProcessEnv; db?: SupabaseClient } = {}) {
  const waits: number[] = [];
  const result = await runPaymentRemindersCron({
    db: options.db ?? client(), todayIst: TODAY, env: options.env ?? ENV, fetchImpl: telegram.fetch,
    sleep: async (ms) => {
      waits.push(ms);
    },
  });
  return { result, waits };
}

/** Bills on record as reminded today. */
async function reminded(): Promise<string[]> {
  const { rows } = await db.query<{ invoice_no: string }>(
    `select invoice_no from public.invoices where last_reminder_sent_on = $1 and cancelled_at is null order by invoice_seq`,
    [TODAY],
  );
  return rows.map((row) => row.invoice_no);
}

beforeAll(async () => {
  db = await createTestDb({ today: TODAY });
  md = await seedMasterData(db);
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await db.query(`update public.invoices set cancelled_at = now(), cancellation_reason = 'between tests' where cancelled_at is null and amount_paid = 0`);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('a reminder counts only once it is delivered', () => {
  it('is not recorded while Telegram is down, and goes out with the next run', async () => {
    const { invoice_no } = await issue(TODAY);
    const telegram = new FakeTelegram();
    telegram.takes = 0;
    expect((await remind(telegram)).result.telegram_sent).toBe(false);
    expect(await reminded()).toEqual([]);

    telegram.takes = Infinity;
    expect((await remind(telegram)).result.telegram_sent).toBe(true);
    expect(telegram.timesListed(invoice_no)).toBe(1);
    expect(await reminded()).toEqual([invoice_no]);

    await remind(telegram);
    expect(telegram.timesListed(invoice_no)).toBe(1);
  });

  it('is not recorded while Telegram is not set up', async () => {
    const { invoice_no } = await issue(TODAY);
    const telegram = new FakeTelegram();
    const { result } = await remind(telegram, { env: { NODE_ENV: 'test' } });
    expect(result.telegram_sent).toBe(false);
    expect(await reminded()).toEqual([]);
    await remind(telegram);
    expect(await reminded()).toEqual([invoice_no]);
  });

  it('waits as long as Telegram asks, and tries again in the same run', async () => {
    const { invoice_no } = await issue(TODAY);
    const telegram = new FakeTelegram();
    telegram.next = [429];
    const { result, waits } = await remind(telegram);
    expect(result.telegram_sent).toBe(true);
    expect(waits).toEqual([7000]);
    expect(await reminded()).toEqual([invoice_no]);
  });

  it('survives a dropped connection and a server error in the same run', async () => {
    const { invoice_no } = await issue(TODAY);
    const telegram = new FakeTelegram();
    telegram.next = ['dropped', 502];
    expect((await remind(telegram)).result.telegram_sent).toBe(true);
    expect(telegram.calls).toBe(3);
    expect(await reminded()).toEqual([invoice_no]);
  });

  it('reports a lost connection without its address, which has the bot token in it', async () => {
    await issue(TODAY);
    const telegram = new FakeTelegram();
    telegram.takes = 0;
    const { result } = await remind(telegram);
    expect(result.telegram_error).toBeTruthy();
    expect(JSON.stringify(result)).not.toContain(ENV.TELEGRAM_BOT_TOKEN);
  });

  it('does not repeat a message Telegram refuses', async () => {
    await issue(TODAY);
    const telegram = new FakeTelegram();
    telegram.next = [403];
    expect((await remind(telegram)).result.telegram_sent).toBe(false);
    expect(telegram.calls).toBe(1);
    expect(await reminded()).toEqual([]);
  });

  it('says so when a delivered reminder could not be recorded', async () => {
    await issue(TODAY);
    const telegram = new FakeTelegram();
    const readOnly = client({
      wire: (real) => async (input, init) =>
        init?.method === 'PATCH' ? Response.json({ code: '57014', message: 'canceling statement due to statement timeout' }, { status: 500 }) : real(input, init),
    });
    const { result } = await remind(telegram, { db: readOnly });
    expect(result.telegram_sent).toBe(true);
    expect(result.unrecorded).toBe(1);
  });
});

describe('any number of bills', () => {
  it('reaches the owner in as many messages as Telegram needs', async () => {
    const numbers = await issueMany(12, '2026-11-16');
    const telegram = new FakeTelegram();
    const { result } = await remind(telegram);
    expect(result.telegram_sent).toBe(true);
    expect(telegram.messages.length).toBeGreaterThan(1);
    for (const no of numbers) expect([no, telegram.timesListed(no)]).toEqual([no, 1]);
    expect(telegram.messages.join('\n').match(/https:\/\/wa\.me\//g)).toHaveLength(12);
    expect(telegram.messages[0]).toContain('12 bill(s)');
    expect(await reminded()).toEqual(numbers);
  });

  it('records only the delivered messages when it stops half way, and finishes next time', async () => {
    const numbers = await issueMany(12, '2026-11-16');
    const telegram = new FakeTelegram();
    telegram.takes = 1;
    expect((await remind(telegram)).result.telegram_sent).toBe(false);
    const first = await reminded();
    expect(first.length).toBeGreaterThan(0);
    expect(first.length).toBeLessThan(12);
    for (const no of first) expect(telegram.timesListed(no)).toBe(1);

    telegram.takes = Infinity;
    expect((await remind(telegram)).result.telegram_sent).toBe(true);
    for (const no of numbers) expect([no, telegram.timesListed(no)]).toEqual([no, 1]);
    expect(await reminded()).toEqual(numbers);
  });

  it('finds bills that are due however many paid ones came before', async () => {
    for (let i = 0; i < 8; i++) await issue('2026-11-02', { amount_paid: '1770.00', payment_status: 'paid', payment_mode: 'cash' });
    const numbers = await issueMany(7, '2026-11-20');
    const telegram = new FakeTelegram();
    await remind(telegram, { db: client({ maxRows: 5 }) });
    expect(await reminded()).toEqual(numbers);
  });

  it('writes to the customer’s present number however many customers there are', async () => {
    await db.exec(`insert into public.customers (name, state_code, credit_days) select 'Other ' || i, '33', 0 from generate_series(1, 10) as i`);
    const { rows } = await db.query<{ id: string }>(`insert into public.customers (name, state_code, credit_days, phone) values ('Moved Works', '33', 0, '9000000001') returning id`);
    await issue(TODAY, { customer_id: rows[0]?.id });
    await db.query(`update public.customers set phone = '9000000002' where id = $1`, [rows[0]?.id]);
    const telegram = new FakeTelegram();
    await remind(telegram, { db: client({ maxRows: 3 }) });
    expect(telegram.messages.join('\n')).toContain('https://wa.me/919000000002?');
    expect(telegram.messages.join('\n')).not.toContain('9000000001');
  });
});

describe('what the customer is told', () => {
  /** The WhatsApp message behind a bill's link, as the owner gets it. */
  function draft(telegram: FakeTelegram, invoiceNo: string): string {
    const [, link = ''] = telegram.messages.join('\n').split(`• ${invoiceNo} `)[1]?.split('\n') ?? [];
    return new URL(link.trim()).searchParams.get('text') ?? '';
  }

  it('says today, a week or 15 days only on that very day', async () => {
    const LATENESS = ['is due today', 'a week ago', '15 days overdue'];
    const dueDates: [daysLate: number, dueDate: string][] = [
      [0, '2026-11-23'], [1, '2026-11-22'], [6, '2026-11-17'], [7, '2026-11-16'], [8, '2026-11-15'], [14, '2026-11-09'], [15, '2026-11-08'], [16, '2026-11-07'], [30, '2026-10-24'],
    ];
    const bills: [daysLate: number, invoiceNo: string][] = [];
    for (const [daysLate, dueDate] of dueDates) bills.push([daysLate, (await issue(dueDate, { invoice_date: '2026-10-24' })).invoice_no]);
    const telegram = new FakeTelegram();
    await remind(telegram);
    expect(bills.map(([daysLate, no]) => [daysLate, ...LATENESS.filter((words) => draft(telegram, no).includes(words))])).toEqual([
      [0, 'is due today'], [1], [6], [7, 'a week ago'], [8], [14], [15, '15 days overdue'], [16], [30],
    ]);
  });

  it('gives the facts alone on the days between', async () => {
    const { invoice_no } = await issue('2026-11-20');
    const telegram = new FakeTelegram();
    await remind(telegram);
    expect(draft(telegram, invoice_no)).toBe(`Hello Murugan Engineering Works, Demo Stud Works invoice ${invoice_no} (1 Nov 2026): balance ₹1,770.00, due 20 Nov 2026. Thank you.`);
  });

  it('is on record with a stage only if that stage went out, and once a day either way', async () => {
    const between = await issue('2026-11-20');
    const week = await issue('2026-11-16');
    const telegram = new FakeTelegram();
    await remind(telegram);
    const { rows } = await db.query(
      `select invoice_no, last_reminder_stage as stage, last_reminder_sent_on::text as sent_on from public.invoices where id in ($1, $2) order by invoice_seq`,
      [between.invoice_id, week.invoice_id],
    );
    expect(rows).toEqual([
      { invoice_no: between.invoice_no, stage: null, sent_on: TODAY },
      { invoice_no: week.invoice_no, stage: 'overdue_7', sent_on: TODAY },
    ]);
    await remind(telegram);
    expect([between, week].map(({ invoice_no }) => telegram.timesListed(invoice_no))).toEqual([1, 1]);
  });
});

describe('the scheduled run', () => {
  const SECRET = 'reminders-test-secret-0123456789abcdef';
  async function run(telegram: FakeTelegram): Promise<Response> {
    vi.stubEnv('CRON_SECRET', SECRET);
    vi.stubEnv('TELEGRAM_BOT_TOKEN', ENV.TELEGRAM_BOT_TOKEN);
    vi.stubEnv('TELEGRAM_OWNER_CHAT_ID', ENV.TELEGRAM_OWNER_CHAT_ID);
    vi.stubGlobal('fetch', telegram.fetch);
    return GET(new Request(`http://localhost/api/cron/reminders?today=${TODAY}`, { headers: { authorization: `Bearer ${SECRET}` } }));
  }

  it('is a failed run when bills could not be delivered', async () => {
    await issue(TODAY);
    const telegram = new FakeTelegram();
    telegram.next = [403];
    const response = await run(telegram);
    expect(response.status).toBe(502);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('NOT_DELIVERED');
  });

  it('is a good run when they were, and when there is nothing to send', async () => {
    await issue(TODAY);
    const telegram = new FakeTelegram();
    expect((await run(telegram)).status).toBe(200);
    expect((await run(telegram)).status).toBe(200);
    expect(telegram.messages).toHaveLength(1);
  });
});
