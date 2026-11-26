/** The state of a bill in words: one answer for every list. Pure. */
import { daysBetween } from './india';

export type StateKind = 'late' | 'due' | 'part' | 'paid' | 'off';

export interface BillState {
  kind: StateKind;
  text: string;
}

export function billState(bill: { due_date: string; payment_status: 'unpaid' | 'partial' | 'paid'; cancelled: boolean }, today: string): BillState {
  if (bill.cancelled) return { kind: 'off', text: 'Cancelled' };
  if (bill.payment_status === 'paid') return { kind: 'paid', text: 'Paid' };
  const late = daysBetween(bill.due_date, today);
  if (late > 0) return { kind: 'late', text: `${late} day${late === 1 ? '' : 's'} late` };
  if (bill.payment_status === 'partial') return { kind: 'part', text: 'Part paid' };
  return { kind: 'due', text: late === 0 ? 'Due today' : late === -1 ? 'Due tomorrow' : `Due in ${-late} days` };
}
