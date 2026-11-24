/** Sends queued bills, oldest first, one at a time. Safe to run twice and after any crash. */
import type { ApiResult } from './api-client';
import { pruneSynced, type OfflineDb, type QueueRecord } from './offline-db';
import { billDraft, issuedBill, type BillDraftInput, type IssuedBill } from './schemas/invoices';

export type SendBill = (draft: BillDraftInput) => Promise<ApiResult<{ invoice_id: string; invoice_no: string; dc_no: string }>>;

export type Verdict =
  | { kind: 'synced'; issued: IssuedBill }
  | { kind: 'conflict'; issued: IssuedBill; message: string }
  | { kind: 'rejected'; message: string }
  /** This bill made the server stumble: keep it, but do not hold up the ones behind it. */
  | { kind: 'skip'; message: string }
  /** The cloud, the session or the setup: keep it, stop, try later. */
  | { kind: 'wait'; reason: 'offline' | 'signed_out' | 'not_ready'; message: string };

/** Answers about the account or the setup, not about this bill: every other bill would get them too. */
const NOT_ABOUT_THE_BILL = new Set(['FORBIDDEN', 'NOT_READY']);

export function judge(result: Awaited<ReturnType<SendBill>>): Verdict {
  if (result.ok) {
    const issued = issuedBill.safeParse({ ...result.data, grand_total: null });
    return issued.success ? { kind: 'synced', issued: issued.data } : { kind: 'wait', reason: 'offline', message: 'The reply was not understood' };
  }
  if (result.code === 'UNAUTHENTICATED') return { kind: 'wait', reason: 'signed_out', message: result.message };
  if (result.code === 'ALREADY_ISSUED') {
    const issued = issuedBill.safeParse(result.details?.issued);
    if (issued.success) return { kind: 'conflict', issued: issued.data, message: result.message };
  }
  if (result.code === 'INTERNAL') return { kind: 'skip', message: result.message };
  if (result.status === 0 || result.status >= 500 || result.status === 408 || result.status === 429 || result.code === 'UNAVAILABLE') {
    return { kind: 'wait', reason: 'offline', message: result.message };
  }
  if (NOT_ABOUT_THE_BILL.has(result.code)) return { kind: 'wait', reason: 'not_ready', message: result.message };
  return { kind: 'rejected', message: result.message };
}

export interface DrainResult {
  stopped: 'done' | 'retry' | 'offline' | 'signed_out' | 'not_ready';
  message: string | null;
}

const settle = (db: OfflineDb, item: QueueRecord, change: Partial<QueueRecord>): Promise<number> =>
  db.offline_queue.where('seq').equals(item.seq).and((now) => now.status === 'pending').modify({ ...change, settled_at: Date.now() });

/** The caller holds the cross-tab lock. */
export async function drainQueue(db: OfflineDb, send: SendBill): Promise<DrainResult> {
  let cursor = 0;
  let skipped: string | null = null;
  for (;;) {
    const from = cursor;
    const item = await db.offline_queue.where('status').equals('pending').and((row) => row.seq > from).first(); // in seq order
    if (!item) {
      await pruneSynced(db);
      return skipped === null ? { stopped: 'done', message: null } : { stopped: 'retry', message: skipped };
    }
    cursor = item.seq;
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
        await settle(db, item, { status: 'synced', issued: verdict.issued, message: null, draft: null, form: null });
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
