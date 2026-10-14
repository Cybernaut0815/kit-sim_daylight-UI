// Weather-file digest: sunshine hours per month against the possible daylight hours, and the monthly radiation sums.
import type { EpwMonthly } from '../lib/epw';
import { sum } from '../lib/epw';
import { Swatch } from '../ui';
import { AXIS, FONT, GRID, MONTHS, STRONG, TEXT, fmtTick, niceTicks } from './axes';

const W = 320, H = 150, L = 34, R = 8, TOP = 10, BOTTOM = 22;
const SERIES = [['ghi', 'Global horizontal', '--chart-cat-1'], ['dni', 'Direct normal', '--chart-cat-2'], ['dhi', 'Diffuse horizontal', '--chart-cat-3']] as const;

function Frame({ max, label, children }: { max: number; label: string; children: (x: (m: number, k?: number, of?: number) => number, y: (v: number) => number, plotW: number) => React.ReactNode }) {
  const plotW = W - L - R, plotH = H - TOP - BOTTOM, base = TOP + plotH, mw = plotW / 12;
  const y = (v: number) => base - (v / (max || 1)) * plotH;
  const x = (m: number, k = 0, of = 1) => L + m * mw + (mw / of) * k + 1;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={label}>
      {niceTicks(0, max, 4).map((t) => (
        <g key={t}>
          <line x1={L} x2={L + plotW} y1={y(t)} y2={y(t)} stroke={GRID} />
          <text x={L - 4} y={y(t) + 3} fontSize={FONT} textAnchor="end" fill={TEXT}>{fmtTick(t)}</text>
        </g>
      ))}
      {children(x, y, plotW)}
      <line x1={L} x2={L + plotW} y1={base} y2={base} stroke={AXIS} />
      {MONTHS.map((m, i) => <text key={i} x={L + (i + 0.5) * mw} y={base + 12} fontSize={FONT} textAnchor="middle" fill={TEXT}>{m}</text>)}
    </svg>
  );
}

export function EpwCharts({ monthly }: { monthly: EpwMonthly }) {
  const { sunshine, daylight, ghi, dni, dhi } = monthly, series = { ghi, dni, dhi };
  const hMax = Math.max(...daylight, ...sunshine, 1), rMax = Math.max(...ghi, ...dni, ...dhi, 1);
  const mw = (W - L - R) / 12;
  return (
    <div className="stack stack--tight">
      <h3>Sunshine hours per month</h3>
      <Frame max={hMax} label={`Sunshine hours per month, ${Math.round(sum(sunshine))} h of ${Math.round(sum(daylight))} h daylight a year`}>
        {(x, y) => (
          <>
            {sunshine.map((h, m) => (
              <rect key={m} x={x(m)} y={y(h)} width={mw - 2} height={Math.max(y(0) - y(h), 0)} fill="var(--accent-fill)">
                <title>{`${MONTHS[m]}: ${Math.round(h)} h sunshine (direct normal irradiance of 120 W/m² and more) of ${Math.round(daylight[m])} h daylight`}</title>
              </rect>
            ))}
            <polyline points={daylight.flatMap((h, m) => [`${x(m)},${y(h)}`, `${x(m) + mw - 2},${y(h)}`]).join(' ')} fill="none" stroke={STRONG} strokeWidth={1.5} />
          </>
        )}
      </Frame>
      <div className="cluster text-muted">
        <span><Swatch color="var(--accent-fill)" /> sunshine, DNI at or above 120 W/m²: {Math.round(sum(sunshine)).toLocaleString('en-GB')} h a year</span>
        <span>— daylight, sunrise to sunset: {Math.round(sum(daylight)).toLocaleString('en-GB')} h</span>
      </div>
      <h3>Radiation per month</h3>
      <Frame max={rMax} label={`Monthly radiation in kWh/m²: global horizontal ${Math.round(sum(ghi))}, direct normal ${Math.round(sum(dni))}, diffuse horizontal ${Math.round(sum(dhi))} a year`}>
        {(x, y) => SERIES.map(([key, name, token], k) => series[key].map((v, m) => (
          <rect key={`${key}${m}`} x={x(m, k, 3)} y={y(v)} width={mw / 3 - 1} height={Math.max(y(0) - y(v), 0)} fill={`var(${token})`}>
            <title>{`${MONTHS[m]}: ${name} ${Math.round(v)} kWh/m²`}</title>
          </rect>
        )))}
      </Frame>
      <div className="cluster text-muted">
        {SERIES.map(([key, name, token]) => <span key={key}><Swatch color={`var(${token})`} /> {name} {Math.round(sum(series[key])).toLocaleString('en-GB')} kWh/m²</span>)}
      </div>
    </div>
  );
}
