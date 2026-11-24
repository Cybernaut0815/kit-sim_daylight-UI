import { describe, expect, it } from 'vitest';
import { QUANTITIES, initialState, reducer, type ObjectRow, type RunResult, type State } from '../store';
import { unitFor } from '../lib/result';
import { applyReport, captureSet, copyName, copySet, copyText, entryFor, inputText, newId, notOpen, parseSets, renameSet, setSummary, type AnalysisSet, type CombinedView } from './model';

const GLASS = { rho: 0.1, tau: 0.5, kind: 'glass' as const };

const row = (id: string, path: string, role: ObjectRow['role'] = 'none', extra: Partial<ObjectRow> = {}): ObjectRow => ({ id, name: id, path, tris: 2, verts: 4, role, ...extra });
const m = (s: State, slot = 0) => s.models.find((x) => x.slot === slot)!;
const result = (receivers: string[]): RunResult => ({ data: [], weights: new Float32Array(), columns: ['radiation_front'], receivers, on: 'faces', key: 'k', elapsed: 0, manifest: { columns: ['radiation_front'], meshes: [] } as unknown as RunResult['manifest'] });
/** Models in slots 0.. as [file, rows] (row ids unique per slot: `${slot}${id}`). */
function open(...models: [string, ObjectRow[]][]): State {
  let s = initialState();
  models.forEach(([name, rows], slot) => {
    if (slot) s = reducer(s, { type: 'ADD' });
    s = reducer(s, { type: 'LOAD', slot, name, objects: rows.map((o) => ({ ...o, id: `${slot}${o.id}` })) });
  });
  return s;
}
const facade = () => [row('a', '/W/a', 'receiver'), row('b', '/W/b', 'receiver', { shade: false }), row('c', '/W/c', 'shade'), row('d', '/W/d')];

describe('sets', () => {
  it('newId: a slug of the name and a random suffix, a valid server id', () => {
    const id = newId('South façade, level 2!');
    expect(id).toMatch(/^south-facade-level-2-[a-z0-9]{4}$/);
    expect(newId('***')).toMatch(/^set-[a-z0-9]{4}$/);
    expect(newId('x'.repeat(200)).length).toBeLessThanOrEqual(64);
  });

  it('captureSet keeps the roles by path, the Materials edits, the run settings, north, site, weather, column, colours, charts and subdivision', () => {
    let s = open(['tower', facade()]);
    s = reducer(s, { type: 'SIM', patch: { north: 30, bounces: 2 } });
    s = reducer(s, { type: 'VIZ', quantity: 'radiation', patch: { gradient: 'magma', lo: 100 } });
    s = reducer(s, { type: 'COLOUR_BY', colourBy: 'value' });
    s = reducer(s, { type: 'OPTICS_EDIT', slot: 0, key: '/M/glass', edit: GLASS });
    s = reducer(s, { type: 'SITE', patch: { lat: 48.1, lon: 11.6, place: 'Munich' } });
    s = reducer(s, { type: 'WEATHER', patch: { source: 'upload', file: new File(['x'], 'munich.epw') } });
    const set = captureSet(s, 'daylight', 'South', { shown: 'radiation_front', now: '2026-11-24T10:00:00.000Z', subdiv: 2 });
    expect(set).toMatchObject({
      kind: 'set', name: 'South', tool: 'daylight', column: 'radiation_front', colourBy: 'value', created: '2026-11-24T10:00:00.000Z',
      north: 30, site: { lat: 48.1, lon: 11.6, place: 'Munich' }, weather: { source: 'upload', file: 'munich.epw', turbidity: 3 }, subdiv: 2,
    });
    expect(set.look).toBeUndefined();
    expect(Object.keys(set.looks!.quantities)).toEqual(QUANTITIES); // every Daylight quantity, a default one as {}
    expect([set.looks!.quantities.radiation, set.looks!.quantities.sunhours]).toEqual([{ gradient: 'magma', lo: 100, hi: null }, {}]);
    expect(set.charts).toEqual(s.settings.charts);
    expect(set.models).toEqual([{ model: 'A', file: 'tower', roles: [{ path: '/W/a', role: 'receiver' }, { path: '/W/b', role: 'receiver', shade: false }, { path: '/W/c', role: 'shade' }], optics: { '/M/glass': GLASS } }]);
    expect('sim' in set.settings && set.settings.sim).toMatchObject({ bounces: 2 });
    expect('sim' in set.settings && 'north' in set.settings.sim).toBe(false);
    const again = captureSet(s, 'daylight', 'South 2', { was: set });
    expect([again.id, again.created, 'subdiv' in again]).toEqual([set.id, set.created, false]);
  });

  it('setSummary: the set in words, a line each; an older set says what it does not keep', () => {
    let s = open(['tower', facade()]);
    s = reducer(s, { type: 'SIM', patch: { north: 30, bounces: 2, quantities: ['radiation', 'sunhours'] } });
    s = reducer(s, { type: 'VIZ', quantity: 'radiation', patch: { gradient: 'magma', scaling: 'log', lo: 100, max: 900 } });
    s = reducer(s, { type: 'OPTICS_EDIT', slot: 0, key: '/M/glass', edit: GLASS });
    s = reducer(s, { type: 'SITE', patch: { lat: 48.1, lon: 11.6, place: 'Munich' } });
    s = reducer(s, { type: 'WEATHER', patch: { source: 'upload', file: new File(['x'], 'munich.epw') } });
    s = reducer(s, { type: 'TIME', patch: { mode: 'instant', date: '2026-06-21', hour: 750 } });
    const set = captureSet(s, 'daylight', 'South', { shown: 'radiation_front', subdiv: 2 }), lines = setSummary(set);
    expect(Object.fromEntries(lines.map((l) => [l.label, l.value]))).toEqual({
      'Model A': 'tower: 2 receivers, 1 shade, 1 material edit', Location: 'Munich (48.1, 11.6), north 30°', Time: '21 Jun, 12:30',
      Simulation: 'Physical: Radiation, Sun hours; front sides on faces; sky density 1; 2 reflections', Weather: 'an uploaded EPW, munich.epw', Subdivision: 'Level 2',
      Result: 'Radiation, front; the meshes plain', Colours: 'Magma, logarithmic, legend lowest to 900', 'Problem range': `below 100 ${unitFor('radiation_front').value}`,
    });
    const { north: _n, site: _s, weather: _w, looks: _l, subdiv: _d, ...older } = set;
    expect(setSummary({ ...older, models: [{ ...older.models[0], optics: undefined }] }).filter((l) => /older/.test(l.value)).map((l) => l.label)).toEqual(['Location', 'Weather', 'Subdivision']);
    const views = setSummary(captureSet(s, 'views', 'Views', { shown: 'sky_front' }));
    expect(views.map((l) => l.label)).toEqual(['Model A', 'North', 'View settings', 'Subdivision', 'Result', 'Colours', 'Problem range']);
    expect(views[2].value).toBe('field 120°, -70° to 50°; a ray every 2°; far 1,000 m; front sides on faces');
  });

  it('APPLY_SET brings back north, the site and weather, the Materials edits, every colour and the charts', () => {
    let s = open(['tower', facade()]);
    s = reducer(s, { type: 'SITE', patch: { lat: 48.1, lon: 11.6, place: 'Munich' } });
    s = reducer(s, { type: 'WEATHER', patch: { source: 'clear-sky', turbidity: 4 } });
    s = reducer(s, { type: 'SIM', patch: { north: 15 } });
    s = reducer(s, { type: 'OPTICS_EDIT', slot: 0, key: '/M/glass', edit: GLASS });
    s = reducer(s, { type: 'VIZ', quantity: 'sunhours', patch: { lo: 2, below: '#112233' } });
    s = reducer(s, { type: 'CHART', spec: { id: 'facades', kind: 'parts', parts: ['/W/a'], metric: 'mean' } });
    const set = captureSet(s, 'daylight', 'Munich', { shown: 'sunhours_front' });
    s = reducer(s, { type: 'SITE', patch: { lat: 51.5, lon: -0.1, place: 'London' } });
    s = reducer(s, { type: 'WEATHER', patch: { source: 'station', turbidity: 3 } });
    s = reducer(s, { type: 'EPW_META', meta: { lat: 51.5, lon: -0.1, tz: 0, name: 'London', leap: false } });
    s = reducer(s, { type: 'SIM', patch: { north: 0 } });
    s = reducer(s, { type: 'OPTICS_RESET', slot: 0, key: '/M/glass' });
    s = reducer(s, { type: 'VIZ_RESET', quantity: 'sunhours', what: 'range' });
    s = reducer(s, { type: 'VIZ', quantity: 'radiation', patch: { gradient: 'magma' } }); // a look given after the save: back to the default
    s = reducer(s, { type: 'CHART', id: 'facades', remove: true });
    s = reducer(s, { type: 'APPLY_SET', set });
    expect(s.settings.site).toEqual({ lat: 48.1, lon: 11.6, place: 'Munich' });
    expect([s.settings.weather.source, s.settings.weather.turbidity, s.settings.epwMeta, s.settings.sim.north]).toEqual(['clear-sky', 4, null, 15]);
    expect(m(s).optics).toEqual({ '/M/glass': GLASS });
    expect([s.settings.viz.ranges.sunhours, s.settings.viz.colors.below, s.settings.viz.gradients.radiation]).toEqual([{ lo: 2, hi: null }, '#112233', undefined]);
    expect(s.settings.charts.map((c) => c.id)).toEqual(['hist', 'curve', 'facades']);
  });

  it('an uploaded EPW stays loaded when it is the file the set names; another file is asked for again', () => {
    const epw = new File(['x'], 'munich.epw');
    let s = reducer(open(['tower', facade()]), { type: 'WEATHER', patch: { source: 'upload', file: epw } });
    const set = captureSet(s, 'daylight', 'Upload');
    s = reducer(s, { type: 'WEATHER', patch: { source: 'station' } }); // the file stays picked
    expect(reducer(s, { type: 'APPLY_SET', set }).settings.weather).toMatchObject({ source: 'upload', file: epw });
    s = reducer(s, { type: 'WEATHER', patch: { source: 'upload', file: new File(['y'], 'berlin.epw') } });
    expect(reducer(s, { type: 'APPLY_SET', set }).settings.weather).toMatchObject({ source: 'upload', file: null });
  });

  it('a set of an older version (no north, site, weather, edits, colours or charts) leaves those as the app has them', () => {
    const { north: _n, site: _s, weather: _w, looks: _l, charts: _c, ...old } = captureSet(open(['tower', facade()]), 'daylight', 'Old', { shown: 'radiation_front' });
    const set: AnalysisSet = { ...old, models: old.models.map(({ optics: _o, ...e }) => e) };
    let s = open(['tower', facade()]);
    s = reducer(s, { type: 'SITE', patch: { lat: 48.1, lon: 11.6, place: 'Munich' } });
    s = reducer(s, { type: 'SIM', patch: { north: 15 } });
    s = reducer(s, { type: 'OPTICS_EDIT', slot: 0, key: '/M/glass', edit: GLASS });
    s = reducer(s, { type: 'VIZ', quantity: 'sunhours', patch: { lo: 2 } });
    const after = reducer(s, { type: 'APPLY_SET', set });
    expect([after.settings.site, after.settings.sim.north, after.settings.viz, after.settings.charts, m(after).optics]).toEqual([s.settings.site, 15, s.settings.viz, s.settings.charts, m(s).optics]);
  });

  it('APPLY_SET restores the roles, settings, north, column and look; an unchanged model keeps its result', () => {
    let s = open(['tower', facade()]);
    s = reducer(s, { type: 'SIM', patch: { bounces: 2 } });
    s = reducer(s, { type: 'VIZ', quantity: 'radiation', patch: { gradient: 'magma' } });
    const set = captureSet(s, 'daylight', 'South', { shown: 'radiation_front' });
    s = reducer(s, { type: 'RUN', slot: 0, run: { status: 'done', result: result(['0a', '0b']) } });
    expect(reducer(s, { type: 'APPLY_SET', set }).models[0]).toBe(s.models[0]); // the same roles: its result stays
    s = reducer(s, { type: 'ROLE', slot: 0, ids: ['0a', '0c'], role: 'none' });
    s = reducer(s, { type: 'ROLE', slot: 0, ids: ['0d'], role: 'receiver' });
    s = reducer(s, { type: 'SIM', patch: { bounces: 0, north: 45 } });
    s = reducer(s, { type: 'VIZ_RESET', quantity: 'radiation', what: 'scale' });
    s = reducer(s, { type: 'COLUMN', column: 'sunhours_front' });
    s = reducer(s, { type: 'APPLY_SET', set });
    expect(m(s).objects.map((o) => [o.role, o.shade])).toEqual([['receiver', undefined], ['receiver', false], ['shade', undefined], ['none', undefined]]);
    expect([s.settings.sim.bounces, s.settings.sim.north, s.column, s.settings.viz.gradients.radiation]).toEqual([2, 0, 'radiation_front', 'magma']);
  });

  it('APPLY_SET of a view analysis set acts on its slice only: the view roles with their groups, viewSim, its column', () => {
    let s = open(['tower', facade()]);
    s = reducer(s, { type: 'ROLE', slot: 0, ids: ['0c'], role: 'shade', group: 'park', tab: 'views' });
    s = reducer(s, { type: 'VIEW_SIM', patch: { cell: 1 } });
    const set = captureSet(s, 'views', 'Park', { shown: 'park_front' });
    expect(set.models[0].roles).toContainEqual({ path: '/W/c', role: 'shade', group: 'park' });
    expect(set.settings).toHaveProperty('viewSim.cell', 1);
    s = reducer(s, { type: 'ROLE', slot: 0, ids: ['0c'], role: 'none', tab: 'views' });
    s = reducer(s, { type: 'VIEW_SIM', patch: { cell: 4 } });
    const daylight = m(s).objects;
    s = reducer(s, { type: 'APPLY_SET', set });
    expect(m(s).viewAnalysis.objects.find((o) => o.path === '/W/c')).toMatchObject({ role: 'shade', group: 'park' });
    expect(m(s).objects).toBe(daylight);
    expect([s.settings.viewSim.cell, s.viewAnalysis.column, s.column]).toEqual([1, 'park_front', '']);
  });

  it('an instanced row never becomes a receiver', () => {
    const s0 = open(['tower', [row('a', '/W/a', 'shade', { instances: 4 })]]);
    const set: AnalysisSet = { ...captureSet(s0, 'daylight', 'x'), models: [{ model: 'A', file: 'tower', roles: [{ path: '/W/a', role: 'receiver' }] }] };
    expect(m(reducer(s0, { type: 'APPLY_SET', set })).objects[0].role).toBe('none');
  });
});

describe('sets over several models', () => {
  // A and B: the same file (variants); C: another file sharing 2 of A's 3 paths; D: another file with none
  const four = () => open(
    ['tower', facade()], ['tower', facade()],
    ['tower-v2', [row('a', '/W/a'), row('b', '/W/b'), row('x', '/W/x', 'receiver')]],
    ['shed', [row('s', '/S/s', 'receiver')]],
  );

  it('entryFor: its own entry (letter and file); never another model\'s, not even of the same file or with the same paths', () => {
    const s = four(), A = { model: 'A', file: 'tower', roles: [{ path: '/W/a', role: 'receiver' as const }, { path: '/W/b', role: 'receiver' as const }, { path: '/W/c', role: 'shade' as const }] };
    const B = { model: 'B', file: 'tower', roles: [{ path: '/W/d', role: 'receiver' as const }] };
    expect(entryFor(m(s, 0), [A, B], s.models)).toMatchObject({ entry: A, how: 'same', matched: 3, total: 3 });
    expect(entryFor(m(s, 1), [A, B], s.models)).toMatchObject({ entry: B, how: 'same' });
    expect(entryFor(m(s, 1), [A], s.models)).toBeNull(); // A still shows tower: B is another model of it
    expect(entryFor(m(s, 2), [A, B], s.models)).toBeNull(); // paths in common: only a copy (copySet) takes them
    expect(entryFor(m(s, 3), [A, B], s.models)).toBeNull();
  });

  it('entryFor: an entry whose tab shows another file now goes to its file reopened in another tab, in slot order', () => {
    const s = open(['shed', [row('s', '/S/s')]], ['tower', facade()], ['tower', facade()], ['tower', facade()]);
    const A = { model: 'A', file: 'tower', roles: [{ path: '/W/a', role: 'receiver' as const }] }, B = { model: 'B', file: 'tower', roles: [] };
    expect(entryFor(m(s, 0), [A, B], s.models)).toBeNull(); // the shed is not A's tower
    expect(entryFor(m(s, 1), [A, B], s.models)).toMatchObject({ entry: B, how: 'same' });
    expect(entryFor(m(s, 2), [A, B], s.models)).toMatchObject({ entry: A, how: 'file', matched: 1, total: 1 });
    expect(entryFor(m(s, 3), [A, B], s.models)).toBeNull(); // one entry away, one model takes it
    expect(applyReport(s.models, { models: [A, B] }).map((r) => r.text)[2]).toBe('C: from A, the same file reopened here, 1 of 1 meshes');
  });

  it('APPLY_SET on 4 models: each entry on its own model, the others left as they are; its report per model', () => {
    let s = four();
    s = reducer(s, { type: 'ROLE', slot: 0, ids: ['0d'], role: 'receiver' });
    const set = captureSet(s, 'daylight', 'All'); // A, B, C and D, each with its own roles
    const onlyA: AnalysisSet = { ...set, models: set.models.filter((e) => e.model === 'A') };
    expect(applyReport(s.models, onlyA).map((r) => r.text)).toEqual([
      'A: as saved, 4 of 4 meshes', ...['B', 'C', 'D'].map((L) => `${L}: not in this set, left as it is (Copy to ${L} makes a new set for it)`),
    ]);
    expect(notOpen(s.models, { models: [...onlyA.models, { model: 'D', file: 'gone', roles: [] }] })).toEqual(['gone (D in the set): not open, its roles wait for it']);
    s = reducer(s, { type: 'ROLE', slot: 1, ids: ['1a'], role: 'none' });
    const others = s.models.slice(1);
    s = reducer(s, { type: 'APPLY_SET', set: onlyA });
    s.models.slice(1).forEach((x, i) => expect(x).toBe(others[i]));
    s = reducer(s, { type: 'APPLY_SET', set }); // each its own again
    expect(m(s, 2).objects.map((o) => o.role)).toEqual(['none', 'none', 'receiver']);
    expect(m(s, 1).objects.map((o) => o.role)).toEqual(['receiver', 'receiver', 'shade', 'none']);
  });

  it('copySet: a new set for the target alone, the roles and Materials edits of the paths it has, the rest as it is', () => {
    let s = four();
    s = reducer(s, { type: 'OPTICS_EDIT', slot: 0, key: '/M/glass', edit: GLASS });
    s = reducer(s, { type: 'OPTICS_EDIT', slot: 0, key: '/M/brick', edit: { rho: 0.3, tau: 0, kind: 'opaque' } });
    s = reducer(s, { type: 'OPTICS_EDIT', slot: 0, key: 'default', edit: { rho: 0.4, tau: 0, kind: 'opaque' } });
    s = reducer(s, { type: 'SIM', patch: { bounces: 2, north: 20 } });
    const set = captureSet(s, 'daylight', 'South', { now: '2026-11-24T10:00:00.000Z', subdiv: 1 }), A = set.models[0];
    const { set: copy, counts } = copySet(set, A, m(s, 2), ['/M/glass', '/M/steel'], copyName(set, 'tower-v2'), '2026-11-25T10:00:00.000Z');
    expect(copy.models).toEqual([{ model: 'C', file: 'tower-v2', roles: [{ path: '/W/a', role: 'receiver' }, { path: '/W/b', role: 'receiver', shade: false }], optics: { '/M/glass': GLASS, default: { rho: 0.4, tau: 0, kind: 'opaque' } } }]);
    expect(counts).toEqual({ roles: 2, rolesOf: 3, bare: 1, edits: 2, editsOf: 3 });
    expect(copyText('C', counts)).toBe('C: 2 of 3 roles by path, 1 mesh without a role; 2 of 3 material edits');
    expect(copyText('D', { roles: 0, rolesOf: 3, bare: 3, edits: 0, editsOf: 0 })).toBe('D: 0 of 3 roles by path, 3 meshes without a role; no material edits');
    expect(copy).toMatchObject({ name: 'South for tower-v2', created: '2026-11-25T10:00:00.000Z', updated: '2026-11-25T10:00:00.000Z', settings: set.settings, north: 20, subdiv: 1, looks: set.looks, site: set.site });
    expect(copy.id).not.toBe(set.id);
    expect(copy.settings).not.toBe(set.settings); // its own, to edit
    expect(set.models).toHaveLength(4); // the original as it was
    const opened = reducer(s, { type: 'APPLY_SET', set: copy }); // on C alone
    expect(m(opened, 2).objects.map((o) => o.role)).toEqual(['receiver', 'receiver', 'none']);
    expect(m(opened, 2).optics).toEqual(copy.models[0].optics);
    [0, 1, 3].forEach((slot) => expect(m(opened, slot).objects).toBe(m(s, slot).objects));
    expect(() => copySet(set, A, { slot: 1, name: '', objects: [] }, [], 'x')).toThrow(/no file open/);
    expect(() => copySet(set, A, m(s, 2), [], '  ')).toThrow(/name/);
  });
});

describe('renameSet and inputText', () => {
  const set = captureSet(open(['tower', facade()]), 'daylight', 'South', { shown: 'radiation_front', now: '2026-11-24T10:00:00.000Z' });

  it('renameSet: the name trimmed and the time it changed, the id and all it keeps as they are; a blank or long name is refused', () => {
    const renamed = renameSet(set, '  South facade ', '2026-11-25T10:00:00.000Z');
    expect(renamed).toEqual({ ...set, name: 'South facade', updated: '2026-11-25T10:00:00.000Z' });
    expect(renamed.id).toBe(set.id);
    expect(set.name).toBe('South'); // the one renamed as it was
    expect(() => renameSet(set, '   ')).toThrow('name: 1 to 80 characters');
    expect(() => renameSet(set, 'x'.repeat(81))).toThrow('name: 1 to 80 characters');
  });

  it('inputText: the set, the result, the function with only the bounds it reads and has, the weight', () => {
    const i = { set: set.id, column: 'radiation_front', weight: 1, fn: 'normalise' as const };
    expect(inputText(i, 0, [set])).toBe('1. South: Radiation, front; normalised 0 to 1; weight 1');
    expect(inputText({ ...i, lo: 10, hi: 200 }, 1, [set])).toBe('2. South: Radiation, front; normalised 0 to 1 (0 at 10, 1 at 200); weight 1');
    expect(inputText({ ...i, fn: 'invert', hi: 50, weight: 0.5 }, 0, [set])).toBe('1. South: Radiation, front; inverted (1 - normalised) (0 at 50); weight 0.5');
    expect(inputText({ ...i, fn: 'threshold', lo: 5, hi: 9 }, 0, [set])).toBe('1. South: Radiation, front; 1 at or above a threshold (threshold 5); weight 1');
    expect(inputText({ ...i, fn: 'band', lo: 2, hi: 8 }, 0, [set])).toBe('1. South: Radiation, front; 1 within a band (from 2, to 8); weight 1');
    expect(inputText({ ...i, fn: 'raw', lo: 2, hi: 8 }, 0, [set])).toBe('1. South: Radiation, front; as it is; weight 1');
    expect(inputText({ ...i, fn: 'log' }, 0, [set])).toBe('1. South: Radiation, front; log10; weight 1');
    expect(inputText({ ...i, set: 'gone-ab12', column: '' }, 2, [set])).toBe('3. gone-ab12 (not saved): no result; normalised 0 to 1; weight 1');
  });
});

describe('parseSets', () => {
  const s = open(['tower', facade()]), set = captureSet(s, 'daylight', 'South', { shown: 'radiation_front' });
  const view: CombinedView = { kind: 'combined', id: 'score-ab12', name: 'Score', created: set.created, updated: set.updated, unit: '', op: 'mean', inputs: [{ set: set.id, column: 'radiation_front', weight: 1, fn: 'normalise' }] };
  const entry = (x: unknown, id = (x as { id: string }).id) => ({ id, spec: JSON.stringify(x) });

  it('keeps what the app can read, drops the rest', () => {
    const list = parseSets([
      entry(set), entry(view), { id: 'bad-json', spec: '{' }, entry({ ...set, id: 'other' }, 'mismatch'), entry({ ...set, kind: 'report' }),
      entry({ ...set, models: [{ model: 'E', file: 'x', roles: [] }] }), entry({ ...set, models: [{ model: 'A', file: 'x', roles: [{ path: 'no-slash', role: 'receiver' }] }] }),
      entry({ ...view, op: 'median' }), entry({ ...view, inputs: [] }), entry({ ...view, inputs: [{ ...view.inputs[0], weight: -1 }] }),
      entry({ ...set, weather: { ...set.weather, source: 'ftp' } }), entry({ ...set, site: { lat: 95, lon: 0, place: 'x' } }), entry({ ...set, subdiv: 7 }),
      entry({ ...set, looks: { quantities: {}, colors: { below: 'red', above: '#ff0000' } } }), entry({ ...set, models: [{ ...set.models[0], optics: { '/M': { rho: 2, tau: 0, kind: 'glass' } } }] }),
    ]);
    expect(list.map((x) => x.id)).toEqual([set.id, view.id]);
  });

  it('a set\'s charts are read as the app keeps them: the built-ins first, junk dropped', () => {
    const [x] = parseSets([entry({ ...set, charts: [{ id: 'facades', kind: 'parts', metric: 'mean' }, { id: 'junk', kind: 'pie' }] })]) as AnalysisSet[];
    expect(x.charts!.map((c) => c.id)).toEqual(['hist', 'curve', 'facades']);
  });

  it('an older set opens with the fields it lacks at their defaults', () => {
    const old = { ...set, settings: { sim: { mode: 'ladybug' }, time: { mode: 'instant' } } };
    const [x] = parseSets([entry(old)]) as AnalysisSet[];
    expect('sim' in x.settings && [x.settings.sim.mode, x.settings.sim.bounces, x.settings.time.mode, x.settings.time.stepMin]).toEqual(['ladybug', 0, 'instant', 60]);
  });
});
