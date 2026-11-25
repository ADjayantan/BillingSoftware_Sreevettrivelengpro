import 'server-only';
import { NextResponse } from 'next/server';
import { verifyCronAuth } from '@/app/api/cron/weekly-backup/route';
import { isDriveConfigured } from '@/lib/drive-backup';
import { monthName } from '@/lib/india';
import { runBooks } from '@/lib/month-books';
import { sendTelegramAlert } from '@/lib/telegram';

const NO_STORE = { 'cache-control': 'no-store' };

/** Once a day: whatever is still waiting, resting or not. Trouble is told, success is not. */
async function handleCron(request: Request): Promise<NextResponse> {
  const auth = verifyCronAuth(request);
  if (auth !== 'ok') {
    const [status, code, message] = auth === 'unconfigured' ? [503, 'NOT_READY', 'CRON_SECRET is not configured on the server'] as const : [401, 'UNAUTHENTICATED', 'Valid cron bearer token required'] as const;
    return NextResponse.json({ error: { code, message } }, { status, headers: NO_STORE });
  }
  if (!isDriveConfigured()) return NextResponse.json({ data: { written: [], failed: [], off: true } }, { headers: NO_STORE });
  try {
    const runs = await runBooks({ force: true, budgetMs: 200_000 });
    const named = (outcome: 'written' | 'failed'): string[] => runs.filter((run) => run.outcome === outcome).map((run) => run.month.slice(0, 7));
    const failed = runs.filter((run) => run.outcome === 'failed');
    if (failed.length > 0) {
      const which = failed.map((run) => monthName(run.month)).join(', ');
      const why = (failed[0]?.error ?? '').replace(/\.$/, '');
      await sendTelegramAlert({ text: `StudFlow Excel: ${which} could not be updated on Google Drive. ${why}. It is tried again by itself. The bills are safe.` });
    }
    return NextResponse.json({ data: { written: named('written'), failed: named('failed') } }, { status: failed.length > 0 ? 502 : 200, headers: NO_STORE });
  } catch (error) {
    console.error('books cron error', error instanceof Error ? error.name : typeof error);
    return NextResponse.json({ error: { code: 'INTERNAL', message: 'The Excel books could not be updated' } }, { status: 500, headers: NO_STORE });
  }
}

export const GET = handleCron;
export const POST = handleCron;
