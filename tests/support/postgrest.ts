// A PostgREST stand-in for tests: turns supabase-js HTTP calls into SQL on PGlite, as the
// given actor. Only the request shapes this app uses; anything else throws, loudly.
import type { PGlite } from '@electric-sql/pglite';
import { asActor, type Actor } from '../db/harness';

const ident = (name: string): string => {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`unexpected identifier ${name}`);
  return `"${name}"`;
};

const columns = (select: string | null): string =>
  !select || select === '*'
    ? '*'
    : select
        .split(',')
        .map((part) => {
          const [name = '', cast] = part.split('::');
          if (cast !== undefined && cast !== 'text') throw new Error(`unexpected cast ${cast}`);
          return cast ? `${ident(name)}::text as ${ident(name)}` : ident(name);
        })
        .join(', ');

/** Supabase's "Max rows" (1000 on the live project): longer answers are cut, and nothing says so. */
const MAX_ROWS = 1000;

const STATUS: Record<string, number> = {
  '42501': 403, '23505': 409, '23503': 409, '23514': 400, '22023': 400, '22P02': 400, '23502': 400, '55000': 500,
};

function where(url: URL, params: unknown[]): string {
  const clauses: string[] = [];
  for (const [key, raw] of url.searchParams) {
    if (['select', 'order', 'limit', 'offset', 'columns'].includes(key)) continue;
    const dot = raw.indexOf('.');
    const operator = raw.slice(0, dot);
    const value = raw.slice(dot + 1);
    if (operator === 'is' && value === 'null') clauses.push(`${ident(key)} is null`);
    else if (raw === 'not.is.null') clauses.push(`${ident(key)} is not null`);
    else if (operator === 'neq') clauses.push(`${ident(key)}::text <> $${params.push(value)}`);
    else if (operator === 'eq') clauses.push(`${ident(key)}::text = $${params.push(value)}`);
    else if (operator === 'gt') clauses.push(`${ident(key)} > $${params.push(value)}`);
    else if (operator === 'gte') clauses.push(`${ident(key)} >= $${params.push(value)}`);
    else if (operator === 'lte') clauses.push(`${ident(key)} <= $${params.push(value)}`);
    else if (operator === 'in') {
      const list = value.replace(/^\(|\)$/g, '').split(',');
      clauses.push(`${ident(key)}::text in (${list.map((item) => `$${params.push(item)}`).join(', ')})`);
    } else if (operator === 'ilike') clauses.push(`${ident(key)} ilike $${params.push(value)}`);
    else throw new Error(`unexpected filter ${key}=${raw}`);
  }
  return clauses.length ? ` where ${clauses.join(' and ')}` : '';
}

function tail(url: URL, maxRows: number): string {
  const order = url.searchParams.get('order');
  const limit = url.searchParams.get('limit');
  const offset = url.searchParams.get('offset');
  const orderBy = order
    ?.split(',')
    .map((part) => {
      const [name = '', direction] = part.split('.');
      return `${ident(name)} ${direction === 'desc' ? 'desc' : 'asc'}`;
    })
    .join(', ');
  return `${orderBy ? ` order by ${orderBy}` : ''} limit ${Math.min(limit ? Number(limit) : maxRows, maxRows)}${offset ? ` offset ${Number(offset)}` : ''}`;
}

/** PostgREST renders dates as text and timestamps as ISO; PGlite hands back Date objects. */
const asJson = (sql: string): string => `with q as (${sql}) select coalesce(json_agg(row_to_json(q)), '[]'::json)::text as body from q`;

export async function handle(db: PGlite, actor: Actor, method: string, href: string, body: unknown, accept: string, maxRows = MAX_ROWS): Promise<Response> {
  const url = new URL(href);
  const path = url.pathname.replace(/^\/rest\/v1\//, '');
  const params: unknown[] = [];
  let sql: string;
  let wrap = true;
  let returns: 'rows' | 'value' | 'nothing' = 'rows';
  if (path.startsWith('rpc/')) {
    const found = await db.query<{ many: boolean; type: string; names: string[] | null; types: string[] }>(
      `select p.proretset as many, t.typname as type, p.proargnames as names,
              array(select format_type(a.oid, null) from unnest(p.proargtypes::oid[]) with ordinality as a(oid, n) order by a.n) as types
         from pg_proc p join pg_type t on t.oid = p.prorettype where p.pronamespace = 'public'::regnamespace and p.proname = $1`, [path.slice(4)],
    );
    const fn = found.rows[0];
    const args = Object.entries((body ?? {}) as Record<string, unknown>);
    const typeOf = (name: string): string | undefined => fn?.types[fn.names?.indexOf(name) ?? -1];
    if (!fn || args.some(([name]) => !typeOf(name))) {
      return new Response(JSON.stringify({ code: 'PGRST202', message: `no function ${path}`, details: null, hint: null }), { status: 404, headers: { 'content-type': 'application/json' } });
    }
    const list = args.map(([name, value]) => `${ident(name)} := $${params.push(typeOf(name) === 'jsonb' ? JSON.stringify(value) : value)}::${typeOf(name)}`);
    const call = `public.${ident(path.slice(4))}(${list.join(', ')})`;
    returns = fn.many ? 'rows' : fn.type === 'void' ? 'nothing' : 'value';
    sql = returns === 'nothing' ? `select ${call}` : `select to_json(q)::text as body from ${call} as q`;
    wrap = false; // volatile functions: aggregate in JavaScript instead
  } else {
    const table = `public.${ident(path)}`;
    const returning = ` returning ${columns(url.searchParams.get('select'))}`;
    if (method === 'GET') {
      sql = `select ${columns(url.searchParams.get('select'))} from ${table}${where(url, params)}${tail(url, maxRows)}`;
    } else if (method === 'HEAD') {
      // supabase-js { count: 'exact', head: true }: no rows, the number in a header, never cut.
      sql = `select count(*)::int as n from ${table}${where(url, params)}`;
    } else if (method === 'POST') {
      const entries = Object.entries(body as Record<string, unknown>);
      const values = entries.map(([, value]) => `$${params.push(value)}`);
      sql = `insert into ${table} (${entries.map(([name]) => ident(name)).join(', ')}) values (${values.join(', ')})${returning}`;
    } else if (method === 'PATCH') {
      const sets = Object.entries(body as Record<string, unknown>).map(([name, value]) => `${ident(name)} = $${params.push(value)}`);
      sql = `update ${table} set ${sets.join(', ')}${where(url, params)}${returning}`;
    } else if (method === 'DELETE') {
      sql = `delete from ${table}${where(url, params)}${returning}`;
    } else {
      throw new Error(`unexpected method ${method}`);
    }
  }

  const reply = (status: number, payload: unknown): Response =>
    new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
  try {
    const rows = await asActor(db, actor, async (tx) => {
      if (!wrap) {
        const answered = (await tx.query<{ body?: string | null }>(sql, params)).rows;
        return returns === 'nothing' ? [] : answered.map((row) => JSON.parse(row.body ?? 'null') as Record<string, unknown>);
      }
      const text = (await tx.query<{ body: string }>(asJson(sql), params)).rows[0]!.body;
      return JSON.parse(text) as Record<string, unknown>[];
    });
    if (returns === 'nothing') return new Response(null, { status: 204 });
    if (returns === 'value') return reply(200, rows[0]);
    if (method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-range': `*/${String(rows[0]?.n)}` } });
    if (accept.includes('vnd.pgrst.object')) {
      if (rows.length !== 1) return reply(406, { code: 'PGRST116', message: 'Cannot coerce the result to a single JSON object', details: null, hint: null });
      return reply(200, rows[0]);
    }
    return reply(method === 'POST' && wrap ? 201 : 200, rows);
  } catch (error) {
    const { code, message } = error as { code?: string; message?: string };
    if (!code) throw error;
    return reply(STATUS[code] ?? 500, { code, message, details: null, hint: null });
  }
}

/** A fetch for supabase-js. */
export const pgliteFetch =
  (db: PGlite, actor: () => Actor, maxRows = MAX_ROWS): typeof fetch =>
  async (input, init) => {
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === 'string' && init.body ? (JSON.parse(init.body) as unknown) : undefined;
    return handle(db, actor(), init?.method ?? 'GET', String(input), body, headers.get('accept') ?? '', maxRows);
  };
