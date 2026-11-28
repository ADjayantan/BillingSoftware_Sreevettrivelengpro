import { stateLabel } from '@/lib/india';
import { decimalToPaise, paiseToDecimal } from '@/lib/money';
import type { MonthData } from '@/lib/month-workbook';

export interface Gstr1B2bRateRow {
  ratePercent: string;
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
}

export interface Gstr1B2bInvoice {
  id: string;
  gstin: string;
  customerName: string;
  invoiceNo: string;
  invoiceDate: string;
  placeOfSupply: string;
  isSez: boolean;
  invoiceValuePaise: number;
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  rates: Gstr1B2bRateRow[];
}

export interface Gstr1B2cRow {
  placeOfSupply: string;
  ratePercent: string;
  invoicesCount: number;
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
}

export interface Gstr1HsnRow {
  hsnSac: string;
  description: string;
  uqc: 'PCS-PIECES' | 'KGS-KILOGRAMS';
  ratePercent: string;
  totalQuantity: string;
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  totalValuePaise: number;
}

export interface Gstr1DocSeries {
  nature: string;
  fromNo: string;
  toNo: string;
  totalCount: number;
  cancelledCount: number;
  netCount: number;
}

export interface Gstr1Report {
  month: string; // YYYY-MM
  fp: string; // MMYYYY
  companyName: string | null;
  companyGstin: string | null;
  b2b: Gstr1B2bInvoice[];
  b2c: Gstr1B2cRow[];
  hsn: Gstr1HsnRow[];
  docs: Gstr1DocSeries[];
  totals: {
    activeInvoices: number;
    cancelledInvoices: number;
    b2bInvoices: number;
    b2cInvoices: number;
    taxablePaise: number;
    cgstPaise: number;
    sgstPaise: number;
    igstPaise: number;
    totalTaxPaise: number;
    invoiceValuePaise: number;
  };
}

const normRate = (r: string): string => String(Number(r));

/** Formats YYYY-MM-DD as DD-MM-YYYY for GST Portal JSON & auditor tables. */
export function gstPortalDate(isoDate: string): string {
  const [y, m, d] = isoDate.split('-');
  return `${d}-${m}-${y}`;
}

/**
 * Pure GSTR-1 & Auditor Report builder from one month's issued records.
 * Cancelled bills count only in Document Series (Table 13), never in tax tables.
 */
export function buildGstr1Report(data: MonthData, companyGstin: string | null): Gstr1Report {
  const ym = data.month.slice(0, 7);
  const [year = '2026', mm = '11'] = ym.split('-');
  const fp = `${mm}${year}`;

  const itemsByInvoice = new Map<string, MonthData['items'][number][]>();
  for (const item of data.items) {
    const list = itemsByInvoice.get(item.invoice_id) ?? [];
    list.push(item);
    itemsByInvoice.set(item.invoice_id, list);
  }

  const activeInvoices = data.invoices
    .filter((inv) => inv.cancelled_at === null)
    .sort((a, b) => a.invoice_date.localeCompare(b.invoice_date) || a.invoice_seq - b.invoice_seq);
  const cancelledInvoices = data.invoices.filter((inv) => inv.cancelled_at !== null);

  const b2b: Gstr1B2bInvoice[] = [];
  const b2cMap = new Map<string, Gstr1B2cRow & { seenInvoices: Set<string> }>();
  const hsnMap = new Map<
    string,
    {
      hsnSac: string;
      description: string;
      uqc: 'PCS-PIECES' | 'KGS-KILOGRAMS';
      ratePercent: string;
      qtyMicro: bigint;
      isKg: boolean;
      taxablePaise: number;
      cgstPaise: number;
      sgstPaise: number;
      igstPaise: number;
    }
  >();

  let totalTaxablePaise = 0;
  let totalCgstPaise = 0;
  let totalSgstPaise = 0;
  let totalIgstPaise = 0;
  let totalValuePaise = 0;
  let b2cInvoicesCount = 0;

  for (const inv of activeInvoices) {
    const invItems = itemsByInvoice.get(inv.id) ?? [];
    const rateBuckets = new Map<string, Gstr1B2bRateRow>();

    // Determine the primary rate on the invoice for any header-level taxable packing/delivery charges
    let highestRate = '18';
    for (const item of invItems) {
      const r = normRate(item.tax_rate_percent);
      if (Number(r) >= Number(highestRate)) highestRate = r;

      const lineTaxable = decimalToPaise(item.line_total);
      const lineCgst = decimalToPaise(item.cgst_amount);
      const lineSgst = decimalToPaise(item.sgst_amount);
      const lineIgst = decimalToPaise(item.igst_amount);

      const bucket = rateBuckets.get(r) ?? {
        ratePercent: r,
        taxablePaise: 0,
        cgstPaise: 0,
        sgstPaise: 0,
        igstPaise: 0,
      };
      bucket.taxablePaise += lineTaxable;
      bucket.cgstPaise += lineCgst;
      bucket.sgstPaise += lineSgst;
      bucket.igstPaise += lineIgst;
      rateBuckets.set(r, bucket);

      // HSN summary aggregation
      const isKg = item.billing_unit === 'kg';
      const uqc: 'PCS-PIECES' | 'KGS-KILOGRAMS' = isKg ? 'KGS-KILOGRAMS' : 'PCS-PIECES';
      const hsnKey = `${item.hsn_sac}|${uqc}|${r}`;
      const qtyMicro = isKg
        ? BigInt(Math.round(Number(item.total_weight_kg ?? '0') * 1_000_000))
        : BigInt(item.qty_pieces ?? 0) * 1_000_000n;
      const existingHsn = hsnMap.get(hsnKey);
      if (existingHsn) {
        existingHsn.qtyMicro += qtyMicro;
        existingHsn.taxablePaise += lineTaxable;
        existingHsn.cgstPaise += lineCgst;
        existingHsn.sgstPaise += lineSgst;
        existingHsn.igstPaise += lineIgst;
      } else {
        hsnMap.set(hsnKey, {
          hsnSac: item.hsn_sac,
          description: item.description,
          uqc,
          ratePercent: r,
          qtyMicro,
          isKg,
          taxablePaise: lineTaxable,
          cgstPaise: lineCgst,
          sgstPaise: lineSgst,
          igstPaise: lineIgst,
        });
      }
    }

    // Include header-level packing/delivery charges and header tax difference into the highest rate bucket
    const itemsTaxableSum = [...rateBuckets.values()].reduce((acc, b) => acc + b.taxablePaise, 0);
    const itemsCgstSum = [...rateBuckets.values()].reduce((acc, b) => acc + b.cgstPaise, 0);
    const itemsSgstSum = [...rateBuckets.values()].reduce((acc, b) => acc + b.sgstPaise, 0);
    const itemsIgstSum = [...rateBuckets.values()].reduce((acc, b) => acc + b.igstPaise, 0);

    const invChargesPaise = decimalToPaise(inv.packing_charge) + decimalToPaise(inv.delivery_charge);
    const invTaxablePaise = itemsTaxableSum + invChargesPaise;
    const invCgstPaise = decimalToPaise(inv.cgst);
    const invSgstPaise = decimalToPaise(inv.sgst);
    const invIgstPaise = decimalToPaise(inv.igst);
    const invGrandPaise = decimalToPaise(inv.grand_total);

    if (invChargesPaise > 0 || invCgstPaise !== itemsCgstSum || invIgstPaise !== itemsIgstSum) {
      const target = rateBuckets.get(highestRate) ?? {
        ratePercent: highestRate,
        taxablePaise: 0,
        cgstPaise: 0,
        sgstPaise: 0,
        igstPaise: 0,
      };
      target.taxablePaise += invChargesPaise;
      target.cgstPaise += invCgstPaise - itemsCgstSum;
      target.sgstPaise += invSgstPaise - itemsSgstSum;
      target.igstPaise += invIgstPaise - itemsIgstSum;
      rateBuckets.set(highestRate, target);
    }

    const rates = [...rateBuckets.values()].sort((a, b) => Number(a.ratePercent) - Number(b.ratePercent));
    const gstin = inv.customer_snapshot.gstin?.trim() || null;

    if (gstin) {
      b2b.push({
        id: inv.id,
        gstin,
        customerName: inv.customer_snapshot.name,
        invoiceNo: inv.invoice_no,
        invoiceDate: inv.invoice_date,
        placeOfSupply: inv.place_of_supply,
        isSez: inv.is_sez,
        invoiceValuePaise: invGrandPaise,
        taxablePaise: invTaxablePaise,
        cgstPaise: invCgstPaise,
        sgstPaise: invSgstPaise,
        igstPaise: invIgstPaise,
        rates,
      });
    } else {
      b2cInvoicesCount += 1;
      for (const r of rates) {
        const key = `${inv.place_of_supply}|${r.ratePercent}`;
        const existing = b2cMap.get(key);
        if (existing) {
          existing.seenInvoices.add(inv.id);
          existing.invoicesCount = existing.seenInvoices.size;
          existing.taxablePaise += r.taxablePaise;
          existing.cgstPaise += r.cgstPaise;
          existing.sgstPaise += r.sgstPaise;
          existing.igstPaise += r.igstPaise;
        } else {
          b2cMap.set(key, {
            placeOfSupply: inv.place_of_supply,
            ratePercent: r.ratePercent,
            invoicesCount: 1,
            taxablePaise: r.taxablePaise,
            cgstPaise: r.cgstPaise,
            sgstPaise: r.sgstPaise,
            igstPaise: r.igstPaise,
            seenInvoices: new Set([inv.id]),
          });
        }
      }
    }

    totalTaxablePaise += invTaxablePaise;
    totalCgstPaise += invCgstPaise;
    totalSgstPaise += invSgstPaise;
    totalIgstPaise += invIgstPaise;
    totalValuePaise += invGrandPaise;
  }

  const b2c: Gstr1B2cRow[] = [...b2cMap.values()]
    .map((r) => ({
      placeOfSupply: r.placeOfSupply,
      ratePercent: r.ratePercent,
      invoicesCount: r.invoicesCount,
      taxablePaise: r.taxablePaise,
      cgstPaise: r.cgstPaise,
      sgstPaise: r.sgstPaise,
      igstPaise: r.igstPaise,
    }))
    .sort((a, b) => a.placeOfSupply.localeCompare(b.placeOfSupply) || Number(a.ratePercent) - Number(b.ratePercent));

  const hsn: Gstr1HsnRow[] = [...hsnMap.values()]
    .map((h) => {
      const totalQty = h.isKg
        ? (Number(h.qtyMicro) / 1_000_000).toFixed(3)
        : String(h.qtyMicro / 1_000_000n);
      const totalVal = h.taxablePaise + h.cgstPaise + h.sgstPaise + h.igstPaise;
      return {
        hsnSac: h.hsnSac,
        description: h.description,
        uqc: h.uqc,
        ratePercent: h.ratePercent,
        totalQuantity: totalQty,
        taxablePaise: h.taxablePaise,
        cgstPaise: h.cgstPaise,
        sgstPaise: h.sgstPaise,
        igstPaise: h.igstPaise,
        totalValuePaise: totalVal,
      };
    })
    .sort((a, b) => a.hsnSac.localeCompare(b.hsnSac) || Number(a.ratePercent) - Number(b.ratePercent));

  // Document Series (Table 13)
  const docs: Gstr1DocSeries[] = [];
  const allInvoicesSorted = [...data.invoices].sort((a, b) => a.invoice_seq - b.invoice_seq);
  if (allInvoicesSorted.length > 0) {
    docs.push({
      nature: 'Invoices for outward supply',
      fromNo: allInvoicesSorted[0]!.invoice_no,
      toNo: allInvoicesSorted[allInvoicesSorted.length - 1]!.invoice_no,
      totalCount: allInvoicesSorted.length,
      cancelledCount: cancelledInvoices.length,
      netCount: allInvoicesSorted.length - cancelledInvoices.length,
    });
  }
  const allDcsSorted = [...data.sentNow].sort((a, b) => a.dc_seq - b.dc_seq);
  if (allDcsSorted.length > 0) {
    const cancelledIds = new Set(cancelledInvoices.map((i) => i.id));
    const cancelledDcs = allDcsSorted.filter((d) => cancelledIds.has(d.invoice_id)).length;
    docs.push({
      nature: 'Delivery Challan for job work / supply',
      fromNo: allDcsSorted[0]!.dc_no,
      toNo: allDcsSorted[allDcsSorted.length - 1]!.dc_no,
      totalCount: allDcsSorted.length,
      cancelledCount: cancelledDcs,
      netCount: allDcsSorted.length - cancelledDcs,
    });
  }

  return {
    month: ym,
    fp,
    companyName: data.company,
    companyGstin,
    b2b,
    b2c,
    hsn,
    docs,
    totals: {
      activeInvoices: activeInvoices.length,
      cancelledInvoices: cancelledInvoices.length,
      b2bInvoices: b2b.length,
      b2cInvoices: b2cInvoicesCount,
      taxablePaise: totalTaxablePaise,
      cgstPaise: totalCgstPaise,
      sgstPaise: totalSgstPaise,
      igstPaise: totalIgstPaise,
      totalTaxPaise: totalCgstPaise + totalSgstPaise + totalIgstPaise,
      invoiceValuePaise: totalValuePaise,
    },
  };
}

const num = (paise: number): number => Number(paiseToDecimal(paise));

/** Official GST Portal GSTR-1 Offline Tool JSON format. */
export function toGstr1PortalJson(report: Gstr1Report): Record<string, unknown> {
  // Group B2B invoices by buyer GSTIN (ctin) as required by the GST Portal JSON schema
  const byCtin = new Map<string, Gstr1B2bInvoice[]>();
  for (const inv of report.b2b) {
    const list = byCtin.get(inv.gstin) ?? [];
    list.push(inv);
    byCtin.set(inv.gstin, list);
  }

  const b2b = [...byCtin.entries()].map(([ctin, invoices]) => ({
    ctin,
    inv: invoices.map((inv) => ({
      inum: inv.invoiceNo,
      idt: gstPortalDate(inv.invoiceDate),
      val: num(inv.invoiceValuePaise),
      pos: inv.placeOfSupply,
      rchrg: 'N',
      inv_typ: inv.isSez ? 'SEWP' : 'R',
      itms: inv.rates.map((r, idx) => ({
        num: idx + 1,
        itm_det: {
          rt: Number(r.ratePercent),
          txval: num(r.taxablePaise),
          iamt: num(r.igstPaise),
          camt: num(r.cgstPaise),
          samt: num(r.sgstPaise),
          csamt: 0,
        },
      })),
    })),
  }));

  const b2cs = report.b2c.map((row) => ({
    sply_ty: row.placeOfSupply === '33' ? 'INTRA' : 'INTER',
    pos: row.placeOfSupply,
    typ: 'OE',
    rt: Number(row.ratePercent),
    txval: num(row.taxablePaise),
    iamt: num(row.igstPaise),
    camt: num(row.cgstPaise),
    samt: num(row.sgstPaise),
    csamt: 0,
  }));

  const hsnData = report.hsn.map((row, idx) => ({
    num: idx + 1,
    hsn_sc: row.hsnSac,
    desc: row.description.slice(0, 30),
    uqc: row.uqc === 'KGS-KILOGRAMS' ? 'KGS' : 'PCS',
    qty: Number(row.totalQuantity),
    val: num(row.totalValuePaise),
    rt: Number(row.ratePercent),
    txval: num(row.taxablePaise),
    iamt: num(row.igstPaise),
    camt: num(row.cgstPaise),
    samt: num(row.sgstPaise),
    csamt: 0,
  }));

  const docDet = report.docs.map((doc, idx) => ({
    doc_num: idx + 1,
    doc_typ: doc.nature,
    docs: [
      {
        num: 1,
        from: doc.fromNo,
        to: doc.toNo,
        totnum: doc.totalCount,
        cancel: doc.cancelledCount,
        net_issue: doc.netCount,
      },
    ],
  }));

  return {
    gstin: report.companyGstin ?? '',
    fp: report.fp,
    version: 'GST3.1.6',
    hash: 'hash',
    b2b,
    b2cs,
    hsn: { data: hsnData },
    doc_issue: { doc_det: docDet },
  };
}

const csvCell = (val: string | number | null | undefined): string => {
  const s = val === null || val === undefined ? '' : String(val);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csvRow = (cells: ReadonlyArray<string | number | null | undefined>): string => cells.map(csvCell).join(',');

/** Multi-section Auditor GSTR-1 CSV file (opens cleanly in Excel with UTF-8 BOM). */
export function toGstr1AuditorCsv(report: Gstr1Report): string {
  const lines: string[] = [
    csvRow(['GSTR-1 & Auditor Report', report.companyName ?? 'StudFlow', `Month: ${report.month}`, `GSTIN: ${report.companyGstin ?? ''}`]),
    '',
    csvRow(['1. SUMMARY']),
    csvRow(['Active Invoices', 'Cancelled Invoices', 'B2B Invoices', 'B2C Invoices', 'Taxable Value (Rs)', 'CGST (Rs)', 'SGST (Rs)', 'IGST (Rs)', 'Total Tax (Rs)', 'Total Invoice Value (Rs)']),
    csvRow([
      report.totals.activeInvoices,
      report.totals.cancelledInvoices,
      report.totals.b2bInvoices,
      report.totals.b2cInvoices,
      paiseToDecimal(report.totals.taxablePaise),
      paiseToDecimal(report.totals.cgstPaise),
      paiseToDecimal(report.totals.sgstPaise),
      paiseToDecimal(report.totals.igstPaise),
      paiseToDecimal(report.totals.totalTaxPaise),
      paiseToDecimal(report.totals.invoiceValuePaise),
    ]),
    '',
    csvRow(['2. B2B INVOICES (Table 4A, 4B, 6B)']),
    csvRow(['GSTIN/UIN of Recipient', 'Receiver Name', 'Invoice Number', 'Invoice Date', 'Invoice Value', 'Place Of Supply', 'Reverse Charge', 'Invoice Type', 'Rate (%)', 'Taxable Value', 'CGST Amount', 'SGST Amount', 'IGST Amount']),
  ];

  for (const inv of report.b2b) {
    for (const r of inv.rates) {
      lines.push(
        csvRow([
          inv.gstin,
          inv.customerName,
          inv.invoiceNo,
          gstPortalDate(inv.invoiceDate),
          paiseToDecimal(inv.invoiceValuePaise),
          `${inv.placeOfSupply}-${stateLabel(inv.placeOfSupply)}`,
          'N',
          inv.isSez ? 'SEZ Supplies with payment' : 'Regular B2B',
          r.ratePercent,
          paiseToDecimal(r.taxablePaise),
          paiseToDecimal(r.cgstPaise),
          paiseToDecimal(r.sgstPaise),
          paiseToDecimal(r.igstPaise),
        ]),
      );
    }
  }

  lines.push(
    '',
    csvRow(['3. B2CS SUMMARY (Table 7 - Unregistered Buyers)']),
    csvRow(['Type', 'Place Of Supply', 'Rate (%)', 'Invoices Count', 'Taxable Value', 'CGST Amount', 'SGST Amount', 'IGST Amount']),
  );
  for (const row of report.b2c) {
    lines.push(
      csvRow([
        'OE',
        `${row.placeOfSupply}-${stateLabel(row.placeOfSupply)}`,
        row.ratePercent,
        row.invoicesCount,
        paiseToDecimal(row.taxablePaise),
        paiseToDecimal(row.cgstPaise),
        paiseToDecimal(row.sgstPaise),
        paiseToDecimal(row.igstPaise),
      ]),
    );
  }

  lines.push(
    '',
    csvRow(['4. HSN / SAC SUMMARY (Table 12)']),
    csvRow(['HSN/SAC', 'Description', 'UQC', 'Total Quantity', 'Total Value', 'Rate (%)', 'Taxable Value', 'CGST Amount', 'SGST Amount', 'IGST Amount']),
  );
  for (const row of report.hsn) {
    lines.push(
      csvRow([
        row.hsnSac,
        row.description,
        row.uqc,
        row.totalQuantity,
        paiseToDecimal(row.totalValuePaise),
        row.ratePercent,
        paiseToDecimal(row.taxablePaise),
        paiseToDecimal(row.cgstPaise),
        paiseToDecimal(row.sgstPaise),
        paiseToDecimal(row.igstPaise),
      ]),
    );
  }

  lines.push(
    '',
    csvRow(['5. DOCUMENTS ISSUED SUMMARY (Table 13)']),
    csvRow(['Nature of Document', 'Sr. No. From', 'Sr. No. To', 'Total Number', 'Cancelled', 'Net Issued']),
  );
  for (const doc of report.docs) {
    lines.push(csvRow([doc.nature, doc.fromNo, doc.toNo, doc.totalCount, doc.cancelledCount, doc.netCount]));
  }

  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}
