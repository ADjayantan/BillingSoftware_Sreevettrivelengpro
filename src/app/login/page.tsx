import { Drawing } from '@/components/drawing';
import { Icon } from '@/components/icon';
import { GEAR, VEL } from '@/lib/bill-art';
import { LoginForm } from './form';

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const { next } = await searchParams;
  return (
    <main className="grid min-h-dvh content-start border-t-[3px] border-crimson bg-card lg:grid-cols-[1.05fr_1fr] lg:content-stretch">
      <section className="relative flex flex-col overflow-hidden border-line bg-soft px-6 py-7 lg:border-r lg:p-14">
        <Drawing art={VEL} className="pointer-events-none absolute -right-14 -bottom-16 w-64 opacity-[0.07] lg:w-[420px]" />
        <span className="flex items-center gap-3"><Drawing art={GEAR} className="size-12 lg:size-16" /><span className="small-head text-slate">Billing and dispatch</span></span>
        <h1 className="mt-6 max-w-lg text-[32px] leading-[1.15] lg:mt-auto lg:text-[46px]" style={{ fontFamily: 'var(--font-serif)' }}>Your bills, money and goods in one place</h1>
        <p className="mt-3 max-w-md text-[16.5px] text-ink-2">Make bills, send goods, see who owes you. It keeps working when the internet does not.</p>
        <ul className="mt-10 flex flex-wrap gap-x-8 gap-y-3 max-lg:hidden">
          {([['wifi', 'Works without internet'], ['cloud', 'Kept in the cloud'], ['lock', 'Only your people']] as const).map(([icon, words]) => (
            <li key={icon} className="flex items-center gap-2.5 text-[12.5px] font-semibold tracking-[0.07em] text-accent uppercase"><Icon name={icon} className="size-6" />{words}</li>
          ))}
        </ul>
      </section>
      <section className="grid place-items-center px-6 py-10"><LoginForm next={typeof next === 'string' ? next : ''} /></section>
    </main>
  );
}
