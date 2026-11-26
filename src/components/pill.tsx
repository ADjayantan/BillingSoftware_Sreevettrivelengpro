import type { ReactNode } from 'react';
import type { StateKind } from '@/lib/bill-state';
import { Icon, type IconName } from './icon';

const ICONS: Record<StateKind, IconName | null> = { late: 'alert', due: 'clock', part: 'coin', paid: 'check', off: null };

/** A state: always a sign and words, never colour alone. */
export function Pill({ kind, icon, children }: { kind: StateKind; icon?: IconName; children: ReactNode }) {
  const sign = icon ?? ICONS[kind];
  return <span className={`pill pill-${kind}`}>{sign ? <Icon name={sign} /> : null}{children}</span>;
}
