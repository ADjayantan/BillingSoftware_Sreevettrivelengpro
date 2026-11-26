import 'server-only';
import type { JWK } from '@supabase/supabase-js';
import { publicEnv } from '@/lib/schemas/public-env';

const TTL_MS = 5 * 60_000;
let cached: { url: string; at: number; keys: JWK[] } | null = null;
let inflight: Promise<{ keys: JWK[] } | undefined> | null = null;

/**
 * Caches the project's public signing keys across requests in the same server instance so
 * `supabase.auth.getClaims()` verifies asymmetric JWTs locally in WebCrypto instead of
 * re-fetching `/.well-known/jwks.json` on every API call.
 */
export async function getCachedJwks(): Promise<{ keys: JWK[] } | undefined> {
  let supabaseUrl: string;
  try {
    supabaseUrl = publicEnv().supabaseUrl;
  } catch {
    return undefined;
  }
  if (!supabaseUrl.startsWith('https://')) return undefined;
  const now = Date.now();
  if (cached && cached.url === supabaseUrl && now - cached.at < TTL_MS) {
    return { keys: cached.keys };
  }
  inflight ??= fetch(`${supabaseUrl}/auth/v1/.well-known/jwks.json`, {
    signal: AbortSignal.timeout(2000),
  })
    .then(async (res) => {
      if (!res.ok) return undefined;
      const body = (await res.json()) as { keys?: JWK[] };
      if (!Array.isArray(body.keys) || body.keys.length === 0) return undefined;
      cached = { url: supabaseUrl, at: Date.now(), keys: body.keys };
      return { keys: body.keys };
    })
    .catch(() => undefined)
    .finally(() => {
      inflight = null;
    });
  return inflight;
}
