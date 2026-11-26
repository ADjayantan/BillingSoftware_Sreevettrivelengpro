/** Payment messages, the English ones of specs/whatsapp-templates.md, and the wa.me draft link. Pure. */
import { daysBetween, formatDate } from './india';
import { formatInr } from './money';

export type Stage = 'due' | 'overdue_7' | 'overdue_15';

const TEMPLATES: Record<Stage, string> = {
  due:
    'Hello {{recipient_name}}, a friendly reminder from {{company_name}}. The balance of {{balance}} on invoice {{invoice_no}} ({{invoice_date}}) is due today, {{due_date}}. If you’ve already paid, please share the payment reference so we can update our records. Thank you.',
  overdue_7:
    'Hello {{recipient_name}}, invoice {{invoice_no}} from {{company_name}} was due on {{due_date}}, a week ago. Our records show {{balance}} outstanding. Could you confirm the date we can expect payment? If you’ve already transferred it, the payment reference is enough. Thank you.',
  overdue_15:
    'Hello {{recipient_name}}, the {{balance}} outstanding on {{company_name}} invoice {{invoice_no}} is now 15 days overdue (due {{due_date}}). Please arrange payment today, or reply today with a definite payment date. If the amount differs from your records, please tell us so we can reconcile it. Thank you.',
};

/** The wording says "today", "a week ago", "15 days", so a stage is valid on that day only. */
export function reminderStage(dueDate: string, today: string): Stage | null {
  switch (daysBetween(dueDate, today)) {
    case 0:
      return 'due';
    case 7:
      return 'overdue_7';
    case 15:
      return 'overdue_15';
    default:
      return null;
  }
}

export interface MessageFacts {
  recipientName: string;
  companyName: string;
  invoiceNo: string;
  invoiceDate: string;
  dueDate: string;
  balancePaise: number;
}

export function reminderText(stage: Stage, facts: MessageFacts): string {
  const values: Record<string, string> = {
    recipient_name: facts.recipientName,
    company_name: facts.companyName,
    invoice_no: facts.invoiceNo,
    invoice_date: formatDate(facts.invoiceDate),
    due_date: formatDate(facts.dueDate),
    balance: formatInr(facts.balancePaise),
  };
  return TEMPLATES[stage].replace(/\{\{(\w+)\}\}/g, (_match, field: string) => values[field] ?? '');
}

/** For days that match no reminder stage: the facts, with no claim about lateness. */
export function invoiceSummaryText(facts: MessageFacts): string {
  return `Hello ${facts.recipientName}, ${facts.companyName} invoice ${facts.invoiceNo} (${formatDate(facts.invoiceDate)}): balance ${formatInr(facts.balancePaise)}, due ${formatDate(facts.dueDate)}. Thank you.`;
}

/** Digits with country code, or null. Ten-digit numbers are Indian mobiles. */
export function whatsappNumber(phone: string | null): string | null {
  const digits = (phone ?? '').replace(/\D/g, '');
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 11 && digits.startsWith('0')) return `91${digits.slice(1)}`;
  return digits.length >= 11 ? digits : null;
}

export function whatsappLink(phone: string | null, text: string): string | null {
  const number = whatsappNumber(phone);
  return number ? `https://wa.me/${number}?text=${encodeURIComponent(text)}` : null;
}

export interface WhatsappDraft {
  label: string;
  href: string;
}

/** The wording that is true today, or none without a phone; opening it only drafts the message. */
export function whatsappDrafts(phone: string | null, today: string, facts: MessageFacts): WhatsappDraft[] {
  const stage = reminderStage(facts.dueDate, today);
  const href = whatsappLink(phone, stage ? reminderText(stage, facts) : invoiceSummaryText(facts));
  return href ? [{ label: 'WhatsApp', href }] : [];
}
