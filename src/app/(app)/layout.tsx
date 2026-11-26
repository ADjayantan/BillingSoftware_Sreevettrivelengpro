import Link from 'next/link';
import type { ReactNode } from 'react';
import { Drawing } from '@/components/drawing';
import { Brand } from '@/components/frame/brand';
import { FindBox } from '@/components/frame/find-box';
import { MakeLink, MakeMenu } from '@/components/frame/make-menu';
import { MAKE, MENU } from '@/components/frame/menu';
import { NavLink } from '@/components/frame/nav-link';
import { Net } from '@/components/frame/net';
import { Icon } from '@/components/icon';
import { OfflineBar } from '@/components/offline-bar';
import { SignOut } from '@/components/sign-out';
import { GEAR } from '@/lib/bill-art';

const mark = (
  <Link href="/home" className="mark">
    <span className="mark-tile"><Drawing art={GEAR} /></span>
    <Brand />
  </Link>
);

/**
 * The frame around every page, the static billing page too: it has no data in it. What it
 * shows of this device comes from this device.
 */
export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="app">
      <header className="head">
        <div className="head-in">
          <div className="w-[252px] flex-none max-lg:w-[190px]">{mark}</div>
          <FindBox keys className="max-w-[520px] flex-[4]" />
          <span className="flex-1" />
          <Net className="max-xl:hidden" />
          <Net short className="xl:hidden" />
          <button type="button" className="round" popoverTarget="make-menu" aria-label="Make something new"><Icon name="plus" /></button>
          <Link href="/billing" prefetch className="make">New bill<kbd className="kbd max-lg:hidden">Alt N</kbd></Link>
        </div>
      </header>
      <nav className="top-nav" aria-label="Main">
        <div className="top-nav-in">
          {MENU.map(({ head, entries }, i) => (
            // Below lg the office pages and Sign out wait behind More.
            <div key={head ?? 'top'} className={`top-group ${i === MENU.length - 1 ? 'max-lg:hidden' : ''}`}>
              {entries.map(({ href, label }) => <NavLink key={href} href={href} className="top-link">{label}</NavLink>)}
            </div>
          ))}
          <NavLink href="/more" className="top-link lg:hidden">More</NavLink>
          <span className="flex-1" />
          <span className="flex max-lg:hidden"><SignOut className="top-link h-full pr-0" /></span>
        </div>
      </nav>

      <header className="phone-top">{mark}<Net short /></header>
      <OfflineBar />
      <main className="page">{children}</main>

      <nav className="phone-bar" aria-label="Main, short">
        <NavLink href="/home" className="phone-link"><Icon name="home" />Home</NavLink>
        <NavLink href="/invoices" className="phone-link"><Icon name="bill" />Bills</NavLink>
        <button type="button" className="phone-plus" popoverTarget="make-menu" aria-label="Make something new"><Icon name="plus" /></button>
        <NavLink href="/customers" className="phone-link"><Icon name="users" />Customers</NavLink>
        <NavLink href="/more" className="phone-link"><Icon name="menu" />More</NavLink>
      </nav>

      <MakeMenu>
        <div className="flex items-center gap-3 border-b border-line px-6 py-4">
          <h2 className="card-title text-[23px]">Make something new</h2>
          <button type="button" className="btn btn-small ml-auto" popoverTarget="make-menu" popoverTargetAction="hide">Close</button>
        </div>
        <div className="grid grid-cols-2 gap-4 px-3.5 py-5">
          {MAKE.map(({ head, entries }) => (
            <div key={head}>
              <p className="small-head mx-2.5 mb-1.5">{head}</p>
              {entries.map(({ href, label, icon }) => <MakeLink key={href} href={href}><Icon name={icon} />{label}</MakeLink>)}
            </div>
          ))}
        </div>
      </MakeMenu>
    </div>
  );
}
