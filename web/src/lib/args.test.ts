import { describe, expect, it } from 'vitest';
import { defaultSettings } from '../store';
import { buildArgs, derivedTz, validate } from './args';

const pairs = (a: string[]) => Object.fromEntries(a.map((v, i) => [v, a[i + 1]]));

describe('buildArgs', () => {
  it('always sends --lat --lon --tz, tz derived from lon without an EPW', () => {
    const s = defaultSettings();
    s.site.lon = 13.4;
    const p = pairs(buildArgs(s));
    expect(p['--lat']).toBe('51.5074');
    expect(p['--lon']).toBe('13.4');
    expect(p['--tz']).toBe('1');
  });
  it('uses the civil zone of the site, never the weather file zone or the longitude', () => {
    const s = defaultSettings();
    s.epwMeta = { lat: 0, lon: 0, tz: -5, name: 'x', leap: false };
    expect(derivedTz(s)).toBe(0); // London: the header's -5 is the file's own clock, the core converts
    s.site = { ...s.site, lat: 40.4168, lon: -3.7038 };
    expect(derivedTz(s)).toBe(1); // Madrid: CET, where round(lon / 15) would say 0
    expect(pairs(buildArgs(s))['--tz']).toBe('1');
  });
  it('rejects Feb 29 unless the weather year is a leap year', () => {
    const s = defaultSettings();
    s.weather.source = 'clear-sky';
    s.time.mode = 'instant';
    s.time.date = '2028-02-29';
    expect(validate(s, true).timeDate).toMatch(/Feb 29/);
    s.weather.source = 'pvgis';
    expect(validate(s, true).timeDate).toBeUndefined(); // the weather year is not known before its header arrives
    s.weather.source = 'upload';
    s.weather.file = new Blob(['x']) as File;
    s.epwMeta = { lat: 0, lon: 0, tz: 0, name: 'x', leap: true };
    expect(validate(s, true)).toEqual({});
    expect(pairs(buildArgs(s))['--time']).toBe('02-29T12:00');
  });
  it('emits time flags per mode and the clear-sky trio', () => {
    const s = defaultSettings();
    expect(buildArgs(s)).not.toContain('--time');
    s.time.mode = 'instant';
    s.time.date = '2026-06-21';
    s.time.hour = 750;
    expect(pairs(buildArgs(s))['--time']).toBe('06-21T12:30');
    s.time.mode = 'range';
    s.time.from = { date: '2026-03-01', hour: 0 };
    s.time.to = { date: '2026-03-01', hour: 1440 };
    s.time.stepMin = 15;
    const p = pairs(buildArgs(s));
    expect(p['--from']).toBe('03-01T00:00');
    expect(p['--to']).toBe('03-02T00:00');
    expect(p['--step']).toBe('15');
    s.weather.source = 'clear-sky';
    s.weather.turbidity = 4;
    const c = buildArgs(s);
    expect(c).toContain('--clear-sky');
    expect(pairs(c)['--turbidity']).toBe('4');
    s.sim.selfOcclude = false;
    s.sim.cullBackfaces = true;
    expect(buildArgs(s)).toEqual(expect.arrayContaining(['--no-self-occlude', '--cull-backfaces']));
    expect(pairs(buildArgs(s))['--quantity']).toBe('radiation,direct,diffuse,irradiance,illuminance,sunhours');
  });
  it('a range over several days sends the daily window as --hours, a one-day range does not', () => {
    const s = defaultSettings();
    s.time.mode = 'range';
    s.time.from = { date: '2026-06-01', hour: 540 };
    s.time.to = { date: '2026-08-31', hour: 1020 };
    const p = pairs(buildArgs(s));
    expect([p['--from'], p['--to'], p['--hours']]).toEqual(['06-01T09:00', '08-31T17:00', '09:00-17:00']);
    expect(buildArgs(s).at(-2)).toBe('--hours'); // appended last: the other flags keep their order (and request keys)
    s.time.to.hour = 1440;
    expect(pairs(buildArgs(s))['--hours']).toBe('09:00-24:00');
    s.time.to.date = '2026-06-01';
    expect(buildArgs(s)).not.toContain('--hours');
  });
});

describe('validate', () => {
  it('passes the defaults with a receiver and a station', () => {
    const s = defaultSettings();
    s.weather.station = { title: 't', href: 'h', lat: 0, lon: 0 };
    expect(validate(s, true)).toEqual({});
    expect(validate(s, false)).toHaveProperty('model');
  });
  it('names the field that blocks the run', () => {
    const s = defaultSettings();
    expect(validate(s, true)).toHaveProperty('weather'); // station source, no station yet
    s.sim.quantities = ['sunhours'];
    expect(validate(s, true)).toEqual({}); // sun hours need no weather
    s.weather.source = 'upload';
    s.sim.quantities = ['radiation'];
    expect(validate(s, true).weather).toMatch(/EPW/);
    s.weather.source = 'pvgis';
    s.sim.mode = 'ladybug';
    s.sim.skyDensity = 4;
    s.sim.quantities = ['illuminance'];
    const e = validate(s, true);
    expect(e).toHaveProperty('skyDensity');
    expect(e.quantities).toMatch(/illuminance/);
    s.site.lat = 95;
    expect(validate(s, true)).toHaveProperty('lat');
    s.time.mode = 'range';
    s.time.from = { date: '2026-06-21', hour: 600 };
    s.time.to = { date: '2026-06-21', hour: 600 };
    expect(validate(s, true)).toHaveProperty('timeTo');
  });
  it('a range needs the end date on or after the start and a daily window that ends after it starts', () => {
    const s = defaultSettings();
    s.weather.source = 'clear-sky';
    s.time.mode = 'range';
    s.time.from = { date: '2026-06-01', hour: 540 };
    s.time.to = { date: '2026-08-31', hour: 1020 };
    expect(validate(s, true)).toEqual({});
    s.time.to.hour = 480; // later date, earlier time: the daily window would be empty
    expect(validate(s, true).timeTo).toMatch(/end time/);
    s.time.to = { date: '2026-05-31', hour: 1020 };
    expect(validate(s, true).timeTo).toMatch(/end date/);
  });
});
