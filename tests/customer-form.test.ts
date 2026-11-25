// A new customer typed at the counter: what must be there, and who it may already be. Pure.
import { describe, expect, it } from 'vitest';
import { cleanGstin, customerBody, customerProblem, firstField, gstinHint, localCustomer, newCustomer, newCustomerFrom, stateOf, type CustomerForm } from '@/lib/customer-form';
import { lookAlikes, nameKey, sameName } from '@/lib/customer-match';
import { customerInput } from '@/lib/schemas/masters';

const ID = '00000000-0000-4000-8000-00000000000a';
const GSTIN = '33ABCPV1357D1ZX';
const form = (over: Partial<CustomerForm> = {}): CustomerForm => ({ ...newCustomer(ID, 'Sri Balaji Fabricators'), ...over });

describe('the form', () => {
  it('starts with the name and the defaults the owner knows', () => {
    expect(newCustomer(ID, '  Sri Balaji  ')).toMatchObject({ id: ID, name: 'Sri Balaji', registered: false, gstin: '', state: '33', creditDays: '30', openingBalance: '0', isSez: false, phone: '', address: '', more: false, differentFrom: [] });
  });

  it('opens with what was typed in the search, whatever that was', () => {
    expect(newCustomerFrom(ID, ' Sri Balaji ')).toEqual(newCustomer(ID, 'Sri Balaji'));
    expect(newCustomerFrom(ID, '33 abcpv1357d1zx')).toEqual({ ...newCustomer(ID), registered: true, gstin: GSTIN });
    expect(newCustomerFrom(ID, '33ABCPV1357D1ZY')).toEqual(newCustomer(ID, '33ABCPV1357D1ZY')); // not a GSTIN: never guessed
    for (const phone of ['98765 43210', '+91 98765-43210', '9876543210']) expect(newCustomerFrom(ID, phone)).toEqual({ ...newCustomer(ID), phone });
    expect(newCustomerFrom(ID, '3M India')).toEqual(newCustomer(ID, '3M India'));
    expect(newCustomerFrom(ID, '  ')).toEqual(newCustomer(ID));
  });

  it('puts the cursor on the first box a person has to look at', () => {
    expect(firstField(newCustomer(ID))).toBe('name');
    expect(firstField(form())).toBe('state'); // the name is there; the state is a default to be confirmed
    expect(firstField(form({ registered: true }))).toBe('gstin');
    expect(firstField(form({ registered: true, gstin: GSTIN }))).toBe('address');
    expect(firstField(form({ registered: true, gstin: GSTIN, address: 'x' }))).toBe('phone');
    expect(firstField(newCustomerFrom(ID, GSTIN))).toBe('name');
  });

  it('needs only a name and a state from an unregistered buyer', () => {
    expect(customerProblem(form())).toBeNull();
    expect(customerProblem(form({ name: ' ' }))).toMatchObject({ field: 'name' });
    const body = customerBody(form({ state: '29' }));
    expect(customerInput.parse(body)).toMatchObject({ name: 'Sri Balaji Fabricators', gstin: null, phone: null, state_code: '29', is_sez: false, credit_days: 30, address: null, opening_balance: '0', is_active: true });
    expect(body).toMatchObject({ id: ID, different_from: [] });
  });

  it('reads the state from the GSTIN, and needs an address with it', () => {
    const registered = form({ registered: true, gstin: GSTIN, state: '29' });
    expect(stateOf(registered)).toBe('33');
    expect(customerProblem(registered)).toMatchObject({ field: 'address' });
    expect(customerProblem({ ...registered, address: 'SIDCO, Coimbatore' })).toBeNull();
    expect(customerInput.parse(customerBody({ ...registered, address: 'SIDCO, Coimbatore', isSez: true }))).toMatchObject({ gstin: GSTIN, state_code: '33', is_sez: true, address: 'SIDCO, Coimbatore' });
  });

  it('sends no GSTIN and no SEZ when the buyer is not registered after all', () => {
    expect(customerBody(form({ registered: false, gstin: GSTIN, isSez: true }))).toMatchObject({ gstin: '', is_sez: false, state_code: '33' });
  });

  it.each([['', null], ['33', '13 more characters'], ['33ABCPV1357D1Z', '1 more character'], ['33ABCPV1357D1ZY', 'Not a valid GSTIN: check each character'], [GSTIN, null]])('says of the GSTIN %j: %j', (gstin, hint) => {
    expect(gstinHint(gstin)).toBe(hint);
  });

  it('reads a GSTIN however it is typed', () => {
    expect(cleanGstin(' 33 abcpv-1357.d1zx extra')).toBe(GSTIN);
    expect(customerProblem(form({ registered: true, gstin: '33ABCPV1357D1ZY', address: 'x' }))).toMatchObject({ field: 'gstin' });
    expect(customerProblem(form({ registered: true, address: 'x' }))).toMatchObject({ field: 'gstin', message: 'Type the GSTIN' });
  });

  it.each([
    ['phone', { phone: '12345' }], ['phone', { phone: 'call him' }], ['creditDays', { creditDays: '400' }], ['creditDays', { creditDays: '' }], ['creditDays', { creditDays: '1.5' }],
    ['openingBalance', { openingBalance: 'abc' }], ['openingBalance', { openingBalance: '1.234' }], ['name', { name: 'x'.repeat(121) }], ['address', { address: 'x'.repeat(501) }],
  ] as const)('points at %s when it is wrong (%j)', (field, over) => expect(customerProblem(form(over))?.field).toBe(field));

  it.each([['98765 43210'], ['+91 98765-43210'], ['']])('takes the phone %j', (phone) => {
    expect(customerProblem(form({ phone }))).toBeNull();
    expect(customerInput.safeParse(customerBody(form({ phone }))).success).toBe(true);
  });

  it('is a customer the bill can use before the books know it', () => {
    expect(localCustomer(form({ registered: true, gstin: GSTIN, address: ' SIDCO ', phone: '98765 43210', creditDays: '7', openingBalance: '-5' }))).toEqual({
      id: ID, name: 'Sri Balaji Fabricators', gstin: GSTIN, phone: '9876543210', state_code: '33', is_sez: false, credit_days: 7, address: 'SIDCO', opening_balance: '-5', is_active: true,
    });
    expect(localCustomer(form())).toMatchObject({ gstin: null, phone: null, address: null, state_code: '33' });
  });
});

describe('is it somebody we know?', () => {
  it.each([
    ['Sri Balaji Fabricators', 'SHRI BALAJI FABRICATION'], ['M/s. Vel Tools', 'Vel Tools'], ['Vel Tools (P) Ltd', 'Vel Tools Private Limited'], ['Vel Tools & Co.', 'Vel Tools'],
    ['Murugan Engg Works', 'Murugan Engineering Work'], ['Sri Balaji Fabricators', 'Sri Balagi Fabricators'], ['Murugan', 'Murugan Engineering Works'], ['முருகன் டூல்ஸ்', 'முருகன்  டூல்ஸ்'],
    ['Kovai Fasteners', 'Kovai Fastner'],
  ])('%j and %j sound alike', (a, b) => {
    expect(lookAlikes({ name: a, phone: null }, [{ id: '1', name: b, phone: null }])).toHaveLength(1);
    expect(lookAlikes({ name: b, phone: null }, [{ id: '1', name: a, phone: null }])).toHaveLength(1);
  });

  it.each([
    ['Sri Murugan Traders', 'Sri Murugan Engineering'], ['Vel Tools', 'Vel Steels'], ['Kovai Fasteners', 'Salem Fasteners'], ['ABC', 'ABD'], ['Balaji', 'Sri Vari'], ['முருகன் டூல்ஸ்', 'வேலன் டூல்ஸ்'], ['Pvt Ltd', 'The Company'],
  ])('%j and %j do not', (a, b) => expect(lookAlikes({ name: a, phone: null }, [{ id: '1', name: b, phone: null }])).toEqual([]));

  it('asks about a shared phone, however it is written', () => {
    const known = [{ id: '1', name: 'Other Works', phone: '+919876543210' }, { id: '2', name: 'Third', phone: null }];
    expect(lookAlikes({ name: 'New Party', phone: '98765 43210' }, known)).toEqual([known[0]]);
    expect(lookAlikes({ name: 'New Party', phone: null }, known)).toEqual([]);
  });

  it('does not ask again about somebody the owner has called different, nor about itself', () => {
    const known = [{ id: '1', name: 'Vel Tools', phone: null }, { id: '2', name: 'VEL TOOLS', phone: null }];
    expect(lookAlikes({ name: 'Vel Tools', phone: null }, known, ['1'])).toEqual([known[1]]);
    expect(lookAlikes({ name: 'Vel Tools', phone: null }, known, ['1', '2'])).toEqual([]);
  });

  it('calls two names the same only when nothing but punctuation, case and legal form differs', () => {
    expect([sameName('Vel Tools (P) Ltd.', 'VEL TOOLS PRIVATE LIMITED'), sameName('Vel Tools', 'Vel Tool'), sameName('Sri Balaji', 'Sri Balagi')]).toEqual([true, false, false]);
    expect(nameKey('M/s Vel Tools')).toBe('VELTOOLS');
  });
});
