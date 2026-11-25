import type { Metadata } from 'next';
import Link from 'next/link';
import { z } from 'zod';
import { Sheets } from '@/components/sheets';
import { billSheets } from '@/lib/bill-sheets';
import { invoiceMessages, loadInvoice } from '@/lib/load-invoice';
import { buildDocuments } from '@/lib/print-documents';
import { PrintButton } from './print-button';
import './print.css';

const printQuery = z.object({
  paper: z.enum(['a4', 'a5']).catch('a4'),
  docs: z.enum(['both', 'invoice', 'dc']).catch('both'),
  copies: z.enum(['original', 'all']).catch('original'),
});

/** Exactly one page rule per print job, matching data-paper. The drawing has its own margins. */
const PAGE_RULE = {
  a4: '@page { size: A4 portrait; margin: 0; }',
  a5: '@page { size: A5 portrait; margin: 0; }',
} as const;

/** Browsers name the saved PDF after the page title. */
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  return { title: (await loadInvoice(params)).invoice.invoice_no };
}

export default async function PrintPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { paper, docs, copies } = printQuery.parse(await searchParams);
  const doc = await loadInvoice(params);
  const choice = (change: Partial<{ paper: string; docs: string; copies: string }>, label: string, on: boolean) => (
    <Link key={label} prefetch={false} aria-current={on ? 'true' : undefined} className={`btn ${on ? 'btn-primary' : ''}`} href={`?${new URLSearchParams({ paper, docs, copies, ...change }).toString()}`}>{label}</Link>
  );
  return (
    <>
      <style>{PAGE_RULE[paper]}</style>
      <nav aria-label="Print options" className="screen-only flex flex-wrap items-center gap-2 p-3">
        <Link className="btn" href={`/invoices/${doc.invoice.id}`}>← Bill</Link>
        {choice({ paper: 'a4' }, 'A4', paper === 'a4')}
        {choice({ paper: 'a5' }, 'A5', paper === 'a5')}
        {choice({ docs: 'both' }, 'Invoice + DC', docs === 'both')}
        {choice({ docs: 'invoice' }, 'Invoice', docs === 'invoice')}
        {choice({ docs: 'dc' }, 'DC', docs === 'dc')}
        {choice({ copies: copies === 'all' ? 'original' : 'all' }, 'All copies', copies === 'all')}
        <PrintButton />
        {invoiceMessages(doc).map((draft) => <a key={draft.label} className="btn" href={draft.href} target="_blank" rel="noopener noreferrer">{draft.label}</a>)}
      </nav>
      <main className="preview"><Sheets sheets={billSheets(buildDocuments(doc, { documents: docs, copies }))} paper={paper} /></main>
    </>
  );
}
