/** The drawings of the owner's printed bill: the gear at the head, the Vel behind the rows, the rupee sign. Pure. */
import { Pen, type Art, type PathOp, type Segment } from './sheet';

/** 'M175 75C300 128 480 200 600 290Z' as marks, moved by (dx, dy). Only M, L, C and Z. */
function path(text: string, dx = 0, dy = 0): Segment[] {
  return [...text.matchAll(/([MLCZ])([^MLCZ]*)/g)].map(([, command, numbers = '']) => {
    const values = numbers.trim().split(/[\s,]+/).filter(Boolean).map((value, i) => Number(value) + (i % 2 === 0 ? dx : dy));
    return [command, ...values] as unknown as Segment;
  });
}

// ---- Gear --------------------------------------------------------------------
const RADIUS = 102;
const around = (radius: number, degrees: number): [number, number] => [
  RADIUS + Math.cos((degrees * Math.PI) / 180) * radius,
  RADIUS + Math.sin((degrees * Math.PI) / 180) * radius,
];

/** Thirteen teeth with round valleys. */
function teeth(): Segment[] {
  const count = 13;
  const tip = 100;
  const valley = 84;
  const half = 3.6;
  const step = 360 / count;
  // A curve whose middle just touches the valley.
  const control = 2 * valley - tip * Math.cos(((step / 2 - half) * Math.PI) / 180);
  const d: Segment[] = [];
  for (let i = 0; i < count; i += 1) {
    const middle = -84 + i * step;
    const start = around(tip, middle - half);
    const end = around(tip, middle + half);
    const next = around(tip, middle + step - half);
    const deep = around(control, middle + step / 2);
    const third = (from: [number, number]): [number, number] => [from[0] + ((deep[0] - from[0]) * 2) / 3, from[1] + ((deep[1] - from[1]) * 2) / 3];
    if (i === 0) d.push(['M', ...start]);
    d.push(['L', ...end], ['C', ...third(end), ...third(next), ...next]);
  }
  return [...d, ['Z']];
}

function disc(radius: number): Segment[] {
  const k = radius * 0.5523;
  const [l, r, c] = [RADIUS - radius, RADIUS + radius, RADIUS];
  return [
    ['M', r, c], ['C', r, c + k, c + k, r, c, r], ['C', c - k, r, l, c + k, l, c],
    ['C', l, c - k, c - k, l, c, l], ['C', c + k, l, r, c - k, r, c], ['Z'],
  ];
}

const beam = (long: boolean): Segment[] => (long
  ? path('M0 -77C5 -40 5 40 0 77C-5 40 -5 -40 0 -77Z', RADIUS, RADIUS)
  : path('M-77 0C-40 -5 40 -5 77 0C40 5 -40 5 -77 0Z', RADIUS, RADIUS));

function gear(): Art {
  const pen = new Pen();
  const shape = (d: Segment[], fill: PathOp['fill']): void => {
    pen.ops.push({ kind: 'path', d, ...(fill ? { fill } : {}) });
  };
  shape(teeth(), 'red');
  shape(disc(77), 'rose');
  shape(beam(true), 'white');
  shape(beam(false), 'white');
  const letter = (text: string, x: number, y: number, size: number): void => {
    pen.text(text, RADIUS + x, RADIUS + y, { size, face: 'bold', ink: 'white', align: 'center', outline: { ink: 'red', weight: 5 } });
  };
  letter('S', -38, -17, 47);
  letter('V', 38, -17, 47);
  letter('E', -38, 52, 47);
  letter('P', 38, 52, 47);
  letter('V', 0, 10, 30);
  return { width: 2 * RADIUS, height: 2 * RADIUS, ops: pen.ops };
}
export const GEAR: Art = gear();

// ---- Vel ---------------------------------------------------------------------
const VEL_X = -110;
const VEL_Y = -75;
const stripe = (text: string): PathOp => ({ kind: 'path', d: path(text, VEL_X, VEL_Y), stroke: 'white', weight: 52, round: true });

/** Muruga's spear: the blade, three stripes of ash and the dot. */
export const VEL: Art = {
  width: 690,
  height: 1143,
  ops: [
    {
      kind: 'path', fill: 'vel',
      d: path(
        'M175 75C300 128 480 200 600 290C720 372 800 470 800 580C800 690 742 780 716 862C702 925 732 1045 772 1175L705 1218'
        + 'C668 1160 622 1070 585 1030C540 975 470 945 370 925C250 900 175 800 140 680C110 560 116 400 150 240C162 180 172 120 175 75Z', VEL_X, VEL_Y,
      ),
    },
    stripe('M262 452L456 358'),
    stripe('M296 534L494 438'),
    stripe('M332 608L528 512'),
    { kind: 'path', fill: 'vel', d: path('M414 482C414 493 405 502 394 502C383 502 374 493 374 482C374 471 383 462 394 462C405 462 414 471 414 482Z', VEL_X, VEL_Y) },
  ],
};

// ---- Rupee sign ----------------------------------------------------------------
/** Helvetica has none. */
export const RUPEE: Art = {
  width: 68,
  height: 100,
  ops: [
    { kind: 'path', d: path('M7 8L61 8M7 32L61 32'), stroke: 'black', weight: 9 },
    { kind: 'path', d: path('M7 8L24 8C56 8 56 55 24 55L9 55L48 95'), stroke: 'black', weight: 9 },
  ],
};
