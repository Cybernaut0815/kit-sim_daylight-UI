// Weather-file digest, coloured from the result gradients: sunshine against the possible daylight per month (with the
// sunshine fraction on top), and monthly horizontal radiation split into its direct and diffuse parts. With no data
// yet it renders same-size placeholders, so the panel does not jump when the file arrives.
import type { ReactNode } from 'react';
import { sum, type EpwMonthly } from '../lib/epw';
import { hexAt, type Gradient } from '../lib/gradients';
import { Swatch } from '../ui';
import { AXIS, FONT, GRID, MONTHS, TEXT, fmtTick, niceTicks } from './axes';

const W = 320, H = 150, L = 34, R = 8, TOP = 18, BOTTOM = 16;
const PW = W - L - R, PH = H - TOP - BOTTOM, BASE = TOP + PH, MW = PW / 12, BW = MW * 0.64;
const bx = (m: number) => L + m * MW + (MW - BW) / 2;

function Chart({ max, unit, label, children }: { max: number; unit: string; label: string; children: (y: (v: number) => number) => ReactNode }) {
  const y = (v: number) => BASE - (v / (max || 1)) * PH;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={label}>
      <text x={0} y={9} fontSize={FONT} fill={TEXT}>{unit}</text>
      {niceTicks(0, max, 4).map((t) => (
        <g key={t}>
          <line x1={L} x2={L + PW} y1={y(t)} y2={y(t)} stroke={GRID} />
          <text x={L - 4} y={y(t) + 3} fontSize={FONT} textAnchor="end" fill={TEXT}>{fmtTick(t)}</text>
        </g>
      ))}
      {children(y)}
      <line x1={L} x2={L + PW} y1={BASE} y2={BASE} stroke={AXIS} />
      {MONTHS.map((m, i) => <text key={i} x={L + (i + 0.5) * MW} y={BASE + 11} fontSize={FONT} textAnchor="middle" fill={TEXT}>{m}</text>)}
    </svg>
  );
}

export function EpwCharts({ monthly, sun, rad }: { monthly: EpwMonthly | null; sun: Gradient; rad: Gradient }) {
  const sunC = hexAt(sun, 0.85), dirC = hexAt(rad, 0.8), difC = hexAt(rad, 0.45);
  const ph = <div className="skeleton chart-ph" aria-hidden="true" />;
  let sunChart: ReactNode = ph, radChart: ReactNode = ph, sunCap: ReactNode = null, radCap: ReactNode = null;
  if (monthly) {
    const { sunshine, daylight, ghi, dni, dhi } = monthly;
    const direct = ghi.map((g, m) => Math.max(0, g - dhi[m])); // direct on the horizontal = global - diffuse
    const sunYear = sum(sunshine), dayYear = sum(daylight);
    sunChart = (
      <Chart max={Math.max(...daylight, 1)} unit="h" label={`Sunshine hours per month, ${Math.round(sunYear)} of ${Math.round(dayYear)} possible hours a year`}>
        {(y) => sunshine.map((h, m) => (
          <g key={m}>
            <rect x={bx(m)} y={y(daylight[m])} width={BW} height={BASE - y(daylight[m])} fill="var(--bg-surface-3)" />
            <rect x={bx(m)} y={y(h)} width={BW} height={BASE - y(h)} fill={sunC}>
              <title>{`${MONTHS[m]}: ${Math.round(h)} h sunshine of ${Math.round(daylight[m])} h daylight`}</title>
            </rect>
            <text x={bx(m) + BW / 2} y={y(daylight[m]) - 3} fontSize={8} textAnchor="middle" fill={TEXT}>{daylight[m] ? Math.round((100 * h) / daylight[m]) : 0}</text>
          </g>
        ))}
      </Chart>
    );
    sunCap = <>
      <span><Swatch color={sunC} /> sunshine {Math.round(sunYear).toLocaleString('en-GB')} h</span>
      <span><Swatch color="var(--bg-surface-3)" /> possible {Math.round(dayYear).toLocaleString('en-GB')} h</span>
      <span>bar labels: % of possible, {dayYear ? Math.round((100 * sunYear) / dayYear) : 0} % a year</span>
    </>;
    radChart = (
      <Chart max={Math.max(...ghi, 1)} unit="kWh/m²" label={`Global horizontal radiation per month, ${Math.round(sum(ghi))} kWh/m² a year: direct ${Math.round(sum(direct))}, diffuse ${Math.round(sum(dhi))}`}>
        {(y) => ghi.map((g, m) => (
          <g key={m}>
            <rect x={bx(m)} y={y(dhi[m])} width={BW} height={BASE - y(dhi[m])} fill={difC}><title>{`${MONTHS[m]}: diffuse ${Math.round(dhi[m])} kWh/m²`}</title></rect>
            <rect x={bx(m)} y={y(g)} width={BW} height={Math.max(0, y(dhi[m]) - y(g))} fill={dirC}><title>{`${MONTHS[m]}: direct ${Math.round(direct[m])} kWh/m², global ${Math.round(g)} kWh/m²`}</title></rect>
          </g>
        ))}
      </Chart>
    );
    radCap = <>
      <span><Swatch color={dirC} /> direct {Math.round(sum(direct)).toLocaleString('en-GB')}</span>
      <span><Swatch color={difC} /> diffuse {Math.round(sum(dhi)).toLocaleString('en-GB')}</span>
      <span>global {Math.round(sum(ghi)).toLocaleString('en-GB')} kWh/m² a year, direct normal {Math.round(sum(dni)).toLocaleString('en-GB')}</span>
    </>;
  }
  return (
    <div className="stack stack--tight">
      <h3>Sunshine per month</h3>
      {sunChart}
      <div className="cluster text-muted lines-3">{sunCap}</div>
      <h3>Horizontal radiation per month</h3>
      {radChart}
      <div className="cluster text-muted lines-3">{radCap}</div>
    </div>
  );
}
