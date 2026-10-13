// Cumulative area curve: the share of area at or below each value (reads "x % of the area gets less than v");
// the problem range tints the ends, the cursor value shows its percentile.
import { ABOVE_VAR, BELOW_VAR, type Scale } from '../lib/gradients';
import { fmtNum, shareBelow, type Cumulative } from '../lib/result';
import { pct } from '../ui';

const W = 320, H = 120, PX = 30, TOP = 8, BOTTOM = 18;

export function AreaCurve({ cum, domain, scale, unit, probe }: { cum: Cumulative; domain: [number, number]; scale: Scale; unit: string; probe: number | null }) {
  const [dmin, dmax] = domain, plotH = H - TOP - BOTTOM, base = TOP + plotH, right = W - 6;
  const x = (v: number) => PX + (Math.min(Math.max((v - dmin) / (dmax - dmin || 1), 0), 1)) * (right - PX);
  const y = (share: number) => base - share * plotH;
  const n = cum.v.length, step = Math.max(1, Math.floor(n / 160));
  const pts: string[] = [`${x(dmin)},${y(0)}`];
  for (let i = 0; i < n; i += step) pts.push(`${x(cum.v[i])},${y(cum.cw[i])}`);
  if (n) pts.push(`${x(cum.v[n - 1])},${y(1)}`, `${x(dmax)},${y(1)}`);
  const p = probe !== null && Number.isFinite(probe) ? { x: x(probe), share: shareBelow(cum, probe) } : null;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`Cumulative share of area by ${unit} value`}>
      {scale.lo !== null && scale.lo > dmin && <rect x={PX} y={TOP} width={x(scale.lo) - PX} height={plotH} fill={`var(${BELOW_VAR})`} opacity={0.15} />}
      {scale.hi !== null && scale.hi < dmax && <rect x={x(scale.hi)} y={TOP} width={right - x(scale.hi)} height={plotH} fill={`var(${ABOVE_VAR})`} opacity={0.15} />}
      {[0.5, 1].map((s) => <line key={s} x1={PX} x2={right} y1={y(s)} y2={y(s)} stroke="var(--chart-grid)" />)}
      {[0, 0.5, 1].map((s) => <text key={s} x={PX - 4} y={y(s) + 3} fontSize={9} textAnchor="end" fill="var(--chart-text)">{`${100 * s} %`}</text>)}
      <polyline points={pts.join(' ')} fill="none" stroke="var(--chart-text-strong)" strokeWidth={1.5} />
      {p && (
        <g aria-label={`cursor: ${pct(p.share)} of the area below ${fmtNum(probe!)} ${unit}`}>
          <line x1={p.x} x2={p.x} y1={TOP} y2={base} stroke="var(--chart-text-strong)" strokeWidth={2} strokeDasharray="3 2" />
          <line x1={PX} x2={p.x} y1={y(p.share)} y2={y(p.share)} stroke="var(--chart-text-strong)" strokeDasharray="3 2" />
          <circle cx={p.x} cy={y(p.share)} r={3} fill="var(--chart-text-strong)" />
        </g>
      )}
      <line x1={PX} x2={right} y1={base} y2={base} stroke="var(--chart-axis)" />
      <text x={PX} y={H - 5} fontSize={9} fill="var(--chart-text)">{fmtNum(dmin)}</text>
      <text x={right} y={H - 5} fontSize={9} textAnchor="end" fill="var(--chart-text)">{`${fmtNum(dmax)} ${unit}`}</text>
    </svg>
  );
}
