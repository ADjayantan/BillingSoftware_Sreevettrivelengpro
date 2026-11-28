import { DesktopDownload } from '@/components/desktop-download';
import { Notice } from '@/components/field';
import { PageHead } from '@/components/page-head';
import { Sheets } from '@/components/sheets';
import { billSheets } from '@/lib/bill-sheets';
import { getCompany } from '@/lib/data';
import { driveInfo } from '@/lib/drive-backup';
import { DRIVE_NOT_HERE_YET, DRIVE_WORDS, driveStateLine, driveWord } from '@/lib/drive-words';
import { istDate } from '@/lib/india';
import { sampleBill } from '@/lib/sample-bill';
import { createClient } from '@/lib/supabase/server';
import { DriveButtons } from './drive-buttons';
import { CompanyForm } from './form';

export default async function CompanyPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const db = await createClient();
  const [company, drive, query] = await Promise.all([getCompany(db), driveInfo(db), searchParams]);
  const word = driveWord(query.drive);
  return (
    <>
      <PageHead title="Company" note="This stands on every bill. A bill that is made keeps what it had. Only the owner can change it." />
      <CompanyForm company={company} />
      <section id="drive" className="mt-8 scroll-mt-28" aria-labelledby="drive-title">
        <h2 id="drive-title" className="card-title mb-1 text-xl">Google Drive</h2>
        <p className="mb-3 max-w-3xl text-muted">
          Every bill and challan, the Excel books and the weekly backup are copied to the folder Company_Billing_Vault in this Google Drive. StudFlow sees nothing else there.
        </p>
        {word ? <div className="mb-3 max-w-3xl"><Notice tone={DRIVE_WORDS[word].good ? 'info' : 'warn'}>{DRIVE_WORDS[word].text}</Notice></div> : null}
        <p className="font-semibold">{driveStateLine(drive.state, drive.accountEmail, drive.connectedAt)}</p>
        {!drive.ready ? (
          <p className="mt-1 text-muted">{DRIVE_NOT_HERE_YET}</p>
        ) : drive.owner ? (
          <DriveButtons state={drive.state} />
        ) : (
          <p className="mt-1 text-muted">Only the owner can connect Google Drive.</p>
        )}
      </section>
      <section id="desktop-app" className="mt-8 scroll-mt-28" aria-labelledby="desktop-app-title">
        <h2 id="desktop-app-title" className="card-title mb-1 text-xl">Windows PC app</h2>
        <p className="mb-3 max-w-3xl text-muted">
          One-click setup for Windows 10 and 11 (StudFlow-Setup.exe). Automatically installs the app, sets up the local offline database on the PC, and connects to your A4 and A5 printers.
        </p>
        <DesktopDownload />
      </section>
      {company ? (
        <section className="mt-8" aria-label="How your bill looks">
          <h2 className="card-title mb-1 text-xl">How your bill looks</h2>
          <p className="mb-3 text-muted">A sample with the details that are saved. Check every word and number: this is what customers get.</p>
          <div className="max-w-3xl border border-line bg-white [&_svg]:h-auto [&_svg]:w-full"><Sheets sheets={billSheets(sampleBill(company, istDate(new Date())))} paper="a4" /></div>
        </section>
      ) : null}
    </>
  );
}
