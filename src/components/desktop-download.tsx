'use client';

import { useSyncExternalStore } from 'react';
import { Icon } from '@/components/icon';
import { DESKTOP_INSTALLER_URL, desktopBridge } from '@/lib/desktop';

const subscribe = (): (() => void) => () => {};
const isDesktopApp = (): boolean => desktopBridge() !== null;
const serverSnapshot = (): boolean => false;

/** Authenticated download button for the self-contained Windows 10/11 installer (StudFlow-Setup.exe). */
export function DesktopDownload({ label = 'Download Windows PC app (.exe)', small = false }: { label?: string; small?: boolean }) {
  const inDesktop = useSyncExternalStore(subscribe, isDesktopApp, serverSnapshot);
  return (
    <a
      href={inDesktop ? DESKTOP_INSTALLER_URL : '/api/desktop-installer'}
      {...(inDesktop ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
      className={`btn ${small ? 'btn-small ml-auto whitespace-nowrap' : ''}`}
    >
      <Icon name="device" />
      {label}
    </a>
  );
}
