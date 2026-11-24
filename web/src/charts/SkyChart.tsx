// The sky chart under Daylight > Time: the sun path in plan (lib/skychart.ts), the scaffold of the year and what the time
// mode picks, in the 3D sun path's colours. Static: the 3D view's handles do the dragging.
import { memo, useMemo } from 'react';
import { dotsOf, pathOf, plan, skyActive, skyScaffold } from '../lib/skychart';
import type { Site } from '../lib/sun';
import { fmtClock, fmtDay } from '../lib/time';
import type { Settings } from '../store';

const S = 220, C = S / 2, R = 94; // the view box, its centre, the horizon's radius
const SUN = 'var(--typology-yellow-text)', PERIOD = 'var(--accent-fill)';

function words(t: Settings['time']): string {
  if (t.mode === 'annual') return 'the arcs of every month (the 21st) and the loop of every hour';
  if (t.mode === 'instant') return `the day of ${fmtDay(t.date)} and the sun at ${fmtClock(t.hour)}`;
  return t.from.date === t.to.date ? `${fmtDay(t.from.date)}, ${fmtClock(t.from.hour)} to ${fmtClock(t.to.hour)}`
    : `every day from ${fmtDay(t.from.date)} to ${fmtDay(t.to.date)}, ${fmtClock(t.from.hour)} to ${fmtClock(t.to.hour)}`;
}

export const SkyChart = memo(function SkyChart({ site, time }: { site: Site; time: Settings['time'] }) {
  const { lat, lon, tz, leap } = site;
  const scaffold = useMemo(() => skyScaffold({ lat, lon, tz, leap }), [lat, lon, tz, leap]);
  const active = useMemo(() => skyActive({ lat, lon, tz, leap }, time), [lat, lon, tz, leap, time]);
  const annual = time.mode === 'annual', tok = time.mode === 'range' ? PERIOD : SUN;
  const faint = annual ? 'var(--chart-axis)' : 'var(--chart-grid)', away = lat >= 0 ? 0 : 180; // the ring labels away from the sun
  const p = (runs: Parameters<typeof pathOf>[0], closed = false) => pathOf(runs, R, C, closed);
  const at = (alt: number, azi: number, r = 1) => { const [x, y] = plan(alt, azi); return { x: C + x * R * r, y: C + y * R * r }; };
  const compass = [['N', 0], ['E', 90], ['S', 180], ['W', 270]] as const;
  return (
    <svg className="diagram" viewBox={`0 0 ${S} ${S}`} role="img" aria-label={`Sky chart in plan, north up: ${words(time)}.`}>
      <circle cx={C} cy={C} r={R} fill="var(--bg-surface-2)" stroke="var(--chart-axis)" />
      {[30, 60].map((a) => <circle key={a} cx={C} cy={C} r={(R * (90 - a)) / 90} fill="none" stroke="var(--chart-grid)" />)}
      <path d={`M${C} ${C - R}V${C + R}M${C - R} ${C}H${C + R}`} stroke="var(--chart-grid)" />
      {[30, 60].map((a) => { const q = at(a, away); return <text key={a} x={q.x + 3} y={q.y - 2} fontSize={8} fill="var(--chart-text)">{`${a}°`}</text>; })}
      {compass.map(([n, azi]) => { const q = at(0, azi, 1.08); return <text key={n} x={q.x} y={q.y + 3.5} textAnchor="middle" fontSize={10} fill="var(--chart-text-strong)">{n}</text>; })}
      <g fill="none" strokeLinejoin="round">
        <path d={p(scaffold.hours)} stroke={faint} />
        <path d={p(scaffold.hoursLate)} stroke={faint} strokeDasharray="3 2" />
        <path d={p(scaffold.months)} stroke={faint} />
        <path d={p(scaffold.monthsLate)} stroke={faint} strokeDasharray="3 2" />
        <path d={p(scaffold.solstices)} stroke="var(--chart-axis)" strokeWidth={1.5} />
        {active.band && <path d={p([active.band], true)} fill="var(--accent-subtle)" stroke="none" />}
        <path d={p(active.arcs)} stroke={tok} strokeWidth={time.mode === 'range' ? 1 : 2} />
        <path d={p(active.windows)} stroke={tok} strokeWidth={2.5} />
        <path d={dotsOf(active.hours, R, C)} stroke={tok} strokeWidth={3} strokeLinecap="square" />
        <path d={dotsOf(active.steps, R, C)} stroke={tok} strokeWidth={2} strokeLinecap="square" />
      </g>
      {active.sun && (
        <g opacity={active.sun.up ? 1 : 0.35}>
          <circle cx={C + active.sun.at[0] * R} cy={C + active.sun.at[1] * R} r={9} fill="var(--color-typology-yellow)" opacity={0.35} />
          <circle cx={C + active.sun.at[0] * R} cy={C + active.sun.at[1] * R} r={4.5} fill={SUN} />
        </g>
      )}
    </svg>
  );
});
