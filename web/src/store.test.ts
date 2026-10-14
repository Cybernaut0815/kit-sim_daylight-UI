import { describe, expect, it } from 'vitest';
import { defaultSettings, initialState, parseSettings, reducer, serializeSettings, type ObjectRow, type Station } from './store';

const obj = (id: string, role: ObjectRow['role'] = 'receiver'): ObjectRow => ({ id, name: id, tris: 2, verts: 4, role });
const stations: Station[] = [
  { title: 'London Gatwick', href: 'https://energyplus-weather.s3.amazonaws.com/GBR_London.Gatwick.epw', lat: 51.15, lon: -0.18 },
  { title: 'Paris Orly', href: 'https://energyplus-weather.s3.amazonaws.com/FRA_Paris.Orly.epw', lat: 48.73, lon: 2.4 },
];

describe('roles', () => {
  it('ROLE sets the role of the given meshes only; a new model starts in the plain view', () => {
    let s = reducer(initialState(), { type: 'LOAD', objects: [obj('a'), obj('b'), obj('c')] });
    expect(s.colourBy).toBe('plain');
    s = reducer(s, { type: 'ROLE', ids: ['b', 'c'], role: 'shade' });
    expect(s.objects.map((o) => o.role)).toEqual(['receiver', 'shade', 'shade']);
  });
});

describe('run and selection', () => {
  it('LOAD and ROLE clear the run', () => {
    let s = reducer(initialState(), { type: 'LOAD', objects: [obj('a')] });
    s = reducer(s, { type: 'RUN', run: { status: 'error', message: 'x' } });
    expect(reducer(s, { type: 'ROLE', ids: ['a'], role: 'shade' }).run.status).toBe('idle');
    expect(reducer(s, { type: 'LOAD', objects: [] }).run.status).toBe('idle');
  });
  it('additive select toggles', () => {
    let s = reducer(initialState(), { type: 'SELECT', ids: ['a'] });
    s = reducer(s, { type: 'SELECT', ids: ['b'], additive: true });
    expect([...s.selected]).toEqual(['a', 'b']);
    s = reducer(s, { type: 'SELECT', ids: ['a'], additive: true });
    expect([...s.selected]).toEqual(['b']);
  });
});

describe('site and weather', () => {
  it('moving the site picks the nearest station and drops the EPW header', () => {
    let s = reducer(initialState(), { type: 'STATIONS', stations });
    expect(s.settings.weather.station?.title).toBe('London Gatwick');
    s = reducer(s, { type: 'EPW_META', meta: { lat: 51, lon: 0, tz: 0, name: 'x', leap: false } });
    s = reducer(s, { type: 'SITE', patch: { lat: 48.85, lon: 2.35 } });
    expect(s.settings.weather.station?.title).toBe('Paris Orly');
    expect(s.settings.epwMeta).toBeNull();
    s = reducer(s, { type: 'EPW_META', meta: { lat: 48, lon: 2, tz: 1, name: 'x', leap: false } });
    expect(reducer(s, { type: 'SITE', patch: { place: 'Paris' } }).settings.epwMeta).not.toBeNull(); // only lat/lon count
    expect(reducer(s, { type: 'WEATHER', patch: { source: 'pvgis' } }).settings.epwMeta).toBeNull();
    expect(reducer(s, { type: 'WEATHER', patch: { turbidity: 4 } }).settings.epwMeta).not.toBeNull();
  });
  it('mode switch keeps the all-quantities default and clamps sky density', () => {
    let s = reducer(initialState(), { type: 'SIM', patch: { skyDensity: 4 } });
    s = reducer(s, { type: 'SIM', patch: { mode: 'ladybug' } });
    expect(s.settings.sim.quantities).not.toContain('illuminance');
    expect(s.settings.sim.quantities).toHaveLength(5);
    expect(s.settings.sim.skyDensity).toBe(2);
    s = reducer(s, { type: 'SIM', patch: { mode: 'physical' } });
    expect(s.settings.sim.quantities).toHaveLength(6);
    s = reducer(s, { type: 'SIM', patch: { quantities: ['radiation', 'illuminance'] } });
    expect(reducer(s, { type: 'SIM', patch: { mode: 'ladybug' } }).settings.sim.quantities).toEqual(['radiation']);
  });
});

describe('persistence', () => {
  it('round-trips without the File and survives garbage', () => {
    const d = defaultSettings();
    d.weather.file = new Blob(['x']) as File;
    d.site.tz = 2;
    const back = parseSettings(serializeSettings(d));
    expect(back.weather.file).toBeNull();
    expect(back.site.tz).toBe(2);
    expect(parseSettings('{not json').site.lat).toBe(d.site.lat);
    expect(parseSettings('{"site":{"lat":1}}').site.lon).toBe(d.site.lon);
    expect(parseSettings(null).sim.quantities).toHaveLength(6);
  });
});
