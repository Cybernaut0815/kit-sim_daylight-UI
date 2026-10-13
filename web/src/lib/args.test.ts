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
  it('prefers the EPW header tz, then the explicit one', () => {
    const s = defaultSettings();
    s.epwMeta = { lat: 0, lon: 0, tz: -5, name: 'x', leap: false };
    expect(derivedTz(s)).toBe(-5);
    s.site.tz = 3;
    expect(pairs(buildArgs(s))['--tz']).toBe('3');
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
});
