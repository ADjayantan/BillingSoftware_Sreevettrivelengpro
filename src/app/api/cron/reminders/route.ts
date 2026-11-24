import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { verifyCronAuth } from '@/app/api/cron/weekly-backup/route';
import { outstandingPaise } from '@/lib/billing-math';
import { istDate } from '@/lib/india';
import { decimalToPaise, formatInr, formatPaise } from '@/lib/money';
import { createAdminClient } from '@/lib/supabase/admin';
import { sendTelegramAlert } from '@/lib/telegram';
import { reminderText, whatsappLink, type Stage as ReminderStage } from '@/lib/whatsapp';

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
  stage: ReminderStage;
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
  telegram_sent: boolean;
}

function diffCalendarDays(laterYmd: string, earlierYmd: string): number {
  const later = Date.parse(`${laterYmd}T00:00:00Z`);
  const earlier = Date.parse(`${earlierYmd}T00:00:00Z`);
  return Math.round((later - earlier) / 86_400_000);
}

function classifyReminderStage(daysOverdue: number): {
  stage: ReminderStage;
  isMilestoneDay: boolean;
} {
  if (daysOverdue <= 0) {
    return { stage: 'due', isMilestoneDay: daysOverdue === 0 };
  }
  if (daysOverdue === 7) {
    return { stage: 'overdue_7', isMilestoneDay: true };
  }
  if (daysOverdue === 15) {
    return { stage: 'overdue_15', isMilestoneDay: true };
  }
  if (daysOverdue >= 15) {
    return { stage: 'overdue_15', isMilestoneDay: false };
  }
  return { stage: 'overdue_7', isMilestoneDay: false };
}

export function formatRemindersTelegramDigest(options: {
  todayIst: string;
  candidates: readonly ReminderInvoiceCandidate[];
  totalOutstandingPaise: number;
}): string | null {
  if (options.candidates.length === 0) return null;

  const lines: string[] = [
    `StudFlow Credit Digest (${options.todayIst})`,
    `Overdue / Due Today: ${options.candidates.length} bill(s) · Total ${formatInr(options.totalOutstandingPaise)}`,
  ];

  for (const item of options.candidates) {
    const tierTag =
      item.days_overdue === 0
        ? 'DUE TODAY'
        : `${item.days_overdue}d overdue`;
    const phoneNote = item.missing_phone
      ? 'Missing phone — call or update customer card'
      : item.whatsapp_url ?? '';
    lines.push(
      `• ${item.invoice_no} · ${item.customer_name} · ₹${item.outstanding_inr} (${tierTag})${phoneNote ? `\n  ${phoneNote}` : ''}`,
    );
  }

  return lines.join('\n');
}

export async function runPaymentRemindersCron(options: {
  db?: SupabaseClient;
  todayIst?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
} = {}): Promise<PaymentRemindersCronResult> {
  const db = options.db ?? createAdminClient();
  const todayIst = options.todayIst ?? istDate(new Date());

  const invoicesRes = await db
    .from('invoices')
    .select(
      'id, invoice_no, customer_id, invoice_date, due_date, grand_total, amount_paid, payment_status, pdf_drive_url, cancelled_at, customer_snapshot, supplier_snapshot, last_reminder_stage, last_reminder_sent_on',
    )
    .is('cancelled_at', null)
    .order('due_date', { ascending: true });

  if (invoicesRes.error) throw invoicesRes.error;

  const companyRes = await db
    .from('company_profile')
    .select('legal_name, phone')
    .limit(1);

  const rawInvoices = ((invoicesRes.data ?? []) as Array<{
    id: string;
    invoice_no: string;
    customer_id: string;
    invoice_date: string;
    due_date: string | null;
    grand_total: string | number;
    amount_paid: string | number;
    payment_status: string;
    pdf_drive_url: string | null;
    cancelled_at: string | null;
    customer_snapshot: { name?: string; phone?: string | null } | null;
    supplier_snapshot: { legal_name?: string; phone?: string | null } | null;
    last_reminder_stage?: string | null;
    last_reminder_sent_on?: string | null;
  }>)
    .filter(
      (inv) =>
        (inv.payment_status === 'unpaid' || inv.payment_status === 'partial') &&
        inv.due_date !== null &&
        inv.due_date <= todayIst,
    )
    .sort((a, b) => (a.due_date ?? '').localeCompare(b.due_date ?? '') || a.invoice_no.localeCompare(b.invoice_no));

  const customersById = new Map<string, { name: string; phone: string | null }>();
  if (rawInvoices.length > 0) {
    const { data: custRows, error: custErr } = await db
      .from('customers')
      .select('id, name, phone');
    if (custErr) throw custErr;
    for (const c of (custRows ?? []) as Array<{ id: string; name: string; phone: string | null }>) {
      customersById.set(c.id, { name: c.name, phone: c.phone });
    }
  }

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

  for (const inv of rawInvoices) {
    if (!inv.due_date || inv.cancelled_at !== null) continue;
    const balancePaise = outstandingPaise(
      decimalToPaise(String(inv.grand_total)),
      decimalToPaise(String(inv.amount_paid)),
    );
    if (balancePaise <= 0) continue;

    const daysOverdue = diffCalendarDays(todayIst, inv.due_date);
    if (daysOverdue < 0) continue;

    const { stage, isMilestoneDay } = classifyReminderStage(daysOverdue);

    // Same-day stage deduplication
    if (
      inv.last_reminder_stage === stage &&
      inv.last_reminder_sent_on === todayIst
    ) {
      skipped_already_sent += 1;
      continue;
    }

    const liveCustomer = customersById.get(inv.customer_id);
    const customerName = liveCustomer?.name ?? inv.customer_snapshot?.name ?? 'Customer';
    const customerPhone = (liveCustomer?.phone ?? inv.customer_snapshot?.phone ?? null)?.trim() || null;
    const supplierName = companyProfile?.legal_name ?? inv.supplier_snapshot?.legal_name ?? 'StudFlow Engineering';

    const baseMessage = reminderText(stage, 'tanglish', {
      recipientName: customerName,
      companyName: supplierName,
      invoiceNo: inv.invoice_no,
      invoiceDate: inv.invoice_date,
      dueDate: inv.due_date,
      balancePaise: balancePaise,
    });
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
      days_overdue: daysOverdue,
      stage,
      is_milestone_day: isMilestoneDay,
      outstanding_paise: balancePaise,
      outstanding_inr: formatPaise(balancePaise),
      pdf_drive_url: inv.pdf_drive_url,
      whatsapp_url,
      whatsapp_message,
      missing_phone: whatsapp_url === null,
    };

    if (daysOverdue === 0) {
      tiers.due.push(candidate);
    } else if (daysOverdue === 7) {
      tiers.overdue_7.push(candidate);
    } else if (daysOverdue === 15) {
      tiers.overdue_15.push(candidate);
    } else {
      tiers.other_overdue.push(candidate);
    }

    digestCandidates.push(candidate);
    total_outstanding_paise += balancePaise;

    // Record reminder stage dispatch on the invoice so a second same-day cron run skips it
    await db
      .from('invoices')
      .update({
        last_reminder_stage: stage,
        last_reminder_sent_on: todayIst,
      })
      .eq('id', inv.id);
  }

  const telegram_digest = formatRemindersTelegramDigest({
    todayIst,
    candidates: digestCandidates,
    totalOutstandingPaise: total_outstanding_paise,
  });

  let telegram_sent = false;
  if (telegram_digest) {
    const sendRes = await sendTelegramAlert({
      text: telegram_digest,
      ...(options.env ? { env: options.env } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
    telegram_sent = sendRes.sent;
  }

  return {
    today_ist: todayIst,
    total_eligible: digestCandidates.length,
    milestone_count: tiers.due.length + tiers.overdue_7.length + tiers.overdue_15.length,
    skipped_already_sent,
    total_outstanding_paise,
    tiers,
    telegram_digest,
    telegram_sent,
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
