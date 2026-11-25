import { Sheets } from '@/components/sheets';
import { billSheets } from '@/lib/bill-sheets';
import { getCompany } from '@/lib/data';
import { istDate } from '@/lib/india';
import { sampleBill } from '@/lib/sample-bill';
import { createClient } from '@/lib/supabase/server';
import { CompanyForm } from './form';

export default async function CompanyPage() {
  const company = await getCompany(await createClient());
  return (
    <>
      <h1 className="mb-1 text-2xl font-bold">Company</h1>
      <p className="mb-3 text-muted">Printed on every bill, and frozen on it when it is issued. Only the owner can change this.</p>
      <CompanyForm company={company} />
      {company ? (
        <section className="mt-6" aria-label="How your bill looks">
          <h2 className="mb-1 text-xl font-bold">How your bill looks</h2>
          <p className="mb-3 text-muted">A sample with the details that are saved. Check every word and number: this is what customers get.</p>
          <div className="max-w-3xl border border-line bg-white [&_svg]:h-auto [&_svg]:w-full"><Sheets sheets={billSheets(sampleBill(company, istDate(new Date())))} paper="a4" /></div>
        </section>
      ) : null}
    </>
  );
}
