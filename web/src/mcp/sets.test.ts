// The agent's set and combined-view tools (sets.ts) against a controller of two models opened from one file: a set
// saved from the app with roles and settings of its own (the app unchanged), the refusals naming their field, run_set's
// numbers per model, a set's kept results and a combined view's through results, a preview, and set_display's tab.
import { describe, expect, it, vi } from 'vitest';
import { isCombined, isSet, type AnalysisSet, type CombinedView, type Saved } from '../sets/model';
import type { SetModelStatus } from '../sets/runs';
import { initialState, reducer, type Action, type ObjectRow, type RunResult, type State } from '../store';
import { TOOLS, check } from './schema';
import { combinedOf, setsOf } from './sets';
import { HANDLERS, roleActions, type Ctl } from './tools';

const rows = (): ObjectRow[] => ['/Site/Wall', '/Site/Roof', '/Site/Tree'].map((path) => ({ id: path.slice(6).toLowerCase(), name: path.slice(6), path, tris: 2, verts: 4, role: 'none' }));
/** A result on the wall, a row per value of 1 m², in column `col`. */
const res = (col: string, values: number[]): RunResult => ({
  data: [Float32Array.from(values)], weights: new Float32Array(values.length).fill(1), columns: [col], receivers: ['wall'], on: 'faces', key: JSON.stringify([[col, String(values)], null, 'wall']), elapsed: 0,
  manifest: { columns: [col], meshes: [{ name: 'Wall', first: 0, count: values.length }] } as unknown as RunResult['manifest'],
});

/** Models A and B, both block.usdz (/Site/Wall, Roof and Tree; A's wall a daylight receiver); the saved sets and combined
 *  views as the server keeps them; each set's status per model from `status` (the runner's). */
function app(status: (set: AnalysisSet) => SetModelStatus[] = () => []) {
  let state: State = reducer(reducer(initialState(), { type: 'LOAD', slot: 0, objects: rows(), name: 'block.usdz' }), { type: 'ADD' });
  state = reducer(reducer(state, { type: 'LOAD', slot: 1, objects: rows(), name: 'block.usdz' }), { type: 'ROLE', slot: 0, ids: ['wall'], role: 'receiver' });
  state = reducer(state, { type: 'ACTIVE', slot: 0 });
  let saved: Saved[] = [], ui = { tab: 'daylight', labels: false };
  const run = vi.fn(async () => {}), opened: AnalysisSet[] = [], dispatch = (a: Action) => { state = reducer(state, a); };
  const c = () => ({
    sunAround: {}, field: { shown: false, scale: 1, density: 'some', around: {} },
    state, dispatch, ui, setUi: (f: (u: typeof ui) => typeof ui) => { ui = f(ui); }, panes: { 0: { loading: false }, 1: { loading: false } }, meshOf: () => undefined,
    analysis: (tool: string) => ({ tool, models: state.models, shown: tool === 'views' ? null : 'sunhours_front', column: state.column, colourBy: state.colourBy, scale: null, dispatch }),
    sets: { saved, error: null, refresh: async () => {}, put: async (x: Saved) => { saved = [...saved.filter((k) => k.id !== x.id), x]; return true; }, remove: async (id: string) => { saved = saved.filter((k) => k.id !== id); return true; } },
    runs: { statusOf: status, run, cancel: () => {}, busy: false },
    combined: { views: saved.filter(isCombined), sets: saved.filter(isSet), view: null, inputs: [], notes: [], models: state.models, shown: null, scale: null, domain: [NaN, NaN] },
    openSet: (s: AnalysisSet) => { opened.push(s); dispatch({ type: 'APPLY_SET', set: s }); },
    viewer: () => ({ materials: new Map([[1, { path: '/Looks/Brick' }], [2, { path: '/Looks/Glass' }]]) }), // the stage's materials by rid

  }) as unknown as Ctl;
  return { c, run, opened, saved: () => saved };
}
const call = async (c: () => Ctl, name: string, args: Record<string, unknown>) => {
  const why = check(TOOLS.find((t) => t.name === name)!.inputSchema, args);
  if (why) return why;
  try {
    return (await HANDLERS[name](args, c, Date.now() + 5e3)).content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join(' ');
  } catch (e) {
    return (e as Error).message;
  }
};
const json = async (c: () => Ctl, name: string, args: Record<string, unknown>) => JSON.parse(await call(c, name, args));

describe('save_set', () => {
  it("keeps the app's setup with roles and settings of its own; the app itself does not change", async () => {
    const { c, saved } = app();
    const r = await json(c, 'save_set', { name: 'Summer', roles: [{ model: 'B', paths: ['/Site/Wall'], role: 'receiver' }, { paths: ['/Site/Tree'], role: 'shade' }], settings: { time: { mode: 'instant', date: '2026-06-21', hour: '12:00' } } });
    expect(r.saved).toMatchObject({ name: 'Summer', analysis: 'daylight', column: 'sunhours_front', models: [{ model: 'A', file: 'block.usdz', roles: 2 }, { model: 'B', file: 'block.usdz', roles: 1 }] });
    const set = saved()[0] as AnalysisSet;
    expect(set.models[0].roles).toEqual([{ path: '/Site/Wall', role: 'receiver' }, { path: '/Site/Tree', role: 'shade' }]);
    expect('time' in set.settings && [set.settings.time.mode, set.settings.time.date, set.settings.time.hour]).toEqual(['instant', '2026-06-21', 720]);
    expect(c().state.settings.time).toEqual(initialState().settings.time);
    expect(c().state.models[1].objects.map((o) => o.role)).toEqual(['none', 'none', 'none']);
    const again = await json(c, 'save_set', { id: set.id, name: 'Summer noon' }); // replaced: the app's roles now, its created kept
    expect([again.saved.id, saved().length, (saved()[0] as AnalysisSet).created, (saved()[0] as AnalysisSet).models[1].roles]).toEqual([set.id, 1, set.created, []]);
    await call(c, 'save_set', { name: 'Turned', settings: { sim: { north: 10 } } }); // a set keeps north: the set's, not the app's
    expect([(saved()[1] as AnalysisSet).north, c().state.settings.sim.north]).toEqual([10, 0]);
  });

  it('a View analysis set takes targets by group and the view settings, checked as the panel checks them', async () => {
    const { c, saved } = app();
    await call(c, 'save_set', { name: 'Park view', analysis: 'views', roles: [{ paths: ['/Site/Wall'], role: 'receiver' }, { paths: ['/Site/Tree'], role: 'target', group: 'park' }], settings: { view: { far: 80 } }, column: 'park_front' });
    const set = saved()[0] as AnalysisSet;
    expect([set.tool, set.column, set.models[0].roles, 'viewSim' in set.settings && set.settings.viewSim.far]).toEqual(['views', 'park_front', [{ path: '/Site/Wall', role: 'receiver' }, { path: '/Site/Tree', role: 'shade', group: 'park' }], 80]);
    expect(c().state.models[0].viewAnalysis.objects.map((o) => o.role)).toEqual(['none', 'none', 'none']);
    expect(await call(c, 'save_set', { name: 'X', analysis: 'views', settings: { view: { fov: [200, 0, 10] } } })).toMatch(/^settings\.view\.fov: The field is up to 180°/);
    expect('viewSim' in set.settings && set.settings.viewSim.gaze).toBe('level');
    await call(c, 'save_set', { name: 'Tilted', analysis: 'views', settings: { view: { gaze: 'normal' } } }); // the gaze: about the normal itself
    expect(saved().map((x) => 'settings' in x && 'viewSim' in x.settings && x.settings.viewSim.gaze)).toEqual(['level', 'normal']);
    expect(await call(c, 'save_set', { name: 'X', analysis: 'views', settings: { view: { gaze: 'up' } } })).toMatch(/^settings\.view\.gaze/);
    expect(await call(c, 'save_set', { name: 'X', analysis: 'views', roles: [{ paths: ['/Site/Tree'], role: 'shade' }] })).toMatch(/^roles\[0\]\.role: the View analysis' roles are receiver, obstruction, target and none/);
    expect(await call(c, 'save_set', { name: 'X', analysis: 'views', roles: [{ paths: ['/Site/Tree'], role: 'target' }] })).toMatch(/^roles\[0\]\.group: a target takes its group/);
    expect(await call(c, 'save_set', { id: set.id, name: 'X', analysis: 'daylight' })).toMatch(/^analysis: set park-view-\w{4} is a views set/);
  });

  it('names the field of what is wrong and saves nothing then', async () => {
    const { c, saved } = app();
    expect(await call(c, 'save_set', { name: 'X', settings: { view: { far: 50 } } })).toBe('settings.view: not a setting of a Daylight set (it takes sim and time)');
    expect(await call(c, 'save_set', { name: 'X', settings: { time: { step: 7 } } })).toBe('settings.time.step: one of 10, 15, 30, 60');
    expect(await call(c, 'save_set', { name: 'X', settings: { time: { date: '2026-02-30' } } })).toMatch(/^settings\.time\.date: no such date/);
    expect(await call(c, 'save_set', { name: 'X', roles: [{ paths: ['/Site/Wall'], role: 'target', group: 'park' }] })).toMatch(/^roles\[0\]\.role: target is a View analysis role/);
    expect(await call(c, 'save_set', { name: 'X', roles: [{ paths: ['/Nope'], role: 'receiver' }] })).toMatch(/^roles\[0\]\.paths: no mesh at or under them in model A/);
    expect(await call(c, 'save_set', { name: 'X', roles: [{ model: 'C', paths: ['/'], role: 'receiver' }] })).toMatch(/^roles\[0\]\.model: no model in slot C/);
    expect(await call(c, 'save_set', { name: 'X', column: 'illuminance_back' })).toBe('column: not a column the set computes (radiation_front, direct_front, diffuse_front, irradiance_front, illuminance_front, sunhours_front)');
    expect(await call(c, 'save_set', { name: 'X', id: 'nope' })).toBe('id: no set nope (none saved; save_set first)');
    expect(await call(c, 'save_set', { name: ' ' })).toBe('name: not blank');
    expect(saved()).toEqual([]);
  });
});

describe('open_set and run_set', () => {
  it('open_set applies the set as the Sets menu does and says which entry each model took', async () => {
    const { c, opened, saved } = app();
    await call(c, 'save_set', { name: 'Both walls', roles: [{ model: 'B', paths: ['/Site/Wall'], role: 'receiver' }] });
    const set = saved()[0] as AnalysisSet, r = await json(c, 'open_set', { id: set.id });
    expect(r.models.map((m: Record<string, unknown>) => [m.model, m.entry, m.how, m.matched])).toEqual([['A', 'A', 'same', 1], ['B', 'B', 'same', 1]]);
    expect([opened, c().state.models[1].objects.find((o) => o.id === 'wall')!.role]).toEqual([[set], 'receiver']);
    expect(await call(c, 'open_set', { id: 'nope' })).toMatch(/^id: no set nope \(both-walls-\w{4}\)$/);
    await c().sets.put({ ...set, id: 'waiting-ab12', models: [...set.models, { model: 'C', file: 'gone.usdz', roles: [] }] });
    expect((await json(c, 'open_set', { id: 'waiting-ab12' })).notOpen).toEqual(['gone.usdz (C in the set): not open, its roles wait for it']);
  });

  it('copy_set makes a new set for another model by prim path, saves and opens it; the set copied stays', async () => {
    const { c, opened, saved } = app();
    c().dispatch({ type: 'OPTICS_EDIT', slot: 0, key: '/Looks/Brick', edit: { rho: 0.3, tau: 0, kind: 'opaque' } });
    c().dispatch({ type: 'OPTICS_EDIT', slot: 0, key: '/Looks/Steel', edit: { rho: 0.5, tau: 0, kind: 'opaque' } });
    await call(c, 'save_set', { name: 'Walls' });
    const set = saved()[0] as AnalysisSet, before = c().state.models[0];
    expect(await call(c, 'copy_set', { id: set.id, to: 'B' })).toBe(`from: set Walls has several entries (A block.usdz, B block.usdz); name the one to copy`);
    expect(await call(c, 'copy_set', { id: set.id, to: 'B', from: 'C' })).toBe('from: set Walls has no entry C (A block.usdz, B block.usdz)');
    expect(await call(c, 'copy_set', { id: set.id, to: 'C', from: 'A' })).toMatch(/^to: no model in slot C/);
    const r = await json(c, 'copy_set', { id: set.id, to: 'B', from: 'A' });
    expect(r).toMatchObject({
      saved: { name: 'Walls for block.usdz', analysis: 'daylight', from: 'A', to: 'B', file: 'block.usdz' }, roles: { matched: 1, of: 1 }, meshesWithoutRole: 2,
      materialEdits: { matched: 1, of: 2 }, text: 'B: 1 of 1 roles by path, 2 meshes without a role; 1 of 2 material edits',
    });
    const copy = saved().find((x) => x.id === r.saved.id) as AnalysisSet;
    expect(copy.models).toEqual([{ model: 'B', file: 'block.usdz', roles: [{ path: '/Site/Wall', role: 'receiver' }], optics: { '/Looks/Brick': { rho: 0.3, tau: 0, kind: 'opaque' } } }]);
    expect([opened.at(-1), c().state.models[1].objects.find((o) => o.id === 'wall')!.role, c().state.models[1].optics]).toEqual([copy, 'receiver', copy.models[0].optics]);
    expect(c().state.models[0]).toBe(before); // A has no entry in the copy
    expect((saved().find((x) => x.id === set.id) as AnalysisSet).models).toHaveLength(2);
    expect((await json(c, 'copy_set', { id: copy.id, to: 'A', name: 'Mine' })).saved).toMatchObject({ name: 'Mine', from: 'B', to: 'A' }); // one entry: no from needed
  });

  it('rename_set gives a set or a combined view another name, its id and all it keeps as they are; a blank name is refused', async () => {
    const { c, saved } = app();
    await call(c, 'save_set', { name: 'Walls' });
    const set = saved()[0] as AnalysisSet;
    expect(await json(c, 'rename_set', { id: set.id, name: ' South walls ' })).toEqual({ renamed: { id: set.id, kind: 'set', from: 'Walls', name: 'South walls' } });
    const renamed = saved()[0] as AnalysisSet;
    expect(renamed).toEqual({ ...set, name: 'South walls', updated: renamed.updated });
    expect(await call(c, 'rename_set', { id: set.id, name: '   ' })).toBe('name: 1 to 80 characters');
    expect(await call(c, 'rename_set', { id: 'nope', name: 'X' })).toMatch(/^id: no set or combined view nope \(sets: walls-\w{4}; combined views: none\)$/);
    await call(c, 'save_combined', { name: 'Score', op: 'mean', inputs: [{ set: set.id, column: 'sunhours_front' }] });
    const view = saved().find(isCombined)!;
    expect(await json(c, 'rename_set', { id: view.id, name: 'Facade score' })).toEqual({ renamed: { id: view.id, kind: 'combined', from: 'Score', name: 'Facade score' } });
    expect(saved().find(isCombined)).toEqual({ ...view, name: 'Facade score', updated: saved().find(isCombined)!.updated });
    expect(saved().find(isCombined)!.inputs[0].set).toBe(set.id); // the view still takes the renamed set
  });

  it('run_set runs the models without a result and quotes the column of each done one', async () => {
    const done: SetModelStatus = { slot: 0, model: 'A', state: 'done', result: res('sunhours_front', [1, 3]) };
    const { c, run, saved } = app(() => [done, { slot: 1, model: 'B', state: 'missing' }]);
    await call(c, 'save_set', { name: 'Sun' });
    const set = saved()[0] as AnalysisSet, r = await json(c, 'run_set', { id: set.id });
    expect(run).toHaveBeenCalledWith(set, [1]);
    expect(r.models[0]).toMatchObject({ model: 'A', status: 'done', column: 'sunhours_front', mean: 2 });
    expect(r.models[1]).toEqual({ model: 'B', status: 'not run' });
    expect(await call(c, 'run_set', { id: set.id, models: ['C'] })).toBe('models[0]: no model with a file in slot C (A, B)');
    expect((await json(c, 'run_set', { id: set.id, wait: 0 })).models).toHaveLength(2); // answers at once
    expect(run).toHaveBeenCalledTimes(2);
    expect(await call(c, 'run_set', { id: set.id, wait: 41 })).toBe('wait: 0 to 40');
    expect(setsOf(c())).toEqual([{ id: set.id, name: 'Sun', analysis: 'daylight', column: 'sunhours_front', models: ['A', 'B'], updated: set.updated, summary: expect.any(Array), status: [{ model: 'A', status: 'done', seconds: 0 }, { model: 'B', status: 'not run' }] }]);
    expect(setsOf(c())[0].summary.slice(0, 3)).toEqual(['Model A: block.usdz: 1 receiver, 0 shades, no material edits', 'Model B: block.usdz: 0 receivers, 0 shades, no material edits', 'Location: London, United Kingdom (51.5, -0.128), north 0°']);
  });
});

describe('combined views', () => {
  /** Sets Sun (A and B done) and Sky (A done, B not run), and the view Score: their mean per element. */
  async function scored() {
    const results: Record<string, SetModelStatus[]> = {};
    const x = app((set) => results[set.name] ?? []);
    await call(x.c, 'save_set', { name: 'Sun' });
    await call(x.c, 'save_set', { name: 'Sky', analysis: 'views', column: 'sky_front' });
    results.Sun = [{ slot: 0, model: 'A', state: 'done', result: res('sunhours_front', [1, 3]) }, { slot: 1, model: 'B', state: 'done', result: res('sunhours_front', [2, 2]) }];
    results.Sky = [{ slot: 0, model: 'A', state: 'done', result: res('sky_front', [0.5, 0.5]) }, { slot: 1, model: 'B', state: 'missing' }];
    const [sun, sky] = x.saved() as AnalysisSet[];
    const saved = await json(x.c, 'save_combined', { name: 'Score', op: 'mean', inputs: [{ set: sun.id, column: 'sunhours_front' }, { set: sky.id, column: 'sky_front' }] });
    return { ...x, sun, sky, saved };
  }

  it('save_combined says the view in words and what each model misses; a problem names its input', async () => {
    const { c, sun, saved } = await scored();
    expect(saved.saved).toMatchObject({ name: 'Score', op: 'mean', inputs: 2, column: `combined_${saved.saved.id}` });
    expect(saved.meaning).toBe('The weighted mean of Sun, Sun hours, front; Sky, Sky, front. A score: its total over the area in m². Meshes no input covers stay unpainted.');
    expect(saved.missing).toEqual(['B: no result of Sky']);
    expect(await call(c, 'save_combined', { name: 'X', op: 'mean', inputs: [{ set: 'nope', column: 'sky_front' }, { set: sun.id, column: 'sky_front', lo: 2, hi: 1 }] })).toMatch(/^2 problems: inputs\[0\]\.set: the id of a saved set \(.*\); inputs\[1\]\.hi: not below lo \(2\)$/);
    expect(await call(c, 'save_combined', { id: sun.id, name: 'X', op: 'mean', inputs: [{ set: sun.id, column: 'sunhours_front' }] })).toMatch(/^id: sun-\w{4} is a set/);
    expect(combinedOf(c())).toMatchObject([{ id: saved.saved.id, name: 'Score', shown: false, missing: ['B: no result of Sky'] }]);
  });

  it('results with analysis combined combines per model without changing the app, runs the missing inputs first, and differences to the first', async () => {
    const { c, run, sun, sky, saved } = await scored(), id = saved.saved.id;
    const r = await json(c, 'results', { analysis: 'combined', id, thresholds: [1.5] });
    expect(run).toHaveBeenCalledWith(sky, [1]); // B's Sky first (it stays not run here)
    const [a, b] = r.models;
    expect([r.analysis, r.column, a.model, a.inputs, a.whole.mean, a.whole.thresholds[0].atOrAbove]).toEqual(['combined', `combined_${id}`, 'A', '2 of 2', 1.25, 50]); // (1 + 0.5) / 2, (3 + 0.5) / 2
    expect([b.model, b.missing, b.inputs, b.whole.mean, b.whole.diff.mean]).toEqual(['B', ['B: no result of Sky'], '1 of 2', 2, 0.75]);
    expect(a.rows).toEqual([expect.objectContaining({ mesh: '/Site/Wall', mean: 1.25 })]);
    expect(c().state.column).toBe(initialState().column);
    expect(await call(c, 'results', { analysis: 'combined', id: 'nope' })).toMatch(/^id: no combined view nope/);
    expect(await call(c, 'results', { analysis: 'combined', id, column: 'sky_front' })).toBe('column: a combined view has one column of its own; leave column out');
    expect(await call(c, 'results', { analysis: 'combined', id, set: sun.id })).toMatch(/^set: quotes a saved set's kept results/);
    await json(c, 'delete_set', { id: sky.id }).then((d) => expect([d.kind, d.note]).toEqual(['set', 'combined views that took it as an input now miss it: Score']));
    run.mockClear();
    expect((await json(c, 'results', { analysis: 'combined', id, wait: 0 })).models[0].missing).toEqual([`A: the set ${sky.id} is deleted`]);
    expect(run).not.toHaveBeenCalled(); // wait 0: quotes what there is
    expect(await json(c, 'delete_set', { id })).toEqual({ deleted: id, kind: 'combined', sets: [sun.id], combined: [] });
  });

  it("results with set quotes a saved set's kept results without opening it, the first model the reference", async () => {
    const { c, sun, sky } = await scored();
    const r = await json(c, 'results', { set: sun.id, thresholds: [2] }), [a, b] = r.models;
    expect([r.set, r.column, r.unit, r.problemRange]).toEqual([{ id: sun.id, name: 'Sun', analysis: 'daylight' }, 'sunhours_front', 'h', { lo: null, hi: null }]);
    expect([a.model, a.whole.mean, a.whole.thresholds[0].atOrAbove, a.run.seconds, b.model, b.whole.mean, b.whole.diff.mean]).toEqual(['A', 2, 50, 0, 'B', 2, 0]);
    const s = await json(c, 'results', { set: sky.id, models: ['A', 'B'] });
    expect([s.set.analysis, s.column, s.models[1]]).toEqual(['views', 'sky_front', { model: 'B', name: 'block.usdz', status: 'not run', result: null }]);
    expect(await call(c, 'results', { set: sun.id, column: 'sky_front' })).toBe("column: model A's kept result has no sky_front (sunhours_front)");
    expect(await call(c, 'results', { set: sun.id, analysis: 'views' })).toBe(`analysis: set ${sun.id} is a daylight set; leave analysis out`);
    expect(await call(c, 'results', { set: 'nope' })).toMatch(/^set: no set nope/);
    expect(c().state.column).toBe(initialState().column); // nothing opened
  });

  it('save_combined with preview shows a draft on the Combined tab without storing it; a save shows the saved view instead', async () => {
    const { c, sun } = await scored();
    let shown = null as CombinedView | null; // the preview the Combined tab shows, as App keeps it
    const x = () => { const y = c(); return { ...y, combined: { ...y.combined, view: shown }, previewCombined: (v: CombinedView | null) => { shown = v; } } as unknown as Ctl; };
    const draft = { name: 'Best of', op: 'max', inputs: [{ set: sun.id, column: 'sunhours_front' }] };
    const p = await json(x, 'save_combined', { ...draft, preview: true });
    expect(p.preview).toMatchObject({ id: 'draft', name: 'Best of', op: 'max', inputs: 1 });
    expect([p.tab, x().ui.tab, shown?.name, x().sets.saved.filter(isCombined).length]).toEqual(['combined', 'combined', 'Best of', 1]);
    expect(combinedOf(x()).at(-1)).toMatchObject({ id: 'draft', name: 'Best of', shown: true, preview: true });
    const s = await json(x, 'save_combined', draft);
    expect([shown, x().sets.saved.filter(isCombined).length, s.saved.name]).toEqual([null, 2, 'Best of']);
    expect(await call(x, 'save_combined', { ...draft, inputs: [{ set: 'nope', column: 'sky_front' }], preview: true })).toMatch(/^1 problem: inputs\[0\]\.set: /);
  });

  it("set_display shows a combined view by id on the Combined tab", async () => {
    const { c, saved } = await scored(), id = saved.saved.id;
    expect((await json(c, 'set_display', { analysis: 'combined', id, colourBy: 'value' })).analysis).toBe('combined');
    expect([c().ui.tab, c().state.combined.column, c().state.combined.colourBy]).toEqual(['combined', `combined_${id}`, 'value']);
  });

  it("results with analysis combined by 'facing' reads the sides against its first input run's north", async () => {
    const results: Record<string, SetModelStatus[]> = {};
    const x = app((set) => results[set.name] ?? []);
    await call(x.c, 'save_set', { name: 'Sun' });
    results.Sun = [{ slot: 0, model: 'A', state: 'done', result: { ...res('sunhours_front', [1, 3]), key: JSON.stringify([['--north', '90'], null, 'wall']) } }];
    const id = (await json(x.c, 'save_combined', { name: 'Sun only', op: 'mean', inputs: [{ set: (x.saved()[0] as AnalysisSet).id, column: 'sunhours_front' }] })).saved.id;
    const wall = { positions: Float32Array.from([0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1]), indices: Uint32Array.from([0, 1, 2, 0, 2, 3]) }; // two triangles facing -Y
    const c = () => ({ ...x.c(), meshOf: () => wall }) as unknown as Ctl;
    const r = await json(c, 'results', { analysis: 'combined', id, by: 'facing', models: ['A'] });
    expect(r.models[0].rows).toEqual([expect.objectContaining({ facing: 'W', elements: 2, mean: 2 })]); // north 90°: the model's -Y faces west
  });
});

describe('roles and the display by analysis', () => {
  it('roleActions: daylight as it was; the view analysis tagged, a target a shade in its group', () => {
    const m = app().c().state.models[0];
    expect(roleActions(m, { paths: ['/Site'], role: 'receiver', shade: false }, 'daylight')).toEqual([
      { type: 'ROLE', slot: 0, ids: ['wall', 'roof', 'tree'], role: 'receiver' }, { type: 'SHADE', slot: 0, ids: ['wall', 'roof', 'tree'], shade: false },
    ]);
    expect(roleActions(m, { paths: ['/Site/Tree'], role: 'target', group: 'park' }, 'views')).toEqual([{ type: 'ROLE', slot: 0, ids: ['tree'], role: 'shade', group: 'park', tab: 'views' }]);
    expect(roleActions(m, { paths: ['/Site/Roof'], role: 'obstruction' }, 'views')).toEqual([{ type: 'ROLE', slot: 0, ids: ['roof'], role: 'shade', tab: 'views' }]);
    expect(() => roleActions(m, { paths: ['/Site/Roof'], role: 'shade', group: 'g' }, 'daylight')).toThrow(/^group: only with role 'target'$/);
  });

  it("set_display switches the tab as a click does, refuses an id off the Combined tab, and the labels", async () => {
    const { c } = app();
    const d = await json(c, 'set_display', { analysis: 'views', labels: true });
    expect([d.analysis, d.labels, c().ui.tab]).toEqual(['views', true, 'views']);
    expect(await call(c, 'set_display', { id: 'nope' })).toBe('id: no combined view nope (none saved; save_combined first)');
    expect(await call(c, 'set_display', { analysis: 'views', id: 'nope' })).toBe("id: a combined view shows on the Combined tab; give analysis 'combined'");
    expect(await call(c, 'set_display', { analysis: 'combined', column: 'sunhours_front' })).toBe("column: the Combined tab shows a combined view's own column; give its id instead");
  });
});
