import { describe, expect, it } from 'vitest';
import { DEFAULT_KEY } from './lib/optics';
import { defaultSettings, initialState, parseSettings, reducer, serializeSettings, type ObjectRow, type RunResult, type Station } from './store';

const obj = (id: string, role: ObjectRow['role'] = 'receiver'): ObjectRow => ({ id, name: id, path: `/${id}`, tris: 2, verts: 4, role });
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
  it("SELECTION mirrors the viewer's prims; a parent selects every mesh below it, and LOAD clears it", () => {
    const rows = [{ ...obj('a'), path: '/W/G/a' }, { ...obj('b'), path: '/W/G/b' }, { ...obj('c'), path: '/W/c' }];
    let s = reducer(initialState(), { type: 'LOAD', objects: rows });
    s = reducer(s, { type: 'SELECTION', paths: ['/W/G'], active: '/W/G', source: 'hierarchy' });
    expect([...s.selected]).toEqual(['a', 'b']);
    expect(s.selection).toEqual({ paths: ['/W/G'], active: '/W/G', source: 'hierarchy' });
    s = reducer(s, { type: 'ROLE', ids: [...s.selected], role: 'shade' });
    expect(s.objects.map((o) => o.role)).toEqual(['shade', 'shade', 'receiver']);
    s = reducer(s, { type: 'LOAD', objects: rows });
    expect([s.selection.paths, s.selected.size]).toEqual([[], 0]);
  });
  it('RELOAD (a variant switch) keeps the selection, maps it onto the new rows and drops the result', () => {
    let s = reducer(initialState(), { type: 'LOAD', objects: [{ ...obj('a'), path: '/W/G/a' }] });
    s = reducer(s, { type: 'SELECTION', paths: ['/W/G'], active: '/W/G', source: 'hierarchy' });
    s = { ...s, result: { values: [], columns: [], receivers: ['a'], on: 'faces', key: 'k', elapsed: 0, manifest: { columns: [], duration_h: 1, dirs: { sky: 0, ground: 0, sun: 0 }, meshes: [] } } };
    s = reducer(s, { type: 'RELOAD', objects: [{ ...obj('a2'), path: '/W/G/a' }, { ...obj('n', 'none'), path: '/W/G/new' }] });
    expect([s.selection.paths, [...s.selected], s.result]).toEqual([['/W/G'], ['a2', 'n'], null]);
  });
  it('an instanced mesh is never a receiver: Shade and Ignore only', () => {
    let s = reducer(initialState(), { type: 'LOAD', objects: [obj('a', 'none'), { ...obj('i', 'none'), instances: 3 }] });
    s = reducer(s, { type: 'ROLE', ids: ['a', 'i'], role: 'receiver' });
    expect(s.objects.map((o) => o.role)).toEqual(['receiver', 'none']);
    expect(reducer(s, { type: 'ROLE', ids: ['i'], role: 'shade' }).objects[1].role).toBe('shade');
    expect(reducer(s, { type: 'ROLE', ids: ['i'], role: 'receiver' })).toBe(s); // refused: the state (and a result) stays
    expect(reducer(s, { type: 'ROLE', ids: ['a'], role: 'receiver' })).toBe(s); // already so
  });
});

describe('run and selection', () => {
  it('LOAD and ROLE clear the run', () => {
    let s = reducer(initialState(), { type: 'LOAD', objects: [obj('a')] });
    s = reducer(s, { type: 'RUN', run: { status: 'error', message: 'x' } });
    expect(reducer(s, { type: 'ROLE', ids: ['a'], role: 'shade' }).run.status).toBe('idle');
    expect(reducer(s, { type: 'LOAD', objects: [] }).run.status).toBe('idle');
  });
  it('the last result stays while the next run is queued, running, failed or cancelled; LOAD and ROLE drop it', () => {
    const result: RunResult = {
      values: [Float64Array.of(1)], columns: ['radiation_front'], receivers: ['a'], on: 'faces', key: 'k1', elapsed: 0.1,
      manifest: { columns: ['radiation_front'], duration_h: 1, dirs: { sky: 145, ground: 145, sun: 1 }, meshes: [{ name: 'a', first: 0, count: 1 }] },
    };
    let s = reducer(initialState(), { type: 'LOAD', objects: [obj('a')] });
    s = reducer(s, { type: 'RUN', run: { status: 'done', result } });
    expect(s.colourBy).toBe('value');
    s = reducer(s, { type: 'COLOUR_BY', colourBy: 'plain' });
    for (const run of [{ status: 'queued', position: 0 }, { status: 'running' }, { status: 'error', message: 'x' }, { status: 'idle' }] as const) {
      expect(reducer(s, { type: 'RUN', run }).result).toBe(result);
    }
    s = reducer(s, { type: 'RUN', run: { status: 'done', result: { ...result, key: 'k2' } } });
    expect(s.result?.key).toBe('k2');
    expect(s.colourBy).toBe('plain'); // a re-run keeps the user's choice
    expect(reducer(s, { type: 'ROLE', ids: ['a'], role: 'shade' }).result).toBeNull();
    expect(reducer(s, { type: 'LOAD', objects: [obj('b')] }).result).toBeNull();
  });
  it('a run that finishes after the model or the roles changed is dropped', () => {
    const result: RunResult = {
      values: [Float64Array.of(1)], columns: ['radiation_front'], receivers: ['a'], on: 'faces', key: 'k', elapsed: 0.1,
      manifest: { columns: ['radiation_front'], duration_h: 1, dirs: { sky: 145, ground: 145, sun: 1 }, meshes: [{ name: 'a', first: 0, count: 1 }] },
    };
    let s = reducer(initialState(), { type: 'LOAD', objects: [obj('b')] });
    s = reducer(s, { type: 'RUN', run: { status: 'running' } });
    s = reducer(s, { type: 'RUN', run: { status: 'done', result } });
    expect(s.result).toBeNull();
    expect(s.run.status).toBe('idle');
  });
  it('a job in flight keeps its status across LOAD and ROLE; a failure stays shown until the next run ends', () => {
    let s = reducer(initialState(), { type: 'LOAD', objects: [obj('a')] });
    s = reducer(s, { type: 'RUN', run: { status: 'running' } });
    expect(reducer(s, { type: 'ROLE', ids: ['a'], role: 'shade' }).run.status).toBe('running');
    expect(reducer(s, { type: 'LOAD', objects: [obj('b')] }).run.status).toBe('running');
    s = reducer(s, { type: 'RUN', run: { status: 'error', message: 'boom' } });
    expect(s.error).toBe('boom');
    s = reducer(s, { type: 'RUN', run: { status: 'queued', position: 0 } }); // the next (Auto) run: the alert does not blink
    expect(s.error).toBe('boom');
    expect(reducer(s, { type: 'RUN', run: { status: 'idle' } }).error).toBeNull();
    expect(reducer(s, { type: 'ROLE', ids: ['a'], role: 'none' }).error).toBeNull();
  });
  it('a repeated run status and empty errors do not re-render', () => {
    let s = reducer(initialState(), { type: 'RUN', run: { status: 'queued', position: 2 } });
    expect(reducer(s, { type: 'RUN', run: { status: 'queued', position: 2 } })).toBe(s);
    expect(reducer(s, { type: 'RUN', run: { status: 'queued', position: 1 } })).not.toBe(s);
    s = reducer(s, { type: 'RUN', run: { status: 'running' } });
    expect(reducer(s, { type: 'RUN', run: { status: 'running' } })).toBe(s);
    expect(reducer(s, { type: 'ERRORS', errors: {} })).toBe(s);
    const e = reducer(s, { type: 'ERRORS', errors: { lat: 'x' } });
    expect(e.errors).toEqual({ lat: 'x' });
    expect(reducer(e, { type: 'RUN', run: { status: 'queued', position: 0 } }).errors).toEqual({});
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
  it('a move clears a station picked before the index arrived', () => {
    let s = reducer(initialState(), { type: 'WEATHER', patch: { station: stations[0] } });
    s = reducer(s, { type: 'SITE', patch: { lat: 48.85, lon: 2.35 } });
    expect(s.settings.weather.station).toBeNull(); // no index yet: STATIONS picks the nearest
    expect(reducer(s, { type: 'STATIONS', stations }).settings.weather.station?.title).toBe('Paris Orly');
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
    d.site.place = 'Somewhere';
    const back = parseSettings(serializeSettings(d));
    expect(back.weather.file).toBeNull();
    expect(back.site.place).toBe('Somewhere');
    expect(parseSettings('{"site":{"lat":40,"lon":-3,"tz":5,"place":"x"}}').site).toEqual({ lat: 40, lon: -3, place: 'x' }); // an old override is dropped
    expect(parseSettings('{not json').site.lat).toBe(d.site.lat);
    expect(parseSettings('{"site":{"lat":1}}').site.lon).toBe(d.site.lon);
    expect(parseSettings(null).sim.quantities).toHaveLength(6);
    const u = defaultSettings();
    u.weather.source = 'upload';
    u.epwMeta = { lat: 51, lon: 0, tz: 0, name: 'x', leap: false };
    expect(parseSettings(serializeSettings(u)).epwMeta).toBeNull(); // the file is not kept, nor its header
  });
  it('the optics switches default to today (transmission off, angle-dependent glass on); a record from before them loads', () => {
    expect(defaultSettings().sim).toMatchObject({ transmission: false, fresnel: true });
    const old = parseSettings('{"sim":{"mode":"physical","quantities":["radiation"],"sides":"both","ground":0.3}}');
    expect(old.sim).toMatchObject({ transmission: false, fresnel: true, sides: 'both', ground: 0.3, skyDensity: 1 });
    const d = defaultSettings();
    d.sim.transmission = true;
    d.sim.fresnel = false;
    expect(parseSettings(serializeSettings(d)).sim).toMatchObject({ transmission: true, fresnel: false });
  });
  it('Reflections default to off with 1024 samples; a record from before them (phase 1 too) loads with those', () => {
    expect(defaultSettings().sim).toMatchObject({ bounces: 0, bounceSamples: 1024 });
    const old = parseSettings('{"sim":{"mode":"physical","quantities":["radiation"],"transmission":true,"fresnel":false}}');
    expect(old.sim).toMatchObject({ transmission: true, fresnel: false, bounces: 0, bounceSamples: 1024 });
    const d = defaultSettings();
    d.sim.bounces = 3;
    d.sim.bounceSamples = 4096;
    expect(parseSettings(serializeSettings(d)).sim).toMatchObject({ bounces: 3, bounceSamples: 4096 });
  });
});

describe('optics edits', () => {
  it('OPTICS_EDIT sets a row, OPTICS_RESET drops it; a re-read keeps the edits, a new model clears them', () => {
    const glass = { rho: 0, tau: 0.5, kind: 'glass' } as const;
    let s = reducer(initialState(), { type: 'LOAD', objects: [obj('a')] });
    expect(s.optics).toEqual({});
    s = reducer(s, { type: 'OPTICS_EDIT', key: '/M/Glass', edit: glass });
    s = reducer(s, { type: 'OPTICS_EDIT', key: DEFAULT_KEY, edit: { rho: 0.3, tau: 0, kind: 'opaque' } });
    s = reducer(s, { type: 'OPTICS_RESET', key: DEFAULT_KEY });
    expect(s.optics).toEqual({ '/M/Glass': glass });
    expect(reducer(s, { type: 'OPTICS_RESET', key: DEFAULT_KEY })).toBe(s); // nothing to reset
    s = reducer(s, { type: 'RELOAD', objects: [obj('a2')] }); // a variant switch or a subdivision level
    expect(s.optics).toEqual({ '/M/Glass': glass });
    expect(reducer(s, { type: 'LOAD', objects: [obj('b')] }).optics).toEqual({});
  });
});
