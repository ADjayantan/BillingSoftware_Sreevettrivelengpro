import { createBrowserClient } from '@supabase/ssr';
import { publicEnv } from '@/lib/schemas/public-env';

/** Browser client: the signed-in user's session, limited by RLS. A singleton in the browser. */
export function createClient() {
  const env = publicEnv();
  return createBrowserClient(env.supabaseUrl, env.supabasePublishableKey);
}
