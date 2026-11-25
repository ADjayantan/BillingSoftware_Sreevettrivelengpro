'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent, type ReactNode } from 'react';
import { enterAdvances } from '@/components/enter-advance';
import { Field, Notice } from '@/components/field';
import { useAltN } from '@/components/use-alt-n';
import { api, type ApiResult } from '@/lib/api-client';
import { weightForPieces, wholePiecesForWeight } from '@/lib/billing-math';
import { trimZeros } from '@/lib/money';
import { offlineEngine, type OfflineEngine } from '@/lib/offline';
import { attempt, blankProduct, editProduct, productInput, setStud, unitWeight, weightSpec, type ProductForm } from '@/lib/product-form';
import { ownCode, productCode, productName } from '@/lib/products';
import type { StudItem } from '@/lib/schemas/masters';

/** Best effort: without it the next refresh brings the copy up to date. */
const inCopy = (work: (engine: OfflineEngine) => Promise<void>): void =>
  void offlineEngine().then((engine) => (engine ? work(engine) : undefined)).catch(() => undefined);

export function ProductsView({ rows, search }: { rows: StudItem[]; search: ReactNode }) {
  const [editing, setEditing] = useState<StudItem | 'new' | null>(null);
  const [saved, setSaved] = useState<{ product: StudItem; added: boolean } | null>(null);
  const open = (which: StudItem | 'new'): void => {
    setSaved(null);
    setEditing(which);
  };
  useAltN(() => open('new'));
  return (
    <>
      <div className="mb-3 flex flex-wrap items-start gap-3">
        <div className="min-w-64 flex-1">{search}</div>
        <button className="btn btn-primary" type="button" onClick={() => open('new')}>New product (Alt+N)</button>
      </div>
      {saved ? (
        <div className="mb-3">
          <Notice>{saved.added ? 'Saved as ' : 'Saved '}<strong className="text-lg">{productCode(saved.product.product_no)}</strong> · {productName(saved.product)}</Notice>
        </div>
      ) : null}
      {editing ? (
        <ProductEditor
          key={editing === 'new' ? 'new' : editing.id} product={editing === 'new' ? null : editing} onClose={() => setEditing(null)}
          onSaved={(product) => {
            setSaved({ product, added: editing === 'new' });
            setEditing(null);
          }}
        />
      ) : null}
      <div className="card overflow-x-auto p-0">
        <table className="grid-table">
          <thead><tr><th>ID</th><th>Product</th><th>HSN</th><th className="num">GST %</th><th className="num">kg / piece</th><th className="num">₹ / piece</th><th className="num">₹ / kg</th></tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className={row.is_active ? '' : 'opacity-60'}>
                <td className="font-semibold whitespace-nowrap tabular-nums">{productCode(row.product_no)}</td>
                <td>
                  <button type="button" className="cursor-pointer text-left font-semibold text-accent underline" onClick={() => open(row)}>{productName(row)}</button>
                  {row.name !== null && ownCode(row) ? <span className="block text-sm text-muted">{ownCode(row)}</span> : null}
                  {row.is_active ? null : <span className="block text-sm">Not in use</span>}
                </td>
                <td>{row.hsn_sac}</td>
                <td className="num">{trimZeros(row.gst_rate_percent)}</td>
                <td className="num">{row.unit_weight_kg ?? '—'}{row.unit_weight_is_manual ? <span className="block text-sm text-muted">measured</span> : null}</td>
                <td className="num">{row.default_rate_per_piece ? trimZeros(row.default_rate_per_piece) : '—'}</td>
                <td className="num">{row.default_rate_per_kg ? trimZeros(row.default_rate_per_kg) : '—'}</td>
              </tr>
            ))}
            {rows.length === 0 ? <tr><td colSpan={7} className="text-muted">No products here yet.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </>
  );
}

function ProductEditor({ product, onClose, onSaved }: { product: StudItem | null; onClose: () => void; onSaved: (product: StudItem) => void }) {
  const router = useRouter();
  const [form, setForm] = useState<ProductForm>(() => (product ? editProduct(product) : blankProduct));
  const [pieces, setPieces] = useState('1000');
  const [kg, setKg] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const patch = (change: Partial<ProductForm>): void => setForm((old) => ({ ...old, ...change }));

  const formula = unitWeight({ ...form, measured: false });
  const spec = weightSpec(form);
  const lot = /^\d+$/.test(pieces) ? attempt(() => weightForPieces(spec, Number(pieces))) : null;
  const fits = kg ? attempt(() => wholePiecesForWeight(spec, kg)) : null;

  async function send<T>(request: Promise<ApiResult<T>>): Promise<T | null> {
    setBusy(true);
    setError(null);
    const outcome = await request;
    setBusy(false);
    if (outcome.ok) return outcome.data;
    setError(outcome.message);
    return null;
  }

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) return;
    const body = productInput(form);
    const row = await send(product ? api<StudItem>(`/api/stud-items/${product.id}`, 'PUT', body) : api<StudItem>('/api/stud-items', 'POST', body));
    if (!row) return;
    inCopy((engine) => engine.keepProduct(row));
    onSaved(row);
    router.refresh();
  }

  async function remove(): Promise<void> {
    if (!product || !window.confirm(`Delete ${productCode(product.product_no)} ${productName(product)}? Its ID is never used again. A product used on a bill cannot be deleted: untick Active instead.`)) return;
    if ((await send(api(`/api/stud-items/${product.id}`, 'DELETE'))) === null) return;
    inCopy((engine) => engine.forgetProduct(product.id));
    onClose();
    router.refresh();
  }

  return (
    <div className="mb-4 grid gap-4 lg:grid-cols-[2fr_1fr]">
      <form onSubmit={(event) => void save(event)} onKeyDown={enterAdvances} className="card grid content-start gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label={product ? 'Edit product' : 'New product'}>
        <p className="sm:col-span-2 lg:col-span-4">Product ID: <strong>{product ? productCode(product.product_no) : 'given when you save'}</strong></p>
        <Field label={form.isStud ? 'Product name (a stud may go without)' : 'Product name'} className="sm:col-span-2">
          <input className="field" value={form.name} required={!form.isStud} maxLength={120} autoFocus onChange={(event) => patch({ name: event.target.value })} />
        </Field>
        <Field label="HSN / SAC"><input className="field" inputMode="numeric" value={form.hsn} required onChange={(event) => patch({ hsn: event.target.value.trim(), hsnOffered: false })} /></Field>
        <Field label="GST %"><input className="field num" inputMode="decimal" value={form.gst} required onChange={(event) => patch({ gst: event.target.value })} /></Field>
        <Field label="₹ per piece"><input className="field num" inputMode="decimal" value={form.ratePiece} onChange={(event) => patch({ ratePiece: event.target.value })} /></Field>
        <Field label="₹ per kg"><input className="field num" inputMode="decimal" value={form.rateKg} onChange={(event) => patch({ rateKg: event.target.value })} /></Field>
        {form.isStud ? (
          <Field label="kg per piece" hint={form.measured ? `Formula says ${formula ?? '—'}` : 'Steel formula'}>
            <input className="field num" inputMode="decimal" aria-label="kg per piece" value={form.measured ? form.kg : (formula ?? '')} readOnly={!form.measured} onChange={(event) => patch({ kg: event.target.value })} />
          </Field>
        ) : (
          <Field label="kg per piece" hint="If you know it"><input className="field num" inputMode="decimal" value={form.kg} onChange={(event) => patch({ kg: event.target.value })} /></Field>
        )}
        <Field label="Own code" hint="If you use one"><input className="field uppercase" value={form.code} maxLength={40} onChange={(event) => patch({ code: event.target.value })} /></Field>
        <label className="flex items-center gap-2 sm:col-span-2 lg:col-span-4">
          <input className="size-5" type="checkbox" checked={form.isStud} onChange={(event) => setForm((old) => setStud(old, event.target.checked))} /> It is a stud (it has a size)
        </label>
        {form.isStud ? (
          <>
            <Field label="Diameter mm"><input className="field num" inputMode="decimal" value={form.diameter} required onChange={(event) => patch({ diameter: event.target.value })} /></Field>
            <Field label="Length mm"><input className="field num" inputMode="decimal" value={form.length} required onChange={(event) => patch({ length: event.target.value })} /></Field>
            <Field label="Thread"><input className="field" value={form.thread} required maxLength={80} onChange={(event) => patch({ thread: event.target.value })} /></Field>
            <Field label="Grade">
              <input className="field uppercase" list="grades" value={form.grade} required maxLength={30} onChange={(event) => patch({ grade: event.target.value })} />
              <datalist id="grades">{['MS', 'EN8', 'EN19', 'SS 304', 'SS 316', 'BRASS'].map((grade) => <option key={grade} value={grade} />)}</datalist>
            </Field>
          </>
        ) : null}
        <div className="flex flex-wrap items-center gap-4 sm:col-span-2 lg:col-span-4">
          {form.isStud ? (
            <label className="flex items-center gap-2">
              <input className="size-5" type="checkbox" checked={form.measured} onChange={(event) => patch({ measured: event.target.checked, kg: form.kg || (formula ?? '') })} /> Use a measured weight
            </label>
          ) : null}
          <label className="flex items-center gap-2"><input className="size-5" type="checkbox" checked={form.active} onChange={(event) => patch({ active: event.target.checked })} /> Active</label>
        </div>
        {error ? <div className="sm:col-span-2 lg:col-span-4"><Notice tone="warn">{error}</Notice></div> : null}
        <div className="flex flex-wrap gap-2 sm:col-span-2 lg:col-span-4">
          <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save product'}</button>
          <button className="btn" type="button" onClick={onClose}>Close</button>
          {product ? <button className="btn ml-auto text-warn" type="button" disabled={busy} onClick={() => void remove()}>Delete</button> : null}
        </div>
      </form>
      {form.isStud || form.kg.trim() !== '' ? (
        <section className="card grid content-start gap-3" aria-label="Pieces and kilograms calculator">
          <h2 className="text-lg font-bold">Pieces ↔ kg</h2>
          <Field label="Pieces"><input className="field num" inputMode="numeric" value={pieces} onChange={(event) => setPieces(event.target.value)} /></Field>
          <output className="text-2xl font-bold tabular-nums" aria-label="Weight of these pieces">= {lot ?? '—'} kg</output>
          <Field label="Kilograms"><input className="field num" inputMode="decimal" value={kg} onChange={(event) => setKg(event.target.value)} /></Field>
          <output className="text-2xl font-bold tabular-nums" aria-label="Pieces in this weight">= {fits ?? '—'} whole pieces</output>
        </section>
      ) : null}
    </div>
  );
}
