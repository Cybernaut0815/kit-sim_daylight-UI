// Per part: one row per prim path, one bar per model in its colour (several models: their letters in a key above), the
// value axis over the chart's domain (shares of the problem range in percent) and each bar's value at the right. A part a
// model lacks has no bar and '–' for its value.
import { isShare, type Drawn, type Metric } from '../lib/charts';
import { fmtNum } from '../lib/result';
import { LETTERS, cat, pct } from '../ui';
import { AXIS, FONT, GRID, TEXT, fmtTick, niceTicks } from './axes';

const L = 96, R = 34, TOP = 6, KEY = 14, BOTTOM = 30, BAR = 8, PITCH = 10, GAP = 6, CHARS = 17; // CHARS: a name in L

/** What a bar measures: the parts axis and the settings menu (its markers too). */
export const METRIC_LABEL: Record<Metric, string> = {
  mean: 'Mean', median: 'Median', p10: 'P10', p90: 'P90', min: 'Min', max: 'Max',
  below: 'Share below the range', within: 'Share within the range', above: 'Share above the range',
};

/** `width`: the viewBox's (the drawing scales to its box); the height follows the rows. */
export function Parts({ d, width = 320 }: { d: Extract<Drawn, { kind: 'parts' }>; width?: number }) {
  const share = isShare(d.metric), slots = d.groups[0]?.bars.map((b) => b.slot) ?? [], many = slots.length > 1;
  const top = TOP + (many ? KEY : 0), rowH = slots.length * PITCH + GAP, base = top + d.groups.length * rowH, plotW = width - L - R;
  const [dmin, dmax] = d.domain, x = (v: number) => L + Math.min(Math.max((v - dmin) / (dmax - dmin || 1), 0), 1) * plotW;
  const zero = x(0); // bars grow from 0, or from the axis end nearest it
  const fmt = (v: number) => (!Number.isFinite(v) ? '–' : share ? pct(v) : fmtNum(v));
  const what = (g: (typeof d.groups)[number]) => g.bars.map((b) => `${many ? `${LETTERS[b.slot]} ` : ''}${fmt(b.v)}`).join(', ');
  return (
    <>
      <svg viewBox={`0 0 ${width} ${base + BOTTOM}`} width="100%" role="img" aria-label={`${METRIC_LABEL[d.metric]} per part${share || !d.unit ? '' : ` (${d.unit})`}: ${d.groups.map((g) => `${g.name} ${what(g)}`).join('; ')}`}>
        {many && slots.map((s, k) => (
          <g key={s}>
            <rect x={L + 26 * k} y={TOP} width={8} height={8} fill={cat(s)} />
            <text x={L + 26 * k + 11} y={TOP + 7.5} fontSize={FONT} fill={TEXT}>{LETTERS[s]}</text>
          </g>
        ))}
        {niceTicks(dmin, dmax, 5).map((t) => (
          <g key={t}>
            {d.grid && <line x1={x(t)} x2={x(t)} y1={top} y2={base} stroke={GRID} />}
            <line x1={x(t)} x2={x(t)} y1={base} y2={base + 3} stroke={AXIS} />
            <text x={x(t)} y={base + 13} fontSize={FONT} textAnchor="middle" fill={TEXT}>{share ? `${fmtTick(100 * t)} %` : fmtTick(t)}</text>
          </g>
        ))}
        {d.groups.map((g, i) => {
          const y0 = top + i * rowH + GAP / 2;
          return (
            <g key={g.path}>
              <title>{`${g.path}: ${what(g)}${share || !d.unit ? '' : ` ${d.unit}`}`}</title>
              {/* a long name cut in the middle: prims named alike differ at the end ('Panel_…ng_name_07') */}
              <text x={L - 4} y={y0 + (slots.length * PITCH) / 2 + 2} fontSize={FONT} textAnchor="end" fill={TEXT}>{g.name.length > CHARS ? `${g.name.slice(0, 6)}…${g.name.slice(g.name.length - CHARS + 7)}` : g.name}</text>
              {g.bars.map((b, k) => (
                <g key={b.slot}>
                  {Number.isFinite(b.v) && <rect x={Math.min(zero, x(b.v))} y={y0 + k * PITCH} width={Math.abs(x(b.v) - zero)} height={BAR} fill={cat(b.slot)} />}
                  <text x={width - 2} y={y0 + k * PITCH + BAR - 0.5} fontSize={FONT} textAnchor="end" fill={TEXT}>{fmt(b.v)}</text>
                </g>
              ))}
            </g>
          );
        })}
        <line x1={L} x2={L + plotW} y1={base} y2={base} stroke={AXIS} />
        <line x1={zero} x2={zero} y1={top} y2={base} stroke={AXIS} />
        <text x={L} y={base + 26} fontSize={FONT} fill={TEXT}>{share ? `share of each part's area ${d.metric} the range` : `${d.metric[0] === 'p' ? d.metric.toUpperCase() : d.metric} per part`}</text>
        {!share && <text x={L + plotW} y={base + 26} fontSize={FONT} textAnchor="end" fill={TEXT}>{d.unit}</text>}
      </svg>
      {d.more > 0 && <p className="text-muted">First {d.groups.length} of {d.groups.length + d.more} parts</p>}
    </>
  );
}
