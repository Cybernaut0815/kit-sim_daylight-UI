import { describe, expect, it } from 'vitest';
import { initialState, parseSettings, reducer, serializeSettings, type RunResult } from './store';

const result: RunResult = {
  values: [Float64Array.of(1), Float64Array.of(2)], columns: ['radiation_front'], receivers: ['a'], on: 'faces', key: 'k', elapsed: 0.1,
  manifest: { columns: ['radiation_front'], duration_h: 1, dirs: { sky: 145, ground: 145, sun: 1 }, meshes: [{ name: 'a', first: 0, count: 2 }] },
};
const defaults = { below: '#0000ff', above: '#ff0000' };

describe('result visualisation state', () => {
  it('a finished run shows values, clears the probe and the bin', () => {
    let s = reducer(initialState(), { type: 'LOAD', slot: 0, objects: [{ id: 'a', name: 'a', path: '/a', tris: 2, verts: 4, role: 'receiver' }] });
    s = reducer(s, { type: 'PROBE', probe: { id: 'a', element: 1, value: 2 } });
    s = reducer(s, { type: 'BIN', bin: [1, 2] });
    expect(s.probe?.value).toBe(2);
    s = reducer(s, { type: 'RUN', slot: 0, run: { status: 'done', result } });
    expect(s.colourBy).toBe('value');
    expect(s.probe).toBeNull();
    expect(s.bin).toBeNull();
    const same = reducer(s, { type: 'PROBE', probe: null });
    expect(same).toBe(s); // no re-render for an unchanged probe
  });
  it('VIZ merges per quantity, colours are shared, and a round trip through storage keeps it', () => {
    let s = reducer(initialState(), { type: 'VIZ', quantity: 'radiation', patch: { gradient: 'turbo', lo: 100 } });
    s = reducer(s, { type: 'VIZ', quantity: 'radiation', patch: { hi: 900, below: '#000080' } });
    s = reducer(s, { type: 'VIZ', quantity: 'sunhours', patch: { min: 0, max: 8 } });
    s = reducer(s, { type: 'VIZ', quantity: 'radiation', patch: { lo: null } });
    expect(s.settings.viz).toEqual({ gradients: { radiation: 'turbo' }, scales: { sunhours: { min: 0, max: 8 } }, ranges: { radiation: { lo: null, hi: 900 } }, colors: { below: '#000080', above: '#ff0000' } });
    const back = parseSettings(serializeSettings(s.settings));
    expect(back.viz).toEqual(s.settings.viz);
    expect(parseSettings('{"sim":{}}').viz).toEqual({ gradients: {}, scales: {}, ranges: {}, colors: defaults }); // an older record without viz
    expect(parseSettings('{"viz":{"colors":{"below":"#123456"}}}').viz.colors).toEqual({ below: '#123456', above: '#ff0000' });
  });
  it('VIZ_RESET restores one group for one quantity, colours with the range', () => {
    let s = reducer(initialState(), { type: 'VIZ', quantity: 'radiation', patch: { gradient: 'turbo', min: 1, lo: 2, above: '#800000' } });
    s = reducer(s, { type: 'VIZ', quantity: 'sunhours', patch: { gradient: 'greys' } });
    s = reducer(s, { type: 'VIZ_RESET', quantity: 'radiation', what: 'scale' });
    expect(s.settings.viz.gradients).toEqual({ sunhours: 'greys' });
    expect(s.settings.viz.scales).toEqual({});
    expect(s.settings.viz.ranges).toEqual({ radiation: { lo: 2, hi: null } });
    s = reducer(s, { type: 'VIZ_RESET', quantity: 'radiation', what: 'range' });
    expect(s.settings.viz.ranges).toEqual({});
    expect(s.settings.viz.colors).toEqual(defaults);
  });
  it('CHART puts a checked spec in place, removes an extra (never a built-in), resets a look; storage keeps it, junk loads the defaults', () => {
    const builtIns = [{ id: 'hist', kind: 'histogram' }, { id: 'curve', kind: 'curve' }];
    let s = initialState();
    expect(s.settings.charts).toEqual(builtIns);
    expect(reducer(s, { type: 'CHART', spec: { id: 'hist', kind: 'histogram', bins: 16, title: 'x', parts: ['/W'] } })).toBe(s); // a built-in takes its look only
    s = reducer(s, { type: 'CHART', spec: { id: 'hist', kind: 'histogram', bins: 16, range: [0, 8] } });
    s = reducer(s, { type: 'CHART', spec: { id: 'per-part', kind: 'parts', title: 'Per part', parts: ['/W'], metric: 'p10' } });
    expect(reducer(s, { type: 'CHART', spec: { id: 'curve', kind: 'histogram' } })).toBe(s); // a built-in keeps its kind
    expect(reducer(s, { type: 'CHART', spec: { id: 'bad id', kind: 'curve' } })).toBe(s);
    expect(reducer(s, { type: 'CHART', id: 'hist', remove: true })).toBe(s);
    const set = [{ id: 'hist', kind: 'histogram', range: [0, 8], bins: 16 }, builtIns[1], { id: 'per-part', kind: 'parts', title: 'Per part', parts: ['/W'], metric: 'p10' }];
    expect(s.settings.charts).toEqual(set);
    expect(parseSettings(serializeSettings(s.settings)).charts).toEqual(set);
    s = reducer(s, { type: 'CHART', spec: { id: 'per-part', kind: 'parts', metric: 'max' } }); // the whole spec is replaced
    s = reducer(s, { type: 'CHART', id: 'hist', reset: true });
    expect(s.settings.charts).toEqual([...builtIns, { id: 'per-part', kind: 'parts', metric: 'max' }]);
    expect(reducer(s, { type: 'CHART', id: 'per-part', reset: true }).settings.charts[2]).toEqual({ id: 'per-part', kind: 'parts' });
    expect(reducer(s, { type: 'CHART', id: 'per-part', remove: true }).settings.charts).toEqual(builtIns);
    expect(parseSettings('{"sim":{}}').charts).toEqual(builtIns); // an older record
    expect(parseSettings('{"charts":{"hist":{"bins":5}}}').charts).toEqual(builtIns);
    expect(parseSettings('{"charts":[{"id":"hist","kind":"curve"},{"id":"x","kind":"pie"},7,{"id":"e","kind":"curve","grid":false},{"id":"curve","kind":"curve","height":120}]}').charts)
      .toEqual([builtIns[0], { id: 'curve', kind: 'curve', height: 120 }, { id: 'e', kind: 'curve', grid: false }]);
  });
});
