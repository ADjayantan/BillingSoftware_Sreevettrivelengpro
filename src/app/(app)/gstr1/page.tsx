import Link from 'next/link';
import { Icon } from '@/components/icon';
import { PageHead } from '@/components/page-head';
import { getCompany } from '@/lib/data';
import { buildGstr1Report, gstPortalDate } from '@/lib/gstr1';
import { istDate, monthName, stateLabel } from '@/lib/india';
import { formatInr, formatPaise } from '@/lib/money';
import { readMonth } from '@/lib/month-data';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

function recentMonths(todayIso: string, count = 6): string[] {
  const [y = 2026, m = 11] = todayIso.slice(0, 7).split('-').map(Number);
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(d.toISOString().slice(0, 7));
  }
  return out;
}

export default async function Gstr1Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const db = await createClient();
  const today = istDate(new Date());
  const params = await searchParams;
  const rawMonth = typeof params.month === 'string' ? params.month : '';
  const selectedMonth = /^\d{4}-(0[1-9]|1[0-2])$/.test(rawMonth) ? rawMonth : today.slice(0, 7);
  const monthFirstDay = `${selectedMonth}-01`;

  const [monthData, company] = await Promise.all([readMonth(db, monthFirstDay), getCompany(db)]);
  const report = buildGstr1Report(monthData, company?.gstin ?? null);
  const months = recentMonths(today, 6);

  return (
    <>
      <PageHead
        title={`GSTR-1 & Auditor Report · ${monthName(monthFirstDay)}`}
        note="Ready for your month-end GST filing and auditor. Built directly from issued bills — cancelled bills are excluded from tax totals and counted in Table 13."
      />

      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <nav aria-label="Choose filing month" className="flex flex-wrap items-center gap-1.5">
          {months.map((ym) => (
            <Link
              key={ym}
              href={`/gstr1?month=${ym}`}
              className={`min-h-9 rounded-[3px] border px-3 py-1.5 text-[13.5px] font-semibold ${
                ym === selectedMonth
                  ? 'border-slate bg-slate text-white'
                  : 'border-line bg-white text-ink-2 hover:bg-soft'
              }`}
            >
              {monthName(`${ym}-01`)}
            </Link>
          ))}
        </nav>

        <div className="flex flex-wrap items-center gap-2.5">
          <a className="btn btn-primary" href={`/api/gstr1?month=${selectedMonth}&format=json`}>
            <Icon name="down" />
            Download GSTR-1 JSON (GST Portal)
          </a>
          <a className="btn" href={`/api/gstr1?month=${selectedMonth}&format=csv`}>
            <Icon name="sheet" />
            Download Auditor CSV (Excel)
          </a>
          <a className="btn" href={`/api/books/${monthFirstDay}`}>
            <Icon name="drive" />
            Full monthly Excel book
          </a>
        </div>
      </div>

      <section aria-label="GSTR-1 summary totals" className="mb-7 grid grid-cols-2 gap-3.5 lg:grid-cols-5">
        <div className="card p-4">
          <p className="small-head">Issued bills</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">{report.totals.activeInvoices}</p>
          <p className="mt-0.5 text-[13.5px] text-muted">
            {report.totals.b2bInvoices} B2B · {report.totals.b2cInvoices} B2C
            {report.totals.cancelledInvoices > 0 ? ` · ${report.totals.cancelledInvoices} cancelled` : ''}
          </p>
        </div>
        <div className="card p-4">
          <p className="small-head">Taxable value</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">{formatInr(report.totals.taxablePaise)}</p>
          <p className="mt-0.5 text-[13.5px] text-muted">Before GST</p>
        </div>
        <div className="card p-4">
          <p className="small-head">CGST + SGST (Tamil Nadu)</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">
            {formatInr(report.totals.cgstPaise + report.totals.sgstPaise)}
          </p>
          <p className="mt-0.5 text-[13.5px] text-muted">
            CGST {formatPaise(report.totals.cgstPaise)} · SGST {formatPaise(report.totals.sgstPaise)}
          </p>
        </div>
        <div className="card p-4">
          <p className="small-head">IGST (Inter-state / SEZ)</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">{formatInr(report.totals.igstPaise)}</p>
          <p className="mt-0.5 text-[13.5px] text-muted">Total GST: {formatInr(report.totals.totalTaxPaise)}</p>
        </div>
        <div className="card p-4 max-lg:col-span-2">
          <p className="small-head">Total invoice value</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-accent">
            {formatInr(report.totals.invoiceValuePaise)}
          </p>
          <p className="mt-0.5 text-[13.5px] text-muted">Filing period {report.fp}</p>
        </div>
      </section>

      <div className="grid gap-8">
        <section aria-label="B2B invoices" className="card overflow-x-auto p-5">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <h2 className="card-title text-lg">1. B2B Invoices (Tables 4A, 4B, 6B — Registered buyers with GSTIN)</h2>
              <p className="text-[13.5px] text-muted">Invoice-wise details for registered customers</p>
            </div>
            <span className="text-[13.5px] font-semibold text-muted">{report.b2b.length} bills</span>
          </div>
          {report.b2b.length === 0 ? (
            <p className="py-4 text-muted">No B2B invoices with a buyer GSTIN in {monthName(monthFirstDay)}.</p>
          ) : (
            <table className="w-full border-collapse text-left text-[14px]">
              <thead>
                <tr className="border-b border-line text-[12.5px] font-semibold tracking-wider text-muted uppercase">
                  <th className="py-2 pr-3">Customer GSTIN</th>
                  <th className="py-2 pr-3">Customer</th>
                  <th className="py-2 pr-3">Invoice No.</th>
                  <th className="py-2 pr-3">Date</th>
                  <th className="py-2 pr-3">Place</th>
                  <th className="py-2 pr-3 text-right">Taxable ₹</th>
                  <th className="py-2 pr-3 text-right">CGST ₹</th>
                  <th className="py-2 pr-3 text-right">SGST ₹</th>
                  <th className="py-2 pr-3 text-right">IGST ₹</th>
                  <th className="py-2 text-right">Total ₹</th>
                </tr>
              </thead>
              <tbody>
                {report.b2b.map((row) => (
                  <tr key={row.id} className="border-b border-line last:border-b-0">
                    <td className="py-2.5 pr-3 font-mono text-[13px]">{row.gstin}</td>
                    <td className="py-2.5 pr-3 font-semibold">{row.customerName}</td>
                    <td className="py-2.5 pr-3">
                      <Link href={`/invoices/${row.id}`} className="font-semibold text-accent underline">
                        {row.invoiceNo}
                      </Link>
                    </td>
                    <td className="py-2.5 pr-3 whitespace-nowrap">{gstPortalDate(row.invoiceDate)}</td>
                    <td className="py-2.5 pr-3 whitespace-nowrap">
                      {row.placeOfSupply}-{stateLabel(row.placeOfSupply)}
                    </td>
                    <td className="num py-2.5 pr-3 text-right">{formatPaise(row.taxablePaise)}</td>
                    <td className="num py-2.5 pr-3 text-right">{formatPaise(row.cgstPaise)}</td>
                    <td className="num py-2.5 pr-3 text-right">{formatPaise(row.sgstPaise)}</td>
                    <td className="num py-2.5 pr-3 text-right">{formatPaise(row.igstPaise)}</td>
                    <td className="num py-2.5 text-right font-semibold">{formatPaise(row.invoiceValuePaise)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section aria-label="B2CS summary" className="card overflow-x-auto p-5">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <h2 className="card-title text-lg">2. B2CS Summary (Table 7 — Unregistered buyers)</h2>
              <p className="text-[13.5px] text-muted">Grouped by Place of Supply and GST Rate %</p>
            </div>
            <span className="text-[13.5px] font-semibold text-muted">{report.totals.b2cInvoices} bills</span>
          </div>
          {report.b2c.length === 0 ? (
            <p className="py-4 text-muted">No unregistered (B2C) invoices in {monthName(monthFirstDay)}.</p>
          ) : (
            <table className="w-full border-collapse text-left text-[14px]">
              <thead>
                <tr className="border-b border-line text-[12.5px] font-semibold tracking-wider text-muted uppercase">
                  <th className="py-2 pr-3">Place of Supply</th>
                  <th className="py-2 pr-3 text-right">GST Rate %</th>
                  <th className="py-2 pr-3 text-right">Bills</th>
                  <th className="py-2 pr-3 text-right">Taxable Value ₹</th>
                  <th className="py-2 pr-3 text-right">CGST ₹</th>
                  <th className="py-2 pr-3 text-right">SGST ₹</th>
                  <th className="py-2 text-right">IGST ₹</th>
                </tr>
              </thead>
              <tbody>
                {report.b2c.map((row) => (
                  <tr key={`${row.placeOfSupply}-${row.ratePercent}`} className="border-b border-line last:border-b-0">
                    <td className="py-2.5 pr-3 font-semibold">
                      {row.placeOfSupply}-{stateLabel(row.placeOfSupply)}
                    </td>
                    <td className="num py-2.5 pr-3 text-right">{row.ratePercent}%</td>
                    <td className="num py-2.5 pr-3 text-right">{row.invoicesCount}</td>
                    <td className="num py-2.5 pr-3 text-right">{formatPaise(row.taxablePaise)}</td>
                    <td className="num py-2.5 pr-3 text-right">{formatPaise(row.cgstPaise)}</td>
                    <td className="num py-2.5 pr-3 text-right">{formatPaise(row.sgstPaise)}</td>
                    <td className="num py-2.5 text-right">{formatPaise(row.igstPaise)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section aria-label="HSN and SAC summary" className="card overflow-x-auto p-5">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <h2 className="card-title text-lg">3. HSN / SAC Summary (Table 12)</h2>
              <p className="text-[13.5px] text-muted">Outward supplies grouped by HSN/SAC code, unit and GST rate</p>
            </div>
            <span className="text-[13.5px] font-semibold text-muted">{report.hsn.length} HSN rows</span>
          </div>
          {report.hsn.length === 0 ? (
            <p className="py-4 text-muted">No billed items in {monthName(monthFirstDay)}.</p>
          ) : (
            <table className="w-full border-collapse text-left text-[14px]">
              <thead>
                <tr className="border-b border-line text-[12.5px] font-semibold tracking-wider text-muted uppercase">
                  <th className="py-2 pr-3">HSN / SAC</th>
                  <th className="py-2 pr-3">Description</th>
                  <th className="py-2 pr-3">UQC</th>
                  <th className="py-2 pr-3 text-right">Total Qty</th>
                  <th className="py-2 pr-3 text-right">Rate %</th>
                  <th className="py-2 pr-3 text-right">Taxable ₹</th>
                  <th className="py-2 pr-3 text-right">CGST ₹</th>
                  <th className="py-2 pr-3 text-right">SGST ₹</th>
                  <th className="py-2 pr-3 text-right">IGST ₹</th>
                  <th className="py-2 text-right">Total Value ₹</th>
                </tr>
              </thead>
              <tbody>
                {report.hsn.map((row) => (
                  <tr key={`${row.hsnSac}-${row.uqc}-${row.ratePercent}`} className="border-b border-line last:border-b-0">
                    <td className="py-2.5 pr-3 font-mono font-semibold">{row.hsnSac}</td>
                    <td className="py-2.5 pr-3">{row.description}</td>
                    <td className="py-2.5 pr-3 text-[13px] text-muted">{row.uqc}</td>
                    <td className="num py-2.5 pr-3 text-right font-semibold">{row.totalQuantity}</td>
                    <td className="num py-2.5 pr-3 text-right">{row.ratePercent}%</td>
                    <td className="num py-2.5 pr-3 text-right">{formatPaise(row.taxablePaise)}</td>
                    <td className="num py-2.5 pr-3 text-right">{formatPaise(row.cgstPaise)}</td>
                    <td className="num py-2.5 pr-3 text-right">{formatPaise(row.sgstPaise)}</td>
                    <td className="num py-2.5 pr-3 text-right">{formatPaise(row.igstPaise)}</td>
                    <td className="num py-2.5 text-right font-semibold">{formatPaise(row.totalValuePaise)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section aria-label="Documents issued summary" className="card overflow-x-auto p-5">
          <div className="mb-3">
            <h2 className="card-title text-lg">4. Documents Issued (Table 13)</h2>
            <p className="text-[13.5px] text-muted">Serial number range and cancelled count for the month</p>
          </div>
          {report.docs.length === 0 ? (
            <p className="py-4 text-muted">No documents issued in {monthName(monthFirstDay)}.</p>
          ) : (
            <table className="w-full border-collapse text-left text-[14px]">
              <thead>
                <tr className="border-b border-line text-[12.5px] font-semibold tracking-wider text-muted uppercase">
                  <th className="py-2 pr-3">Nature of Document</th>
                  <th className="py-2 pr-3">Sr. No. From</th>
                  <th className="py-2 pr-3">Sr. No. To</th>
                  <th className="py-2 pr-3 text-right">Total Number</th>
                  <th className="py-2 pr-3 text-right">Cancelled</th>
                  <th className="py-2 text-right">Net Issued</th>
                </tr>
              </thead>
              <tbody>
                {report.docs.map((doc) => (
                  <tr key={doc.nature} className="border-b border-line last:border-b-0">
                    <td className="py-2.5 pr-3 font-semibold">{doc.nature}</td>
                    <td className="py-2.5 pr-3 font-mono">{doc.fromNo}</td>
                    <td className="py-2.5 pr-3 font-mono">{doc.toNo}</td>
                    <td className="num py-2.5 pr-3 text-right">{doc.totalCount}</td>
                    <td className="num py-2.5 pr-3 text-right">{doc.cancelledCount}</td>
                    <td className="num py-2.5 text-right font-semibold">{doc.netCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </>
  );
}
