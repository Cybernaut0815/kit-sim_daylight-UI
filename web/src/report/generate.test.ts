import { afterEach, describe, expect, it, vi } from 'vitest';
import { NONE } from '../lib/section';
import type { Ctl } from '../mcp/tools';
import { captureSet } from '../sets/model';
import { initialState, reducer, type Action, type ObjectRow, type RunResult, type State } from '../store';
import { generate } from './generate';
import type { Report } from './spec';

const events: string[] = []; // what the app was asked, in order
vi.mock('../viewer/capture', () => ({ capture: async () => { events.push('shot'); return new Blob([new Uint8Array(8)], { type: 'image/png' }); } })); // no GPU here
vi.mock('./Report', () => ({ renderReport: vi.fn(() => '<html></html>') }));

/** Two models of one file (a wall and a tree), loaded and set up: the wall a receiver in each, `step` minutes. */
function opened(role: ObjectRow['role'], step: number): State {
  const rows = ['/Site/Wall', '/Site/Tree'].map((path): ObjectRow => ({ id: path.slice(6).toLowerCase(), name: path.slice(6), path, tris: 2, verts: 4, role: 'none' }));
  let s = reducer(initialState(), { type: 'LOAD', slot: 0, objects: rows, name: 'building' });
  s = reducer(reducer(s, { type: 'ADD' }), { type: 'LOAD', slot: 1, objects: rows, name: 'building' });
  for (const slot of [0, 1]) s = reducer(s, { type: 'ROLE', slot, ids: ['wall'], role });
  return reducer(s, { type: 'TIME', patch: { stepMin: step } });
}
/** A run key as the app makes one, of the settings that count here. */
const keyOf = (s: State) => JSON.stringify([['--step', String(s.settings.time.stepMin)], null]);
const resultOf = (slot: number, key: string) => ({
  columns: ['sunhours_front'], data: [Float32Array.from([2 + slot])], weights: Float32Array.from([1]), receivers: ['wall'], on: 'faces', key, elapsed: 1,
  manifest: { meshes: [{ name: 'wall', first: 0, count: 1 }] },
}) as unknown as RunResult;

/** The app as the generation drives it: its store, a session cache holding A's result of the report's settings (its
 *  Open shows it at once, as kept.ts), a run that gives every model without a result one. */
function app(state0: State, kept: RunResult) {
  let state = state0;
  const dispatch = (a: Action) => { state = reducer(state, a); };
  const el = { stage: { metersPerUnit: 1, upAxis: 'Z' }, view: { eye: [0, -10, 2], target: [0, 0, 2], fov: 45, projection: 'perspective', height: 1 }, three: { overlay: { children: [] } } };
  const c = () => ({
    state, dispatch, ui: { tab: 'daylight' }, setUi: () => {}, section: NONE, panes: { 0: { loading: false }, 1: { loading: false } }, variants: () => ({}), shown: 'sunhours_front',
    per: state.models.map((m) => ({ m, receivers: m.objects.filter((o) => o.role === 'receiver'), shades: m.objects.filter((o) => o.role === 'shade'), key: keyOf(state) })),
    analysis: () => ({ models: state.models, column: state.column, colourBy: state.colourBy, shown: 'sunhours_front', scale: null, dispatch }),
    viewer: () => ({ el }), fileOf: () => null, meshOf: () => null, refreshReports: async () => {}, busy: () => false, held: () => false,
    openSet: (set: NonNullable<Report['setup']>) => {
      events.push('open');
      dispatch({ type: 'APPLY_SET', set });
      if (kept.key === keyOf(state)) dispatch({ type: 'RUN', slot: 0, run: { status: 'done', result: kept } });
    },
    onRun: () => {
      events.push('run');
      for (const m of state.models) if (!m.result) dispatch({ type: 'RUN', slot: m.slot, run: { status: 'done', result: resultOf(m.slot, keyOf(state)) } });
    },
  }) as unknown as Ctl;
  return c;
}

describe('a generation', () => {
  afterEach(() => { vi.unstubAllGlobals(); events.length = 0; });

  it("opens the report's setup first (roles, settings, ranges), runs what has no result, then shoots both models", async () => {
    const saved = opened('receiver', 15), key = keyOf(saved), T = '2026-11-24T10:00:00.000Z';
    const report: Report = {
      id: 'wall', title: 'The wall', created: T, updated: T, summary: 'Sun on the wall.', ranges: { sunhours: { lo: 2, hi: null } },
      models: ['A', 'B'].map((model) => ({ model, file: 'building', variants: {}, receivers: ['/Site/Wall'], shades: [], runKey: key })),
      setup: { ...captureSet(saved, 'daylight', 'Report setup', { shown: 'sunhours_front' }) },
      blocks: [{ type: 'view', name: 'Wall', view: { eye: [0, -10, 2], target: [0, 0, 2], fov: 45, projection: 'perspective', height: 1 }, column: 'sunhours_front', caption: 'The wall.' }],
    };
    const posted: string[] = [];
    vi.stubGlobal('document', { documentElement: { dataset: {} }, createElement: () => ({ getContext: () => null }) }); // no stylesheet: the colours' fallbacks
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }));
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/reports') return new Response(JSON.stringify([{ id: 'wall', pdf: false, spec: JSON.stringify(report) }]), { headers: { 'Content-Type': 'application/json' } });
      posted.push(`${init?.method} ${url}`);
      return new Response(JSON.stringify({ pdf: 'wall.pdf', url: '/reports/wall/pdf', pages: 1, bytes: 9, fonts: [], fallback: [] }), { headers: { 'Content-Type': 'application/json' } });
    }));
    // since the save: the wall ignored, another step, no problem range; A's result of the report's settings kept; a third
    // model of the same file, not in the report, its tree a receiver with a result
    let now = reducer(opened('none', 60), { type: 'VIZ_RESET', quantity: 'sunhours', what: 'range' });
    now = reducer(reducer(now, { type: 'ADD' }), { type: 'LOAD', slot: 2, objects: now.models[0].objects, name: 'building' });
    const own = { ...resultOf(2, keyOf(now)), receivers: ['tree'] };
    now = reducer(reducer(now, { type: 'ROLE', slot: 2, ids: ['tree'], role: 'receiver' }), { type: 'RUN', slot: 2, run: { status: 'done', result: own } });
    expect(now.models[2].result).toBe(own);
    const c = app(now, resultOf(0, key));
    expect((await generate('wall', c)).pages).toBe(1);
    expect(events).toEqual(['open', 'run', 'shot', 'shot']); // B only ran: A's came from the cache
    const s = c().state;
    expect([s.settings.time.stepMin, s.settings.viz.ranges.sunhours, s.models.slice(0, 2).map((m) => [m.objects[0].role, m.result?.key])]).toEqual([15, { lo: 2, hi: null }, [['receiver', key], ['receiver', key]]]);
    expect([s.models[2].objects.map((o) => o.role), s.models[2].result]).toEqual([['none', 'receiver'], own]); // C as it was
    expect(posted).toEqual(['POST /reports/wall/pdf']);
  });

  it('without a setup refuses as before: the roles and settings of save time are the user\'s to restore', async () => {
    const saved = opened('receiver', 15), key = keyOf(saved), T = '2026-11-24T10:00:00.000Z';
    const report: Report = {
      id: 'old', title: 'Older', created: T, updated: T, summary: 'x', ranges: {}, models: [{ model: 'A', file: 'building', variants: {}, receivers: ['/Site/Wall'], shades: [], runKey: key }],
      blocks: [{ type: 'text', text: 'x' }],
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([{ id: 'old', pdf: false, spec: JSON.stringify(report) }]), { headers: { 'Content-Type': 'application/json' } })));
    await expect(generate('old', app(opened('none', 60), resultOf(0, key)))).rejects.toThrow(/^not ready: model A: not as at save: set_roles receiver for \/Site\/Wall; then run$/);
    expect(events).toEqual([]);
  });
});
