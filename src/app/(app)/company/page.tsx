import { getCompany } from '@/lib/data';
import { createClient } from '@/lib/supabase/server';
import { CompanyForm } from './form';

export default async function CompanyPage() {
  const company = await getCompany(await createClient());
  return (
    <>
      <h1 className="mb-1 text-2xl font-bold">Company</h1>
      <p className="mb-3 text-muted">Printed on every bill, and frozen on it when it is issued. Only the owner can change this.</p>
      <CompanyForm company={company} />
    </>
  );
}
