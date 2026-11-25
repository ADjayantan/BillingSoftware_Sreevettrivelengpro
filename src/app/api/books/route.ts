import { route } from '@/lib/api/http';
import { bookMonths } from '@/lib/data';
import { isDriveConfigured } from '@/lib/drive-backup';

export const GET = route(async ({ supabase }) => ({ drive: isDriveConfigured(), months: await bookMonths(supabase) }));
