'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent, type ReactNode } from 'react';
import { enterAdvances } from '@/components/enter-advance';
import { Field, Notice } from '@/components/field';
import { useAltN } from '@/components/use-alt-n';
import { api } from '@/lib/api-client';
import { weightForPieces, wholePiecesForWeight, type WeightSpec } from '@/lib/billing-math';
import { trimZeros } from '@/lib/money';
import type { StudItem } from '@/lib/schemas/masters';

/** The conversion, or null while a dimension is still being typed. */
function attempt<T>(compute: () => T): T | null {
  try {
    return compute();
  } catch {
    return null;
  }
}

export function StudMasterView({ rows, search }: { rows: StudItem[]; search: ReactNode }) {
  const [editing, setEditing] = useState<StudItem | 'new' | null>(null);
  useAltN(() => setEditing('new'));
  return (
    <>
      <div className="mb-3 flex flex-wrap items-start gap-3">
        <div className="min-w-64 flex-1">{search}</div>
        <button className="btn btn-primary" type="button" onClick={() => setEditing('new')}>New stud (Alt+N)</button>
      </div>
      {editing ? <StudForm key={editing === 'new' ? 'new' : editing.id} stud={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
      <div className="card overflow-x-auto p-0">
        <table className="grid-table">
          <thead><tr><th>SKU</th><th>Size mm</th><th>Grade</th><th>HSN</th><th className="num">kg / piece</th><th className="num">₹ / piece</th><th className="num">₹ / kg</th></tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className={row.is_active ? '' : 'opacity-60'}>
                <td><button type="button" className="cursor-pointer text-left font-semibold text-accent underline" onClick={() => setEditing(row)}>{row.sku_code}</button></td>
                <td>{trimZeros(row.diameter_mm)} × {trimZeros(row.length_mm)}</td>
                <td>{row.material_grade}</td>
                <td>{row.hsn_sac} · {trimZeros(row.gst_rate_percent)}%</td>
                <td className="num">{row.unit_weight_kg}{row.unit_weight_is_manual ? <span className="block text-sm text-muted">measured</span> : null}</td>
                <td className="num">{row.default_rate_per_piece ? trimZeros(row.default_rate_per_piece) : '—'}</td>
                <td className="num">{row.default_rate_per_kg ? trimZeros(row.default_rate_per_kg) : '—'}</td>
              </tr>
            ))}
            {rows.length === 0 ? <tr><td colSpan={7} className="text-muted">No studs here yet.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </>
  );
}

function StudForm({ stud, onClose }: { stud: StudItem | null; onClose: () => void }) {
  const router = useRouter();
  const [diameter, setDiameter] = useState(stud ? trimZeros(stud.diameter_mm) : '');
  const [length, setLength] = useState(stud ? trimZeros(stud.length_mm) : '');
  const [measured, setMeasured] = useState(stud?.unit_weight_is_manual ?? false);
  const [manual, setManual] = useState(stud?.unit_weight_is_manual ? stud.unit_weight_kg : '');
  const [pieces, setPieces] = useState('1000');
  const [kg, setKg] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const spec: WeightSpec = { diameter_mm: diameter, length_mm: length, manual_unit_weight_kg: measured ? manual : null };
  const formula = attempt(() => weightForPieces({ diameter_mm: diameter, length_mm: length }, 1));
  const lot = /^\d+$/.test(pieces) ? attempt(() => weightForPieces(spec, Number(pieces))) : null;
  const fits = kg ? attempt(() => wholePiecesForWeight(spec, kg)) : null;

  async function finish(result: Promise<{ ok: boolean; message?: string }>): Promise<void> {
    setBusy(true);
    const outcome = await result;
    setBusy(false);
    if (!outcome.ok) return setError(outcome.message ?? 'Could not save');
    onClose();
    router.refresh();
  }

  function save(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (name: string): string => String(form.get(name) ?? '').trim();
    const body = {
      sku_code: text('sku_code'), diameter_mm: diameter, length_mm: length, thread_type: text('thread_type'), material_grade: text('material_grade'),
      hsn_sac: text('hsn_sac'), gst_rate_percent: text('gst_rate_percent'), manual_unit_weight_kg: measured ? manual : null,
      default_rate_per_piece: text('rate_piece') || null, default_rate_per_kg: text('rate_kg') || null, is_active: form.has('is_active'),
    };
    void finish(stud ? api(`/api/stud-items/${stud.id}`, 'PUT', body) : api('/api/stud-items', 'POST', body));
  }

  function remove(): void {
    if (!stud || !window.confirm(`Delete ${stud.sku_code}? Studs used on bills cannot be deleted.`)) return;
    void finish(api(`/api/stud-items/${stud.id}`, 'DELETE'));
  }

  return (
    <div className="mb-4 grid gap-4 lg:grid-cols-[2fr_1fr]">
      <form onSubmit={save} onKeyDown={enterAdvances} className="card grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label={stud ? 'Edit stud' : 'New stud'}>
        <Field label="SKU" className="lg:col-span-2"><input className="field uppercase" name="sku_code" defaultValue={stud?.sku_code} required maxLength={40} autoFocus /></Field>
        <Field label="Diameter mm"><input className="field num" inputMode="decimal" value={diameter} required onChange={(event) => setDiameter(event.target.value)} /></Field>
        <Field label="Length mm"><input className="field num" inputMode="decimal" value={length} required onChange={(event) => setLength(event.target.value)} /></Field>
        <Field label="Thread" className="lg:col-span-2"><input className="field" name="thread_type" defaultValue={stud?.thread_type ?? 'ISO metric RH'} required maxLength={80} /></Field>
        <Field label="Grade">
          <input className="field uppercase" name="material_grade" list="grades" defaultValue={stud?.material_grade} required maxLength={30} />
          <datalist id="grades">{['MS', 'EN8', 'EN19', 'SS 304', 'SS 316', 'BRASS'].map((grade) => <option key={grade} value={grade} />)}</datalist>
        </Field>
        <Field label="HSN"><input className="field" name="hsn_sac" inputMode="numeric" defaultValue={stud?.hsn_sac ?? '731815'} required /></Field>
        <Field label="GST %"><input className="field num" name="gst_rate_percent" inputMode="decimal" defaultValue={stud ? trimZeros(stud.gst_rate_percent) : '18'} required /></Field>
        <Field label="₹ per piece"><input className="field num" name="rate_piece" inputMode="decimal" defaultValue={stud?.default_rate_per_piece ? trimZeros(stud.default_rate_per_piece) : ''} /></Field>
        <Field label="₹ per kg"><input className="field num" name="rate_kg" inputMode="decimal" defaultValue={stud?.default_rate_per_kg ? trimZeros(stud.default_rate_per_kg) : ''} /></Field>
        <Field label="kg per piece" hint={measured ? `Formula says ${formula ?? '—'}` : 'Steel formula'}>
          <input className="field num" inputMode="decimal" aria-label="kg per piece" value={measured ? manual : (formula ?? '')} readOnly={!measured} onChange={(event) => setManual(event.target.value)} />
        </Field>
        <div className="flex flex-wrap items-center gap-4 sm:col-span-2 lg:col-span-4">
          <label className="flex items-center gap-2">
            <input className="size-5" type="checkbox" checked={measured} onChange={(event) => { setMeasured(event.target.checked); if (!manual) setManual(formula ?? ''); }} />
            Use a measured weight
          </label>
          <label className="flex items-center gap-2"><input className="size-5" type="checkbox" name="is_active" defaultChecked={stud?.is_active ?? true} /> Active</label>
        </div>
        {error ? <div className="sm:col-span-2 lg:col-span-4"><Notice tone="warn">{error}</Notice></div> : null}
        <div className="flex flex-wrap gap-2 sm:col-span-2 lg:col-span-4">
          <button className="btn btn-primary" type="submit" disabled={busy}>Save stud</button>
          <button className="btn" type="button" onClick={onClose}>Close</button>
          {stud ? <button className="btn ml-auto text-warn" type="button" disabled={busy} onClick={remove}>Delete</button> : null}
        </div>
      </form>
      <section className="card grid content-start gap-3" aria-label="Pieces and kilograms calculator">
        <h2 className="text-lg font-bold">Pieces ↔ kg</h2>
        <Field label="Pieces"><input className="field num" inputMode="numeric" value={pieces} onChange={(event) => setPieces(event.target.value)} /></Field>
        <output className="text-2xl font-bold tabular-nums" aria-label="Weight of these pieces">= {lot ?? '—'} kg</output>
        <Field label="Kilograms"><input className="field num" inputMode="decimal" value={kg} onChange={(event) => setKg(event.target.value)} /></Field>
        <output className="text-2xl font-bold tabular-nums" aria-label="Pieces in this weight">= {fits ?? '—'} whole pieces</output>
      </section>
    </div>
  );
}
