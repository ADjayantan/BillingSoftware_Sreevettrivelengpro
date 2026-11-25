/** What the Products page holds while a product is typed, and what it sends. Pure. */
import type { z } from 'zod';
import { weightForPieces, type WeightSpec } from './billing-math';
import { trimZeros } from './money';
import { isStud, ownCode, plainPercent } from './products';
import type { StudItem, studItemInput } from './schemas/masters';

export interface ProductForm {
  name: string;
  hsn: string;
  /** The HSN was filled in by ticking "stud", not typed. */
  hsnOffered: boolean;
  gst: string;
  ratePiece: string;
  rateKg: string;
  isStud: boolean;
  diameter: string;
  length: string;
  thread: string;
  grade: string;
  /** A stud weighed by somebody, instead of computed from its size. */
  measured: boolean;
  /** kg per piece, where it is not computed. */
  kg: string;
  code: string;
  active: boolean;
}

/** Nothing is assumed: HSN and GST % are for a person to type. */
export const blankProduct: ProductForm = {
  name: '', hsn: '', hsnOffered: false, gst: '', ratePiece: '', rateKg: '',
  isStud: false, diameter: '', length: '', thread: 'ISO metric RH', grade: '', measured: false, kg: '', code: '', active: true,
};

const trimmed = (decimal: string | null): string => (decimal === null ? '' : trimZeros(decimal));

export const editProduct = (p: StudItem): ProductForm => ({
  name: p.name ?? '', hsn: p.hsn_sac, hsnOffered: false, gst: trimZeros(p.gst_rate_percent), ratePiece: trimmed(p.default_rate_per_piece), rateKg: trimmed(p.default_rate_per_kg),
  isStud: isStud(p), diameter: trimmed(p.diameter_mm), length: trimmed(p.length_mm), thread: p.thread_type ?? blankProduct.thread, grade: p.material_grade ?? '',
  measured: isStud(p) && p.unit_weight_is_manual, kg: p.unit_weight_is_manual ? trimmed(p.unit_weight_kg) : '', code: ownCode(p) ?? '', active: p.is_active,
});

const STUD_HSN = '731815';

export function setStud(form: ProductForm, on: boolean): ProductForm {
  if (on) return { ...form, isStud: true, ...(form.hsn.trim() === '' ? { hsn: STUD_HSN, hsnOffered: true } : {}) };
  return { ...form, isStud: false, ...(form.hsnOffered ? { hsn: '', hsnOffered: false } : {}) };
}

export const weightSpec = (form: ProductForm): WeightSpec =>
  form.isStud
    ? { diameter_mm: form.diameter.trim(), length_mm: form.length.trim(), manual_unit_weight_kg: form.measured ? form.kg.trim() : null }
    : { diameter_mm: null, length_mm: null, manual_unit_weight_kg: form.kg.trim() || null };

/** A conversion, or null while something it needs is still being typed. */
export function attempt<T>(compute: () => T): T | null {
  try {
    return compute();
  } catch {
    return null;
  }
}

export const unitWeight = (form: ProductForm): string | null => attempt(() => weightForPieces(weightSpec(form), 1));

export function productInput(form: ProductForm): z.input<typeof studItemInput> {
  const size = (value: string): string | null => (form.isStud ? value.trim() : null);
  return {
    name: form.name, sku_code: form.code, hsn_sac: form.hsn, gst_rate_percent: plainPercent(form.gst),
    diameter_mm: size(form.diameter), length_mm: size(form.length), thread_type: size(form.thread), material_grade: size(form.grade),
    manual_unit_weight_kg: weightSpec(form).manual_unit_weight_kg ?? null,
    default_rate_per_piece: form.ratePiece.trim() || null, default_rate_per_kg: form.rateKg.trim() || null, is_active: form.active,
  };
}
