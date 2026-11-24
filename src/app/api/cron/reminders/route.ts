import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { verifyCronAuth } from '@/app/api/cron/weekly-backup/route';
import { outstandingPaise } from '@/lib/billing-math';
import { daysBetween, istDate } from '@/lib/india';
import { decimalToPaise, formatInr, formatPaise } from '@/lib/money';
import { PAGE_ROWS, readAllRows } from '@/lib/read-all';
import { createAdminClient } from '@/lib/supabase/admin';
import { sendTelegramAlert, TELEGRAM_MAX_CHARS } from '@/lib/telegram';
import { invoiceSummaryText, reminderStage, reminderText, whatsappLink, type MessageFacts, type Stage as ReminderStage } from '@/lib/whatsapp';

const NO_STORE = { 'cache-control': 'no-store' };

export interface ReminderInvoiceCandidate {
  invoice_id: string;
  invoice_no: string;
  customer_id: string;
  customer_name: string;
  customer_phone: string | null;
  invoice_date: string;
  due_date: string;
  days_overdue: number;
  /** Null between the reminder days: no stage's wording is true then. */
  stage: ReminderStage | null;
  is_milestone_day: boolean;
  outstanding_paise: number;
  outstanding_inr: string;
  pdf_drive_url: string | null;
  whatsapp_url: string | null;
  whatsapp_message: string;
  missing_phone: boolean;
}

export interface PaymentRemindersCronResult {
  today_ist: string;
  total_eligible: number;
  milestone_count: number;
  skipped_already_sent: number;
  total_outstanding_paise: number;
  tiers: {
    due: ReminderInvoiceCandidate[];
    overdue_7: ReminderInvoiceCandidate[];
    overdue_15: ReminderInvoiceCandidate[];
    other_overdue: ReminderInvoiceCandidate[];
  };
  telegram_digest: string | null;
  /** Every eligible bill reached the owner. */
  telegram_sent: boolean;
  /** Telegram is not set up, so nothing was tried. */
  telegram_skipped: boolean;
  telegram_error: string | null;
  delivered: number;
  /** Delivered, but the database did not take the note: the next run repeats these. */
  unrecorded: number;
}

interface OpenInvoice {
  id: string;
  invoice_no: string;
  customer_id: string;
  invoice_date: string;
  due_date: string;
  grand_total: string | number;
  amount_paid: string | number;
  pdf_drive_url: string | null;
  customer_snapshot: { name?: string; phone?: string | null } | null;
  supplier_snapshot: { legal_name?: string; phone?: string | null } | null;
  last_reminder_stage: string | null;
  last_reminder_sent_on: string | null;
}

interface Contact {
  id: string;
  name: string;
  phone: string | null;
}

interface DigestMessage {
  text: string;
  candidates: ReminderInvoiceCandidate[];
}

function digestBlock(item: ReminderInvoiceCandidate): string {
  const tierTag = item.days_overdue === 0 ? 'DUE TODAY' : `${item.days_overdue}d overdue`;
  const phoneNote = item.missing_phone ? 'Missing phone — call or update customer card' : (item.whatsapp_url ?? '');
  return `• ${item.invoice_no} · ${item.customer_name} · ₹${item.outstanding_inr} (${tierTag})${phoneNote ? `\n  ${phoneNote}` : ''}`;
}

/** Over its limit, Telegram refuses the whole message: the bills go in as many as they need. */
export function buildDigestMessages(options: {
  todayIst: string;
  candidates: readonly ReminderInvoiceCandidate[];
  totalOutstandingPaise: number;
}): DigestMessage[] {
  const title = `StudFlow Credit Digest (${options.todayIst})`;
  const summary = `Overdue / Due Today: ${options.candidates.length} bill(s) · Total ${formatInr(options.totalOutstandingPaise)}`;
  const room = TELEGRAM_MAX_CHARS - `${title} · 999/999\n${summary}`.length;

  const groups: { items: ReminderInvoiceCandidate[]; length: number }[] = [];
  for (const item of options.candidates) {
    const length = digestBlock(item).length + 1; // its line break
    const open = groups.at(-1);
    if (open && open.length + length <= room) {
      open.items.push(item);
      open.length += length;
    } else {
      groups.push({ items: [item], length });
    }
  }
  return groups.map(({ items }, i) => ({
    candidates: items,
    text: [
      groups.length > 1 ? `${title} · ${i + 1}/${groups.length}` : title,
      ...(i === 0 ? [summary] : []),
      ...items.map(digestBlock),
    ].join('\n'),
  }));
}

/** Present names and phones of these customers. */
async function readContacts(db: SupabaseClient, ids: readonly string[]): Promise<Map<string, Contact>> {
  const contacts = new Map<string, Contact>();
  for (let i = 0; i < ids.length; i += 100) {
    const some = ids.slice(i, i + 100);
    const rows = await readAllRows<Contact>((after) => {
      const page = db.from('customers').select('id, name, phone').in('id', some).order('id').limit(PAGE_ROWS);
      return after === null ? page : page.gt('id', after);
    });
    for (const row of rows) contacts.set(row.id, row);
  }
  return contacts;
}

/** Notes the stage on delivered bills, so a second run today leaves them out. Returns how many it could not note. */
async function recordDelivered(db: SupabaseClient, delivered: readonly ReminderInvoiceCandidate[], todayIst: string): Promise<number> {
  let failed = 0;
  for (const stage of new Set(delivered.map((item) => item.stage))) {
    const ids = delivered.filter((item) => item.stage === stage).map((item) => item.invoice_id);
    const { error } = await db.from('invoices').update({ last_reminder_stage: stage, last_reminder_sent_on: todayIst }).in('id', ids);
    if (error) {
      failed += ids.length;
      console.error('payment reminders delivered but not recorded', error.code);
    }
  }
  return failed;
}

export async function runPaymentRemindersCron(options: {
  db?: SupabaseClient;
  todayIst?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
} = {}): Promise<PaymentRemindersCronResult> {
  const db = options.db ?? createAdminClient();
  const todayIst = options.todayIst ?? istDate(new Date());

  const openInvoices = (
    await readAllRows<OpenInvoice>((after) => {
      const page = db
        .from('invoices')
        .select(
          'id, invoice_no, customer_id, invoice_date, due_date, grand_total, amount_paid, pdf_drive_url, customer_snapshot, supplier_snapshot, last_reminder_stage, last_reminder_sent_on',
        )
        .is('cancelled_at', null)
        .in('payment_status', ['unpaid', 'partial'])
        .lte('due_date', todayIst)
        .order('id')
        .limit(PAGE_ROWS);
      return after === null ? page : page.gt('id', after);
    })
  ).sort((a, b) => a.due_date.localeCompare(b.due_date) || a.invoice_no.localeCompare(b.invoice_no));

  const companyRes = await db
    .from('company_profile')
    .select('legal_name, phone')
    .limit(1);

  const contacts = await readContacts(db, [...new Set(openInvoices.map((inv) => inv.customer_id))]);

  const companyRows = (companyRes.data ?? []) as Array<{ legal_name?: string; phone?: string | null }>;
  const companyProfile = companyRows[0] ?? null;

  const tiers: PaymentRemindersCronResult['tiers'] = {
    due: [],
    overdue_7: [],
    overdue_15: [],
    other_overdue: [],
  };

  const digestCandidates: ReminderInvoiceCandidate[] = [];
  let skipped_already_sent = 0;
  let total_outstanding_paise = 0;

  for (const inv of openInvoices) {
    const balancePaise = outstandingPaise(
      decimalToPaise(String(inv.grand_total)),
      decimalToPaise(String(inv.amount_paid)),
    );
    if (balancePaise <= 0) continue;

    const stage = reminderStage(inv.due_date, todayIst);

    // Same-day deduplication, on the days between (no stage) too
    if (
      inv.last_reminder_stage === stage &&
      inv.last_reminder_sent_on === todayIst
    ) {
      skipped_already_sent += 1;
      continue;
    }

    const liveCustomer = contacts.get(inv.customer_id);
    const customerName = liveCustomer?.name ?? inv.customer_snapshot?.name ?? 'Customer';
    const customerPhone = (liveCustomer?.phone ?? inv.customer_snapshot?.phone ?? null)?.trim() || null;
    const supplierName = companyProfile?.legal_name ?? inv.supplier_snapshot?.legal_name ?? 'StudFlow Engineering';

    const facts: MessageFacts = {
      recipientName: customerName,
      companyName: supplierName,
      invoiceNo: inv.invoice_no,
      invoiceDate: inv.invoice_date,
      dueDate: inv.due_date,
      balancePaise,
    };
    const baseMessage = stage ? reminderText(stage, 'tanglish', facts) : invoiceSummaryText(facts);
    const whatsapp_message = inv.pdf_drive_url
      ? `${baseMessage}\nInvoice PDF: ${inv.pdf_drive_url}`
      : baseMessage;

    const whatsapp_url = customerPhone ? whatsappLink(customerPhone, whatsapp_message) : null;
    const candidate: ReminderInvoiceCandidate = {
      invoice_id: inv.id,
      invoice_no: inv.invoice_no,
      customer_id: inv.customer_id,
      customer_name: customerName,
      customer_phone: customerPhone,
      invoice_date: inv.invoice_date,
      due_date: inv.due_date,
      days_overdue: daysBetween(inv.due_date, todayIst),
      stage,
      is_milestone_day: stage !== null,
      outstanding_paise: balancePaise,
      outstanding_inr: formatPaise(balancePaise),
      pdf_drive_url: inv.pdf_drive_url,
      whatsapp_url,
      whatsapp_message,
      missing_phone: whatsapp_url === null,
    };

    tiers[stage ?? 'other_overdue'].push(candidate);
    digestCandidates.push(candidate);
    total_outstanding_paise += balancePaise;
  }

  const messages = buildDigestMessages({ todayIst, candidates: digestCandidates, totalOutstandingPaise: total_outstanding_paise });
  let delivered = 0;
  let unrecorded = 0;
  let telegram_skipped = false;
  let telegram_error: string | null = null;
  for (const message of messages) {
    const sendRes = await sendTelegramAlert({
      text: message.text,
      ...(options.env ? { env: options.env } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.sleep ? { sleep: options.sleep } : {}),
    });
    if (sendRes.sent) {
      // Sent first, recorded second: the other way round, a failed send is a reminder nobody gets.
      delivered += message.candidates.length;
      unrecorded += await recordDelivered(db, message.candidates, todayIst);
      continue;
    }
    telegram_skipped = sendRes.skipped;
    telegram_error ??= sendRes.error ?? null;
    if (!sendRes.refused) break; // down, or not set up: the next message would fare no better
  }

  return {
    today_ist: todayIst,
    total_eligible: digestCandidates.length,
    milestone_count: tiers.due.length + tiers.overdue_7.length + tiers.overdue_15.length,
    skipped_already_sent,
    total_outstanding_paise,
    tiers,
    telegram_digest: messages.length > 0 ? messages.map((message) => message.text).join('\n\n') : null,
    telegram_sent: messages.length > 0 && delivered === digestCandidates.length,
    telegram_skipped,
    telegram_error,
    delivered,
    unrecorded,
  };
}

async function handleRemindersCron(request: Request): Promise<NextResponse> {
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
    const url = new URL(request.url);
    const todayParam = url.searchParams.get('today');
    const data = await runPaymentRemindersCron({
      ...(todayParam && /^\d{4}-\d{2}-\d{2}$/.test(todayParam) ? { todayIst: todayParam } : {}),
    });
    if (!data.telegram_skipped && data.delivered < data.total_eligible) {
      const { delivered, total_eligible, telegram_error } = data;
      return NextResponse.json(
        { error: { code: 'NOT_DELIVERED', message: 'Some reminders did not reach Telegram; the next run sends them', details: { delivered, total_eligible, telegram_error } } },
        { status: 502, headers: NO_STORE },
      );
    }
    return NextResponse.json({ data }, { status: 200, headers: NO_STORE });
  } catch (error) {
    console.error('payment reminders cron error', error instanceof Error ? error.name : typeof error);
    return NextResponse.json(
      { error: { code: 'INTERNAL', message: 'Failed to run payment reminders cron' } },
      { status: 500, headers: NO_STORE },
    );
  }
}

export const GET = handleRemindersCron;
export const POST = handleRemindersCron;
