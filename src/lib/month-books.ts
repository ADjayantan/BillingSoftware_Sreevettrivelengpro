import 'server-only';
import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { after } from 'next/server';
import { z } from 'zod';
import { must, parseRow } from '@/lib/api/http';
import { getDriveCredentials, isDriveConfigured, type DriveCredentials } from '@/lib/drive-backup';
import { DriveProblem, openVault, UPLOAD_MS, type Workbook } from '@/lib/drive-workbook';
import { readMonth } from '@/lib/month-data';
import { monthWorkbook } from '@/lib/month-workbook';
import { bookClaim, type BookClaim } from '@/lib/schemas/books';
import { createAdminClient } from '@/lib/supabase/admin';

/*
 * Keeps one Excel workbook per month on Drive. What changed is written down by the sale itself
 * (migration 006); here one worker at a time takes a month, makes the book from the database
 * and puts it in place. Safe to run as often as anybody likes.
 */

/** How long a worker has a month to itself. */
const LEASE_S = 240;
/**
 * To start an upload there must be time for it, for a second one when the first only found out
 * that our file is there already, and some to spare: a stale one cannot write.
 */
const HOLD_S = (2 * UPLOAD_MS) / 1000 + 30;

export interface BookRun {
  month: string;
  /** lost: somebody else has the month by now, and nothing was written. */
  outcome: 'written' | 'failed' | 'lost';
  error?: string;
}

export interface BookOptions {
  db?: SupabaseClient;
  creds?: DriveCredentials;
  fetchImpl?: typeof fetch;
  /** One month (its first day) instead of all that are due. */
  month?: string;
  /** Although it is resting after a failure. */
  force?: boolean;
  /** No new month is taken after this long. */
  budgetMs?: number;
}

const yes = async (db: SupabaseClient, name: string, args: Record<string, unknown>): Promise<boolean> => {
  const { data, error } = await db.rpc(name, args);
  if (error) throw error;
  return data === true;
};

export async function runBooks(options: BookOptions = {}): Promise<BookRun[]> {
  const creds = options.creds ?? getDriveCredentials();
  const db = options.db ?? createAdminClient();
  const until = Date.now() + (options.budgetMs ?? 100_000);
  const runs: BookRun[] = [];
  do {
    const claims = must(
      await db.rpc('book_claim', {
        p_month: options.month ?? null, p_seconds: LEASE_S, p_force: options.force ?? false,
        p_except: runs.filter((run) => run.outcome !== 'written').map((run) => run.month),
      }),
    );
    const [claim] = parseRow(z.array(bookClaim), claims);
    if (!claim) break;
    runs.push(await writeMonth(db, claim, creds, options.fetchImpl ?? fetch));
  } while (Date.now() < until);
  return runs;
}

async function writeMonth(db: SupabaseClient, claim: BookClaim, creds: DriveCredentials, fetchImpl: typeof fetch): Promise<BookRun> {
  const { month } = claim;
  const mine = { p_month: month, p_token: claim.token };
  const lost: BookRun = { month, outcome: 'lost' };
  let stage: 'drive' | 'read' = 'drive';
  let newId: (() => Promise<string>) | undefined;
  try {
    const vault = await openVault(creds, fetchImpl);
    newId = vault.newId;
    const kept = claim.drive_file_id === null ? null : await vault.file(claim.drive_file_id);

    stage = 'read';
    const bytes = monthWorkbook(await readMonth(db, month), new Date().toISOString());
    stage = 'drive';

    let target: Workbook;
    if (kept) {
      target = kept;
    } else if (claim.drive_file_id !== null && claim.revision === 0) {
      target = { id: claim.drive_file_id, revision: null }; // its id was made, the file never was
    } else {
      target = (await vault.find(month)) ?? { id: await vault.newId(), revision: null };
      if (!(await yes(db, 'book_set_file', { ...mine, p_file_id: target.id }))) return lost;
    }

    if (!(await yes(db, 'book_hold', { ...mine, p_seconds: HOLD_S }))) return lost;
    if (target.revision !== null && (await vault.file(target.id))?.revision !== target.revision) {
      await yes(db, 'book_failed', { ...mine, p_error: 'The workbook was changed meanwhile', p_unknown_outcome: false });
      return lost;
    }
    const revision = Math.max(claim.revision, Number(target.revision) || 0) + 1;
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const link = await vault.put(month, target, bytes, revision, sha256);
    return (await yes(db, 'book_done', { ...mine, p_change_ids: claim.change_ids, p_link: link, p_sha256: sha256 })) ? { month, outcome: 'written' } : lost;
  } catch (error) {
    const problem = reason(error, stage);
    try {
      if (error instanceof DriveProblem && error.idIsGone && newId) await yes(db, 'book_set_file', { ...mine, p_file_id: await newId() });
    } catch {
      // The next round finds out again.
    }
    const unknown = error instanceof DriveProblem && error.unknownOutcome;
    const still = await yes(db, 'book_failed', { ...mine, p_error: problem, p_unknown_outcome: unknown }).catch(() => true); // else the lease runs out by itself
    return still ? { month, outcome: 'failed', error: problem } : lost;
  }
}

/** For the owner, in our own sentences: what a library says may carry an address or a credential. */
function reason(error: unknown, stage: 'drive' | 'read'): string {
  if (error instanceof DriveProblem) return error.message;
  if (stage === 'read') return 'The books could not be read';
  if (error instanceof Error && error.message.startsWith('Google Drive permission has expired')) return 'Google Drive permission has expired: connect Google Drive again';
  return 'Google Drive did not answer';
}

/** After the answer has gone out. Never delays it and never fails it: the changes stay in line. */
export function booksLater(options: BookOptions & { first?: () => Promise<unknown> } = {}): void {
  const { first, ...books } = options;
  const work = async (): Promise<void> => {
    await first?.().catch(() => undefined);
    if (isDriveConfigured()) await runBooks(books).catch((error: unknown) => console.error('books error', error instanceof Error ? error.name : typeof error));
  };
  try {
    after(work);
  } catch {
    void work(); // not inside a Next.js request
  }
}
