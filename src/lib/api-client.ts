/** Browser calls to our own routes. Errors come back as values, in words for the user. */

export type ApiResult<T> = { ok: true; data: T } | { ok: false; code: string; message: string };

export async function api<T>(path: string, method = 'GET', json?: unknown): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      ...(json === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(json) }),
    });
  } catch {
    return { ok: false, code: 'OFFLINE', message: 'No connection. Nothing is lost: press Save again when the internet is back.' };
  }
  const payload = (await response.json().catch(() => null)) as { data?: T; error?: { code: string; message: string } } | null;
  if (response.ok && payload && 'data' in payload) return { ok: true, data: payload.data as T };
  if (response.status === 401) {
    return { ok: false, code: 'UNAUTHENTICATED', message: 'You are signed out. Sign in again in another tab, then press Save.' };
  }
  return {
    ok: false,
    code: payload?.error?.code ?? 'INTERNAL',
    message: payload?.error?.message ?? 'Something went wrong. Try again.',
  };
}
