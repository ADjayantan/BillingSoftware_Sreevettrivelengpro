// What a product is called, how it is found, and what may be saved as one. Pure.
import { describe, expect, it } from 'vitest';
import { weightForPieces, wholePiecesForWeight } from '@/lib/billing-math';
import * as p from '@/lib/products';
import { studItemInput, type StudItem } from '@/lib/schemas/masters';

const nut: StudItem = {
  id: '00000000-0000-4000-8000-00000000000a', product_no: 2, name: 'Hex nut M12 GI', sku_code: 'P0002', search_text: 'HEX NUT M12 GI P0002',
  diameter_mm: null, length_mm: null, thread_type: null, material_grade: null, hsn_sac: '731816', gst_rate_percent: '18.00',
  unit_weight_kg: null, unit_weight_is_manual: false, default_rate_per_piece: '4.500000', default_rate_per_kg: null, is_active: true,
};
const stud: StudItem = {
  ...nut, id: '00000000-0000-4000-8000-00000000000b', product_no: 1, name: null, sku_code: 'MS-M8-45-FT', search_text: 'MS-M8-45-FT M8X45 MS',
  diameter_mm: '8.000', length_mm: '45.00', thread_type: 'Full thread', material_grade: 'MS', hsn_sac: '731815',
  unit_weight_kg: '0.017756', default_rate_per_piece: '3.100000', default_rate_per_kg: '165.000000',
};

describe('product ID', () => {
  it.each([[1, 'P0001'], [42, 'P0042'], [9999, 'P9999'], [10000, 'P10000']])('%i is written %s', (no, code) => expect(p.productCode(no)).toBe(code));

  it.each([['7', 7], [' 7 ', 7], ['p7', 7], ['P0007', 7], ['0007', 7], ['P10000', 10000], ['123456789', 123456789]])(
    'typing %j means product %i', (typed, no) => expect(p.typedProductNo(typed)).toBe(no));

  it.each(['', '0', 'P', 'P0000', 'M12', '7A', 'P-7', 'P 7', '7 8', '12x150', '1.5', '-7', '1234567890', 'PP7'])(
    'typing %j is not an ID', (typed) => expect(p.typedProductNo(typed)).toBeNull());
});

describe('what it is called', () => {
  it('is its name, and for a stud without one its code and size', () => {
    expect(p.productName(nut)).toBe('Hex nut M12 GI');
    expect(p.productName(stud)).toBe('Stud MS-M8-45-FT · M8 × 45 mm · MS · Full thread');
    expect(p.productName({ ...stud, name: 'Vel special' })).toBe('Vel special');
  });

  it('never puts the ID on a bill', () => {
    const noCode = { ...stud, sku_code: 'P0001' };
    expect(p.productName(noCode)).toBe('Stud M8 × 45 mm · MS · Full thread');
    expect(p.lineText(noCode, 'job_work')).toBe('Threading M8 × 45 mm · MS · Full thread');
    expect([p.ownCode(noCode), p.ownCode(stud), p.ownCode(nut)]).toEqual([null, 'MS-M8-45-FT', null]);
  });

  it('is the work done to it on a job-work bill, for a stud', () => {
    expect(p.lineText(stud, 'job_work')).toBe('Threading MS-M8-45-FT · M8 × 45 mm · MS · Full thread');
    expect(p.lineText({ ...stud, name: 'Vel special' }, 'job_work')).toBe('Threading Vel special');
    expect(p.lineText({ ...nut, name: 'Zinc plating', hsn_sac: '998873' }, 'job_work')).toBe('Zinc plating');
    expect(p.lineText(stud, 'supply')).toBe(p.productName(stud));
  });

  it('is listed with its ID, rate, HSN and GST %', () => {
    expect(p.productLabel(nut)).toBe('P0002 · Hex nut M12 GI');
    expect(p.productDetail(nut)).toBe('₹4.5/pc · HSN 731816 · GST 18%');
    expect(p.productDetail({ ...nut, default_rate_per_piece: null, default_rate_per_kg: '165.00' })).toBe('₹165/kg · HSN 731816 · GST 18%');
    expect(p.productDetail({ ...nut, default_rate_per_piece: null })).toBe('no rate · HSN 731816 · GST 18%');
    expect(p.productDetail({ ...stud, name: 'Vel special' })).toBe('MS-M8-45-FT · M8 × 45 mm · MS · Full thread · ₹3.1/pc · HSN 731815 · GST 18%');
    expect(p.productDetail(stud)).toBe('₹3.1/pc · HSN 731815 · GST 18%');
  });

  it('is a service when its code is a SAC', () => {
    expect([p.isService(nut), p.isService({ ...nut, hsn_sac: '998873' })]).toEqual([false, true]);
    expect([p.isStud(nut), p.isStud(stud)]).toEqual([false, true]);
  });
});

describe('how it is found', () => {
  const coded = { ...nut, sku_code: '4501', search_text: 'HEX NUT M12 GI 4501' };
  const products = { nut, stud, coded };
  it.each([
    ['nut', '2', 0], ['nut', 'p2', 0], ['nut', 'P0002', 0], ['nut', '0002', 0],
    ['stud', 'ms-m8-45-ft', 1], ['coded', '4501', 1],
    ['nut', 'nut m12', 2], ['nut', '12', 2], ['stud', 'm8x45', 2], ['stud', '45', 2], ['stud', 'M8-45', 2],
    ['nut', '3', 3], ['nut', 'bolt', 3], ['stud', 'P0002', 3],
  ] as const)('the %s by %j ranks %i', (which, q, rank) => expect(p.findRank(products[which], q)).toBe(rank));

  it('completes a product an earlier version kept, without inventing an ID', () => {
    const old: Partial<StudItem> = { ...stud };
    for (const added of ['product_no', 'name', 'search_text'] as const) delete old[added];
    const revived = p.revivedProduct(old as StudItem);
    expect(revived).toEqual({ ...stud, product_no: 0, search_text: 'MS-M8-45-FT' });
    expect(p.productLabel(revived)).toBe(p.productName(stud));
    expect(p.ownCode(revived)).toBe('MS-M8-45-FT');
    expect(p.findRank(revived, 'm8-45')).toBe(2);
    expect(p.findRank(revived, '0')).toBe(3);
    expect(p.revivedProduct({ ...nut, name: 'Kept' })).toEqual({ ...nut, name: 'Kept' });
  });
});

describe('what may be saved', () => {
  const input = { name: 'Hex nut M12 GI', hsn_sac: '731816', gst_rate_percent: '18' };
  const size = { diameter_mm: '8', length_mm: '45', thread_type: 'Full thread', material_grade: 'ms' };
  const refusal = (body: unknown): string | undefined => studItemInput.safeParse(body).error?.issues[0]?.message;

  it('is a name, HSN and GST %: nothing else is needed', () => {
    expect(studItemInput.parse(input)).toEqual({
      ...input, sku_code: null, diameter_mm: null, length_mm: null, thread_type: null, material_grade: null,
      manual_unit_weight_kg: null, default_rate_per_piece: null, default_rate_per_kg: null, is_active: true,
    });
  });

  it('is a stud without a name, as the last version of the app sends it', () => {
    expect(studItemInput.parse({ ...size, sku_code: 'ms-m8-45-ft', hsn_sac: '731815', gst_rate_percent: '18' })).toMatchObject({
      name: null, sku_code: 'MS-M8-45-FT', diameter_mm: '8', material_grade: 'MS',
    });
  });

  it('never carries an ID somebody typed', () => {
    expect(studItemInput.parse({ ...input, product_no: 900, search_text: 'x' })).not.toHaveProperty('product_no');
  });

  it.each([undefined, null, '', '  '])('asks for the GST percentage when it is %j', (gst) => {
    expect(refusal({ ...input, gst_rate_percent: gst })).toBe('Type the GST %');
  });

  it.each(['abc', '118', '18.555', '-5', '1e1'])('refuses a GST percentage of %j', (gst) => expect(refusal({ ...input, gst_rate_percent: gst })).toBeDefined());

  it.each(['0', '5', '18', '2.5', '100'])('takes a GST percentage of %s, whatever the slabs are', (gst) => expect(refusal({ ...input, gst_rate_percent: gst })).toBeUndefined());

  it('asks for a name when there is no size, and for the rest of a size', () => {
    expect(refusal({ ...input, name: ' ' })).toBe('Give the product a name');
    for (const key of Object.keys(size)) {
      expect(refusal({ ...input, ...size, [key]: null }), key).toBe('A stud needs its diameter, length, thread and grade');
    }
  });

  it.each(['P0007', 'p7', 'P123456'])('refuses %s as an own code: it would be taken for an ID', (code) => {
    expect(refusal({ ...input, sku_code: code })).toBe('Codes like P0007 are product IDs, given automatically: use another code');
  });

  it('takes an own code, and none', () => {
    expect(studItemInput.parse({ ...input, sku_code: ' nut-12 ' }).sku_code).toBe('NUT-12');
    expect(studItemInput.parse({ ...input, sku_code: '' }).sku_code).toBeNull();
    expect(refusal({ ...input, sku_code: 'has space' })).toMatch(/letters/);
  });
});

describe('the weight of a product without a size', () => {
  const weighed = { diameter_mm: null, length_mm: null, manual_unit_weight_kg: '0.0125' };

  it('is what somebody weighed', () => {
    expect(weightForPieces(weighed, 8)).toBe('0.100000');
    expect(wholePiecesForWeight(weighed, '1')).toBe(80);
  });

  it('is never guessed', () => {
    for (const spec of [{ ...weighed, manual_unit_weight_kg: null }, { diameter_mm: null, length_mm: null }, { ...weighed, diameter_mm: '8' }, { ...weighed, length_mm: '45' }, { ...weighed, manual_unit_weight_kg: '0' }]) {
      expect(() => weightForPieces(spec, 1), JSON.stringify(spec)).toThrow();
      expect(() => wholePiecesForWeight(spec, '1'), JSON.stringify(spec)).toThrow();
    }
  });
});
