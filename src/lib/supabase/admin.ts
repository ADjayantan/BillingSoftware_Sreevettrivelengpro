import 'server-only';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { publicEnv } from '@/lib/schemas/public-env';

/**
 * Server-only Supabase admin client using SUPABASE_SECRET_KEY (service_role).
 * Used strictly by background Google Drive archival and CRON_SECRET-authenticated jobs.
 * Never import this module in client components or user-facing CRUD routes.
 */
export function createAdminClient(): SupabaseClient {
  const { supabaseUrl } = publicEnv();
  const secretKey =
    process.env.SUPABASE_SECRET_KEY?.trim() ||
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (!secretKey) {
    throw new Error('SUPABASE_SECRET_KEY is not configured on the server.');
  }

  return createClient(supabaseUrl, secretKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}
