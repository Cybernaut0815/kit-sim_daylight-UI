// Cumulative area curve: the share of area at or below each value ("x % of the area gets less than v"), with the
// problem range tinted, P10 / P50 / P90 marked and the cursor value's percentile.
import { type Scale } from '../lib/gradients';
import { fmtNum, percentile, shareBelow, type Cumulative } from '../lib/result';
import { pct } from '../ui';
import { AXIS, FONT, GRID, STRONG, TEXT, fmtTick, niceTicks } from './axes';

const W = 320, H = 170, L = 34, R = 8, TOP = 10, BOTTOM = 30;

export function AreaCurve({ cum, domain, scale, unit, probe }: { cum: Cumulative; domain: [number, number]; scale: Scale; unit: string; probe: number | null }) {
  const [dmin, dmax] = domain, plotW = W - L - R, plotH = H - TOP - BOTTOM, base = TOP + plotH;
  const x = (v: number) => L + Math.min(Math.max((v - dmin) / (dmax - dmin || 1), 0), 1) * plotW;
  const y = (share: number) => base - share * plotH;
  const n = cum.v.length, step = Math.max(1, Math.floor(n / 200));
  const pts: string[] = [`${x(dmin)},${y(0)}`];
  for (let i = 0; i < n; i += step) pts.push(`${x(cum.v[i])},${y(cum.cw[i])}`);
  if (n) pts.push(`${x(cum.v[n - 1])},${y(1)}`, `${x(dmax)},${y(1)}`);
  const p = probe !== null && Number.isFinite(probe) ? { x: x(probe), share: shareBelow(cum, probe) } : null;
  const xTicks = niceTicks(dmin, dmax, 6);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`Cumulative share of area by ${unit} value; P10 ${fmtNum(percentile(cum, 0.1))}, median ${fmtNum(percentile(cum, 0.5))}, P90 ${fmtNum(percentile(cum, 0.9))}`}>
      {scale.lo !== null && scale.lo > dmin && <rect x={L} y={TOP} width={x(scale.lo) - L} height={plotH} fill={scale.below} opacity={0.12} />}
      {scale.hi !== null && scale.hi < dmax && <rect x={x(scale.hi)} y={TOP} width={L + plotW - x(scale.hi)} height={plotH} fill={scale.above} opacity={0.12} />}
      {[0.25, 0.5, 0.75, 1].map((s) => <line key={s} x1={L} x2={L + plotW} y1={y(s)} y2={y(s)} stroke={GRID} />)}
      {[0, 0.25, 0.5, 0.75, 1].map((s) => <text key={s} x={L - 4} y={y(s) + 3} fontSize={FONT} textAnchor="end" fill={TEXT}>{`${100 * s} %`}</text>)}
      <polyline points={pts.join(' ')} fill="none" stroke={STRONG} strokeWidth={1.5} />
      {[0.1, 0.5, 0.9].map((q) => {
        const v = percentile(cum, q);
        return Number.isFinite(v) && (
          <g key={q}>
            <circle cx={x(v)} cy={y(q)} r={2.5} fill={STRONG} />
            <text x={x(v) + 4} y={y(q) - 3} fontSize={FONT} fill={TEXT}>{`P${Math.round(100 * q)} ${fmtNum(v)}`}</text>
          </g>
        );
      })}
      {p && (
        <g aria-label={`cursor: ${pct(p.share)} of the area below ${fmtNum(probe!)} ${unit}`}>
          <line x1={p.x} x2={p.x} y1={TOP} y2={base} stroke={STRONG} strokeWidth={2} strokeDasharray="4 2" />
          <line x1={L} x2={p.x} y1={y(p.share)} y2={y(p.share)} stroke={STRONG} strokeDasharray="4 2" />
          <circle cx={p.x} cy={y(p.share)} r={3.5} fill={STRONG} />
        </g>
      )}
      <line x1={L} x2={L + plotW} y1={base} y2={base} stroke={AXIS} />
      {xTicks.map((t) => (
        <g key={t}>
          <line x1={x(t)} x2={x(t)} y1={base} y2={base + 3} stroke={AXIS} />
          <text x={x(t)} y={base + 14} fontSize={FONT} textAnchor="middle" fill={TEXT}>{fmtTick(t)}</text>
        </g>
      ))}
      <text x={L + plotW} y={base + 26} fontSize={FONT} textAnchor="end" fill={TEXT}>{unit}</text>
      <text x={L} y={base + 26} fontSize={FONT} fill={TEXT}>share of area at or below the value</text>
    </svg>
  );
}
