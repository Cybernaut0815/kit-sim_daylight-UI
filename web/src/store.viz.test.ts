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
});
