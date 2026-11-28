import { z } from 'zod';
import { isValidGstin } from '@/lib/india';
import * as c from './common';

export const SUPPLIER_CATEGORIES = ['raw_material', 'tools', 'transport', 'power', 'other'] as const;
export type SupplierCategory = (typeof SUPPLIER_CATEGORIES)[number];

export const SUPPLIER_CATEGORY_LABELS: Record<SupplierCategory, string> = {
  raw_material: 'Raw material (Steel rods)',
  tools: 'Tools & dies',
  transport: 'Transport',
  power: 'Power & fuel',
  other: 'Other supplier',
};

export const EXPENSE_CATEGORIES = [
  'raw_material',
  'tools',
  'electricity',
  'transport',
  'wages',
  'maintenance',
  'office',
  'other',
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export const EXPENSE_CATEGORY_LABELS: Record<ExpenseCategory, string> = {
  raw_material: 'Raw material purchase',
  tools: 'Tools, dies & oil',
  electricity: 'Electricity & power',
  transport: 'Transport & freight',
  wages: 'Shop wages & labour',
  maintenance: 'Machine repair',
  office: 'Office & stationery',
  other: 'Other expense',
};

export const EXPENSE_PAYMENT_MODES = ['cash', 'upi', 'bank_transfer', 'cheque', 'credit'] as const;
export type ExpensePaymentMode = (typeof EXPENSE_PAYMENT_MODES)[number];

const gstin = z
  .string()
  .trim()
  .toUpperCase()
  .pipe(
    z.union([
      z.literal('').transform(() => null),
      z.string().refine(isValidGstin, 'This GSTIN is not valid: check each character'),
    ]),
  );

export const supplierInput = z.object({
  name: c.requiredText(160),
  gstin: gstin.nullish().transform((value) => value ?? null),
  phone: c.optionalPhone,
  category: z.enum(SUPPLIER_CATEGORIES).default('raw_material'),
  notes: c.optionalText(500),
  is_active: z.boolean().default(true),
});
export type SupplierInput = z.infer<typeof supplierInput>;

export const supplierRow = z.object({
  id: c.id,
  name: z.string(),
  gstin: z.string().nullable(),
  phone: z.string().nullable(),
  category: z.enum(SUPPLIER_CATEGORIES),
  notes: z.string().nullable(),
  is_active: z.boolean(),
});
export type SupplierRow = z.infer<typeof supplierRow>;

export const expenseInput = z.object({
  expense_date: c.isoDate,
  category: z.enum(EXPENSE_CATEGORIES),
  supplier_id: c.id.nullish().transform((value) => value ?? null),
  supplier_name: c.optionalText(160),
  bill_no: c.optionalText(60),
  description: c.requiredText(300),
  material_grade: c.optionalText(40),
  weight_kg: c.positiveDecimal(3, 8).nullish().transform((value) => value ?? null),
  taxable_amount: c.rupees.refine((value) => /[1-9]/.test(value), 'Amount must be more than zero'),
  gst_amount: c.rupees.default('0'),
  payment_mode: z.enum(EXPENSE_PAYMENT_MODES).default('bank_transfer'),
  payment_status: z.enum(['paid', 'unpaid']).default('paid'),
});
export type ExpenseInput = z.infer<typeof expenseInput>;

export const expenseRow = z.object({
  id: c.id,
  expense_date: c.isoDate,
  category: z.enum(EXPENSE_CATEGORIES),
  supplier_id: c.id.nullable(),
  supplier_name: z.string().nullable(),
  bill_no: z.string().nullable(),
  description: z.string(),
  material_grade: z.string().nullable(),
  weight_kg: z.string().nullable(),
  taxable_amount: z.string(),
  gst_amount: z.string(),
  total_amount: z.string(),
  payment_mode: z.enum(EXPENSE_PAYMENT_MODES),
  payment_status: z.enum(['paid', 'unpaid']),
});
export type ExpenseRow = z.infer<typeof expenseRow>;
