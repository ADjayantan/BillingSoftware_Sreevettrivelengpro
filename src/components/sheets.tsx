import { INKS, PAPERS, type Op, type Paper, type Segment, type Sheet } from '@/lib/sheet';

/** Tenths of a millimetre: some browsers refuse letters of only a few units. */
const FINE = 10;
const FONT = 'Arial, Helvetica, "Liberation Sans", "Nirmala UI", "Noto Sans Tamil", sans-serif';
const SCRIPT = '"Times New Roman", Times, "Liberation Serif", serif';

const n = (value: number): number => Math.round(value * 10) / 10;

/** Drawn pages on the screen and for the printer, one picture in the size of the paper for each. */
export function Sheets({ sheets, paper }: { sheets: readonly Sheet[]; paper: Paper }) {
  const { width, height, margin, unit } = PAPERS[paper];
  const long = (value: number): number => n(value * unit * FINE);
  const at = (value: number): number => n((margin + value * unit) * FINE);
  const path = (d: readonly Segment[]): string => d.map(([command, ...numbers]) => command + (numbers as number[]).map(at).join(' ')).join('');

  const mark = (op: Op, key: number) => {
    if (op.kind === 'line') {
      const weight = long(op.weight);
      return (
        <line
          key={key} x1={at(op.x1)} y1={at(op.y1)} x2={at(op.x2)} y2={at(op.y2)} stroke={INKS[op.ink]} strokeWidth={weight}
          {...(op.dotted ? { strokeDasharray: `0 ${n(weight * 2.4)}`, strokeLinecap: 'round' } : {})}
        />
      );
    }
    if (op.kind === 'path') {
      return (
        <path
          key={key} d={path(op.d)} fill={op.fill ? INKS[op.fill] : 'none'}
          {...(op.stroke ? { stroke: INKS[op.stroke], strokeWidth: long(op.weight ?? 0) } : {})}
          {...(op.round ? { strokeLinecap: 'round' } : {})}
        />
      );
    }
    const [x, y] = [at(op.x), at(op.y)];
    return (
      <text
        key={key} x={x} y={y} fontSize={long(op.size)} fill={INKS[op.ink]}
        {...(op.face === 'regular' ? {} : { fontWeight: 700 })}
        {...(op.face === 'script' ? { fontFamily: SCRIPT, fontStyle: 'italic' } : {})}
        {...([...op.text].length > 1 ? { textLength: long(op.width), lengthAdjust: 'spacingAndGlyphs' } : {})}
        {...(op.up ? { transform: `rotate(-90 ${x} ${y})` } : {})}
        {...(op.outline ? { stroke: INKS[op.outline.ink], strokeWidth: long(op.outline.weight), paintOrder: 'stroke' } : {})}
      >
        {op.text}
      </text>
    );
  };

  return (
    <div className="packet" data-paper={paper}>
      {sheets.map((sheet) => (
        <article className="sheet" key={sheet.key}>
          <svg xmlns="http://www.w3.org/2000/svg" viewBox={`0 0 ${width * FINE} ${height * FINE}`} role="img" aria-label={sheet.label} fontFamily={FONT}>
            {sheet.ops.map(mark)}
          </svg>
        </article>
      ))}
    </div>
  );
}
