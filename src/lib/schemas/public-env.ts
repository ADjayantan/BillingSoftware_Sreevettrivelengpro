import { z } from 'zod';

function isSecretKey(key: string): boolean {
  if (key.startsWith('sb_secret_')) return true;
  const payload = key.split('.')[1];
  if (payload === undefined) return false;
  try {
    const claims: unknown = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    return z.object({ role: z.literal('service_role') }).safeParse(claims).success;
  } catch {
    return false;
  }
}

const publicEnvSchema = z.object({
  supabaseUrl: z.url(),
  supabasePublishableKey: z
    .string()
    .min(1)
    // The secret key bypasses RLS; a copy-paste into a public variable must never be used.
    .refine((key) => !isSecretKey(key), 'a secret / service_role key must never be public'),
});

export type PublicEnv = z.infer<typeof publicEnvSchema>;

export function parsePublicEnv(raw: Record<keyof PublicEnv, string | undefined>): PublicEnv {
  const result = publicEnvSchema.safeParse(raw);
  if (!result.success) {
    // Names and reasons only: never echo a key's value.
    const problems = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`Supabase is not configured (see .env.example). ${problems.join('; ')}`);
  }
  return result.data;
}

/** Read lazily, so `next build` needs no environment. */
export function publicEnv(): PublicEnv {
  // Next.js inlines NEXT_PUBLIC_* only when each is written out literally.
  return parsePublicEnv({
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
    supabasePublishableKey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  });
}
