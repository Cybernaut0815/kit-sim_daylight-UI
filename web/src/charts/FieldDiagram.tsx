// The field of view under View analysis > Field of view (lib/viewfield.ts): the plan and the section of the field,
// and its panorama (azimuth across, elevation up) with the thinned cell grid. Static: the inputs above edit it. Drawn
// like the sky chart (Daylight > Time): chart greys, a dashed 30° scaffold, the field's rays dotted, hairlines in screen
// px whatever the panel's width.
import { memo } from 'react';
import { panX, panY, planOutline, rayGrid, sectionOutline, type Fov, type Gaze, type Pt } from '../lib/viewfield';
import { knob } from '../ui';

const R = 36, CY = 56, PLAN = 48, SIDE = 156; // the plan's and the section's radius, centres
const P = { x: 18, y: 8, w: 176, h: 88 }; // the panorama's plot: 360° x 180°
const RAD = Math.PI / 180, LINES = 12, HUB = 7; // the most cell lines a direction draws, + 1; where the dotted rays start
const hair = (w: number) => ({ vectorEffect: 'non-scaling-stroke', strokeWidth: w, fill: 'none' }) as const; // w screen px
const DASHED = { stroke: 'var(--chart-grid)', strokeDasharray: '3 2', ...hair(0.5) } as const; // the 30° scaffold
const DOTTED = { stroke: 'var(--chart-text)', strokeDasharray: '1 1.5', ...hair(0.5) } as const; // the field's cell lines
const OUTLINE = { stroke: 'var(--chart-text-strong)', strokeLinejoin: 'round', ...hair(0.75) } as const;
const DISC = { fill: 'var(--bg-surface-2)', stroke: 'var(--chart-axis)', vectorEffect: 'non-scaling-stroke', strokeWidth: 0.75 } as const;
const EVERY = (step: number, to = 360) => Array.from({ length: Math.round(to / step) }, (_, i) => i * step);
const d = (pts: readonly Pt[], cx: number, cy: number, r: number) => pts.map(([x, y], i) => `${i ? 'L' : 'M'}${(cx + x * r).toFixed(1)} ${(cy + y * r).toFixed(1)}`).join('');
/** Radial strokes at angles (deg, clockwise from up) from radius r0 to r1 about (cx, cy). */
const rays = (angles: readonly number[], cx: number, cy: number, r0: number, r1: number) => angles.map((a) => {
  const s = Math.sin(a * RAD), c = -Math.cos(a * RAD);
  return `M${(cx + s * r0).toFixed(1)} ${(cy + c * r0).toFixed(1)}L${(cx + s * r1).toFixed(1)} ${(cy + c * r1).toFixed(1)}`;
}).join('');
/** A circle's scaffold: dashed spokes every 30°, a tick every 10° outside (longer every 30°). */
const scaffold = (cx: number) => (
  <>
    <path d={rays(EVERY(30), cx, CY, 0, R)} {...DASHED} />
    <path d={rays(EVERY(10).filter((a) => a % 30), cx, CY, R, R + 1.5)} stroke="var(--chart-axis)" {...hair(0.5)} />
    <path d={rays(EVERY(30), cx, CY, R, R + 3)} stroke="var(--chart-axis)" {...hair(0.5)} />
  </>
);
const deg = (x: number) => `${Math.round(x * 10) / 10}°`.replace('-', '−');

function words([h, lo, hi]: Fov, gaze: Gaze, rays: string): string {
  if (h === 360) return lo === 0 && hi === 0 ? `a ring of horizontal rays all around, ${rays}` : `all around from north, ${deg(lo)} to ${deg(hi)} about the horizon, ${rays}`;
  const about = gaze === 'level' ? 'the horizon (level gaze)' : 'the face\'s normal';
  return lo === 0 && hi === 0 ? `a fan ${deg(h)} wide about ${about}, ${rays}` : `${deg(h)} wide, ${deg(lo)} to ${deg(hi)} about ${about}, ${rays}`;
}

export const FieldDiagram = memo(function FieldDiagram({ fov, cell, gaze }: { fov: Fov; cell: number; gaze: Gaze }) {
  const g = rayGrid(fov, cell, LINES), [, lo, hi] = fov, side = g.all ? 'horizon' : gaze === 'level' ? 'horizon' : 'normal';
  const label = words(fov, gaze, `${g.cols} × ${g.rows} rays`);
  const sect = sectionOutline(g), mirror = sect.map(([x, y]): Pt => [-x, y]);
  const elAngles = g.flat ? [] : g.elLines.map((e) => 90 - e), azAngles = g.all ? g.azLines.slice(0, -1) : g.azLines;
  const x = (az: number) => P.x + panX(g, az) * P.w, y = (el: number) => P.y + panY(el) * P.h;
  const x0 = x(g.az[0]), x1 = x(g.az[1]), y0 = y(g.flat ? 0 : hi), y1 = y(g.flat ? 0 : lo);
  const across = g.all ? [['N', 0], ['E', 90], ['S', 180], ['W', 270], ['N', 360]] as const : [['behind', -180], ['left', -90], ['gaze', 0], ['right', 90], ['behind', 180]] as const;
  return (
    <div className="grid" style={knob('--grid-min', '14rem')}>
      <svg className="diagram" viewBox="0 0 200 100" role="img" aria-label={`The field in plan and section: ${label}.`}>
        <text x={PLAN - R} y={10} fontSize={8} fill="var(--chart-text)">{g.all ? 'Plan, north up' : 'Plan, gaze up'}</text>
        <text x={SIDE - R} y={10} fontSize={8} fill="var(--chart-text)">Section</text>
        <text x={SIDE - R - 4} y={CY + 2.5} textAnchor="end" fontSize={7} fill="var(--chart-text)">{side}</text>
        <circle cx={PLAN} cy={CY} r={R} {...DISC} />
        {scaffold(PLAN)}
        <path d={d(planOutline(g), PLAN, CY, R)} fill="var(--bg-surface-3)" />
        <path d={rays(azAngles, PLAN, CY, HUB, R)} {...DOTTED} />
        <path d={d(planOutline(g), PLAN, CY, R)} {...OUTLINE} />
        {g.all
          ? <text x={PLAN} y={CY - R + 11} textAnchor="middle" fontSize={8} fill="var(--chart-text-strong)">N</text>
          : <path d={`M${PLAN - R} ${CY}H${PLAN + R}`} stroke="var(--chart-text-strong)" {...hair(1)} />}
        <circle cx={SIDE} cy={CY} r={R} {...DISC} />
        {scaffold(SIDE)}
        <path d={`M${SIDE - R} ${CY}H${SIDE + R}`} stroke="var(--chart-axis)" strokeDasharray="3 2" {...hair(0.75)} />
        {!g.flat && <path d={d(sect, SIDE, CY, R) + (g.all ? d(mirror, SIDE, CY, R) : '')} fill="var(--bg-surface-3)" />}
        <path d={rays(elAngles, SIDE, CY, HUB, R) + (g.all ? rays(elAngles.map((a) => -a), SIDE, CY, HUB, R) : '')} {...DOTTED} />
        <path d={d(sect, SIDE, CY, R) + (g.all ? d(mirror, SIDE, CY, R) : '')} {...OUTLINE} {...(g.flat ? hair(1) : {})} />
        {!g.all && <path d={`M${SIDE} ${CY - R}V${CY + R}`} stroke="var(--chart-text-strong)" {...hair(1)} />}
        {!g.flat && [hi, lo].map((e, i) => <text key={i} x={SIDE + Math.cos(e * RAD) * (R + 7)} y={CY - Math.sin(e * RAD) * (R + 7) + 3} fontSize={7} fill="var(--chart-text)">{deg(e)}</text>)}
      </svg>
      <svg className="diagram" viewBox="0 0 200 110" role="img" aria-label={`Panorama of the field, azimuth across and elevation up: ${label}.`}>
        <rect x={P.x} y={P.y} width={P.w} height={P.h} fill={DISC.fill} />
        {!g.all && <path d={`M${x(-180)} ${P.y}h${P.w / 4}v${P.h}h${-P.w / 4}ZM${x(90)} ${P.y}h${P.w / 4}v${P.h}h${-P.w / 4}Z`} fill="var(--bg-surface-1)" />}
        <rect x={P.x} y={P.y} width={P.w} height={P.h} {...DISC} fill="none" />
        <path d={EVERY(30, 360).slice(1).map((a) => `M${(P.x + (a / 360) * P.w).toFixed(1)} ${P.y}v${P.h}`).join('') + [60, 30, -30, -60].map((e) => `M${P.x} ${y(e).toFixed(1)}h${P.w}`).join('')} {...DASHED} />
        <path d={`M${P.x} ${y(0)}H${P.x + P.w}`} stroke="var(--chart-axis)" strokeDasharray="3 2" {...hair(0.75)} />
        {!g.flat && <rect x={x0} y={y0} width={x1 - x0} height={y1 - y0} fill="var(--bg-surface-3)" />}
        <path d={g.azLines.map((a) => `M${x(a).toFixed(1)} ${y0 - (g.flat ? 3 : 0)}V${y1 + (g.flat ? 3 : 0)}`).join('') + (g.flat ? '' : g.elLines.map((e) => `M${x0} ${y(e).toFixed(1)}H${x1}`).join(''))} {...DOTTED} />
        {g.flat
          ? <path d={`M${x0} ${y0}H${x1}`} stroke="var(--chart-text-strong)" {...hair(1)} />
          : <rect x={x0} y={y0} width={x1 - x0} height={y1 - y0} {...OUTLINE} />}
        {[90, 0, -90].map((e) => <text key={e} x={P.x - 3} y={y(e) + 3} textAnchor="end" fontSize={7} fill="var(--chart-text)">{deg(e)}</text>)}
        {across.map(([t, a], i) => <text key={i} x={x(a)} y={P.y + P.h + 10} textAnchor={i === 0 ? 'start' : i === across.length - 1 ? 'end' : 'middle'} fontSize={7} fill="var(--chart-text)">{t}</text>)}
      </svg>
    </div>
  );
});
