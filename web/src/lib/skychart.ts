// The sky chart under Daylight > Time: the 3D sun path (viewer/sunpath.ts) drawn flat, in plan. An equidistant polar
// projection of the sky: the zenith at the centre, the horizon at radius 1, true north up and east right (SVG y down),
// so a point at altitude a lies (90 - a) / 90 out. The scaffold (the 21st of every month, one analemma per hour) depends
// on the site only; the active layer (the instant's day arc and sun, a period's arcs, band and steps) on the time too.
// Parts below the horizon are left out. Pure: no DOM.
import type { Settings } from '../store';
import { analemma, dayPath, parseHoy, stepHoys, sunAt, sunDir, type Site } from './sun';
import { dateFromDoy, doy, fmtTime, pad, yearOf } from './time';

export type Pt = [number, number];
type Time = Settings['time'];

/** The most step dots drawn (as the 3D sun path caps its own). */
export const SKY_DOTS = 2000;

/** A sky direction (diagram-frame unit vector of sunDir: +Y up, north -Z, east +X) in plan; below the horizon r > 1. */
export function planOf(x: number, y: number, z: number): Pt {
  const h = Math.hypot(x, z), r = Math.acos(Math.max(-1, Math.min(1, y))) / (Math.PI / 2);
  return h > 1e-12 ? [(r * x) / h, (r * z) / h] : [0, 0];
}

/** Altitude and azimuth (deg, clockwise from true north) in plan. */
export const plan = (alt: number, azi: number): Pt => planOf(...sunDir(alt, azi));

/** The runs of a sampled path above the horizon (xyz: diagram-frame unit vectors, alt: their altitudes), each ending on
 *  the horizon where it crosses it; samples [from, to) only. */
export function upRuns(xyz: number[], alt: number[], from = 0, to = alt.length): Pt[][] {
  const runs: Pt[][] = [], at = (i: number) => planOf(xyz[3 * i], xyz[3 * i + 1], xyz[3 * i + 2]);
  const cross = (i: number, j: number): Pt => { // where i -> j meets the horizon: linear in radius, then on the ring
    const a = at(i), b = at(j), ra = Math.hypot(...a), rb = Math.hypot(...b), f = rb === ra ? 0 : (1 - ra) / (rb - ra);
    const p: Pt = [a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1])], r = Math.hypot(...p);
    return r > 0 ? [p[0] / r, p[1] / r] : p;
  };
  let run: Pt[] | null = null;
  for (let i = Math.max(0, from); i < Math.min(to, alt.length); i++) {
    const up = alt[i] >= 0;
    if (up && !run) { run = i > from && alt[i - 1] < 0 ? [cross(i - 1, i)] : []; runs.push(run); }
    if (up) run!.push(at(i));
    else if (run) { run.push(cross(i - 1, i)); run = null; }
  }
  return runs.filter((r) => r.length > 1);
}

export interface SkyScaffold {
  months: Pt[][]; monthsLate: Pt[][]; solstices: Pt[][]; // the 21st: Jan to May, Jul to Nov (dashed), June and December
  hours: Pt[][]; hoursLate: Pt[][];                      // an analemma per whole hour: first half of the year, second (dashed)
}

/** What depends on the site only, as the 3D sun path's fixed layer draws it. */
export function skyScaffold(site: Site): SkyScaffold {
  const s: SkyScaffold = { months: [], monthsLate: [], solstices: [], hours: [], hoursLate: [] };
  for (let m = 1; m <= 12; m++) {
    const p = dayPath(site, `${pad(m)}-21`, 10);
    (m === 6 || m === 12 ? s.solstices : m < 6 ? s.months : s.monthsLate).push(...upRuns(p.xyz, p.alt));
  }
  for (let h = 0; h < 24; h++) {
    const p = analemma(site, h * 60), half = Math.floor(p.alt.length / 2);
    s.hours.push(...upRuns(p.xyz, p.alt, 0, half + 1));
    s.hoursLate.push(...upRuns(p.xyz, p.alt, half));
  }
  return s;
}

export interface SkyActive {
  arcs: Pt[][];          // the instant's day, a period's end days
  windows: Pt[][];       // a period's hours on its end days
  band: Pt[] | null;     // a period over several days: the outline of the sky it sweeps (clamped to the horizon)
  steps: Pt[];           // a period's evaluated steps above the horizon (each at its middle, as the core takes it); none past SKY_DOTS
  hours: Pt[];           // the instant's whole hours above the horizon
  sun: { at: Pt; up: boolean } | null; // the instant's sun (below the horizon: on it)
}

const NONE: SkyActive = { arcs: [], windows: [], band: null, steps: [], hours: [], sun: null };
const mmdd = (date: string, leap: boolean) => fmtTime(date, 0, leap).slice(0, 5);
const clamp = ([x, y]: Pt): Pt => { const r = Math.hypot(x, y); return r > 1 ? [x / r, y / r] : [x, y]; };

/** What the time adds, as the 3D sun path's active layer: nothing for annual. */
export function skyActive(site: Site, t: Time): SkyActive {
  if (t.mode === 'annual') return NONE;
  const at = (date: string, minute: number) => sunAt(site, parseHoy(fmtTime(date, minute, site.leap), site.leap));
  const out: SkyActive = { arcs: [], windows: [], band: null, steps: [], hours: [], sun: null };
  const arc = (date: string, from = 0, to = 1440) => {
    const p = dayPath(site, mmdd(date, site.leap), 5);
    out.arcs.push(...upRuns(p.xyz, p.alt));
    if (t.mode === 'range') out.windows.push(...upRuns(p.xyz, p.alt, Math.round(from / 5), Math.round(to / 5) + 1));
    if (t.mode === 'instant') for (let i = 0; i < p.alt.length - 1; i += 12) if (p.alt[i] >= 0) out.hours.push(planOf(p.xyz[3 * i], p.xyz[3 * i + 1], p.xyz[3 * i + 2]));
  };
  if (t.mode === 'instant') {
    arc(t.date);
    const s = at(t.date, t.hour);
    if (Number.isFinite(s.alt)) out.sun = { at: clamp(plan(s.alt, s.azi)), up: s.up };
    return out;
  }
  const multi = t.from.date !== t.to.date;
  arc(t.from.date, t.from.hour, t.to.hour);
  if (multi) {
    arc(t.to.date, t.from.hour, t.to.hour);
    // the band's outline: the window on the first day, the end hour over the days, the window on the last day back, the
    // start hour back over the days (a period across a solstice folds over itself)
    const year = yearOf(t.from.date), d0 = doy(t.from.date), d1 = doy(t.to.date), k = Math.min(48, d1 - d0 + 1), ring: Pt[] = [];
    const day = (r: number) => dateFromDoy(d0 + Math.round(((d1 - d0) * r) / Math.max(1, k - 1)), year);
    const push = (date: string, minute: number) => { const s = at(date, minute); if (Number.isFinite(s.alt)) ring.push(clamp(plan(s.alt, s.azi))); };
    for (let j = 0; j <= 24; j++) push(t.from.date, t.from.hour + ((t.to.hour - t.from.hour) * j) / 24);
    for (let r = 1; r < k; r++) push(day(r), t.to.hour);
    for (let j = 24; j >= 0; j--) push(t.to.date, t.from.hour + ((t.to.hour - t.from.hour) * j) / 24);
    for (let r = k - 2; r > 0; r--) push(day(r), t.from.hour);
    if (ring.length > 2) out.band = ring;
  }
  const steps = stepHoys(t, site.leap);
  if (steps.length <= SKY_DOTS)
    for (const hoy of steps) { const s = sunAt(site, hoy + t.stepMin / 120); if (s.up) out.steps.push(plan(s.alt, s.azi)); }
  return out;
}

const px = (v: number, r: number, c: number) => Math.round((c + v * r) * 10) / 10;

/** Runs as one SVG path's data, scaled by r about (c, c), 0.1 px steps. */
export function pathOf(runs: readonly Pt[][], r: number, c: number, closed = false): string {
  return runs.map((run) => run.map(([x, y], i) => `${i ? 'L' : 'M'}${px(x, r, c)} ${px(y, r, c)}`).join('') + (closed ? 'Z' : '')).join('');
}

/** Points as one SVG path of zero-length subpaths (a square line cap draws each as a dot), scaled as pathOf. */
export const dotsOf = (pts: readonly Pt[], r: number, c: number): string => pts.map(([x, y]) => `M${px(x, r, c)} ${px(y, r, c)}h0`).join('');
