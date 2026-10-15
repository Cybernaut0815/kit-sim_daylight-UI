import { Object3D, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { defaultSettings, type Settings, type TimePoint } from '../store';
import { altAzi, analemma, dayBounds, dayPath, decOf, decTable, dragDay, hoyToDate, nearestMinute, parseHoy, round2, startDayDrag, stepHoys, sunAt, sunDir, sunNoaa, type Site } from './sun';
import { doy, pad } from './time';

// The core's tests/check_solar.cpp kGold (ladybug-core 0.44 Sunpath): lat, lon, tz, hoy, leap, alt, azi, up
const GOLD = [
  [42.35, -71.07, -5, 12.5, 0, 24.0339386184163, 190.570642204051, 1],
  [42.35, -71.07, -5, 4000.5, 0, 29.08381246151125, 276.17896241480855, 1],
  [42.35, -71.07, -5, 6000.25, 0, -41.44263283012595, 10.983536987101843, 0],
  [42.35, -71.07, -5, 8759.5, 0, -70.30471699994148, 347.8405810050913, 0],
  [42.35, -71.07, -5, 1428.5, 1, 39.48797980663118, 190.7228271557164, 1],
  [42.35, -71.07, -5, 6000.25, 1, -41.17039406533562, 10.845617532167182, 0],
  [-33.87, 151.21, 10, 12.5, 0, 77.13561721832852, 325.6862040558454, 1],
  [-33.87, 151.21, 10, 4000.5, 0, 3.5430411612210313, 301.1471210914584, 1],
  [-33.87, 151.21, 10, 6000.25, 0, -61.52147685262607, 168.5136689766449, 0],
  [-33.87, 151.21, 10, 8759.5, 0, -32.671122980132544, 187.7313007570311, 0],
  [-33.87, 151.21, 10, 1428.5, 1, 63.47570158069742, 347.5427234050982, 1],
  [-33.87, 151.21, 10, 6000.25, 1, -61.81145969247512, 168.54733691494903, 0],
  [69.65, 18.96, 1, 12.5, 0, -2.8060492434552717, 189.71332252273297, 0],
  [69.65, 18.96, 1, 4000.5, 0, 28.348217517311056, 260.943393834801, 1],
  [69.65, 18.96, 1, 6000.25, 0, -14.404862608925326, 8.487049213244063, 0],
  [69.65, 18.96, 1, 8759.5, 0, -43.295128829433864, 354.4791363604088, 0],
  [69.65, 18.96, 1, 1428.5, 1, 12.506761401540151, 188.4741942527532, 1],
  [69.65, 18.96, 1, 6000.25, 1, -14.124331495896154, 8.405926941386554, 0],
  [1.35, 103.82, 8, 12.5, 0, 63.953180935220225, 159.62552457750758, 1],
  [1.35, 103.82, 8, 4000.5, 0, 35.840247685373875, 298.1647603729691, 1],
  [1.35, 103.82, 8, 6000.25, 0, -76.11471777161485, 301.2009173781879, 0],
  [1.35, 103.82, 8, 8759.5, 0, -57.832628764322145, 225.72183675574692, 0],
  [1.35, 103.82, 8, 1428.5, 1, 75.0873589975341, 128.06493639024552, 1],
  [1.35, 103.82, 8, 6000.25, 1, -75.91337880896288, 302.0675774002865, 0],
  [28.6, 77.2, 5.5, 12.5, 0, 38.42996071686319, 181.53487192212, 1],
  [28.6, 77.2, 5.5, 4000.5, 0, 34.6367900660623, 279.9266392744926, 1],
  [28.6, 77.2, 5.5, 6000.25, 0, -55.60136715411337, 358.2081230414227, 0],
  [28.6, 77.2, 5.5, 8759.5, 0, -76.56423773821679, 291.3410151747154, 0],
  [28.6, 77.2, 5.5, 1428.5, 1, 53.62972517352374, 178.46450224504974, 1],
  [28.6, 77.2, 5.5, 6000.25, 1, -55.31611991426416, 358.10944649135683, 0],
  // refraction branches (Boston): > 5 deg, 0..5 deg polynomial, below -0.575 deg, exact x.0 hours
  [42.35, -71.07, -5, 4001.0, 0, 23.61253947328314, 280.82961400006536, 1],
  [42.35, -71.07, -5, 4003.0, 0, 3.079793521974994, 299.4863519386687, 1],
  [42.35, -71.07, -5, 4747.5, 0, -2.6631840530198203, 302.01819322052427, 0],
  [42.35, -71.07, -5, 4747.7, 0, -4.570041547695895, 304.11659632398306, 0],
  [42.35, -71.07, -5, 100.0, 0, -34.9456080460268, 89.79282732386088, 0],
];
const boston: Site = { lat: 42.35, lon: -71.07, tz: -5, leap: false };
const london: Site = { lat: 51.5074, lon: -0.1278, tz: 0, leap: false };
const dist = (a: ArrayLike<number>, b: ArrayLike<number>) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe('sun position (core port)', () => {
  it('matches all core goldens: hoy -> hoyToDate -> sunNoaa, as check_solar.cpp', () => {
    expect(GOLD).toHaveLength(35);
    for (const [lat, lon, tz, hoy, leap, alt, azi, up] of GOLD) {
      const d = hoyToDate(hoy, !!leap), s = sunNoaa(lat, lon, tz, d.month, d.day, d.hour, !!leap), at = `${lat} ${lon} hoy ${hoy} leap ${leap}`;
      expect(Math.abs(s.alt - alt), at).toBeLessThan(1e-5);
      expect(Math.abs(s.azi - azi), at).toBeLessThan(1e-5);
      expect(s.up, at).toBe(!!up);
    }
  });
  it('rounds the day fraction like printf("%.2f"): exact binary ties to even', () => {
    expect(round2(0.125)).toBe(0.12); // 03:00, toFixed gives 0.13
    expect(round2(0.625)).toBe(0.62); // 15:00
    expect(round2(0.375)).toBe(0.38);
    expect(round2(0.135)).toBe(0.14); // no tie: the double is just above 0.135
    expect(round2(615 / 1440)).toBe(0.43);
  });
  it('sunDir: true north is -Z; a group rotated by north about +Y gives the core rotate_z vector', () => {
    expect(hoyToDate(4000.5, false)).toEqual({ month: 6, day: 16, hour: 16.5 });
    const s = sunAt(boston, 4000.5), v = sunDir(s.alt, s.azi);
    expect(dist(v, [-0.8688326578327976, 0.4860884977817768, -0.0940626653218609])).toBeLessThan(1e-5); // core vec (x, z, -y)
    const g = new Object3D();
    g.rotation.y = (30 * Math.PI) / 180;
    g.updateMatrixWorld();
    const w = g.localToWorld(new Vector3(...v)), t = Math.PI / 6;
    expect(dist([w.x, w.y, w.z], [-0.799462485981686, 0.4860884977817768, 0.35295567119999366])).toBeLessThan(1e-5); // rotate_z(vec, 30)
    expect(dist([w.x, w.y, w.z], [v[0] * Math.cos(t) + v[2] * Math.sin(t), v[1], -v[0] * Math.sin(t) + v[2] * Math.cos(t)])).toBeLessThan(1e-12);
  });
  it('altAzi inverts sunDir for any length; decOf gives the declination back up to refraction', () => {
    const v = sunDir(30, 200), a = altAzi(...v), b = altAzi(2 * v[0], 2 * v[1], 2 * v[2]);
    expect([a.alt, a.azi, b.alt, b.azi].map((x) => Math.round(x * 1e9) / 1e9)).toEqual([30, 200, 30, 200]);
    const n = altAzi(...sunDir(5, 359.9999999999)).azi;
    expect(n >= 0 && n < 360).toBe(true);
    for (let m = 1; m <= 12; m++) {
      const s = sunAt(london, parseHoy(`${pad(m)}-15T10:00`, false)), d = altAzi(...sunDir(s.alt, s.azi));
      expect(Math.abs(decOf(london.lat, d.alt, d.azi) - s.dec)).toBeLessThan(0.1);
    }
  });
});

describe('core calendar', () => {
  it('parseHoy / hoyToDate mirror parse_hoy / hoy_to_date', () => {
    expect(parseHoy('06-21T06:00', false)).toBe(4110);
    expect(parseHoy('2017-06-21T12:30', false)).toBe(4116.5);
    expect(hoyToDate(4116.5, false)).toEqual({ month: 6, day: 21, hour: 12.5 });
    const end = parseHoy('12-31T23:59', false), e = hoyToDate(end, false);
    expect(Math.abs(end - (8759 + 59 / 60))).toBeLessThan(1e-12);
    expect([e.month, e.day, Math.abs(e.hour - (23 + 59 / 60)) < 1e-12]).toEqual([12, 31, true]);
    expect(parseHoy('01-01T00:00', true)).toBe(0);
    expect(parseHoy('02-29T00:00', true)).toBe(1416);
    expect(hoyToDate(1416, true)).toEqual({ month: 2, day: 29, hour: 0 });
    expect([parseHoy('03-01T00:00', true), parseHoy('03-01T00:00', false), parseHoy('12-31T00:00', true)]).toEqual([1440, 1416, 365 * 24]);
    for (const bad of ['02-29T00:00', '13-01T00:00', '06-21T24:00', '06-21T12:60', 'garbage', '06-21', '']) expect(parseHoy(bad, false), bad).toBeNaN();
  });
  it('every hoy survives hoyToDate -> MM-DDTHH:MM -> parseHoy', () => {
    for (let r = 0; r < 8784; r += 7) {
      const { month, day, hour } = hoyToDate(r + 0.25, true), h = Math.trunc(hour);
      expect(parseHoy(`${pad(month)}-${pad(day)}T${pad(h)}:${pad(Math.round((hour - h) * 60))}`, true)).toBe(r + 0.25);
    }
  });
});

describe('stepHoys (make_steps)', () => {
  const T = defaultSettings().time; // spread, so Settings['time'] fields added later keep their defaults
  const range = (from: TimePoint, to: TimePoint, stepMin: number): Settings['time'] => ({ ...T, mode: 'range', from, to, stepMin });
  const at = (date: string, hour: number): TimePoint => ({ date, hour });
  const hoy = (ts: string) => parseHoy(ts, false);
  it('instant: one exact step; annual: none', () => {
    expect(stepHoys({ ...T, mode: 'instant', date: '2026-06-21', hour: 360 }, false)).toEqual([4110]);
    expect(stepHoys({ ...T, mode: 'instant', date: '2028-02-29', hour: 360 }, false)).toEqual([]); // Feb 29 without a leap EPW
    expect(stepHoys({ ...T, mode: 'annual' }, false)).toEqual([]);
  });
  it('range: [from, to) every stepMin, no fp extra step, 24:00 of Dec 31 capped at 23:59', () => {
    expect(stepHoys(range(at('2026-06-21', 360), at('2026-06-21', 540), 30), false)).toEqual([4110, 4110.5, 4111, 4111.5, 4112, 4112.5]);
    const ten = stepHoys(range(at('2026-06-21', 360), at('2026-06-21', 420), 10), false);
    expect(ten).toHaveLength(6);
    expect(Math.abs(ten[5] - (4110 + 50 / 60))).toBeLessThan(1e-9);
    const eoy = stepHoys(range(at('2026-12-31', 1380), at('2026-12-31', 1440), 10), false);
    expect(eoy).toHaveLength(6);
    expect(Math.abs(eoy[5] - (8759 + 50 / 60))).toBeLessThan(1e-9);
    const day = stepHoys(range(at('2026-12-31', 0), at('2026-12-31', 1440), 60), false); // same day: no window
    expect(day).toEqual(Array.from({ length: 24 }, (_, k) => 8736 + k));
  });
  it('dates differ: only the daily window [from.hour, to.hour) (--hours)', () => {
    const st = stepHoys(range(at('2026-06-01', 480), at('2026-06-03', 1080), 60), false);
    expect(st).toHaveLength(30);
    expect([st[0], st[9], st[10], st[29]]).toEqual([hoy('06-01T08:00'), hoy('06-01T17:00'), hoy('06-02T08:00'), hoy('06-03T17:00')]);
    expect(stepHoys(range(at('2026-06-01', 0), at('2026-06-03', 1440), 60), false)).toHaveLength(72);
    expect(stepHoys(range(at('2026-06-01', 1080), at('2026-06-03', 480), 60), false)).toEqual([]); // --hours 18:00-08:00: rejected
  });
  it('[] where the core rejects the range', () => {
    expect(stepHoys(range(at('2026-06-21', 540), at('2026-06-21', 360), 30), false)).toEqual([]);
    expect(stepHoys(range(at('2028-02-29', 480), at('2028-03-02', 1080), 60), false)).toEqual([]); // Feb 29 without a leap EPW
    expect(stepHoys(range(at('2026-06-21', 360), at('2026-06-21', 540), 0), false)).toEqual([]);
  });
});

describe('sampling', () => {
  it('dayPath: 289 unit samples 00:00..24:00, highest near due south at London midsummer', () => {
    const p = dayPath(london, '06-21');
    expect([p.min.length, p.alt.length, p.xyz.length, p.min[0], p.min[288]]).toEqual([289, 289, 3 * 289, 0, 1440]);
    for (let i = 0; i < 289; i++) expect(Math.abs(Math.hypot(p.xyz[3 * i], p.xyz[3 * i + 1], p.xyz[3 * i + 2]) - 1)).toBeLessThan(1e-9);
    expect(p.alt.every(Number.isFinite)).toBe(true);
    const top = p.alt.indexOf(Math.max(...p.alt));
    expect(Math.abs(altAzi(p.xyz[3 * top], p.xyz[3 * top + 1], p.xyz[3 * top + 2]).azi - 180)).toBeLessThan(3);
    expect(dayPath(london, '02-29')).toEqual({ min: [], xyz: [], alt: [] });
    expect(dayPath({ ...london, leap: true }, '02-29').min).toHaveLength(289);
  });
  it('nearestMinute: the sample of a day path nearest a direction', () => {
    const p = dayPath(london, '06-21'), at = (m: number) => p.xyz.slice(3 * (m / 5), 3 * (m / 5) + 3);
    for (const m of [60, 300, 725, 1100]) expect(nearestMinute(p, at(m))).toBe(m);
    const u = [0, 1, 2].map((k) => 0.7 * at(600)[k] + 0.3 * at(605)[k]), n = Math.hypot(...u);
    expect(nearestMinute(p, u.map((x) => x / n))).toBe(600); // between two samples: the nearer one
    expect(nearestMinute(dayPath(london, '02-29'), [0, 1, 0])).toBeNaN(); // no path (Feb 29 of a common year)
  });
  it('analemma: one sample per day of the core year', () => {
    const a = analemma(london, 720), b = analemma({ ...london, leap: true }, 720);
    expect([a.day.length, a.xyz.length, a.alt.length, a.day[364]]).toEqual([365, 3 * 365, 365, 364]);
    expect(b.day).toHaveLength(366);
  });
});

describe('date drag', () => {
  const dec = decTable(london, 2026), D = (md: string) => doy(`2026-${md}`), target = dec[D('06-01')];
  const hi = dec.indexOf(Math.max(...dec)), lo = dec.indexOf(Math.min(...dec));
  let nearest = hi + 1; // the falling-half day whose declination is nearest the target
  for (let d = hi + 1; d < lo; d++) if (Math.abs(dec[d] - target) < Math.abs(dec[nearest] - target)) nearest = d;
  it('decTable: one entry per UI day, solstices on Jun 21 / Dec 21', () => {
    expect(dec).toHaveLength(365);
    expect(Math.abs(hi - D('06-21'))).toBeLessThanOrEqual(1);
    expect(Math.abs(lo - D('12-21'))).toBeLessThanOrEqual(1);
  });
  it('searches the half-year the drag started in', () => {
    const rising = startDayDrag(dec, D('05-01'));
    expect(rising.half).toBe(1);
    expect(dragDay(dec, target, rising, D('05-01'))).toBe(D('06-01'));
    const falling = startDayDrag(dec, D('07-15')), d = dragDay(dec, target, falling, D('07-15'));
    expect(falling.half).toBe(-1);
    expect(Math.abs(d - nearest)).toBeLessThanOrEqual(1);
    expect(Math.abs(d - D('07-10'))).toBeLessThanOrEqual(1); // the Jun 1 arc again on about Jul 10
  });
  it('an overshoot of more than 1.5 deg past a solstice arc flips the half once; 1 deg does not', () => {
    const s = startDayDrag(dec, D('05-01')), top = dragDay(dec, dec[hi] + 2, s, D('05-01'));
    expect(top).toBe(hi);
    expect(s).toEqual({ half: -1, latch: true });
    expect(dragDay(dec, dec[hi] + 2, s, top)).toBe(hi); // latched: no flip back
    expect(s.half).toBe(-1);
    const d = dragDay(dec, target, s, top);
    expect(d).toBeGreaterThan(hi);
    expect(Math.abs(d - nearest)).toBeLessThanOrEqual(1);
    expect(s.latch).toBe(false);
    const small = startDayDrag(dec, D('05-01')), near = dragDay(dec, dec[hi] + 1, small, D('05-01'));
    expect(small.half).toBe(1);
    expect(dragDay(dec, target, small, near)).toBe(D('06-01'));
  });
  it('from the June solstice day it runs forward', () => {
    const s = startDayDrag(dec, hi);
    expect(s.half).toBe(-1);
    expect(dragDay(dec, dec[hi] - 0.5, s, hi)).toBeGreaterThan(hi);
  });
  it('stays inside [first, last]', () => {
    expect(dragDay(dec, target, startDayDrag(dec, D('05-01')), D('05-01'), D('03-01'), D('05-15'))).toBe(D('05-15'));
    expect(dragDay(dec, target, startDayDrag(dec, D('05-01')), D('06-10'), 0, D('05-15'))).toBe(D('05-15')); // cur outside: not kept
    expect(dragDay(dec, target, { half: -1, latch: false }, D('05-01'), D('03-01'), D('05-15'))).toBe(-1); // no falling day allowed
  });
  it('one end of a multi-day range never jumps across New Year and never freezes', () => {
    const n = dec.length, run = (cur: number, targets: number[], first: number, last: number) => {
      const s = startDayDrag(dec, cur);
      let d = cur;
      for (const t of targets) { const r = dragDay(dec, t, s, d, first, last); if (r >= 0) d = r; }
      return d;
    };
    expect(run(D('08-31'), [12, 18, 23, 26, 28, 24], D('07-01') + 1, n - 1)).toBe(D('07-02')); // 1 Jul - 31 Aug, end dragged far north
    expect(run(D('04-15'), [5, 0, -8, -16], D('03-01') + 1, n - 1)).toBe(D('03-02')); // 1 Mar - 15 Apr, end dragged south past the start
    expect(run(D('01-20'), [-21, -23, -26], D('01-05') + 1, n - 1)).toBe(D('01-06')); // 5 - 20 Jan, end dragged south
    expect(run(D('12-22'), [-23, -22, -20], 0, D('12-30') - 1)).toBe(D('12-29')); // 22 - 30 Dec, start dragged north
    expect(run(D('05-01'), [18, 22, 26, 23], 0, D('06-10') - 1)).toBe(D('06-09')); // 1 May - 10 Jun, start dragged past June
  });
  it('never lands on a day the core rejects (Feb 29 of a leap UI year, non-leap weather)', () => {
    const d28 = decTable(london, 2028);
    expect(d28).toHaveLength(366);
    expect(d28.map((v, d) => (Number.isNaN(v) ? d : -1)).filter((d) => d >= 0)).toEqual([59]);
    for (let t = -24; t <= 24; t += 0.25) expect(dragDay(d28, t, startDayDrag(d28, 59), 59)).not.toBe(59);
    expect([58, 60]).toContain(dragDay(d28, (d28[58] + d28[60]) / 2, startDayDrag(d28, 59), 59));
  });
});

describe('dayBounds (the day band of the Time panel)', () => {
  it('is where the drawn sun path crosses the horizon', () => {
    const b = dayBounds(london, '2026-06-21');
    expect(b.sunrise).toBeGreaterThan(3 * 60 + 40); // the arc rises about 03:46 and sets about 20:20 (UTC)
    expect(b.sunrise).toBeLessThan(3 * 60 + 52);
    expect(b.sunset).toBeGreaterThan(20 * 60 + 14);
    expect(b.sunset).toBeLessThan(20 * 60 + 26);
  });
  it('shifts with the zone; polar day, polar night; wraps when sunset falls after midnight', () => {
    const berlin: Site = { lat: 52.5, lon: 13.4, tz: 0, leap: false };
    expect(dayBounds({ ...berlin, tz: 1 }, '2026-03-21').sunrise - dayBounds(berlin, '2026-03-21').sunrise).toBe(60);
    expect(dayBounds({ lat: 78, lon: 15, tz: 1, leap: false }, '2026-06-21')).toEqual({ sunrise: 0, sunset: 1440 });
    expect(dayBounds({ lat: 78, lon: 15, tz: 1, leap: false }, '2026-12-21')).toEqual({ sunrise: 0, sunset: 0 });
    const late = dayBounds({ lat: 64.146, lon: -21.9422, tz: 2, leap: false }, '2026-06-21'); // a clock 2 h ahead of the sun
    expect(late.sunset).toBeLessThan(120); // sets after midnight ...
    expect(late.sunrise).toBeGreaterThan(240); // ... and rises about 05:00: the band wraps
    expect(dayBounds(london, '2028-02-29')).toEqual({ sunrise: 0, sunset: 0 }); // not in a non-leap weather year
  });
});
