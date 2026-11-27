/** Browser calls to our own routes. Errors come back as values, in words for the user. */
import { setConnection } from './connection';

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; code: string; message: string; details?: Record<string, unknown> };

interface Envelope {
  data?: unknown;
  error?: { code: string; message: string; details?: Record<string, unknown> };
}

const GATEWAY = new Set([502, 503, 504]);

/** It waits for somebody else's AI, and how that fares says nothing about our cloud or the internet. */
const AI_FILL = '/api/ai/parse-bill';
const AI_SILENT = { ok: false, code: 'AI_UNAVAILABLE', message: 'AI fill is not answering. Try again in a minute, or type the bill below.' } as const;

/** The network or the cloud failed, as opposed to our server answering "no". */
export const isDown = (result: { code: string }): boolean => result.code === 'OFFLINE' || result.code === 'UNAVAILABLE';

export async function api<T>(path: string, method = 'GET', json?: unknown, timeoutMs = 30_000): Promise<ApiResult<T>> {
  const patience = AbortSignal.timeout(timeoutMs); // a dead Wi-Fi hangs rather than fails
  let response: Response;
  let payload: Envelope | null;
  try {
    response = await fetch(path, {
      method,
      cache: 'no-store',
      signal: patience,
      ...(json === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(json) }),
    });
    payload = (await response.json().catch(() => null)) as Envelope | null;
  } catch {
    if (path === AI_FILL && patience.aborted) return { ...AI_SILENT, status: 0 };
    setConnection('offline');
    return { ok: false, status: 0, code: 'OFFLINE', message: 'No connection. Nothing is lost: try again when the internet is back.' };
  }
  const error = payload && typeof payload === 'object' ? payload.error : undefined;
  if (response.ok && payload && typeof payload === 'object' && !('error' in payload)) {
    setConnection('online');
    return { ok: true, data: ('data' in payload ? payload.data : payload) as T };
  }
  if (response.status === 401) {
    setConnection('signed_out');
    return { ok: false, status: 401, code: 'UNAUTHENTICATED', message: 'You are signed out. Sign in again; nothing is lost.' };
  }
  if (path === AI_FILL && error?.code !== 'UNAVAILABLE' && (response.status >= 500 || (payload === null && patience.aborted))) {
    return { ...AI_SILENT, status: response.status };
  }
  // Not our JSON means something in between answered: a gateway, or a Wi-Fi login page.
  if (GATEWAY.has(response.status) || !error) {
    setConnection('offline');
    return { ok: false, status: response.status, code: 'UNAVAILABLE', message: 'The cloud is not answering. Nothing is lost: try again in a minute.' };
  }
  if (response.status < 500) setConnection('online');
  return { ok: false, status: response.status, code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) };
}
