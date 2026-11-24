import { z } from 'zod';
import { GST_STATES } from '@/lib/india';

/** '' from an untouched form field means "not given". */
export const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((value) => (value ? value : null));

export const requiredText = (max: number) => z.string().trim().min(1, 'Required').max(max);

export const id = z.uuid();
export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), 'Not a real date');

/** Non-negative decimal string with at most `scale` decimals; no exponent, sign or NaN. */
export const decimal = (scale: number, maxWhole = 12) =>
  z
    .string()
    .trim()
    .regex(new RegExp(`^\\d{1,${maxWhole}}(\\.\\d{1,${scale}})?$`), `Use a number with up to ${scale} decimals`);

export const positiveDecimal = (scale: number, maxWhole = 12) =>
  decimal(scale, maxWhole).refine((value) => /[1-9]/.test(value), 'Must be more than zero');

/** Whole paise: the frozen billing contract cannot represent less. */
export const rupees = decimal(2, 11);
export const signedRupees = z.string().trim().regex(/^-?\d{1,11}(\.\d{1,2})?$/, 'Use an amount with up to 2 decimals');
export const gstRate = decimal(2, 3).refine((value) => Number(value) <= 100, 'At most 100%');

export const phone = z
  .string()
  .trim()
  .transform((value) => value.replace(/[\s-]/g, ''))
  .pipe(z.string().regex(/^\+?\d{10,15}$/, 'Use 10 to 15 digits'));
export const optionalPhone = z.union([z.literal('').transform(() => null), z.null(), phone]).optional().transform((value) => value ?? null);

export const stateCode = z.string().refine((code) => code in GST_STATES, 'Unknown GST state code');
export const hsnSac = z.string().trim().regex(/^(\d{4}|\d{6}|\d{8})$/, 'HSN/SAC has 4, 6 or 8 digits');
export const materialGrade = z
  .string()
  .trim()
  .toUpperCase()
  .pipe(z.string().regex(/^[A-Z0-9][A-Z0-9 ./-]{0,29}$/, 'Use letters, digits, space, dot, slash or dash'));

export const listQuery = z.object({
  q: z.string().trim().max(60).default(''),
  page: z.coerce.number().int().min(1).max(1000).default(1),
});
export const PAGE_SIZE = 50;
