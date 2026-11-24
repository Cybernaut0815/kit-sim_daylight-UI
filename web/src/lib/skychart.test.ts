import { describe, expect, it } from 'vitest';
import { defaultSettings } from '../store';
import { SKY_DOTS, dotsOf, pathOf, plan, skyActive, skyScaffold, upRuns } from './skychart';
import { sunDir } from './sun';

const site = { lat: 51.5, lon: -0.13, tz: 0, leap: false };
const time = () => defaultSettings().time;
const inside = (runs: [number, number][][]) => runs.every((run) => run.every(([x, y]) => Math.hypot(x, y) <= 1 + 1e-9));

describe('the sky chart', () => {
  it('plan: the zenith at the centre, the horizon at the radius, north up, east right; equidistant in altitude', () => {
    const near = (p: [number, number], q: [number, number]) => { expect(p[0]).toBeCloseTo(q[0], 9); expect(p[1]).toBeCloseTo(q[1], 9); };
    near(plan(90, 123), [0, 0]);
    near(plan(0, 0), [0, -1]);
    near(plan(0, 90), [1, 0]);
    near(plan(0, 180), [0, 1]);
    near(plan(0, 270), [-1, 0]);
    near(plan(30, 0), [0, -2 / 3]);
    near(plan(60, 90), [1 / 3, 0]);
  });

  it('upRuns drops what is below the horizon and ends each run on it', () => {
    const alts = [-20, -5, 10, 40, 10, -5, -20], xyz = alts.flatMap((a, i) => sunDir(a, 60 + 40 * i));
    const runs = upRuns(xyz, alts);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toHaveLength(5); // the crossing, three samples up, the crossing
    expect(Math.hypot(...runs[0][0])).toBeCloseTo(1, 9);
    expect(Math.hypot(...runs[0][4])).toBeCloseTo(1, 9);
    expect(upRuns(xyz, alts.map(() => -1))).toEqual([]);
  });

  it('the scaffold: month arcs, the solstices and an analemma per daylight hour, all on or above the horizon', () => {
    const s = skyScaffold(site);
    expect([s.months.length, s.monthsLate.length, s.solstices.length]).toEqual([5, 5, 2]);
    expect(s.hours.length).toBeGreaterThan(8);
    expect([s.months, s.monthsLate, s.solstices, s.hours, s.hoursLate].every(inside)).toBe(true);
    // the June arc rises higher than the December one: its nearest point to the zenith is closer in
    const top = (run: [number, number][]) => Math.min(...run.map((p) => Math.hypot(...p)));
    expect(top(s.solstices[0])).toBeLessThan(top(s.solstices[1]));
  });

  it('each time mode adds its layer: none for annual, the day and the sun for an instant, the arcs, band and steps for a period', () => {
    expect(skyActive(site, time())).toEqual({ arcs: [], windows: [], band: null, steps: [], hours: [], sun: null });
    const noon = skyActive(site, { ...time(), mode: 'instant', date: '2026-06-21', hour: 720 });
    expect([noon.arcs.length, noon.windows.length, noon.band, noon.steps.length]).toEqual([1, 0, null, 0]);
    expect(noon.sun?.up).toBe(true);
    expect(noon.sun!.at[1]).toBeGreaterThan(0); // in the northern hemisphere the noon sun stands south of the zenith
    expect(noon.hours.length).toBeGreaterThan(10);
    const night = skyActive(site, { ...time(), mode: 'instant', date: '2026-06-21', hour: 60 });
    expect(night.sun?.up).toBe(false);
    expect(Math.hypot(...night.sun!.at)).toBeCloseTo(1, 9); // on the horizon
    const period = skyActive(site, { ...time(), mode: 'range', from: { date: '2026-03-01', hour: 540 }, to: { date: '2026-05-31', hour: 1020 }, stepMin: 60 });
    expect([period.arcs.length, period.windows.length]).toEqual([2, 2]);
    expect(period.band!.length).toBeGreaterThan(50);
    expect(period.band!.every((p) => Math.hypot(...p) <= 1 + 1e-9)).toBe(true);
    expect(period.steps.length).toBe(92 * 8); // 92 days, 09:00 to 17:00 hourly, every step's middle up
    const oneDay = skyActive(site, { ...time(), mode: 'range', from: { date: '2026-06-21', hour: 480 }, to: { date: '2026-06-21', hour: 960 }, stepMin: 30 });
    expect([oneDay.arcs.length, oneDay.band, oneDay.steps.length]).toEqual([1, null, 16]);
    const year = skyActive(site, { ...time(), mode: 'range', from: { date: '2026-01-01', hour: 0 }, to: { date: '2026-12-31', hour: 1440 }, stepMin: 10 });
    expect(year.steps).toEqual([]); // past SKY_DOTS: no dots
    expect(SKY_DOTS).toBeLessThan(52560);
  });

  it('pathOf and dotsOf: one path each, scaled about the centre', () => {
    expect(pathOf([[[0, -1], [1, 0]]], 50, 60)).toBe('M60 10L110 60');
    expect(pathOf([[[0, 0], [0.5, 0]], [[0, 1], [0, 0.5]]], 10, 10, true)).toBe('M10 10L15 10ZM10 20L10 15Z');
    expect(dotsOf([[0, 0], [-1, 0]], 50, 60)).toBe('M60 60h0M10 60h0');
  });
});
