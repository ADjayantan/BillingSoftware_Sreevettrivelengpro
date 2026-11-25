// 007: the buyer's order number on a bill, and the lines at the head of the owner's bill
// (specs/own-bill.md).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { ACTORS, createTestDb, intraStatePayload, migrationFiles, pgError, queryAs, seedMasterData, syncInvoice, type MasterData, type Payload } from './harness';

let db: PGlite;
let md: MasterData;
beforeAll(async () => {
  db = await createTestDb();
  md = await seedMasterData(db);
});
afterAll(async () => {
  await db.close();
});

const issue = (over: Payload = {}) => syncInvoice(db, ACTORS.staff, intraStatePayload(md, over));
const order = async (id: string, on = db) =>
  (await on.query<{ po_no: string | null; po_date: string | null }>('select po_no, po_date::text from public.invoices where id = $1', [id])).rows[0];
const company = (set: string, actor: (typeof ACTORS)['owner' | 'staff'] = ACTORS.owner) =>
  queryAs<{ id: string }>(db, actor, `update public.company_profile set ${set} returning id`);

describe('P.O. number and date', () => {
  it('are kept with the bill, as typed', async () => {
    const bill = await issue({ po_no: ' 4500012/A ', po_date: '2026-11-18' });
    expect(await order(bill.invoice_id)).toEqual({ po_no: '4500012/A', po_date: '2026-11-18' });
    expect(await order((await issue({ po_no: 'Phone order' })).invoice_id)).toEqual({ po_no: 'Phone order', po_date: null });
  });

  it('nothing typed is nothing stored', async () => {
    expect(await order((await issue({ po_no: '  ', po_date: null })).invoice_id)).toEqual({ po_no: null, po_date: null });
    expect(await order((await issue()).invoice_id)).toEqual({ po_no: null, po_date: null });
  });

  it('a date needs a number, and both must make sense', async () => {
    expect(await pgError(issue({ po_date: '2026-11-18' }))).toMatchObject({ code: '23514' });
    expect(await pgError(issue({ po_no: 'x'.repeat(41) }))).toMatchObject({ code: '23514' });
    expect(await pgError(issue({ po_no: 'A', po_date: '18.11.2026' }))).toMatchObject({ code: '22023' });
    expect(await pgError(issue({ po_no: 'A', po_date: '1926-11-18' }))).toMatchObject({ code: '23514' });
    expect(await pgError(issue({ po_no: 'A', po_date: 'infinity' }))).toMatchObject({ code: '22023' });
  });

  it('a refused bill used no number', async () => {
    const last = async () => (await db.query<{ n: number }>(`select last_value::int as n from private.document_sequences where series = 'INV'`)).rows[0]!.n;
    const before = await last();
    await pgError(issue({ po_date: '2026-11-18' }));
    expect(await last()).toBe(before);
  });

  it('cannot change on an issued bill', async () => {
    const { invoice_id } = await issue({ po_no: 'PO-1' });
    for (const set of [`po_no = 'PO-2'`, 'po_no = null', `po_date = date '2026-11-18'`]) {
      expect(await pgError(queryAs(db, ACTORS.sqlEditor, `update public.invoices set ${set} where id = $1`, [invoice_id])), set).toMatchObject({ code: '23514' });
      expect(await pgError(queryAs(db, ACTORS.staff, `update public.invoices set ${set} where id = $1`, [invoice_id])), set).toMatchObject({ code: expect.stringMatching(/^(23514|42501)$/) as string });
    }
    expect(await order(invoice_id)).toEqual({ po_no: 'PO-1', po_date: null });
  });

  it('a bill that says nothing about an order is the same bill as before the change', async () => {
    const payload = intraStatePayload(md);
    const first = await syncInvoice(db, ACTORS.staff, payload);
    expect(await syncInvoice(db, ACTORS.staff, payload)).toMatchObject({ invoice_id: first.invoice_id, replayed: true });
    // ... which is why the program leaves the key out instead of sending it empty.
    expect(await pgError(syncInvoice(db, ACTORS.staff, { ...payload, po_no: null }))).toMatchObject({ code: '23505' });
  });
});

describe('the head of the bill', () => {
  it('is written by the owner and frozen on the bill', async () => {
    const before = await issue();
    await company(`tagline = 'Mfrs : Studs', factory_address = '2 Works Road, Coimbatore', office_phone = '0422 - 1234567'`);
    const after = await issue();
    const snapshot = async (id: string) =>
      (await db.query<{ s: Record<string, unknown> }>('select supplier_snapshot as s from public.invoices where id = $1', [id])).rows[0]!.s;
    expect(await snapshot(after.invoice_id)).toMatchObject({ tagline: 'Mfrs : Studs', factory_address: '2 Works Road, Coimbatore', office_phone: '0422 - 1234567' });
    expect(await snapshot(before.invoice_id)).toMatchObject({ tagline: null, factory_address: null, office_phone: null });
    expect(Object.keys(await snapshot(after.invoice_id)).sort()).toEqual([
      'address', 'bank_account_no', 'bank_branch', 'bank_ifsc', 'bank_name', 'email', 'factory_address', 'gstin', 'legal_name', 'office_phone', 'phone', 'state_code', 'tagline',
    ]);
  });

  it('staff cannot write it', async () => {
    expect(await company(`tagline = 'Other'`, ACTORS.staff)).toEqual([]);
  });

  it('has limits', async () => {
    for (const set of [
      `tagline = ' '`, `tagline = '${'x'.repeat(161)}'`, `factory_address = ''`, `factory_address = '${'x'.repeat(501)}'`,
      `office_phone = '12345'`, `office_phone = 'call us'`, `office_phone = '${'1'.repeat(41)}'`,
    ]) expect(await pgError(company(set)), set).toMatchObject({ code: '23514' });
    for (const set of [`office_phone = '0422 - 1234567 / 1234568'`, `office_phone = '+91 (422) 123-4567'`, 'office_phone = null', 'tagline = null', 'factory_address = null']) {
      expect(await company(set), set).toHaveLength(1);
    }
  });
});

describe('a database in use', () => {
  it('takes 007: old bills stay, and one whose answer was lost is still found', async () => {
    const old = await createTestDb({ upTo: '006' });
    const rows = await seedMasterData(old);
    const payload = intraStatePayload(rows);
    const bill = await syncInvoice(old, ACTORS.staff, payload);
    await old.exec('set role supabase_postgres');
    await old.exec(migrationFiles().find(({ name }) => name.startsWith('007'))!.sql);
    await old.exec('reset role');
    expect(await syncInvoice(old, ACTORS.staff, payload)).toMatchObject({ invoice_id: bill.invoice_id, invoice_no: bill.invoice_no, replayed: true });
    expect(await order(bill.invoice_id, old)).toEqual({ po_no: null, po_date: null });
    expect(await syncInvoice(old, ACTORS.staff, intraStatePayload(rows, { po_no: 'PO-9' }))).toMatchObject({ replayed: false });
    await old.close();
  });

  it('keeps who may issue a bill, and how the function runs', async () => {
    const { rows: [may] } = await db.query<{ ok: boolean }>(
      `select has_function_privilege('authenticated', 'public.sync_invoice(jsonb)', 'execute')
          and not has_function_privilege('anon', 'public.sync_invoice(jsonb)', 'execute')
          and not has_function_privilege('service_role', 'public.sync_invoice(jsonb)', 'execute') as ok`,
    );
    expect(may!.ok).toBe(true);
    const { rows: [fn] } = await db.query<{ prosecdef: boolean; proconfig: string[] }>(`select prosecdef, proconfig from pg_proc where oid = 'public.sync_invoice(jsonb)'::regprocedure`);
    expect(fn!.prosecdef).toBe(true);
    expect(fn!.proconfig.map((setting) => setting.replace(/"/g, ''))).toEqual(expect.arrayContaining(['search_path=', 'default_transaction_isolation=read committed']));
  });
});
