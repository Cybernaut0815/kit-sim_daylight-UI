import { describe, expect, it } from 'vitest';
import type { RunResult } from '../store';
import { BOUNDS, apply, boundsOf, columnOf, combine, inputRange, type InputRun } from './combine';
import type { CombinedView } from './model';

/** A result over meshes [id, values][] in one column `col`, every row 1 m². */
function res(meshes: [string, number[]][], col = 'sky_front', on: 'faces' | 'vertices' = 'faces', key = 'k'): RunResult {
  let first = 0;
  const m = meshes.map(([id, v]) => { const g = { name: id, first, count: v.length }; first += v.length; return g; });
  return {
    data: [Float32Array.from(meshes.flatMap(([, v]) => v))], weights: new Float32Array(first).fill(1), columns: [col], receivers: meshes.map(([id]) => id), on, key, elapsed: 0,
    manifest: { columns: [col], meshes: m } as unknown as RunResult['manifest'],
  };
}
const run = (r: RunResult, name = 'S'): InputRun => ({ result: r, col: 0, name });
const view = (inputs: CombinedView['inputs'], op: CombinedView['op'] = 'mean'): CombinedView => ({ kind: 'combined', id: 'v-1', name: 'V', created: '', updated: '', unit: '', op, inputs });
const paths: Record<string, string> = { a: '/W/a', b: '/W/b', r: '/R/r' }, pathOf = (id: string) => paths[id];
const values = (r: RunResult | null) => Array.from(r!.data[0], (v) => (Number.isNaN(v) ? null : Math.round(v * 1000) / 1000));

describe('combine', () => {
  it('each function', () => {
    expect([apply('raw', 5, 0, 10), apply('normalise', 5, 0, 10), apply('normalise', 20, 0, 10), apply('invert', 2, 0, 10)]).toEqual([5, 0.5, 1, 0.8]);
    expect([apply('log', 100, 0, 0), apply('log', 0, 0, 0), apply('threshold', 3, 3, 0), apply('threshold', 2.9, 3, 0)]).toEqual([2, NaN, 1, 0]);
    expect([apply('band', 4, 3, 5), apply('band', 6, 3, 5), apply('raw', NaN, 0, 1), apply('normalise', 7, 7, 7)]).toEqual([1, 0, NaN, 1]);
    expect(boundsOf({ fn: 'threshold' }, [0, 10])).toEqual([5, 10]);
    expect(boundsOf({ fn: 'normalise', lo: 2 }, [0, 10])).toEqual([2, 10]);
  });

  it('BOUNDS lists exactly the bounds apply reads, for each function', () => {
    const fns = ['raw', 'normalise', 'invert', 'log', 'threshold', 'band'] as const;
    expect(Object.keys(BOUNDS).sort()).toEqual([...fns].sort());
    for (const fn of fns) {
      const at = apply(fn, 5, 0, 10), reads = BOUNDS[fn].map(([b]) => b);
      expect([apply(fn, 5, 6, 10) !== at, apply(fn, 5, 0, 4) !== at], fn).toEqual([reads.includes('lo'), reads.includes('hi')]);
    }
  });

  it('each op with weights', () => {
    const A = run(res([['a', [2, 4]]]), 'A'), B = run(res([['a', [4, 1]]]), 'B'), raw = (w: number) => ({ set: 's', column: 'sky_front', weight: w, fn: 'raw' as const });
    const b = [[0, 1], [0, 1]] as const;
    expect(values(combine(view([raw(1), raw(3)]), [A, B], b, pathOf).result)).toEqual([3.5, 1.75]);
    expect(values(combine(view([raw(1), raw(3)], 'sum'), [A, B], b, pathOf).result)).toEqual([14, 7]);
    expect(values(combine(view([raw(1), raw(1)], 'min'), [A, B], b, pathOf).result)).toEqual([2, 1]);
    expect(values(combine(view([raw(1), raw(1)], 'max'), [A, B], b, pathOf).result)).toEqual([4, 4]);
    expect(values(combine(view([raw(1), raw(2)], 'product'), [A, B], b, pathOf).result)).toEqual([32, 4]);
    expect(values(combine(view([raw(1), raw(0)], 'min'), [A, B], b, pathOf).result)).toEqual([2, 4]); // weight 0: left out
  });

  it('the mesh filter takes a set on some meshes only; what no input covers is NaN; NaN values are left out', () => {
    const facade = run(res([['a', [1, 2]], ['b', [3, NaN]]]), 'Facade'), roof = run(res([['r', [9]], ['a', [5, 5]]]), 'Roof');
    const v = view([{ set: 'f', column: 'sky_front', weight: 1, fn: 'raw', meshes: ['/W'] }, { set: 'r', column: 'sky_front', weight: 1, fn: 'raw', meshes: ['/R'] }]);
    const { result, info } = combine(v, [facade, roof], [[0, 1], [0, 1]], pathOf);
    expect(result!.receivers).toEqual(['a', 'b', 'r']);
    expect(values(result)).toEqual([1, 2, 3, null, 9]);
    expect(result!.columns).toEqual([columnOf(v)]);
    expect(result!.manifest.meshes.map((g) => [g.name, g.first, g.count])).toEqual([['a', 0, 2], ['b', 2, 2], ['r', 4, 1]]);
    expect(info).toEqual({ used: 2, of: 2, mismatches: [] });
  });

  it('an input whose rows differ on a mesh is skipped there and listed', () => {
    const A = run(res([['a', [1, 1]]]), 'A'), B = run(res([['a', [3, 3, 3]]]), 'B'), V = run(res([['a', [5, 5]]], 'sky_front', 'vertices'), 'V');
    const raw = { set: 's', column: 'sky_front', weight: 1, fn: 'raw' as const };
    const { result, info } = combine(view([raw, raw, raw]), [A, B, V], [[0, 1], [0, 1], [0, 1]], pathOf);
    expect(values(result)).toEqual([1, 1]);
    expect(info.mismatches).toEqual(['B: a has 3 rows, the view 2', 'V: a has values per vertex, the view per face']);
  });

  it('two models: one normalise range over both, and a model missing an input computes from the ones it has', () => {
    const solar = [run(res([['a', [0, 100]]]), 'Solar'), run(res([['a', [200, 400]]]), 'Solar')], sky = [run(res([['a', [1, 1]]]), 'Sky'), null];
    const inputs: CombinedView['inputs'] = [{ set: 's', column: 'sky_front', weight: 1, fn: 'normalise' }, { set: 'k', column: 'sky_front', weight: 1, fn: 'raw' }];
    const ranges = inputs.map((i, k) => boundsOf(i, inputRange(i, [solar, sky][k], [pathOf, pathOf])));
    expect(ranges[0]).toEqual([0, 400]);
    const A = combine(view(inputs), [solar[0], sky[0]], ranges, pathOf), B = combine(view(inputs), [solar[1], sky[1]], ranges, pathOf);
    expect(values(A.result)).toEqual([0.5, 0.625]); // (0 + 1) / 2, (0.25 + 1) / 2
    expect(values(B.result)).toEqual([0.5, 1]); // the solar input alone
    expect([A.info.used, B.info.used]).toEqual([2, 1]);
    expect(combine(view(inputs), [null, null], ranges, pathOf).result).toBeNull();
  });
});
