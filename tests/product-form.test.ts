// What the Products page holds while a product is typed, and what it sends. Pure.
import { describe, expect, it } from 'vitest';
import { blankProduct, editProduct, productInput, setStud, unitWeight } from '@/lib/product-form';
import { studItemInput, type StudItem } from '@/lib/schemas/masters';

const nut: StudItem = {
  id: '00000000-0000-4000-8000-00000000000a', product_no: 2, name: 'Hex nut M12 GI', sku_code: 'P0002', search_text: 'HEX NUT M12 GI P0002',
  diameter_mm: null, length_mm: null, thread_type: null, material_grade: null, hsn_sac: '731816', gst_rate_percent: '18.00',
  unit_weight_kg: '0.012500', unit_weight_is_manual: true, default_rate_per_piece: '4.500000', default_rate_per_kg: null, is_active: false,
};
const stud: StudItem = {
  ...nut, id: '00000000-0000-4000-8000-00000000000b', product_no: 1, name: null, sku_code: 'MS-M8-45-FT', search_text: 'MS-M8-45-FT M8X45 MS',
  diameter_mm: '8.000', length_mm: '45.00', thread_type: 'Full thread', material_grade: 'MS', hsn_sac: '731815',
  unit_weight_kg: '0.017756', unit_weight_is_manual: false, default_rate_per_piece: '3.100000', default_rate_per_kg: '165.000000', is_active: true,
};
const typed = { ...blankProduct, name: 'Hex nut M12 GI', hsn: '731816', gst: '18' };

describe('a new product', () => {
  it('assumes nothing: no HSN, no GST %, not a stud', () => {
    expect(blankProduct).toMatchObject({ name: '', hsn: '', gst: '', ratePiece: '', rateKg: '', kg: '', code: '', isStud: false, active: true });
    expect(studItemInput.safeParse(productInput({ ...typed, gst: '' })).error?.issues[0]?.message).toBe('Type the GST %');
  });

  it('needs its name, HSN and GST % and nothing else', () => {
    expect(studItemInput.parse(productInput(typed))).toEqual({
      name: 'Hex nut M12 GI', sku_code: null, hsn_sac: '731816', gst_rate_percent: '18', is_active: true,
      diameter_mm: null, length_mm: null, thread_type: null, material_grade: null, manual_unit_weight_kg: null, default_rate_per_piece: null, default_rate_per_kg: null,
    });
  });

  it('takes 18% as 18', () => {
    expect(productInput({ ...typed, gst: ' 18 % ' }).gst_rate_percent).toBe('18');
  });

  it('has a weight only if somebody gives its kg per piece', () => {
    expect(productInput({ ...typed, kg: '0.0125' }).manual_unit_weight_kg).toBe('0.0125');
    expect(productInput(typed).manual_unit_weight_kg).toBeNull();
    expect([unitWeight({ ...typed, kg: '0.0125' }), unitWeight(typed), unitWeight({ ...typed, kg: 'abc' })]).toEqual(['0.012500', null, null]);
  });
});

describe('a stud', () => {
  const size = { diameter: '8', length: '45', thread: 'Full thread', grade: 'ms' };

  it('gets the HSN of studs offered, but only into an empty box', () => {
    expect(setStud(blankProduct, true)).toMatchObject({ isStud: true, hsn: '731815' });
    expect(setStud({ ...blankProduct, hsn: '7318' }, true).hsn).toBe('7318');
    expect(setStud(setStud(blankProduct, true), false)).toMatchObject({ isStud: false, hsn: '' }); // what was only offered goes again
    expect(setStud(setStud({ ...blankProduct, hsn: '731815' }, true), false).hsn).toBe('731815');
    expect(setStud(blankProduct, true).gst).toBe('');
  });

  it('may go without a name, and weighs what the formula says', () => {
    const form = { ...blankProduct, ...size, isStud: true, hsn: '731815', gst: '18', kg: '9' };
    expect(studItemInput.parse(productInput(form))).toMatchObject({ name: null, diameter_mm: '8', length_mm: '45', thread_type: 'Full thread', material_grade: 'MS', manual_unit_weight_kg: null });
    expect(unitWeight(form)).toBe('0.017756');
    expect(unitWeight({ ...form, length: '' })).toBeNull();
  });

  it('weighs what was measured when that is ticked', () => {
    const form = { ...typed, ...size, isStud: true, measured: true, kg: '0.02' };
    expect(productInput(form).manual_unit_weight_kg).toBe('0.02');
    expect(unitWeight(form)).toBe('0.020000');
  });

  it('is an ordinary product again when unticked: nothing of the size is sent', () => {
    const form = setStud({ ...typed, ...size, isStud: true, measured: true, kg: '0.02' }, false);
    expect(productInput(form)).toMatchObject({ diameter_mm: null, length_mm: null, thread_type: null, material_grade: null, manual_unit_weight_kg: '0.02' });
  });
});

describe('editing', () => {
  it.each([['a nut', nut], ['a stud', stud], ['a weighed stud', { ...stud, unit_weight_is_manual: true, unit_weight_kg: '0.020000' }]] as const)('sends %s back as it was', (_what, product) => {
    const sent = studItemInput.parse(productInput(editProduct(product)));
    expect(sent).toMatchObject({
      name: product.name, sku_code: product === nut ? null : product.sku_code, hsn_sac: product.hsn_sac, gst_rate_percent: product === nut ? '18' : '18',
      diameter_mm: product.diameter_mm === null ? null : '8', length_mm: product.length_mm === null ? null : '45', thread_type: product.thread_type, material_grade: product.material_grade,
      manual_unit_weight_kg: product.unit_weight_is_manual ? String(Number(product.unit_weight_kg)) : null, is_active: product.is_active,
      default_rate_per_piece: product === nut ? '4.5' : '3.1', default_rate_per_kg: product === nut ? null : '165',
    });
  });

  it('shows no own code where there is only the ID', () => {
    expect([editProduct(nut).code, editProduct(stud).code]).toEqual(['', 'MS-M8-45-FT']);
  });
});
