'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Field, Notice } from '@/components/field';
import { Icon } from '@/components/icon';
import { Pill } from '@/components/pill';
import { useAltN } from '@/components/use-alt-n';
import { api } from '@/lib/api-client';
import { formatDate } from '@/lib/india';
import { decimalToPaise, formatInr, formatPaise } from '@/lib/money';
import {
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_LABELS,
  SUPPLIER_CATEGORIES,
  SUPPLIER_CATEGORY_LABELS,
  type ExpenseCategory,
  type ExpensePaymentMode,
  type ExpenseRow,
  type SupplierCategory,
  type SupplierRow,
} from '@/lib/schemas/expenses';

const MODE_LABELS: Record<ExpensePaymentMode, string> = {
  bank_transfer: 'Bank transfer',
  upi: 'UPI',
  cash: 'Cash',
  cheque: 'Cheque',
  credit: 'On credit (pay later)',
};

export function ExpensesScreen({
  initialExpenses,
  initialSuppliers,
  today,
  startOpen,
}: {
  initialExpenses: ExpenseRow[];
  initialSuppliers: SupplierRow[];
  today: string;
  startOpen: boolean;
}) {
  const router = useRouter();
  const [expenses, setExpenses] = useState<ExpenseRow[]>(initialExpenses);
  const [suppliers, setSuppliers] = useState<SupplierRow[]>(initialSuppliers);
  const [tab, setTab] = useState<'expenses' | 'suppliers'>('expenses');
  const [openExpenseForm, setOpenExpenseForm] = useState<boolean>(startOpen || initialExpenses.length === 0);
  const [openSupplierForm, setOpenSupplierForm] = useState<boolean>(false);

  // Expense form state
  const [expenseDate, setExpenseDate] = useState<string>(today);
  const [category, setCategory] = useState<ExpenseCategory>('raw_material');
  const [supplierId, setSupplierId] = useState<string>('');
  const [supplierName, setSupplierName] = useState<string>('');
  const [billNo, setBillNo] = useState<string>('');
  const [description, setDescription] = useState<string>('');
  const [materialGrade, setMaterialGrade] = useState<string>('');
  const [weightKg, setWeightKg] = useState<string>('');
  const [taxableAmount, setTaxableAmount] = useState<string>('');
  const [gstAmount, setGstAmount] = useState<string>('0');
  const [paymentMode, setPaymentMode] = useState<ExpensePaymentMode>('bank_transfer');
  const [paymentStatus, setPaymentStatus] = useState<'paid' | 'unpaid'>('paid');

  // Supplier form state
  const [newSupName, setNewSupName] = useState<string>('');
  const [newSupGstin, setNewSupGstin] = useState<string>('');
  const [newSupPhone, setNewSupPhone] = useState<string>('');
  const [newSupCategory, setNewSupCategory] = useState<SupplierCategory>('raw_material');
  const [newSupNotes, setNewSupNotes] = useState<string>('');

  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);

  useAltN(() => {
    setTab('expenses');
    setOpenExpenseForm(true);
    setError(null);
  });

  function onPickSupplier(id: string): void {
    setSupplierId(id);
    const found = suppliers.find((s) => s.id === id);
    if (found) setSupplierName(found.name);
  }

  async function saveExpense(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setBanner(null);

    const res = await api<ExpenseRow>('/api/expenses', 'POST', {
      expense_date: expenseDate,
      category,
      supplier_id: supplierId || null,
      supplier_name: supplierName.trim() || null,
      bill_no: billNo.trim() || null,
      description: description.trim(),
      material_grade: materialGrade.trim() || null,
      weight_kg: weightKg.trim() || null,
      taxable_amount: taxableAmount.trim() || '0',
      gst_amount: gstAmount.trim() || '0',
      payment_mode: paymentMode,
      payment_status: paymentMode === 'credit' ? 'unpaid' : paymentStatus,
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setExpenses((old) => [res.data, ...old]);
    setDescription('');
    setBillNo('');
    setMaterialGrade('');
    setWeightKg('');
    setTaxableAmount('');
    setGstAmount('0');
    setOpenExpenseForm(false);
    setBanner(`Saved ${EXPENSE_CATEGORY_LABELS[res.data.category].toLowerCase()}: ${res.data.description}.`);
    router.refresh();
  }

  async function saveSupplier(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setBanner(null);

    const res = await api<SupplierRow>('/api/suppliers', 'POST', {
      name: newSupName.trim(),
      gstin: newSupGstin.trim() || null,
      phone: newSupPhone.trim() || null,
      category: newSupCategory,
      notes: newSupNotes.trim() || null,
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setSuppliers((old) => [...old, res.data].sort((a, b) => a.name.localeCompare(b.name)));
    setSupplierId(res.data.id);
    setSupplierName(res.data.name);
    setNewSupName('');
    setNewSupGstin('');
    setNewSupPhone('');
    setNewSupNotes('');
    setOpenSupplierForm(false);
    setBanner(`Supplier ${res.data.name} saved.`);
    router.refresh();
  }

  async function markExpensePaid(expense: ExpenseRow): Promise<void> {
    setError(null);
    const res = await api<ExpenseRow>(`/api/expenses/${expense.id}`, 'PATCH', {
      payment_status: 'paid',
      payment_mode: expense.payment_mode === 'credit' ? 'bank_transfer' : expense.payment_mode,
    });
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setExpenses((old) => old.map((e) => (e.id === expense.id ? res.data : e)));
    setBanner(`Marked ${expense.description} as paid.`);
    router.refresh();
  }

  const totalPaise = expenses.reduce((acc, e) => acc + decimalToPaise(e.total_amount), 0);
  const rawMaterialPaise = expenses
    .filter((e) => e.category === 'raw_material')
    .reduce((acc, e) => acc + decimalToPaise(e.total_amount), 0);
  const rawMaterialKg = expenses
    .filter((e) => e.category === 'raw_material' && e.weight_kg)
    .reduce((acc, e) => acc + Number(e.weight_kg ?? 0), 0);
  const inputGstPaise = expenses.reduce((acc, e) => acc + decimalToPaise(e.gst_amount), 0);
  const unpaidPaise = expenses
    .filter((e) => e.payment_status === 'unpaid')
    .reduce((acc, e) => acc + decimalToPaise(e.total_amount), 0);

  return (
    <div className="grid gap-6">
      <section aria-label="Expense figures" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="card p-4">
          <p className="small-head">Total expenses</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">{formatInr(totalPaise)}</p>
          <p className="mt-0.5 text-[13.5px] text-muted">{expenses.length} entries recorded</p>
        </div>
        <div className="card p-4">
          <p className="small-head">Raw material bought</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">{formatInr(rawMaterialPaise)}</p>
          <p className="mt-0.5 text-[13.5px] text-muted">
            {rawMaterialKg > 0 ? `${rawMaterialKg.toFixed(1)} kg steel rods` : 'Steel & rod purchases'}
          </p>
        </div>
        <div className="card p-4">
          <p className="small-head">Input GST on purchases</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">{formatInr(inputGstPaise)}</p>
          <p className="mt-0.5 text-[13.5px] text-muted">ITC from supplier bills</p>
        </div>
        <div className="card p-4">
          <p className="small-head">Unpaid supplier bills</p>
          <p className={`mt-1 text-2xl font-semibold tabular-nums ${unpaidPaise > 0 ? 'text-due' : ''}`}>
            {formatInr(unpaidPaise)}
          </p>
          <p className="mt-0.5 text-[13.5px] text-muted">
            {expenses.filter((e) => e.payment_status === 'unpaid').length} bills to pay
          </p>
        </div>
      </section>

      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-2.5">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setTab('expenses')}
            className={`min-h-9 cursor-pointer rounded-[3px] px-4 text-[14px] font-semibold ${
              tab === 'expenses' ? 'bg-slate text-white' : 'text-ink-2 hover:bg-soft'
            }`}
          >
            Expenses & Purchases ({expenses.length})
          </button>
          <button
            type="button"
            onClick={() => setTab('suppliers')}
            className={`min-h-9 cursor-pointer rounded-[3px] px-4 text-[14px] font-semibold ${
              tab === 'suppliers' ? 'bg-slate text-white' : 'text-ink-2 hover:bg-soft'
            }`}
          >
            Suppliers ({suppliers.length})
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn"
            onClick={() => {
              setTab('suppliers');
              setOpenSupplierForm((v) => !v);
            }}
          >
            <Icon name="users" />
            {openSupplierForm ? 'Hide supplier form' : '+ Add supplier'}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              setTab('expenses');
              setOpenExpenseForm((v) => !v);
            }}
          >
            <Icon name="plus" />
            {openExpenseForm ? 'Hide expense form' : 'Record expense'}
          </button>
        </div>
      </div>

      {banner ? <Notice tone="info">{banner}</Notice> : null}
      {error ? <Notice tone="warn">{error}</Notice> : null}

      {openSupplierForm ? (
        <form onSubmit={(e) => void saveSupplier(e)} aria-label="New supplier" className="card grid gap-4 p-5">
          <h2 className="card-title text-lg">Add supplier</h2>
          <div className="grid gap-3.5 sm:grid-cols-4">
            <Field label="Supplier name">
              <input
                className="field"
                required
                placeholder="Coimbatore Steels & Alloys"
                value={newSupName}
                onChange={(e) => setNewSupName(e.target.value)}
              />
            </Field>
            <Field label="GSTIN (optional)">
              <input
                className="field uppercase"
                placeholder="33AABCC1234D1Z5"
                value={newSupGstin}
                onChange={(e) => setNewSupGstin(e.target.value)}
              />
            </Field>
            <Field label="Phone (optional)">
              <input
                className="field"
                inputMode="tel"
                placeholder="98422 11223"
                value={newSupPhone}
                onChange={(e) => setNewSupPhone(e.target.value)}
              />
            </Field>
            <Field label="Category">
              <select
                className="field"
                value={newSupCategory}
                onChange={(e) => setNewSupCategory(e.target.value as SupplierCategory)}
              >
                {SUPPLIER_CATEGORIES.map((cat) => (
                  <option key={cat} value={cat}>
                    {SUPPLIER_CATEGORY_LABELS[cat]}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="grid gap-3.5 sm:grid-cols-[minmax(0,1fr)_auto]">
            <Field label="Grades / notes (optional)">
              <input
                className="field"
                placeholder="Supplies EN8, SS 304 and SS 410 bright rods"
                value={newSupNotes}
                onChange={(e) => setNewSupNotes(e.target.value)}
              />
            </Field>
            <div className="flex items-end">
              <button type="submit" className="btn btn-primary" disabled={busy}>
                {busy ? 'Saving…' : 'Save supplier'}
              </button>
            </div>
          </div>
        </form>
      ) : null}

      {openExpenseForm && tab === 'expenses' ? (
        <form onSubmit={(e) => void saveExpense(e)} aria-label="Record expense" className="card grid gap-4 p-5">
          <h2 className="card-title text-lg">Record shop expense or raw material purchase</h2>
          <div className="grid gap-3.5 sm:grid-cols-4">
            <Field label="Date">
              <input
                className="field"
                type="date"
                required
                value={expenseDate}
                onChange={(e) => setExpenseDate(e.target.value)}
              />
            </Field>
            <Field label="Category">
              <select
                className="field"
                value={category}
                onChange={(e) => setCategory(e.target.value as ExpenseCategory)}
              >
                {EXPENSE_CATEGORIES.map((cat) => (
                  <option key={cat} value={cat}>
                    {EXPENSE_CATEGORY_LABELS[cat]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Saved supplier (optional)">
              <select className="field" value={supplierId} onChange={(e) => onPickSupplier(e.target.value)}>
                <option value="">— Select or type supplier name —</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Supplier / vendor name">
              <input
                className="field"
                placeholder="Vendor or shop name"
                value={supplierName}
                onChange={(e) => setSupplierName(e.target.value)}
              />
            </Field>
          </div>

          <div className="grid gap-3.5 sm:grid-cols-4">
            <Field label="What was bought / paid for" className="sm:col-span-2">
              <input
                className="field"
                required
                placeholder="SS 304 12mm bright rod bundle / Thread rolling die set / TNEB power bill"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </Field>
            <Field label="Supplier bill / invoice no.">
              <input
                className="field"
                placeholder="Optional bill no."
                value={billNo}
                onChange={(e) => setBillNo(e.target.value)}
              />
            </Field>
            <Field label="How it was paid">
              <select
                className="field"
                value={paymentMode}
                onChange={(e) => {
                  const next = e.target.value as ExpensePaymentMode;
                  setPaymentMode(next);
                  setPaymentStatus(next === 'credit' ? 'unpaid' : 'paid');
                }}
              >
                {Object.entries(MODE_LABELS).map(([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <div className="grid gap-3.5 sm:grid-cols-5">
            <Field label="Material grade (if steel)">
              <input
                className="field"
                placeholder="SS 304 / EN8 / MS"
                value={materialGrade}
                onChange={(e) => setMaterialGrade(e.target.value)}
              />
            </Field>
            <Field label="Weight in kg (optional)">
              <input
                className="field num"
                inputMode="decimal"
                placeholder="e.g. 500"
                value={weightKg}
                onChange={(e) => setWeightKg(e.target.value)}
              />
            </Field>
            <Field label="Amount before GST ₹">
              <input
                className="field num"
                inputMode="decimal"
                required
                placeholder="10000"
                value={taxableAmount}
                onChange={(e) => setTaxableAmount(e.target.value)}
              />
            </Field>
            <Field label="GST amount ₹" hint="₹0 if no GST bill">
              <input
                className="field num"
                inputMode="decimal"
                placeholder="0"
                value={gstAmount}
                onChange={(e) => setGstAmount(e.target.value)}
              />
            </Field>
            <div className="flex items-end">
              <button type="submit" className="btn btn-primary w-full" disabled={busy}>
                {busy ? 'Saving…' : 'Save expense'}
              </button>
            </div>
          </div>
        </form>
      ) : null}

      {tab === 'expenses' ? (
        <section aria-label="Expenses list" className="card overflow-x-auto p-5">
          {expenses.length === 0 ? (
            <p className="py-4 text-muted">No expenses recorded yet.</p>
          ) : (
            <table className="w-full border-collapse text-left text-[14px]">
              <thead>
                <tr className="border-b border-line text-[12.5px] font-semibold tracking-wider text-muted uppercase">
                  <th className="py-2 pr-3">Date</th>
                  <th className="py-2 pr-3">Category</th>
                  <th className="py-2 pr-3">Description & Grade</th>
                  <th className="py-2 pr-3">Supplier & Bill</th>
                  <th className="py-2 pr-3 text-right">Amount ₹</th>
                  <th className="py-2 pr-3 text-right">GST ₹</th>
                  <th className="py-2 pr-3 text-right">Total ₹</th>
                  <th className="py-2 pr-3">Status</th>
                  <th className="py-2 text-right" />
                </tr>
              </thead>
              <tbody>
                {expenses.map((exp) => (
                  <tr key={exp.id} className="border-b border-line last:border-b-0">
                    <td className="py-2.5 pr-3 whitespace-nowrap">{formatDate(exp.expense_date)}</td>
                    <td className="py-2.5 pr-3 font-semibold">{EXPENSE_CATEGORY_LABELS[exp.category]}</td>
                    <td className="py-2.5 pr-3">
                      <div>{exp.description}</div>
                      {exp.material_grade || exp.weight_kg ? (
                        <small className="text-[12.5px] text-muted">
                          {[exp.material_grade, exp.weight_kg ? `${exp.weight_kg} kg` : null].filter(Boolean).join(' · ')}
                        </small>
                      ) : null}
                    </td>
                    <td className="py-2.5 pr-3">
                      <div>{exp.supplier_name ?? '—'}</div>
                      {exp.bill_no ? <small className="text-[12.5px] text-muted">Bill {exp.bill_no}</small> : null}
                    </td>
                    <td className="num py-2.5 pr-3 text-right">{formatPaise(decimalToPaise(exp.taxable_amount))}</td>
                    <td className="num py-2.5 pr-3 text-right">{formatPaise(decimalToPaise(exp.gst_amount))}</td>
                    <td className="num py-2.5 pr-3 text-right font-semibold">
                      {formatPaise(decimalToPaise(exp.total_amount))}
                    </td>
                    <td className="py-2.5 pr-3">
                      <Pill kind={exp.payment_status === 'paid' ? 'paid' : 'late'}>
                        {exp.payment_status === 'paid' ? `Paid · ${MODE_LABELS[exp.payment_mode]}` : 'Unpaid'}
                      </Pill>
                    </td>
                    <td className="py-2.5 text-right">
                      {exp.payment_status === 'unpaid' ? (
                        <button
                          type="button"
                          className="btn btn-small"
                          onClick={() => void markExpensePaid(exp)}
                        >
                          Mark paid
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      ) : (
        <section aria-label="Suppliers list" className="card overflow-x-auto p-5">
          {suppliers.length === 0 ? (
            <p className="py-4 text-muted">No suppliers saved yet. Click &ldquo;+ Add supplier&rdquo; above.</p>
          ) : (
            <table className="w-full border-collapse text-left text-[14px]">
              <thead>
                <tr className="border-b border-line text-[12.5px] font-semibold tracking-wider text-muted uppercase">
                  <th className="py-2 pr-3">Supplier Name</th>
                  <th className="py-2 pr-3">Category</th>
                  <th className="py-2 pr-3">GSTIN</th>
                  <th className="py-2 pr-3">Phone</th>
                  <th className="py-2">Notes</th>
                </tr>
              </thead>
              <tbody>
                {suppliers.map((sup) => (
                  <tr key={sup.id} className="border-b border-line last:border-b-0">
                    <td className="py-2.5 pr-3 font-semibold">{sup.name}</td>
                    <td className="py-2.5 pr-3">{SUPPLIER_CATEGORY_LABELS[sup.category]}</td>
                    <td className="py-2.5 pr-3 font-mono text-[13px]">{sup.gstin ?? '—'}</td>
                    <td className="py-2.5 pr-3">{sup.phone ?? '—'}</td>
                    <td className="py-2.5 text-muted">{sup.notes ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
    </div>
  );
}
