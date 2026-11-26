import type { IconName } from '@/components/icon';
import type { StateKind } from './bill-state';
import type { GoodsRow } from './schemas/home';

/** Where goods are, in words. Pure. */
export const STEP: Record<GoodsRow['status'], { text: string; kind: StateKind; icon: IconName }> = {
  pending: { text: 'Not packed', kind: 'due', icon: 'clock' },
  packed: { text: 'Packed', kind: 'part', icon: 'box' },
  dispatched: { text: 'On the way', kind: 'part', icon: 'truck' },
  delivered: { text: 'Delivered', kind: 'paid', icon: 'check' },
};
