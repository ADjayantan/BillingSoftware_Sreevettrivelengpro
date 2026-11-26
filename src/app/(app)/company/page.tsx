import { PageHead } from '@/components/page-head';
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
      <PageHead title="Company" note="This stands on every bill. A bill that is made keeps what it had. Only the owner can change it." />
      <CompanyForm company={company} />
      {company ? (
        <section className="mt-6" aria-label="How your bill looks">
          <h2 className="card-title mb-1 text-xl">How your bill looks</h2>
          <p className="mb-3 text-muted">A sample with the details that are saved. Check every word and number: this is what customers get.</p>
          <div className="max-w-3xl border border-line bg-white [&_svg]:h-auto [&_svg]:w-full"><Sheets sheets={billSheets(sampleBill(company, istDate(new Date())))} paper="a4" /></div>
        </section>
      ) : null}
    </>
  );
}
