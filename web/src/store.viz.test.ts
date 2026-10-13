import { describe, expect, it } from 'vitest';
import { initialState, parseSettings, reducer, serializeSettings, type RunResult } from './store';

const result: RunResult = {
  values: [Float64Array.of(1), Float64Array.of(2)], columns: ['radiation_front'], receivers: ['a'], on: 'faces',
  manifest: { columns: ['radiation_front'], duration_h: 1, dirs: { sky: 145, ground: 145, sun: 1 }, meshes: [{ name: 'a', first: 0, count: 2 }] },
};

describe('result visualisation state', () => {
  it('a finished run shows values, clears the probe and the bin', () => {
    let s = reducer(initialState(), { type: 'PROBE', probe: { id: 'a', element: 1, value: 2 } });
    s = reducer(s, { type: 'BIN', bin: [1, 2] });
    expect(s.probe?.value).toBe(2);
    s = reducer(s, { type: 'RUN', run: { status: 'done', result } });
    expect(s.colourBy).toBe('value');
    expect(s.probe).toBeNull();
    expect(s.bin).toBeNull();
    const same = reducer(s, { type: 'PROBE', probe: null });
    expect(same).toBe(s); // no re-render for an unchanged probe
  });
  it('VIZ merges per quantity and survives a round trip through storage', () => {
    let s = reducer(initialState(), { type: 'VIZ', quantity: 'radiation', patch: { gradient: 'turbo', lo: 100 } });
    s = reducer(s, { type: 'VIZ', quantity: 'radiation', patch: { hi: 900 } });
    s = reducer(s, { type: 'VIZ', quantity: 'sunhours', patch: { min: 0, max: 8 } });
    s = reducer(s, { type: 'VIZ', quantity: 'radiation', patch: { lo: null } });
    expect(s.settings.viz).toEqual({ gradients: { radiation: 'turbo' }, scales: { sunhours: { min: 0, max: 8 } }, ranges: { radiation: { lo: null, hi: 900 } } });
    const back = parseSettings(serializeSettings(s.settings));
    expect(back.viz).toEqual(s.settings.viz);
    expect(parseSettings('{"sim":{}}').viz).toEqual({ gradients: {}, scales: {}, ranges: {} }); // an older record without viz
  });
});
