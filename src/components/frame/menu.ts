import type { IconName } from '../icon';

export interface MenuEntry {
  href: string;
  label: string;
  icon: IconName;
}
export interface MenuGroup {
  head: string | null;
  entries: readonly MenuEntry[];
}

/** Only what exists: a part that is not built yet is not in the menu. */
export const MENU: readonly MenuGroup[] = [
  { head: null, entries: [{ href: '/home', label: 'Home', icon: 'home' }] },
  {
    head: 'Sales',
    entries: [
      { href: '/invoices', label: 'Bills', icon: 'bill' },
      { href: '/customers', label: 'Customers', icon: 'users' },
      { href: '/money', label: 'Money received', icon: 'wallet' },
    ],
  },
  {
    head: 'Goods',
    entries: [
      { href: '/stud-master', label: 'Products', icon: 'box' },
      { href: '/dispatch', label: 'Send goods', icon: 'truck' },
      { href: '/job-work', label: 'Job work', icon: 'work' },
      { href: '/rates', label: 'Metal rates', icon: 'trend' },
    ],
  },
  {
    head: 'Office',
    entries: [
      { href: '/books', label: 'Excel books', icon: 'sheet' },
      { href: '/company', label: 'Company', icon: 'building' },
    ],
  },
];

/** Behind the + : everything that can be made. `?new` opens the empty form. */
export const MAKE: readonly MenuGroup[] = [
  {
    head: 'Sale',
    entries: [
      { href: '/billing', label: 'Bill', icon: 'bill' },
      { href: '/money', label: 'Money received', icon: 'wallet' },
      { href: '/customers?new', label: 'Customer', icon: 'users' },
    ],
  },
  {
    head: 'Goods',
    entries: [
      { href: '/stud-master?new', label: 'Product', icon: 'box' },
      { href: '/job-work?new', label: 'Job work in', icon: 'work' },
    ],
  },
];
