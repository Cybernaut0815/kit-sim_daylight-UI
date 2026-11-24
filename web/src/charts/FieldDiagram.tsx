// The field of view under View analysis > Field of view (lib/viewfield.ts): the plan and the section of the field,
// and its panorama (azimuth across, elevation up) with the thinned cell grid. Static: the inputs above edit it. Drawn
// in the chart greys with hairlines of 1 screen px whatever the panel's width.
import { memo } from 'react';
import { panX, panY, planOutline, rayGrid, sectionOutline, type Fov, type Gaze, type Pt } from '../lib/viewfield';
import { knob } from '../ui';

const R = 36, CY = 56, PLAN = 52, SIDE = 152; // the plan's and the section's radius, centres
const P = { x: 18, y: 8, w: 176, h: 88 }; // the panorama's plot: 360° x 180°
const RAD = Math.PI / 180;
const hair = (w = 1) => ({ vectorEffect: 'non-scaling-stroke', strokeWidth: w }) as const; // w screen px
const FIELD = { fill: 'var(--bg-surface-3)', stroke: 'var(--chart-text-strong)', strokeLinejoin: 'round', ...hair() } as const;
const d = (pts: readonly Pt[], cx: number, cy: number, r: number) => pts.map(([x, y], i) => `${i ? 'L' : 'M'}${(cx + x * r).toFixed(1)} ${(cy + y * r).toFixed(1)}`).join('');
/** Short radial ticks at angles (deg, clockwise from up) on a circle. */
const ticks = (angles: readonly number[], cx: number, cy: number) => angles.map((a) => {
  const s = Math.sin(a * RAD), c = -Math.cos(a * RAD);
  return `M${(cx + s * R).toFixed(1)} ${(cy + c * R).toFixed(1)}L${(cx + s * (R + 3)).toFixed(1)} ${(cy + c * (R + 3)).toFixed(1)}`;
}).join('');
const deg = (x: number) => `${Math.round(x * 10) / 10}°`.replace('-', '−');

function words([h, lo, hi]: Fov, gaze: Gaze, rays: string): string {
  if (h === 360) return lo === 0 && hi === 0 ? `a ring of horizontal rays all around, ${rays}` : `all around from north, ${deg(lo)} to ${deg(hi)} about the horizon, ${rays}`;
  const about = gaze === 'level' ? 'the horizon (level gaze)' : 'the face\'s normal';
  return lo === 0 && hi === 0 ? `a fan ${deg(h)} wide about ${about}, ${rays}` : `${deg(h)} wide, ${deg(lo)} to ${deg(hi)} about ${about}, ${rays}`;
}

export const FieldDiagram = memo(function FieldDiagram({ fov, cell, gaze }: { fov: Fov; cell: number; gaze: Gaze }) {
  const g = rayGrid(fov, cell), [, lo, hi] = fov, side = g.all ? 'horizon' : gaze === 'level' ? 'horizon' : 'normal';
  const rays = `${g.cols} × ${g.rows} rays`, label = words(fov, gaze, rays);
  const sect = sectionOutline(g), mirror = sect.map(([x, y]): Pt => [-x, y]);
  const elTicks = g.flat ? [90] : g.elLines.map((e) => 90 - e);
  const x = (az: number) => P.x + panX(g, az) * P.w, y = (el: number) => P.y + panY(el) * P.h;
  const x0 = x(g.az[0]), x1 = x(g.az[1]), y0 = y(g.flat ? 0 : hi), y1 = y(g.flat ? 0 : lo);
  const across = g.all ? [['N', 0], ['E', 90], ['S', 180], ['W', 270], ['N', 360]] as const : [['behind', -180], ['left', -90], ['gaze', 0], ['right', 90], ['behind', 180]] as const;
  return (
    <div className="grid" style={knob('--grid-min', '14rem')}>
      <svg className="diagram" viewBox="0 0 200 100" role="img" aria-label={`The field in plan and section: ${label}.`}>
        <text x={PLAN - R} y={10} fontSize={8} fill="var(--chart-text)">{g.all ? 'Plan, north up' : 'Plan, gaze up'}</text>
        <text x={SIDE - R} y={10} fontSize={8} fill="var(--chart-text)">Section</text>
        <text x={SIDE - R - 2} y={CY + 2.5} textAnchor="end" fontSize={7} fill="var(--chart-text)">{side}</text>
        <circle cx={PLAN} cy={CY} r={R} fill="none" stroke="var(--chart-axis)" {...hair()} />
        <path d={d(planOutline(g), PLAN, CY, R)} {...FIELD} />
        <path d={ticks(g.all ? g.azLines.slice(0, -1) : g.azLines, PLAN, CY)} stroke="var(--chart-text)" {...hair()} />
        {g.all
          ? <text x={PLAN} y={CY - R + 11} textAnchor="middle" fontSize={8} fill="var(--chart-text-strong)">N</text>
          : <path d={`M${PLAN - R} ${CY}H${PLAN + R}`} stroke="var(--chart-text-strong)" {...hair(1.5)} />}
        <circle cx={SIDE} cy={CY} r={R} fill="none" stroke="var(--chart-axis)" {...hair()} />
        <path d={`M${SIDE - R} ${CY}H${SIDE + R}`} stroke="var(--chart-axis)" strokeDasharray="2 2" {...hair()} />
        <path d={d(sect, SIDE, CY, R) + (g.all ? d(mirror, SIDE, CY, R) : '')} {...FIELD} {...(g.flat ? { fill: 'none', ...hair(1.5) } : {})} />
        <path d={ticks(elTicks, SIDE, CY) + (g.all ? ticks(elTicks.map((a) => -a), SIDE, CY) : '')} stroke="var(--chart-text)" {...hair()} />
        {!g.all && <path d={`M${SIDE} ${CY - R}V${CY + R}`} stroke="var(--chart-text-strong)" {...hair(1.5)} />}
        {!g.flat && [hi, lo].map((e, i) => <text key={i} x={SIDE + Math.cos(e * RAD) * (R + 7)} y={CY - Math.sin(e * RAD) * (R + 7) + 3} fontSize={8} fill="var(--chart-text)">{deg(e)}</text>)}
      </svg>
      <svg className="diagram" viewBox="0 0 200 110" role="img" aria-label={`Panorama of the field, azimuth across and elevation up: ${label}.`}>
        {!g.all && <path d={`M${x(-180)} ${P.y}h${P.w / 4}v${P.h}h${-P.w / 4}ZM${x(90)} ${P.y}h${P.w / 4}v${P.h}h${-P.w / 4}Z`} fill="var(--chart-grid)" />}
        <rect x={P.x} y={P.y} width={P.w} height={P.h} fill="none" stroke="var(--chart-axis)" {...hair()} />
        <path d={`M${P.x} ${y(0)}H${P.x + P.w}`} stroke="var(--chart-axis)" strokeDasharray="2 2" {...hair()} />
        {!g.flat && <rect x={x0} y={y0} width={x1 - x0} height={y1 - y0} fill="var(--bg-surface-3)" />}
        <path d={g.azLines.map((a) => `M${x(a).toFixed(1)} ${y0 - (g.flat ? 3 : 0)}V${y1 + (g.flat ? 3 : 0)}`).join('') + (g.flat ? '' : g.elLines.map((e) => `M${x0} ${y(e).toFixed(1)}H${x1}`).join(''))} stroke="var(--chart-text)" strokeOpacity={0.6} {...hair()} />
        {g.flat
          ? <path d={`M${x0} ${y0}H${x1}`} stroke="var(--chart-text-strong)" {...hair(1.5)} />
          : <rect x={x0} y={y0} width={x1 - x0} height={y1 - y0} {...FIELD} fill="none" />}
        {[90, 0, -90].map((e) => <text key={e} x={P.x - 3} y={y(e) + 3} textAnchor="end" fontSize={8} fill="var(--chart-text)">{deg(e)}</text>)}
        {across.map(([t, a], i) => <text key={i} x={x(a)} y={P.y + P.h + 10} textAnchor={i === 0 ? 'start' : i === across.length - 1 ? 'end' : 'middle'} fontSize={8} fill="var(--chart-text)">{t}</text>)}
      </svg>
    </div>
  );
});
