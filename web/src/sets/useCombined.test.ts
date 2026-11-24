import { describe, expect, it } from 'vitest';
import { draftOf, previewOf, type Draft } from '../panels/CombinedPanel';
import { initialState, reducer, type RunResult } from '../store';
import { columnOf } from './combine';
import { checkView, viewHelp, type AnalysisSet, type CombinedView } from './model';
import type { SetModelStatus } from './runs';
import { missingOf, shownView } from './useCombined';

const set = (id: string, name: string): AnalysisSet => ({
  kind: 'set', id, name, created: 't', updated: 't', tool: 'daylight', models: [], settings: { viewSim: initialState().settings.viewSim }, column: 'radiation_front', colourBy: 'value',
});
const sets = [set('sun-ab12', 'Sun'), set('view-cd34', 'View south')];
const result = (columns: string[]) => ({ columns }) as RunResult;

describe('combined views', () => {
  it('COLUMN and COLOUR_BY tagged combined change only the Combined tab', () => {
    const s = initialState(), c = reducer(s, { type: 'COLUMN', column: 'combined_x-ab12', tab: 'combined' });
    expect(c.combined.column).toBe('combined_x-ab12');
    expect([c.column, c.viewAnalysis.column]).toEqual([s.column, s.viewAnalysis.column]);
    const p = reducer(c, { type: 'COLOUR_BY', colourBy: 'plain', tab: 'combined' });
    expect([p.combined.colourBy, p.colourBy, p.viewAnalysis.colourBy]).toEqual(['plain', s.colourBy, s.viewAnalysis.colourBy]);
    expect(reducer(p, { type: 'COLUMN', column: 'combined_x-ab12', tab: 'combined' })).toBe(p); // unchanged: the same state
  });

  it('checkView: defaults, every problem by its path, the id and created of the view it replaces', () => {
    const v = checkView({ name: ' Sun and view ', op: 'mean', inputs: [{ set: 'sun-ab12', column: 'radiation_front' }, { set: 'view-cd34', column: 'sky_front', weight: 2, fn: 'normalise', lo: 0, hi: 1 }] }, sets, undefined, 'now');
    expect(Array.isArray(v)).toBe(false);
    const ok = v as CombinedView;
    expect(ok).toMatchObject({ kind: 'combined', name: 'Sun and view', unit: '', op: 'mean', created: 'now', inputs: [{ weight: 1, fn: 'raw' }, { weight: 2, fn: 'normalise', lo: 0, hi: 1 }] });
    expect(ok.id).toMatch(/^sun-and-view-[a-z0-9]{4}$/);
    expect((checkView({ ...ok, name: 'Again' }, sets, ok, 'later') as CombinedView)).toMatchObject({ id: ok.id, created: 'now', updated: 'later', name: 'Again' });
    expect(checkView({ name: '', op: 'avg', inputs: [{ set: 'gone', column: 'a b', weight: -1, fn: 'sq', lo: 2, hi: 1, meshes: ['W'] }] }, sets)).toEqual([
      'name: 1 to 80 characters', 'op: one of mean, sum, min, max, product', 'inputs[0].set: the id of a saved set (sun-ab12, view-cd34)',
      "inputs[0].column: a result column of the set, such as 'radiation_front' or 'sky_front'", 'inputs[0].weight: a number, 0 or more (0: left out)',
      'inputs[0].fn: one of raw, normalise, invert, log, threshold, band', 'inputs[0].hi: not below lo (2)', 'inputs[0].meshes: 1 to 50 prim paths, each starting with / (none: every receiver)',
    ]);
    expect(checkView({ name: 'x', op: 'sum', inputs: [] }, sets)).toEqual(['inputs: 1 to 8 inputs {set, column, weight?, fn?, lo?, hi?, meshes?}']);
  });

  it("missingOf names each input a model misses, as 'C: no result of View south'", () => {
    const v = checkView({ name: 'x', op: 'max', inputs: [{ set: 'sun-ab12', column: 'radiation_front' }, { set: 'view-cd34', column: 'sky_front' }, { set: 'gone-0000', column: 'sky_front' }] }, [...sets, set('gone-0000', 'Gone')]) as CombinedView;
    const st = (slot: number, state: SetModelStatus['state'], extra: Partial<SetModelStatus> = {}): SetModelStatus => ({ slot, model: 'ABCD'[slot], state, ...extra });
    const inputs = [
      { input: v.inputs[0], set: sets[0], status: [st(0, 'done', { result: result(['radiation_front']) }), st(1, 'done', { result: result(['direct_front']) }), st(2, 'running'), st(3, 'none')] },
      { input: v.inputs[1], set: sets[1], status: [st(0, 'error', { message: 'out of memory' }), st(1, 'no-receiver'), st(2, 'missing'), st(3, 'missing')] },
      { input: v.inputs[2], set: null, status: [] },
    ];
    expect(missingOf(0, inputs)).toEqual(['A: View south failed (out of memory)', 'A: the set gone-0000 is deleted']);
    expect(missingOf(1, inputs)).toEqual(['B: Sun has no Radiation, front', 'B: no receiver in View south', 'B: the set gone-0000 is deleted']);
    expect(missingOf(2, inputs)).toEqual(['C: no result of Sun yet', 'C: no result of View south', 'C: the set gone-0000 is deleted']);
    expect(missingOf(3, inputs)[0]).toBe('D: no entry in Sun');
  });

  it('viewHelp says the op, each input with its function and weight, and the unit', () => {
    const v = checkView({ name: 'x', unit: 'pts', op: 'sum', inputs: [{ set: 'sun-ab12', column: 'radiation_front', fn: 'threshold', lo: 1000, weight: 2 }, { set: 'nope-0000', column: 'sky_front', meshes: ['/W'] }] }, [...sets, set('nope-0000', 'n')]) as CombinedView;
    expect(viewHelp(v, sets)).toBe('The weighted sum of Sun, Radiation, front at or above 1,000 (1, else 0), weight 2; nope-0000 (deleted), Sky, front, on /W. In pts. Meshes no input covers stay unpainted.');
  });

  it('shownView: the preview, else the saved view of the column, else the first, else none', () => {
    const a = checkView({ name: 'A', op: 'mean', inputs: [{ set: 'sun-ab12', column: 'radiation_front' }] }, sets) as CombinedView;
    const b = checkView({ name: 'B', op: 'max', inputs: [{ set: 'view-cd34', column: 'sky_front' }] }, sets) as CombinedView;
    const draft = { ...a, name: 'A edited' };
    expect(shownView([a, b], columnOf(b), null)).toBe(b);
    expect(shownView([a, b], 'combined_gone-0000', null)).toBe(a);
    expect(shownView([a, b], columnOf(b), draft)).toBe(draft);
    expect(shownView([], '', draft)).toBe(draft);
    expect(shownView([], '', null)).toBeNull();
  });

  it("previewOf: a valid draft under its view's id ('draft' for a new one), else what is wrong", () => {
    const saved = checkView({ name: 'Sun and view', op: 'mean', inputs: [{ set: 'sun-ab12', column: 'radiation_front' }] }, sets, undefined, 'then') as CombinedView;
    const edited: Draft = { ...draftOf(saved), name: 'Renamed', op: 'sum' };
    edited.inputs = [{ ...edited.inputs[0], weight: 2, fn: 'normalise', lo: 0, hi: 5, meshes: ' /W, /E ' }];
    expect(previewOf(edited, sets)).toMatchObject({ id: saved.id, created: 'then', name: 'Renamed', op: 'sum', inputs: [{ set: 'sun-ab12', weight: 2, fn: 'normalise', lo: 0, hi: 5, meshes: ['/W', '/E'] }] });
    const fresh: Draft = { name: 'New', unit: '', op: 'mean', inputs: [{ set: 'view-cd34', column: 'sky_front', weight: 1, fn: 'raw', meshes: '', uid: 1, unfolded: true }] };
    const p1 = previewOf(fresh, sets) as CombinedView, p2 = previewOf({ ...fresh, name: 'New, typed on' }, sets) as CombinedView;
    expect([p1.id, p2.id]).toEqual(['draft', 'draft']);
    expect(p1.inputs[0]).not.toHaveProperty('meshes');
    expect(previewOf({ ...fresh, name: ' ', inputs: [{ ...fresh.inputs[0], set: '' }] }, sets)).toEqual(['name: 1 to 80 characters', 'inputs[0].set: the id of a saved set (sun-ab12, view-cd34)']);
  });
});
