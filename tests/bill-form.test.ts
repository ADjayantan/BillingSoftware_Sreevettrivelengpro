// Products and the GST % on a bill being typed (specs/company-products.md). Pure.
import { describe, expect, it } from 'vitest';
import * as f from '@/lib/bill-form';
import { buildSyncPayload, composeBill } from '@/lib/bill-draft';
import { newCustomer } from '@/lib/customer-form';
import { billDraft } from '@/lib/schemas/invoices';
import type { Customer, StudItem } from '@/lib/schemas/masters';

const nut: StudItem = {
  id: '00000000-0000-4000-8000-00000000000a', product_no: 2, name: 'Hex nut M12 GI', sku_code: 'P0002', search_text: 'HEX NUT M12 GI P0002',
  diameter_mm: null, length_mm: null, thread_type: null, material_grade: null, hsn_sac: '731816', gst_rate_percent: '18.00',
  unit_weight_kg: null, unit_weight_is_manual: false, default_rate_per_piece: '4.500000', default_rate_per_kg: null, is_active: true,
};
const stud: StudItem = {
  ...nut, id: '00000000-0000-4000-8000-00000000000b', product_no: 1, name: null, sku_code: 'MS-M8-45-FT', search_text: 'MS-M8-45-FT M8X45 MS',
  diameter_mm: '8.000', length_mm: '45.00', thread_type: 'Full thread', material_grade: 'MS', hsn_sac: '731815', gst_rate_percent: '5.00',
  unit_weight_kg: '0.017756', default_rate_per_piece: '3.100000', default_rate_per_kg: '165.000000',
};
const plating: StudItem = { ...nut, id: '00000000-0000-4000-8000-00000000000c', product_no: 3, name: 'Zinc plating', sku_code: 'P0003', hsn_sac: '998873', gst_rate_percent: '12.00', default_rate_per_piece: null, default_rate_per_kg: '22.000000' };

const customer: Customer = { id: '00000000-0000-4000-8000-00000000000d', name: 'Murugan', gstin: null, phone: null, state_code: '33', is_sez: false, credit_days: 0, address: null, opening_balance: '0.00', is_active: true };
const TEMP = 'OFFLINE-00000000-0000-4000-8000-000000000000';
const blank = (key = 1, type: f.BillType = 'supply') => f.blankLine(key, type);
const bill = (lines: f.FormLine[], type: f.BillType = 'supply'): f.BillForm => ({ ...f.newBill(TEMP, '2026-11-23', type), customer, lines });
const problem = (lines: f.FormLine[], type: f.BillType = 'supply'): string | null => {
  const preview = f.previewBill(bill(lines, type));
  return 'problem' in preview ? preview.problem : null;
};
/** As the screen does it: change one line, keep an empty one at the end. */
const change = (lines: f.FormLine[], key: number, how: (line: f.FormLine) => f.FormLine): f.FormLine[] =>
  f.withTrailingBlank(lines.map((line) => (line.key === key ? how(line) : line)), 'supply');
const gstOf = (lines: f.FormLine[]): string[] => lines.map((line) => line.gst);

describe('GST % is typed by a person', () => {
  it('is empty on a new bill, and the bill cannot be saved without it', () => {
    expect(f.newBill(TEMP, '2026-11-23').lines[0]).toMatchObject({ gst: '', gstFrom: '' });
    const typed = { ...blank(), text: 'Special bolt', quantity: '10', rate: '5' };
    expect(problem([typed])).toBe('Line 1 needs its GST %');
    expect(problem([typed], 'job_work')).toBe('Line 1 needs its GST %');
    expect(problem([f.typeGst(typed, '18')])).toBeNull();
    expect(problem([f.typeGst(typed, '18'), { ...typed, key: 2 }])).toBe('Line 2 needs its GST %');
  });

  it.each([['18', '18'], ['18%', '18'], [' 18 % ', '18'], ['2.5', '2.5'], ['0', '0']])('reads %j as %s', (typed, gst) => {
    const line = f.typeGst({ ...blank(), text: 'x', quantity: '1', rate: '1' }, typed);
    expect(line).toMatchObject({ gst, gstFrom: 'hand' });
    expect(problem([line])).toBeNull();
  });

  it.each(['abc', '118', '18.555', '-5', '1e1', '1,8', '18.'])('refuses %j in words', (typed) => {
    expect(problem([f.typeGst({ ...blank(), text: 'x', quantity: '1', rate: '1' }, typed)])).toBe('Line 1: GST % is a number from 0 to 100');
  });

  it('passes from a hand-typed line to the empty line below, while that one is untouched', () => {
    let lines = [blank()];
    lines = change(lines, 1, (line) => ({ ...line, text: 'Cutting', quantity: '1', rate: '10' }));
    expect(gstOf(lines)).toEqual(['', '']);
    for (const typed of ['1', '18']) lines = change(lines, 1, (line) => f.typeGst(line, typed));
    expect(gstOf(lines)).toEqual(['18', '18']);
    lines = change(lines, 1, (line) => f.typeGst(line, '5'));
    expect(gstOf(lines)).toEqual(['5', '5']);
    lines = change(lines, 1, (line) => f.typeGst(line, ''));
    expect(gstOf(lines)).toEqual(['', '']);
  });

  it('does not change a line that is already being typed', () => {
    let lines = change([blank()], 1, (line) => f.typeGst({ ...line, text: 'One', quantity: '1', rate: '1' }, '18'));
    lines = change(lines, 2, (line) => ({ ...line, text: 'Two' }));
    expect(gstOf(lines)).toEqual(['18', '18', '18']); // and on down a ten-line labour bill
    lines = change(lines, 1, (line) => f.typeGst(line, '5'));
    expect(gstOf(lines)).toEqual(['5', '18', '18']);
    lines = change(lines, 3, (line) => f.typeGst(line, '12'));
    lines = change(lines, 2, (line) => f.typeGst(line, '28'));
    expect(gstOf(lines)).toEqual(['5', '28', '12']); // typed there by hand: stays
  });

  it('is not copied down from a product', () => {
    const lines = change([blank()], 1, (line) => f.pickStud(line, nut, 'supply'));
    expect(gstOf(lines)).toEqual(['18', '']);
  });
});

describe('a product fills its line', () => {
  it('with name, HSN, GST %, unit and rate', () => {
    expect(f.pickStud(blank(), nut, 'supply')).toMatchObject({ stud: nut, text: 'Hex nut M12 GI', hsn: '731816', gst: '18', gstFrom: 'product', unit: 'pcs', rate: '4.5' });
    expect(f.pickStud(blank(), plating, 'supply')).toMatchObject({ text: 'Zinc plating', hsn: '998873', gst: '12', unit: 'kg', rate: '22' });
    expect(problem([{ ...f.pickStud(blank(), nut, 'supply'), quantity: '10' }])).toBeNull();
  });

  it('and its GST % can be changed there', () => {
    const line = f.typeGst({ ...f.pickStud(blank(), nut, 'supply'), quantity: '10' }, '5');
    expect(line).toMatchObject({ gst: '5', gstFrom: 'hand', stud: nut });
    const preview = f.previewBill(bill([line]));
    expect(!('problem' in preview) && f.toDraft(bill([line]), preview.bill).lines).toMatchObject([{ stud_item_id: nut.id, description: 'Hex nut M12 GI', hsn_sac: '731816', gst_rate: '5', rate: '4.5' }]);
  });

  it('on a job-work bill only with its text: labour has its own SAC, GST % and rate', () => {
    const line = f.pickStud(blank(1, 'job_work'), stud, 'job_work');
    expect(line).toMatchObject({ text: 'Threading MS-M8-45-FT · M8 × 45 mm · MS · Full thread', hsn: '998873', gst: '', gstFrom: '', rate: '' });
    expect(problem([{ ...line, quantity: '5', rate: '2' }], 'job_work')).toBe('Line 1 needs its GST %');
  });

  it('on a job-work bill with everything when it is labour itself', () => {
    expect(f.pickStud(blank(1, 'job_work'), plating, 'job_work')).toMatchObject({ text: 'Zinc plating', hsn: '998873', gst: '12', gstFrom: 'product', unit: 'kg', rate: '22' });
  });

  it('and leaves nothing of the product picked before it', () => {
    const first = { ...f.pickStud(blank(), stud, 'supply'), quantity: '10' };
    const noRate = { ...nut, default_rate_per_piece: null };
    expect(f.pickStud(first, noRate, 'supply')).toMatchObject({ stud: noRate, quantity: '10', hsn: '731816', gst: '18', rate: '' });
    const labour = { ...f.pickStud(blank(1, 'job_work'), plating, 'job_work'), quantity: '10' };
    expect(f.pickStud(labour, stud, 'job_work')).toMatchObject({ hsn: '998873', gst: '', gstFrom: '', rate: '' });
    const agreed = f.typeGst({ ...f.pickStud(blank(1, 'job_work'), stud, 'job_work'), rate: '12' }, '18');
    expect(f.pickStud(agreed, { ...stud, sku_code: 'OTHER' }, 'job_work')).toMatchObject({ rate: '12', gst: '18', gstFrom: 'hand' }); // the labour terms were typed
  });

  it('keeps a rate typed before it was picked when it has none of its own', () => {
    expect(f.pickStud({ ...blank(), text: 'hex', rate: '9' }, { ...nut, default_rate_per_piece: null }, 'supply').rate).toBe('9');
  });
});

describe('typing over a product', () => {
  const picked = (): f.FormLine => ({ ...f.pickStud(blank(), nut, 'supply'), quantity: '10' });

  it.each(['W', 'H', 'Washer M16', '3'])('with %j makes it a hand-typed line: nothing of the product stays', (text) => {
    expect(f.typeText(picked(), text, 'supply')).toEqual({ ...blank(), text, quantity: '10' });
  });

  it('with nothing empties the line', () => {
    expect(f.isBlank({ ...f.typeText(picked(), '', 'supply'), quantity: '' })).toBe(true);
    expect(f.typeText(picked(), '', 'supply')).toMatchObject({ stud: null, gst: '', rate: '' });
  });

  it.each(['Hex nut M12 GI zinc', 'Hex nut M12 G', 'Hex nut GI', 'Hex nut', 'Best Hex nut M12 GI'])('keeps it when the text is only edited (%j)', (text) => {
    expect(f.typeText(picked(), text, 'supply')).toEqual({ ...picked(), text });
  });

  it('keeps it through every backspace, until the text is gone', () => {
    let line: f.FormLine = picked();
    while (line.text.length > 1) {
      line = f.typeText(line, line.text.slice(0, -1), 'supply');
      expect(line.stud, line.text).toBe(nut);
    }
    expect(f.typeText(line, '', 'supply').stud).toBeNull();
  });

  it('works on short names too', () => {
    const short = f.pickStud(blank(), { ...nut, name: 'Nut' }, 'supply');
    expect(f.typeText(short, 'N', 'supply').stud).toBeNull();
    expect(f.typeText(short, 'Nu', 'supply').stud).not.toBeNull();
  });

  it('keeps a GST % that was typed by hand', () => {
    expect(f.typeText(f.typeGst(picked(), '28'), 'Washer', 'supply')).toMatchObject({ stud: null, gst: '28', gstFrom: 'hand' });
  });

  it('keeps the agreed labour terms on a job-work bill', () => {
    const agreed = f.typeGst({ ...f.pickStud(blank(1, 'job_work'), stud, 'job_work'), rate: '12' }, '18');
    expect(f.typeText(agreed, 'Cutting', 'job_work')).toMatchObject({ stud: null, text: 'Cutting', hsn: '998873', rate: '12', gst: '18' });
  });

  it('never touches a line without a product', () => {
    const typed = f.typeGst({ ...blank(), text: 'Special bolt', rate: '5' }, '18');
    expect(f.typeText(typed, 'X', 'supply')).toEqual({ ...typed, text: 'X' });
  });
});

describe('a typed ID that is no product', () => {
  it.each(['45', 'P0045', 'p45', ' 45 '])('%j is never billed as a description', (text) => {
    const line = f.typeGst({ ...blank(), text, quantity: '1', rate: '1' }, '18');
    expect(problem([line])).toBe('Line 1: press Enter to pick product P0045, or type the item by name');
    expect(problem([{ ...line, quantity: '', rate: '' }])).toBe('Line 1: press Enter to pick product P0045, or type the item by name');
  });

  it('is not what a picked product or an ordinary text is taken for', () => {
    expect(problem([{ ...f.pickStud(blank(), { ...nut, name: '304' }, 'supply'), quantity: '1' }])).toBeNull();
    expect(problem([f.typeGst({ ...blank(), text: 'M12', quantity: '1', rate: '1' }, '18')])).toBeNull();
  });
});

describe('unit and weight', () => {
  it('a rate per piece never becomes a rate per kg', () => {
    const line = f.pickStud(blank(), nut, 'supply');
    expect(f.changeUnit(line, 'kg', 'supply')).toMatchObject({ unit: 'kg', rate: '' });
    expect(f.changeUnit({ ...line, rate: '4' }, 'kg', 'supply')).toMatchObject({ unit: 'kg', rate: '4' }); // a price somebody typed is theirs
    expect(f.changeUnit(f.changeUnit(line, 'kg', 'supply'), 'pcs', 'supply')).toMatchObject({ unit: 'pcs', rate: '4.5' });
    expect(f.changeUnit(f.pickStud(blank(), stud, 'supply'), 'kg', 'supply').rate).toBe('165');
    expect(f.changeUnit({ ...blank(), text: 'x', rate: '7' }, 'kg', 'supply')).toMatchObject({ unit: 'kg', rate: '7' });
  });

  it('without a size there is no weight, unless somebody gave the kg per piece', () => {
    const line = { ...f.pickStud(blank(), nut, 'supply'), quantity: '80' };
    expect(f.supporting(line)).toEqual({ pieces: null, weightKg: null });
    expect(f.supporting({ ...line, unit: 'kg' })).toEqual({ pieces: null, weightKg: null });
    const weighed = { ...nut, unit_weight_kg: '0.012500', unit_weight_is_manual: true };
    expect(f.supporting({ ...line, stud: weighed })).toEqual({ pieces: null, weightKg: '1.000000' });
    expect(f.supporting({ ...line, stud: weighed, unit: 'kg', quantity: '1' })).toEqual({ pieces: 80, weightKg: null });
    expect(f.supporting({ ...f.pickStud(blank(), stud, 'supply'), quantity: '1000' })).toEqual({ pieces: null, weightKg: '17.755857' });
  });
});

describe('supply ↔ job work', () => {
  const switched = (lines: f.FormLine[], from: f.BillType, to: f.BillType): f.FormLine[] => f.changeType(bill(lines, from), to).lines;

  it('takes the GST % of goods off labour, and brings it back', () => {
    const supply = [{ ...f.pickStud(blank(), stud, 'supply'), quantity: '10' }];
    const labour = switched(supply, 'supply', 'job_work');
    expect(labour[0]).toMatchObject({ gst: '', gstFrom: '', stud });
    expect(switched(labour, 'job_work', 'supply')[0]).toMatchObject({ gst: '5', gstFrom: 'product' });
  });

  it('takes the HSN, rate and wording of goods off labour too, and brings them back', () => {
    const supply = [{ ...f.pickStud(blank(), { ...stud, hsn_sac: '7318' }, 'supply'), quantity: '10' }];
    const labour = switched(supply, 'supply', 'job_work');
    expect(labour[0]).toMatchObject({ text: 'Threading MS-M8-45-FT · M8 × 45 mm · MS · Full thread', hsn: '998873', rate: '', quantity: '10', unit: 'pcs' });
    expect(switched(labour, 'job_work', 'supply')[0]).toEqual(supply[0]);
    const perKg = [f.changeUnit(supply[0]!, 'kg', 'supply')];
    expect(switched(switched(perKg, 'supply', 'job_work'), 'job_work', 'supply')[0]).toEqual(perKg[0]);
  });

  it('keeps the words, HSN and rate somebody typed over them', () => {
    const line = { ...f.pickStud(blank(), stud, 'supply'), text: 'Stud MS-M8-45-FT, urgent', hsn: '7326', rate: '2.9', quantity: '10' };
    expect(switched([line], 'supply', 'job_work')[0]).toMatchObject({ text: 'Stud MS-M8-45-FT, urgent', hsn: '7326', rate: '2.9' });
  });

  it('keeps an old draft’s GST % on a hand-typed line', () => {
    expect(switched([{ ...blank(), text: 'By hand', quantity: '1', rate: '1', gst: '18' }], 'supply', 'job_work')[0]).toMatchObject({ gst: '18', hsn: '998873' });
  });

  it('leaves what a person typed', () => {
    const typed = [f.typeGst({ ...f.pickStud(blank(), stud, 'supply'), quantity: '10' }, '12'), f.typeGst({ ...blank(2), text: 'By hand', quantity: '1', rate: '1' }, '28')];
    expect(gstOf(switched(typed, 'supply', 'job_work'))).toEqual(['12', '28', '28']); // the last is the empty line
  });

  it('keeps the GST % of labour on both', () => {
    const line = [{ ...f.pickStud(blank(), plating, 'supply'), quantity: '10' }];
    expect(gstOf(switched(line, 'supply', 'job_work'))).toEqual(['12', '']);
  });

  it('keeps the hand-typed GST % on the empty line too', () => {
    const lines = change([blank()], 1, (line) => f.typeGst({ ...line, text: 'One', quantity: '1', rate: '1' }, '18'));
    expect(gstOf(switched(lines, 'supply', 'job_work'))).toEqual(['18', '18']);
  });
});

describe('a draft of the version before', () => {
  it('opens with its GST % and its stud, and asks for GST % on the next line only', () => {
    const oldStud: Partial<StudItem> = { ...stud };
    for (const added of ['product_no', 'name', 'search_text'] as const) delete oldStud[added];
    const oldLine = { key: 1, stud: oldStud, text: 'Stud MS-M8-45-FT', hsn: '731815', gst: '18', unit: 'pcs', quantity: '1000', rate: '3.1' };
    const revived = f.reviveForm({ tempId: TEMP, type: 'supply', customer, lines: [oldLine, { key: 2, stud: null, text: '', hsn: '731815', gst: '18', unit: 'pcs', quantity: '', rate: '' }] }, '2026-11-23');
    expect(revived?.lines).toMatchObject([
      { gst: '18', gstFrom: '', stud: { product_no: 0, name: null, sku_code: 'MS-M8-45-FT' } },
      { gst: '', gstFrom: '', text: '' },
    ]);
    if (!revived) throw new Error('not revived');
    expect(f.supporting(revived.lines[0]!)).toEqual({ pieces: null, weightKg: '17.755857' });
    expect('bill' in f.previewBill(revived)).toBe(true);
  });
});

describe('where the cursor goes next', () => {
  const full = (key: number): f.FormLine => f.typeGst({ ...blank(key), text: 'Stud', quantity: '50', rate: '12' }, '18');
  const at = (over: Partial<f.BillForm>) => f.firstUnfinished({ ...bill([blank()]), ...over });

  it('is the customer, then the first box of the items that is still empty', () => {
    expect(at({ customer: null })).toEqual({ place: 'customer' });
    expect(at({})).toEqual({ place: 'line', key: 1, box: 'text' });
    for (const box of ['text', 'quantity', 'rate', 'gst'] as const) {
      expect(at({ lines: [full(1), { ...full(2), [box]: '' }, blank(3)] })).toEqual({ place: 'line', key: 2, box });
    }
    expect(at({ lines: [full(1), { ...full(2), text: 'P0099' }, blank(3)] })).toEqual({ place: 'line', key: 2, box: 'text' });
    expect(at({ lines: [f.typeGst(full(1), '118'), blank(2)] })).toEqual({ place: 'line', key: 1, box: 'gst' });
  });

  it('is packing once the items are finished', () => {
    expect(at({ lines: [full(1), blank(2)] })).toEqual({ place: 'packing' });
  });

  it('is the address when the bill needs one', () => {
    expect(at({ lines: [{ ...full(1), rate: '1000' }, blank(2)] })).toEqual({ place: 'address' });
  });
});

describe('Rule 46: ₹50,000 and no address', () => {
  const line = (rate: string): f.FormLine => f.typeGst({ ...blank(), text: 'Stud', quantity: '100', rate }, '18');
  const says = (over: Partial<f.BillForm>) => {
    const preview = f.previewBill({ ...bill([line('500')]), ...over });
    return 'problem' in preview ? preview.problem : null;
  };

  it('is said before the bill is saved, at the very rupee the books refuse it', () => {
    expect(says({})).toBe('A bill of ₹50,000 or more needs the customer’s address');
    expect(says({ lines: [line('499.99')] })).toBeNull();
    expect(says({ lines: [line('499.99')], packing: '1' })).toBe('A bill of ₹50,000 or more needs the customer’s address');
    expect(says({ lines: [line('499.99')], freight: '1', deliveryTaxable: false })).toBe('A bill of ₹50,000 or more needs the customer’s address');
    expect(says({ lines: [line('499.99')], freight: '300', freightPaidBy: 'buyer_to_pay' })).toBeNull(); // the driver's money is not the bill's
  });

  it('still shows the total: only the address is missing', () => {
    const preview = f.previewBill(bill([line('500')]));
    expect('problem' in preview && preview.bill?.detail.amounts.grand_total_paise).toBe(5_900_000);
    const none = f.previewBill({ ...bill([line('500')]), customer: null });
    expect('problem' in none && none.bill).toBeUndefined();
  });

  it('does not stop a customer with an address', () => {
    expect(says({ customer: { ...customer, address: 'SIDCO, Coimbatore' } })).toBeNull();
  });

  it('agrees with the total the bill would have', () => {
    const preview = f.previewBill({ ...bill([line('500')]), customer: { ...customer, address: 'x' } });
    expect(!('problem' in preview) && preview.bill.detail.amounts.taxable_value_paise).toBe(5_000_000);
  });
});

describe('a customer being typed inside the bill', () => {
  const ID = '00000000-0000-4000-8000-0000000000bb';

  it('is part of the bill, so a crash keeps it, half typed', () => {
    const form: f.BillForm = { ...f.newBill(TEMP, '2026-11-23'), customerText: 'Sri Balaji', newCustomer: { ...newCustomer(ID, 'Sri Balaji'), phone: '98765' } };
    expect(f.isEmptyForm(form)).toBe(false);
    expect(f.reviveForm(JSON.parse(JSON.stringify(form)), '2026-11-24')).toMatchObject({ customer: null, newCustomer: { id: ID, name: 'Sri Balaji', phone: '98765' } });
  });

  it('is completed when an older version saved less of it, and dropped when it is rubbish', () => {
    expect(f.reviveForm({ tempId: TEMP, type: 'supply', lines: [], newCustomer: { id: ID, name: 'Half' } }, '2026-11-24')?.newCustomer).toEqual({ ...newCustomer(ID, 'Half') });
    for (const rubbish of [undefined, null, 3, {}, { name: 'no id' }, { id: 'nope', name: 'x' }]) {
      expect(f.reviveForm({ tempId: TEMP, type: 'supply', lines: [], newCustomer: rubbish }, '2026-11-24')?.newCustomer).toBeNull();
    }
  });

  it('takes nothing away from the bill when it is used', () => {
    const typed = { ...bill([{ ...blank(), text: 'Studs', quantity: '50', rate: '12' }]), customer: null, customerText: 'Sri Balaji', newCustomer: newCustomer(ID, 'Sri Balaji'), packing: '40', freight: '300', freightPaidBy: 'buyer_to_pay' as const, notes: 'urgent' };
    const used = f.takeCustomer(typed, customer);
    expect(used).toEqual({ ...typed, customer, customerText: 'Murugan', newCustomer: null, dueDate: null });
  });
});

describe('dispatch details that are behind More details', () => {
  const empty = bill([blank()]);
  const draftOf = (form: f.BillForm) => {
    const full = { ...form, lines: [f.typeGst({ ...blank(), text: 'Stud', quantity: '50', rate: '12' }, '18')] };
    const preview = f.previewBill(full);
    if ('problem' in preview) throw new Error(preview.problem);
    return f.toDraft(full, preview.bill);
  };

  it('are shown by themselves once there is something in them', () => {
    expect(f.hasDispatchDetails(empty)).toBe(false);
    expect(f.hasDispatchDetails({ ...empty, freight: '300', freightPaidBy: 'buyer_to_pay', packing: '40', paid: '10' })).toBe(false);
    for (const change of [{ vehicle_no: 'TN38' }, { driver_name: 'Kumar' }, { driver_phone: '98' }, { lr_number: '1' }, { delivery_address: 'x' }, { status: 'packed' }, { transport_mode: 'courier' }]) {
      expect(f.hasDispatchDetails({ ...empty, transport: { ...empty.transport, ...change } })).toBe(true);
    }
    expect(f.hasDispatchDetails({ ...empty, notes: 'urgent' })).toBe(true);
  });

  it('goods whose driver the customer pays do not go in our own vehicle, unless somebody says so', () => {
    expect(f.transportOf(empty).transport_mode).toBe('own_vehicle');
    const toPay: f.BillForm = { ...empty, freightPaidBy: 'buyer_to_pay' };
    expect(f.transportOf(toPay).transport_mode).toBe('transporter');
    expect(draftOf(toPay).delivery).toMatchObject({ transport_mode: 'transporter', status: 'pending' });
    expect(draftOf(empty).delivery).toMatchObject({ transport_mode: 'own_vehicle' });
    expect(f.transportOf({ ...toPay, transport: { ...empty.transport, transport_mode: 'own_vehicle' } }).transport_mode).toBe('own_vehicle');
    expect(f.transportOf({ ...toPay, freightPaidBy: 'seller' }).transport_mode).toBe('own_vehicle'); // chosen by mistake and taken back
  });

  it('typing a vehicle number is not choosing how the goods go', () => {
    const typed = f.changeTransport(empty, { ...f.transportOf(empty), vehicle_no: 'TN38AB1234' });
    expect(typed.transport).toMatchObject({ vehicle_no: 'TN38AB1234', transport_mode: '' });
    expect(f.transportOf({ ...typed, freightPaidBy: 'buyer_to_pay' }).transport_mode).toBe('transporter');
    const chosen = f.changeTransport(empty, { ...f.transportOf(empty), transport_mode: 'courier' });
    expect(f.transportOf({ ...chosen, freightPaidBy: 'buyer_to_pay' }).transport_mode).toBe('courier');
    const back = f.changeTransport(chosen, { ...f.transportOf(chosen), transport_mode: 'own_vehicle' });
    expect(back.transport.transport_mode).toBe('own_vehicle'); // somebody did choose it
  });

  it('a bill saved by an older version keeps the transport it had', () => {
    const old = f.reviveForm({ tempId: TEMP, type: 'supply', lines: [], freightPaidBy: 'buyer_to_pay', transport: { transport_mode: 'own_vehicle' } }, '2026-11-24');
    expect(old && f.transportOf(old).transport_mode).toBe('own_vehicle');
  });
});

describe('the buyer’s order (P.O.)', () => {
  const line = f.typeGst({ ...blank(), text: 'Stud', quantity: '50', rate: '12' }, '18');
  const draftOf = (change: Partial<f.BillForm>) => {
    const form = { ...bill([line]), ...change };
    const preview = f.previewBill(form);
    if ('problem' in preview) throw new Error(preview.problem);
    return f.toDraft(form, preview.bill);
  };
  const payloadOf = (draft: unknown) => {
    const parsed = billDraft.parse(draft);
    return buildSyncPayload(parsed, composeBill(parsed, customer));
  };

  it('goes with the bill', () => {
    const draft = draftOf({ poNo: ' 4500012/A ', poDate: '2026-11-18' });
    expect(billDraft.parse(draft)).toMatchObject({ po_no: '4500012/A', po_date: '2026-11-18' });
    expect(payloadOf(draft)).toMatchObject({ po_no: '4500012/A', po_date: '2026-11-18' });
    expect(payloadOf(draftOf({ poNo: 'Phone' }))).toMatchObject({ po_no: 'Phone', po_date: null });
  });

  it('is left out altogether when there is none: the bill must stay the one that was sent before', () => {
    for (const none of [{}, { poNo: '', poDate: '' }, { poNo: '   ', poDate: '' }]) {
      const payload = payloadOf(draftOf(none));
      expect(Object.keys(payload)).not.toContain('po_no');
      expect(Object.keys(payload)).not.toContain('po_date');
    }
  });

  it('a date left over from a number that was taken away is not sent', () => {
    expect(draftOf({ poNo: '', poDate: '2026-11-18' })).toMatchObject({ po_no: '', po_date: null });
  });

  it('a bill queued by the version before is still good, and is sent as it was', () => {
    const { po_no, po_date, ...old } = draftOf({});
    expect([po_no, po_date]).toEqual(['', null]);
    expect(billDraft.parse(old)).toMatchObject({ po_no: null, po_date: null });
    expect(payloadOf(old)).toEqual(payloadOf(draftOf({})));
  });

  it('refuses a date without a number and a number that is too long', () => {
    expect(billDraft.safeParse({ ...draftOf({}), po_date: '2026-11-18' }).success).toBe(false);
    expect(billDraft.safeParse({ ...draftOf({}), po_no: 'x'.repeat(41) }).success).toBe(false);
    expect(billDraft.safeParse({ ...draftOf({}), po_no: 'A', po_date: '18.11.2026' }).success).toBe(false);
  });

  it('is kept with the draft, and alone makes it worth keeping', () => {
    const form = { ...f.newBill(TEMP, '2026-11-23'), poNo: '45' };
    expect(f.isEmptyForm(form)).toBe(false);
    expect(f.isEmptyForm(f.newBill(TEMP, '2026-11-23'))).toBe(true);
    expect(f.reviveForm(JSON.parse(JSON.stringify(form)), '2026-11-24')).toMatchObject({ poNo: '45', poDate: '' });
    expect(f.reviveForm({ tempId: TEMP, type: 'supply', lines: [] }, '2026-11-24')).toMatchObject({ poNo: '', poDate: '' });
  });
});
