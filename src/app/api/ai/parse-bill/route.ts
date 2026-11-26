import 'server-only';
import { isAuthRetryableFetchError } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { ApiError, body, toApiError, unavailable } from '@/lib/api/http';
import {
  GeminiError,
  ParseBillRequestSchema,
  parseBillTranscript,
  type ActiveCustomerRow,
  type ActiveStudRow,
} from '@/lib/gemini';
import { PAGE_ROWS, readAllRows } from '@/lib/read-all';
import { createClient } from '@/lib/supabase/server';

const NO_STORE = { 'cache-control': 'no-store' };

export async function POST(request: Request): Promise<NextResponse> {
  try {
    if (request.headers.get('sec-fetch-site') === 'cross-site') {
      throw new ApiError(403, 'FORBIDDEN', 'Cross-site request refused');
    }
    const supabase = await createClient();
    const { data: authData, error: authError } = await supabase.auth.getClaims();
    if (isAuthRetryableFetchError(authError)) throw unavailable();
    if (authData === null) throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in again');

    const input = await body(request, ParseBillRequestSchema);

    const [customers, studItems] = await Promise.all([
      readAllRows<ActiveCustomerRow>((after) => {
        const page = supabase
          .from('customers')
          .select('id, name')
          .eq('is_active', true)
          .order('id')
          .limit(PAGE_ROWS);
        return (after === null ? page : page.gt('id', after)).overrideTypes<ActiveCustomerRow[], { merge: false }>();
      }),
      readAllRows<ActiveStudRow>((after) => {
        const page = supabase
          .from('stud_items')
          .select('id, sku_code, diameter_mm, length_mm, thread_type, material_grade')
          .eq('is_active', true)
          .not('diameter_mm', 'is', null) // studs only: a product without a size is left out, never guessed
          .order('id')
          .limit(PAGE_ROWS);
        return (after === null ? page : page.gt('id', after)).overrideTypes<ActiveStudRow[], { merge: false }>();
      }),
    ]);
    customers.sort((a, b) => a.name.localeCompare(b.name));
    studItems.sort((a, b) => a.sku_code.localeCompare(b.sku_code));

    const result = await parseBillTranscript({
      text: input.text,
      customers,
      studItems,
    });

    return NextResponse.json(result, { status: 200, headers: NO_STORE });
  } catch (error) {
    if (error instanceof GeminiError) {
      const status = error.code === 'SCHEMA_MISMATCH' || error.code === 'INVALID_JSON' ? 422 : 503;
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status, headers: NO_STORE },
      );
    }
    const apiErr = toApiError(error);
    return NextResponse.json(
      { error: { code: apiErr.code, message: apiErr.message } },
      { status: apiErr.status, headers: NO_STORE },
    );
  }
}
