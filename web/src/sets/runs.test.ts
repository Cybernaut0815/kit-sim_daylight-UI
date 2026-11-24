import { describe, expect, it, vi } from 'vitest';
import { initialState, reducer, swapState, type ObjectRow, type State, type Tool } from '../store';

vi.mock('../viewer/usd', () => ({ viewer: () => ({ el: {}, materials: new Map() }), readTexture: async () => null })); // browser-only
const { cfgFor, opticsFor, perOf } = await import('../analysis');
const { captureSet, levelText, needsLevel } = await import('./model');
const { setPer, setup } = await import('./runs');

const row = (id: string, path: string, role: ObjectRow['role'] = 'none'): ObjectRow => ({ id, name: id, path, tris: 2, verts: 4, role });
/** n models: the first n of A (tower), B (tower again), C (tower-v2, 2 paths in common), D (shed, none in common). */
function open(n: number): State {
  const files: [string, ObjectRow[]][] = [
    ['tower', [row('a', '/W/a', 'receiver'), row('b', '/W/b', 'shade'), row('c', '/W/c')]],
    ['tower', [row('a', '/W/a', 'receiver'), row('b', '/W/b', 'shade'), row('c', '/W/c')]],
    ['tower-v2', [row('a', '/W/a'), row('b', '/W/b'), row('x', '/W/x', 'receiver')]],
    ['shed', [row('s', '/S/s', 'receiver')]],
  ];
  let s = initialState();
  files.slice(0, n).forEach(([name, rows], slot) => {
    if (slot) s = reducer(s, { type: 'ADD' });
    s = reducer(s, { type: 'LOAD', slot, name, objects: rows.map((o) => ({ ...o, id: `${slot}${o.id}` })) });
  });
  return s;
}
const optics = (m: Parameters<typeof opticsFor>[0], reflect: boolean) => opticsFor(m, {}, reflect);
/** The live tab's keys after APPLY_SET, per slot with an entry. */
function liveKeys(s: State, set: ReturnType<typeof captureSet>) {
  const live = reducer(s, { type: 'APPLY_SET', set }), view = set.tool === 'views' ? swapState(live) : live, cfg = cfgFor(set.tool, live.settings);
  const slots = new Set(setup(s, set).models.map((m) => m.slot));
  return perOf(view.models, view.models.map((m) => optics(m, cfg.reflect)), cfg).filter((p) => slots.has(p.m.slot)).map((p) => [p.m.slot, p.key]);
}

describe('set runner', () => {
  for (const tool of ['daylight', 'views'] as Tool[]) for (const n of [1, 2, 4]) {
    it(`a set's background key is the live ${tool} key after opening it, ${n} model(s)`, () => {
      let s = open(n);
      s = reducer(s, { type: 'ROLE', slot: 0, ids: ['0c'], role: 'shade', ...(tool === 'views' ? { group: 'park', tab: 'views' as const } : {}) });
      const set = captureSet(s, tool, 'Set');
      // the app moves on: other roles, settings, Materials edits and site than the set's
      s = reducer(s, { type: 'ROLE', slot: 0, ids: ['0a'], role: 'none', ...(tool === 'views' ? { tab: 'views' as const } : {}) });
      s = reducer(s, tool === 'views' ? { type: 'VIEW_SIM', patch: { cell: 4 } } : { type: 'SIM', patch: { bounces: 3 } });
      s = reducer(s, { type: 'OPTICS_EDIT', slot: 0, key: 'default', edit: { rho: 0.5, tau: 0, kind: 'opaque' } });
      s = reducer(s, { type: 'SITE', patch: { lat: 48.1, lon: 11.6 } });
      const bg = setPer(s, set, optics).map((p) => [p.m.slot, p.key]);
      expect(bg).toEqual(liveKeys(s, set));
      expect(bg.length).toBe(n); // each model its own entry
      const withoutD = { ...set, models: set.models.filter((e) => e.model !== 'D') };
      expect(setPer(s, withoutD, optics).map((p) => [p.m.slot, p.key])).toEqual(liveKeys(s, withoutD));
      expect(setPer(s, withoutD, optics).length).toBe(Math.min(n, 3)); // D, without an entry of its own, finds none
      const now = perOf((tool === 'views' ? swapState(s) : s).models, s.models.map((m) => optics(m, false)), cfgFor(tool, s.settings));
      expect(bg[0][1]).not.toBe(now[0].key); // the set's inputs, not the app's
    });
  }

  it('a set of another subdivision level runs only once opened', () => {
    const set = captureSet(open(1), 'daylight', 'Set', { subdiv: 2 });
    expect([needsLevel(set, 2), needsLevel(set, 0), needsLevel({}, 3)]).toEqual([null, 2, null]);
    expect([-1, 0, 2].map(levelText)).toEqual(['Auto', 'Off', 'Level 2']);
  });

  it('setup leaves the app as it is', () => {
    const s = open(4), set = captureSet(s, 'daylight', 'Set');
    const before = JSON.stringify(s.models.map((m) => m.objects));
    setup(s, set);
    expect(JSON.stringify(s.models.map((m) => m.objects))).toBe(before);
  });
});
