import Link from 'next/link';
import { Notice } from '@/components/field';
import { getCompany } from '@/lib/data';
import { istDate } from '@/lib/india';
import { createClient } from '@/lib/supabase/server';
import { BillingScreen } from './screen';

export default async function BillingPage() {
  const company = await getCompany(await createClient());
  return (
    <>
      <h1 className="sr-only">New bill</h1>
      {company ? null : (
        <div className="mb-3">
          <Notice tone="warn">
            Bills carry your company details. <Link className="underline" href="/company">Fill them in first</Link>.
          </Notice>
        </div>
      )}
      <BillingScreen today={istDate(new Date())} />
    </>
  );
}
