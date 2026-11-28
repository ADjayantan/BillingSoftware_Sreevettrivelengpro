import { NextResponse } from 'next/server';
import { ApiError, must, route } from '@/lib/api/http';
import { DESKTOP_INSTALLER_URL } from '@/lib/desktop';

/**
 * Signed-in active users (owner or staff) can download StudFlow-Setup.exe for any Windows 10/11 PC.
 */
export const GET = route(async ({ supabase }) => {
  const rows = must(await supabase.from('company_profile').select('legal_name').limit(1));
  if (rows.length === 0) {
    throw new ApiError(403, 'FORBIDDEN', 'You do not have access to do this');
  }
  const response = NextResponse.redirect(DESKTOP_INSTALLER_URL, 302);
  response.headers.set('cache-control', 'no-store');
  return response;
});
