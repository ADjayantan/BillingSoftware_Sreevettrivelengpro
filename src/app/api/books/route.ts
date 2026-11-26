import { route } from '@/lib/api/http';
import { bookMonths } from '@/lib/data';
import { driveState } from '@/lib/drive-backup';

export const GET = route(async ({ supabase }) => ({ drive: (await driveState(supabase)) !== 'off', months: await bookMonths(supabase) }));
