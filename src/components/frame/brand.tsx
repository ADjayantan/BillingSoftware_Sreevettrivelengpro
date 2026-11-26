'use client';

import { useEffect, useSyncExternalStore } from 'react';
import { askCompanyName, companyName, onCompanyName } from '@/lib/company-name';

/** The company's name, once this device knows it. */
export function Brand() {
  const name = useSyncExternalStore(onCompanyName, companyName, () => '');
  useEffect(() => {
    void askCompanyName();
  }, []);
  return <b className="mark-name line-clamp-3">{name || 'StudFlow'}</b>;
}
