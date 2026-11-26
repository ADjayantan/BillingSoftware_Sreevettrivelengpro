import { INKS, type Art, type Op, type Segment } from '@/lib/sheet';

const n = (value: number): number => Math.round(value * 10) / 10;
const path = (d: readonly Segment[]): string => d.map(([command, ...numbers]) => command + (numbers as number[]).map(n).join(' ')).join('');

function mark(op: Op, key: number) {
  if (op.kind === 'line') return null; // no picture of ours has any
  if (op.kind === 'path') {
    return (
      <path
        key={key} d={path(op.d)} fill={op.fill ? INKS[op.fill] : 'none'}
        {...(op.stroke ? { stroke: INKS[op.stroke], strokeWidth: op.weight ?? 0 } : {})}
        {...(op.round ? { strokeLinecap: 'round' } : {})}
      />
    );
  }
  return (
    <text
      key={key} x={n(op.x)} y={n(op.y)} fontSize={op.size} fill={INKS[op.ink]} fontWeight={700} textLength={n(op.width)} lengthAdjust="spacingAndGlyphs"
      {...(op.outline ? { stroke: INKS[op.outline.ink], strokeWidth: op.outline.weight, paintOrder: 'stroke' } : {})}
    >
      {op.text}
    </text>
  );
}

/** The gear or the Vel of the printed bill, on a screen. A server component: no page loads the drawing code. */
export function Drawing({ art, className }: { art: Art; className?: string }) {
  return (
    <svg className={className} viewBox={`0 0 ${art.width} ${art.height}`} fontFamily="Arial, Helvetica, sans-serif" aria-hidden="true">
      {art.ops.map(mark)}
    </svg>
  );
}
