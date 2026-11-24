import 'server-only';
import { isAuthRetryableFetchError, type SupabaseClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { BillingMathError } from '@/lib/billing-math';
import { DraftError } from '@/lib/bill-draft';
import { createClient } from '@/lib/supabase/server';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Extra facts for the client, e.g. the invoice a bill was already issued as. */
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const unavailable = (): ApiError => new ApiError(503, 'UNAVAILABLE', 'The cloud is not answering. Nothing is lost: try again in a minute.');

/** Constraint names that reach a user, in their words. Anything else stays generic. */
const CONSTRAINT_MESSAGES: Record<string, string> = {
  customers_gstin_key: 'Another customer already has this GSTIN',
  customers_gstin_matches_state: 'The state does not match the GSTIN',
  customers_gstin_needs_address: 'A GST-registered customer needs an address',
  stud_items_sku_code_key: 'Another stud already has this SKU',
  stud_items_formula_weight: 'The weight does not match the dimensions',
  job_work_ledger_close_rule: 'To close this lot, its balance must be within 1% of the inward weight, or give a reason',
  invoices_gst_regime: 'The GST type does not match the customer’s state',
};

interface DbError {
  code: string;
  message: string;
}

function isDbError(error: unknown): error is DbError {
  return z.object({ code: z.string(), message: z.string() }).safeParse(error).success;
}

/** How the sentences our own SQL functions raise begin. */
const OWN_SENTENCES = /^((sync_invoice|record_payment|void_payment): |Invoice |Lot |Delivery challan |Freight |Record receipts |A metal rate |(INV|DC) numbering )/;

/** An allowlist: Postgres' own messages name tables, columns and policies, and never go out. */
function safeMessage(error: DbError, fallback: string): string {
  for (const [constraint, message] of Object.entries(CONSTRAINT_MESSAGES)) {
    if (error.message.includes(`"${constraint}"`)) return message;
  }
  return OWN_SENTENCES.test(error.message) ? error.message.replace(/^\w+: /, '') : fallback;
}

export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof DraftError || error instanceof BillingMathError) return new ApiError(422, 'BILL_INVALID', error.message);
  if (isDbError(error)) {
    switch (error.code) {
      case '42501':
        return new ApiError(403, 'FORBIDDEN', safeMessage(error, 'You do not have access to do this'));
      case '23505':
        return new ApiError(409, 'CONFLICT', safeMessage(error, 'This already exists'));
      case '23503':
        return new ApiError(409, 'IN_USE', safeMessage(error, 'This record is used by other records'));
      case '23001':
      case '55000':
        return new ApiError(409, 'NOT_READY', safeMessage(error, 'This cannot be done yet'));
      case '23514':
        return new ApiError(422, 'RULE_BROKEN', safeMessage(error, 'A value breaks a billing rule'));
      case '22023':
      case '22P02':
      case '22003':
      case '22007':
      case '22008':
      case '23502':
        return new ApiError(400, 'INVALID', safeMessage(error, 'A value is missing or malformed'));
      case 'PGRST116':
        return new ApiError(404, 'NOT_FOUND', 'Not found');
      default:
        // supabase-js reports a failed connection with no code (or a socket one); PGRST00x and
        // classes 08/53/57P are the database being unreachable, full or restarting.
        if (error.code === '' || /^(E[A-Z]{3,}|UND_ERR|PGRST00|08|53|57P)/.test(error.code)) return unavailable();
    }
  }
  // Never "nothing was saved": a reply lost after COMMIT looks the same from here.
  return new ApiError(500, 'INTERNAL', 'Something went wrong. Try again.');
}

/** Business data never rests in an HTTP cache, the browser's included. */
const NO_STORE = { 'cache-control': 'no-store' };

function errorResponse(error: unknown): NextResponse {
  const { status, code, message, details } = toApiError(error);
  // Codes only: messages may carry customer details, and those stay out of logs.
  if (status >= 500) console.error('api error', isDbError(error) ? error.code : error instanceof Error ? error.name : typeof error);
  return NextResponse.json({ error: { code, message, ...(details ? { details } : {}) } }, { status, headers: NO_STORE });
}

export function parse<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const path = issue?.path.join('.') ?? '';
  throw new ApiError(400, 'INVALID', path ? `${path}: ${issue?.message ?? ''}` : (issue?.message ?? 'Invalid input'));
}

/** Rows we read back. A mismatch is our bug, not the caller's, so it must not become a 4xx. */
export function parseRow<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error('unexpected database row shape');
  return result.data;
}

export async function body<T extends z.ZodType>(request: Request, schema: T): Promise<z.output<T>> {
  if (!(request.headers.get('content-type') ?? '').startsWith('application/json')) {
    throw new ApiError(415, 'UNSUPPORTED', 'Send JSON');
  }
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new ApiError(400, 'INVALID', 'The request is not valid JSON');
  }
  return parse(schema, raw);
}

export const query = <T extends z.ZodType>(request: Request, schema: T): z.output<T> =>
  parse(schema, Object.fromEntries(new URL(request.url).searchParams));

/** Throws database errors, so a handler reads as the happy path. */
export function must<T>(result: { data: T; error: unknown }): NonNullable<T> {
  if (result.error) throw result.error;
  if (result.data === null || result.data === undefined) throw new ApiError(404, 'NOT_FOUND', 'Not found');
  return result.data;
}

/** An UPDATE/DELETE that RLS filtered to nothing looks like success; it is not. */
export function mustAffect<T>(result: { data: T[] | null; error: unknown }): T {
  const [row] = must(result);
  if (row === undefined) throw new ApiError(404, 'NOT_FOUND', 'Not found, or only the owner can do this');
  return row;
}

type Params = Record<string, string>;
export interface ApiContext<P extends Params> {
  request: Request;
  supabase: SupabaseClient;
  params: P;
}

/** Every route: a same-site caller, a verified session, RLS, and one error shape. */
export function route<P extends Params = Params>(handler: (context: ApiContext<P>) => Promise<unknown>) {
  return async (request: Request, context: { params: Promise<P> }): Promise<NextResponse> => {
    try {
      if (request.headers.get('sec-fetch-site') === 'cross-site') throw new ApiError(403, 'FORBIDDEN', 'Cross-site request refused');
      const supabase = await createClient();
      const { data, error: authError } = await supabase.auth.getClaims();
      if (isAuthRetryableFetchError(authError)) throw unavailable();
      if (data === null) throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in again');
      const result = await handler({ request, supabase, params: await context.params });
      return NextResponse.json({ data: result }, { status: request.method === 'POST' ? 201 : 200, headers: NO_STORE });
    } catch (error) {
      return errorResponse(error);
    }
  };
}

/** `%`, `_` and `\` are wildcards in LIKE; a search box means them literally. */
export const likePattern = (text: string): string => `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
