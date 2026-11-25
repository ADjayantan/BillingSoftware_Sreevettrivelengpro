/**
 * What a product is called and how it is found: one answer for the server, the screen and the
 * copy on this PC. Pure. Product IDs themselves come from the database (migration 005).
 */
import { trimZeros } from './money';
import type { StudItem } from './schemas/masters';

/** 7 → 'P0007', as private.product_code() writes it. */
export const productCode = (no: number): string => `P${String(no).padStart(4, '0')}`;

/** The ID somebody typed ('7', 'p7', 'P0007'), or null when it is something else. */
export function typedProductNo(q: string): number | null {
  const match = /^p?0*([1-9]\d{0,8})$/i.exec(q.trim());
  return match ? Number(match[1]) : null;
}

/** A GST % as people type it: '18', '18%', ' 18 % '. */
export const plainPercent = (typed: string): string => typed.replace(/[%\s]/g, '');

/** The code somebody gave it. Without one the database keeps the ID there. */
export const ownCode = (p: StudItem): string | null => (p.sku_code === productCode(p.product_no) ? null : p.sku_code);

/** A stud has a size: weight by formula, margin check, AI fill. */
export const isStud = (p: StudItem): boolean => p.diameter_mm !== null;

/** SAC codes start with 99: labour, sold under its own code, tax and rate. */
export const isService = (p: StudItem): boolean => p.hsn_sac.startsWith('99');

const sizeText = (p: StudItem): string | null =>
  p.diameter_mm === null || p.length_mm === null ? null : `M${trimZeros(p.diameter_mm)} × ${trimZeros(p.length_mm)} mm · ${p.material_grade} · ${p.thread_type}`;

const codeAndSize = (p: StudItem): string => [ownCode(p), sizeText(p)].filter(Boolean).join(' · ');

/** What a bill says. Never the ID: that is for typing, not for the buyer. */
export const productName = (p: StudItem): string => p.name ?? `Stud ${codeAndSize(p)}`;

/** On a job-work bill a stud is what the work was done to. */
export const lineText = (p: StudItem, type: 'supply' | 'job_work'): string =>
  type === 'job_work' && isStud(p) ? `Threading ${p.name ?? codeAndSize(p)}` : productName(p);

/** In lists: the ID first. A product kept from before IDs has none to show. */
export const productLabel = (p: StudItem): string => (p.product_no > 0 ? `${productCode(p.product_no)} · ${productName(p)}` : productName(p));

export function productDetail(p: StudItem): string {
  const rate = p.default_rate_per_piece ? `₹${trimZeros(p.default_rate_per_piece)}/pc` : p.default_rate_per_kg ? `₹${trimZeros(p.default_rate_per_kg)}/kg` : 'no rate';
  return [p.name === null ? null : codeAndSize(p), rate, `HSN ${p.hsn_sac}`, `GST ${trimZeros(p.gst_rate_percent)}%`].filter(Boolean).join(' · ');
}

/** 0 the ID typed, 1 its own code, 2 part of its name, code or size, 3 not this one. */
export function findRank(p: StudItem, q: string): 0 | 1 | 2 | 3 {
  if (typedProductNo(q) === p.product_no) return 0;
  const needle = q.trim().toUpperCase();
  if (p.sku_code === needle) return 1;
  return p.search_text.includes(needle) ? 2 : 3;
}

/** A product kept on this PC by a version without IDs and names: usable, with nothing invented. */
export const revivedProduct = (kept: Omit<StudItem, 'product_no' | 'name' | 'search_text'> & Partial<StudItem>): StudItem => ({
  product_no: 0, name: null, search_text: kept.sku_code, ...kept,
});
