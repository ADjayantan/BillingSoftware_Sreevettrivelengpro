import 'server-only';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { publicEnv } from '@/lib/schemas/public-env';

/**
 * Per-request server client acting as the signed-in user, so RLS applies. Never cache it
 * across requests. Uses the publishable key: the secret key belongs to cron/admin code only.
 */
export async function createClient() {
  // First: this marks the route dynamic, so a signed-in page is never prerendered at build.
  const cookieStore = await cookies();
  const env = publicEnv();
  return createServerClient(env.supabaseUrl, env.supabasePublishableKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (cookiesToSet) => {
        try {
          for (const { name, value, options } of cookiesToSet) cookieStore.set(name, value, options);
        } catch {
          // Server Components cannot write cookies; Route Handlers and Server Actions can.
        }
      },
    },
  });
}
