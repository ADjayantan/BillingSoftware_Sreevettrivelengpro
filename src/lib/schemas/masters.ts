import { z } from 'zod';
import { isValidGstin } from '@/lib/india';
import * as c from './common';

// ---- Customers --------------------------------------------------------------
const gstin = z
  .string()
  .trim()
  .toUpperCase()
  .pipe(z.union([z.literal('').transform(() => null), z.string().refine(isValidGstin, 'This GSTIN is not valid: check each character')]));

export const customerInput = z
  .object({
    name: c.requiredText(120),
    gstin: gstin.nullish().transform((value) => value ?? null),
    phone: c.optionalPhone,
    state_code: c.stateCode,
    is_sez: z.boolean().default(false),
    credit_days: z.number().int().min(0).max(365),
    address: c.optionalText(500),
    opening_balance: c.signedRupees.default('0'),
    is_active: z.boolean().default(true),
  })
  .refine((value) => value.gstin === null || value.gstin.startsWith(value.state_code), {
    path: ['state_code'],
    message: 'The state does not match the first two digits of the GSTIN',
  })
  .refine((value) => value.gstin === null || value.address !== null, {
    path: ['address'],
    message: 'A GST-registered customer needs an address (Rule 46)',
  })
  .refine((value) => !value.is_sez || value.gstin !== null, {
    path: ['gstin'],
    message: 'An SEZ unit needs its GSTIN',
  });

export const customerRow = z.object({
  id: c.id,
  name: z.string(),
  gstin: z.string().nullable(),
  phone: z.string().nullable(),
  state_code: z.string(),
  is_sez: z.boolean(),
  credit_days: z.number(),
  address: z.string().nullable(),
  opening_balance: z.string(),
  is_active: z.boolean(),
});
export type Customer = z.infer<typeof customerRow>;

// ---- Products (studs are the ones with a size) ------------------------------
const orNull = <T>(value: T | null | undefined): T | null => value ?? null;

/** Optional. Without one the database keeps the product ID there. */
const ownCode = z
  .string()
  .trim()
  .toUpperCase()
  .refine((code) => code === '' || /^[A-Z0-9][A-Z0-9._/-]{0,39}$/.test(code), 'Use letters, digits and . _ / - (no spaces)')
  .refine((code) => !/^P\d+$/.test(code),'Codes like P0007 are product IDs, given automatically: use another code')
  .nullish()
  .transform((code) => code || null);

export const studItemInput = z
  .object({
    name: c.optionalText(120),
    sku_code: ownCode,
    diameter_mm: c.positiveDecimal(3, 3).refine((value) => Number(value) <= 200, 'At most 200 mm').nullish().transform(orNull),
    length_mm: c.positiveDecimal(2, 5).refine((value) => Number(value) <= 10_000, 'At most 10,000 mm').nullish().transform(orNull),
    thread_type: c.optionalText(80),
    material_grade: c.materialGrade.nullish().transform(orNull),
    hsn_sac: c.hsnSac,
    /** Always typed by a person: no default anywhere. */
    gst_rate_percent: z.string('Type the GST %').trim().min(1, 'Type the GST %').pipe(c.gstRate),
    /** A measured weight. Null computes the steel formula for a stud, and is no weight for anything else. */
    manual_unit_weight_kg: c.positiveDecimal(6, 6).nullish().transform(orNull),
    default_rate_per_piece: c.rupees.nullish().transform(orNull),
    default_rate_per_kg: c.rupees.nullish().transform(orNull),
    is_active: z.boolean().default(true),
  })
  .refine(
    (p) => new Set([p.diameter_mm, p.length_mm, p.thread_type, p.material_grade].map((value) => value === null)).size === 1,
    'A stud needs its diameter, length, thread and grade',
  )
  .refine((p) => p.diameter_mm !== null || p.name !== null, 'Give the product a name');

export const studItemRow = z.object({
  id: c.id,
  /** The product ID, shown as P0007. */
  product_no: z.number().int(),
  name: z.string().nullable(),
  sku_code: z.string(),
  /** Name, code and size in capitals: what searching looks in, here and on the PC. */
  search_text: z.string(),
  diameter_mm: z.string().nullable(),
  length_mm: z.string().nullable(),
  thread_type: z.string().nullable(),
  material_grade: z.string().nullable(),
  hsn_sac: z.string(),
  gst_rate_percent: z.string(),
  unit_weight_kg: z.string().nullable(),
  unit_weight_is_manual: z.boolean(),
  default_rate_per_piece: z.string().nullable(),
  default_rate_per_kg: z.string().nullable(),
  is_active: z.boolean(),
});
export type StudItem = z.infer<typeof studItemRow>;

// ---- Job-work ledger --------------------------------------------------------
export const jobWorkInput = z.object({
  customer_id: c.id,
  party_dc_no: c.requiredText(40),
  party_dc_date: c.isoDate,
  material_grade: c.materialGrade,
  description: c.optionalText(300),
  inward_weight_kg: c.positiveDecimal(3, 8),
  outward_weight_kg: c.decimal(3, 8).default('0'),
  scrap_weight_kg: c.decimal(3, 8).default('0'),
  notes: c.optionalText(1000),
  status: z.enum(['open', 'closed']).default('open'),
  close_reason: z.string().trim().min(3).max(300).nullish().transform((value) => value ?? null),
});

export const jobWorkRow = z.object({
  id: c.id,
  customer_id: c.id,
  party_dc_no: z.string(),
  party_dc_date: z.string(),
  material_grade: z.string(),
  description: z.string().nullable(),
  inward_weight_kg: z.string(),
  outward_weight_kg: z.string(),
  scrap_weight_kg: z.string(),
  balance_weight_kg: z.string(),
  status: z.enum(['open', 'closed']),
  close_reason: z.string().nullable(),
  notes: z.string().nullable(),
});
export type JobWorkLot = z.infer<typeof jobWorkRow>;

// ---- Company profile --------------------------------------------------------
export const companyInput = z.object({
  legal_name: c.requiredText(120),
  tagline: c.optionalText(160),
  gstin: z
    .string()
    .trim()
    .toUpperCase()
    .pipe(z.string().refine((value) => value.startsWith('33') && isValidGstin(value), 'Enter a valid Tamil Nadu (33) GSTIN')),
  address: c.requiredText(500),
  factory_address: c.optionalText(500),
  phone: c.optionalPhone,
  /** Kept as it stands on the bill: '0422 - 1234567'. */
  office_phone: z
    .union([z.literal('').transform(() => null), z.null(), z.string().trim().regex(/^(?=.*\d{4})[0-9+()/, -]{6,40}$/, 'Use digits, for example 0422 - 1234567')])
    .optional()
    .transform((value) => value ?? null),
  email: z.union([z.literal('').transform(() => null), z.null(), z.email().max(120)]).optional().transform((value) => value ?? null),
  bank_name: c.optionalText(80),
  bank_branch: c.optionalText(80),
  bank_account_no: z
    .union([z.literal('').transform(() => null), z.null(), z.string().trim().regex(/^\d{6,20}$/, 'Digits only')])
    .optional()
    .transform((value) => value ?? null),
  bank_ifsc: z
    .union([z.literal('').transform(() => null), z.null(), z.string().trim().toUpperCase().pipe(z.string().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'IFSC looks like ABCD0123456'))])
    .optional()
    .transform((value) => value ?? null),
});

export const companyRow = z.object({
  legal_name: z.string(),
  tagline: z.string().nullable(),
  gstin: z.string(),
  address: z.string(),
  factory_address: z.string().nullable(),
  state_code: z.string(),
  phone: z.string().nullable(),
  office_phone: z.string().nullable(),
  email: z.string().nullable(),
  bank_name: z.string().nullable(),
  bank_branch: z.string().nullable(),
  bank_account_no: z.string().nullable(),
  bank_ifsc: z.string().nullable(),
});
export type Company = z.infer<typeof companyRow>;
