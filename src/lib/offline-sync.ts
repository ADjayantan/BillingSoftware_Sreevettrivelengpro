/**
 * Sends what waits on this device: new customers first, then the bills, oldest first, one at a
 * time. Safe to run twice and after any crash.
 */
import { z } from 'zod';
import type { ApiResult } from './api-client';
import { customerBody, customerProblem, reviveCustomer, type CustomerBody } from './customer-form';
import { holdForReview, markCreated, moveTo, pruneSynced, joinCustomer, type NewCustomerRecord, type OfflineDb, type QueueRecord } from './offline-db';
import { keepCustomer } from './master-cache';
import { billDraft, issuedBill, type BillDraftInput, type IssuedBill } from './schemas/invoices';
import { customerInput, customerRow, type Customer } from './schemas/masters';

export type SendBill = (draft: BillDraftInput) => Promise<ApiResult<{ invoice_id: string; invoice_no: string; dc_no: string }>>;
export type CreateCustomer = (body: CustomerBody) => Promise<ApiResult<unknown>>;

/** Says nothing about what was sent, only that it was not dealt with. */
type Trouble =
  /** It made the server stumble: keep it, but do not hold up the ones behind it. */
  | { kind: 'skip'; message: string }
  /** The cloud, the session or the setup: keep it, stop, try later. */
  | { kind: 'wait'; reason: 'offline' | 'signed_out' | 'not_ready'; message: string };

export type Verdict =
  | { kind: 'synced'; issued: IssuedBill }
  | { kind: 'conflict'; issued: IssuedBill; message: string }
  | { kind: 'rejected'; message: string }
  | Trouble;

/** Answers about the account or the setup, not about this bill: every other bill would get them too. */
const NOT_ABOUT_THE_BILL = new Set(['FORBIDDEN', 'NOT_READY']);
const NOT_UNDERSTOOD: Trouble = { kind: 'wait', reason: 'offline', message: 'The reply was not understood' };

function trouble(result: { status: number; code: string; message: string }): Trouble | null {
  if (result.code === 'UNAUTHENTICATED') return { kind: 'wait', reason: 'signed_out', message: result.message };
  if (result.code === 'INTERNAL') return { kind: 'skip', message: result.message };
  if (result.status === 0 || result.status >= 500 || result.status === 408 || result.status === 429 || result.code === 'UNAVAILABLE') {
    return { kind: 'wait', reason: 'offline', message: result.message };
  }
  if (NOT_ABOUT_THE_BILL.has(result.code)) return { kind: 'wait', reason: 'not_ready', message: result.message };
  return null;
}

export function judge(result: Awaited<ReturnType<SendBill>>): Verdict {
  if (result.ok) {
    const issued = issuedBill.safeParse({ ...result.data, grand_total: null });
    return issued.success ? { kind: 'synced', issued: issued.data } : NOT_UNDERSTOOD;
  }
  if (result.code === 'ALREADY_ISSUED') {
    const issued = issuedBill.safeParse(result.details?.issued);
    if (issued.success) return { kind: 'conflict', issued: issued.data, message: result.message };
  }
  return trouble(result) ?? { kind: 'rejected', message: result.message };
}

export type CustomerVerdict =
  | { kind: 'created'; customer: Customer }
  /** The same GSTIN and the same name, made on another device: one business. */
  | { kind: 'same'; customer: Customer }
  | { kind: 'review'; reason: NewCustomerRecord['reason']; candidates: Customer[]; message: string }
  | Trouble;

const existing = z.object({ existing: customerRow, same_name: z.boolean() });
const similar = z.object({ candidates: z.array(customerRow).min(1) });

export function judgeCustomer(result: ApiResult<unknown>): CustomerVerdict {
  if (result.ok) {
    const row = customerRow.safeParse(result.data);
    return row.success ? { kind: 'created', customer: row.data } : NOT_UNDERSTOOD;
  }
  if (result.code === 'CUSTOMER_EXISTS') {
    const found = existing.safeParse(result.details);
    if (found.success) {
      const customer = found.data.existing;
      // One that was switched off was switched off for a reason: that is the owner's to say.
      if (found.data.same_name && customer.is_active) return { kind: 'same', customer };
      return { kind: 'review', reason: 'gstin', candidates: [customer], message: result.message };
    }
  }
  if (result.code === 'CUSTOMER_SIMILAR') {
    const found = similar.safeParse(result.details);
    if (found.success) return { kind: 'review', reason: 'similar', candidates: found.data.candidates, message: result.message };
  }
  return trouble(result) ?? { kind: 'review', reason: null, candidates: [], message: result.message };
}

/** What is stored may come from an older version, or be damaged. */
function sendable(record: NewCustomerRecord): CustomerBody | { problem: string } {
  const unreadable = { problem: 'These customer details are not readable. Open the bill, check them and save again.' };
  try {
    const form = reviveCustomer(record.form);
    if (!form || form.id !== record.id) return unreadable;
    const problem = customerProblem(form);
    if (problem) return { problem: problem.message };
    const body = customerBody(form);
    return customerInput.safeParse(body).success ? body : unreadable;
  } catch {
    return unreadable;
  }
}

/** Null: dealt with, one way or another. */
async function settleCustomer(db: OfflineDb, record: NewCustomerRecord, create: CreateCustomer): Promise<Trouble | null> {
  const body = sendable(record);
  if ('problem' in body) {
    await holdForReview(db, record.id, { reason: null, candidates: [], message: body.problem });
    return null;
  }
  const verdict = judgeCustomer(await create(body));
  switch (verdict.kind) {
    case 'created':
      await markCreated(db, record.id, record.form); // typed again meanwhile: the books have what was sent
      await keepCustomer(db, verdict.customer);
      return null;
    case 'same':
      await joinCustomer(db, record.id, verdict.customer, `${verdict.customer.name} was already in the books with this GSTIN: billed to it`);
      return null;
    case 'review':
      await holdForReview(db, record.id, verdict);
      return null;
    default:
      return verdict;
  }
}

export interface DrainResult {
  stopped: 'done' | 'retry' | 'offline' | 'signed_out' | 'not_ready';
  message: string | null;
}

const settle = (db: OfflineDb, item: QueueRecord, change: Partial<QueueRecord>): Promise<number> =>
  db.offline_queue.where('seq').equals(item.seq).and((now) => now.status === 'pending').modify({ ...change, settled_at: Date.now() });

/** New customers, oldest first. A bill whose customer is not settled is not sent. */
async function drainCustomers(db: OfflineDb, create: CreateCustomer): Promise<{ waiting: Trouble | null; skipped: Map<string, string> }> {
  const skipped = new Map<string, string>();
  const waiting = (await db.new_customers.where('status').equals('pending').toArray()).sort((a, b) => a.created_at - b.created_at);
  for (const record of waiting) {
    const problem = await settleCustomer(db, record, create);
    if (problem?.kind === 'wait') return { waiting: problem, skipped };
    if (problem) skipped.set(record.id, problem.message);
  }
  return { waiting: null, skipped };
}

/** What stands between this bill and the books, if it is for a customer made on this device. */
async function customerHold(db: OfflineDb, item: QueueRecord, skipped: Map<string, string>): Promise<'send' | { hold: string | null }> {
  const id = item.draft?.customer_id ?? '';
  const record = await db.new_customers.get(id);
  if (!record || record.status === 'created' || item.attempts > 0) return 'send'; // sent before: again, exactly as it was
  if (record.status === 'merged' && record.merged_into) {
    moveTo(item, record.merged_into); // saved by a tab that had not heard yet
    await db.offline_queue.where('seq').equals(item.seq).and((now) => now.status === 'pending' && now.attempts === 0).modify({ customer: item.customer, draft: item.draft, form: item.form });
    return 'send';
  }
  if (record.status === 'review') {
    await holdForReview(db, id, { reason: record.reason, candidates: record.candidates, message: record.message ?? 'Check the customer' });
    return { hold: null };
  }
  return { hold: skipped.get(id) ?? 'Its customer is saved first' };
}

/** The caller holds the cross-tab lock. */
export async function drainQueue(db: OfflineDb, send: SendBill, create: CreateCustomer): Promise<DrainResult> {
  const customers = await drainCustomers(db, create);
  if (customers.waiting?.kind === 'wait') {
    const { reason, message } = customers.waiting;
    const oldest = await db.offline_queue.where('status').equals('pending').first();
    if (oldest) await db.offline_queue.update(oldest.seq, { message }); // why nothing moves
    return { stopped: reason, message };
  }
  let cursor = 0;
  let skipped: string | null = [...customers.skipped.values()][0] ?? null;
  for (;;) {
    const from = cursor;
    const item = await db.offline_queue.where('status').equals('pending').and((row) => row.seq > from).first(); // in seq order
    if (!item) {
      await pruneSynced(db);
      return skipped === null ? { stopped: 'done', message: null } : { stopped: 'retry', message: skipped };
    }
    cursor = item.seq;
    const hold = await customerHold(db, item, customers.skipped);
    if (hold !== 'send') {
      if (hold.hold !== null) {
        skipped ??= hold.hold;
        await db.offline_queue.update(item.seq, { message: hold.hold });
      }
      continue;
    }
    // Stored by an older version, or damaged: say so instead of sending it for ever.
    if (!item.draft || !billDraft.safeParse(item.draft).success) {
      await settle(db, item, { status: 'rejected', message: 'This saved bill is not readable. Open it, check it and save again.' });
      continue;
    }
    // Counted before sending: if we die here, the bill is known to have possibly gone out.
    await db.offline_queue.update(item.seq, { attempts: item.attempts + 1 });
    const verdict = judge(await send(item.draft));
    switch (verdict.kind) {
      case 'synced':
        await settle(db, item, { status: 'synced', issued: verdict.issued, message: item.note ?? null, draft: null, form: null });
        break;
      case 'conflict':
        await settle(db, item, { status: 'conflict', issued: verdict.issued, message: verdict.message, draft: null, form: null });
        break;
      case 'rejected':
        await settle(db, item, { status: 'rejected', message: verdict.message });
        break;
      case 'skip':
        skipped = verdict.message;
        await db.offline_queue.update(item.seq, { message: verdict.message });
        break;
      case 'wait':
        await db.offline_queue.update(item.seq, { message: verdict.message });
        return { stopped: verdict.reason, message: verdict.message };
    }
  }
}
