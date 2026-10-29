import { describe, expect, it } from 'vitest';
import { defaultSettings, type ObjectRow, type RunResult } from '../store';
import { chartData, cleanSpec, dataOf, putChart, type ChartInput, type ChartKind, type ChartSpec, type Drawn } from './charts';

const obj = (id: string, path: string): ObjectRow => ({ id, name: id, path, tris: 2, verts: 4, role: 'receiver' });
/** A 'radiation_front' result with one mesh per receiver: values[k] are the rows of receivers[k]. */
const result = (receivers: string[], values: number[][]): RunResult => {
  let first = 0;
  const meshes = values.map((v, k) => { const g = { name: receivers[k], first, count: v.length }; first += v.length; return g; });
  return { values: values.flat().map((v) => Float64Array.of(v)), columns: ['radiation_front'], receivers, on: 'faces', key: 'k', elapsed: 0, manifest: { columns: ['radiation_front'], duration_h: 1, dirs: { sky: 0, ground: 0, sun: 0 }, meshes } };
};
const input = (models: ChartInput['models'], viz = defaultSettings().viz): ChartInput => ({ models, column: 'radiation_front', viz, weightsFor: () => undefined }); // every element weighs 1
const draw = <K extends ChartKind>(kind: K, spec: Omit<ChartSpec, 'id' | 'kind'>, models: ChartInput['models'], viz?: ChartInput['viz']) => {
  const d = chartData({ id: 'c', kind, ...spec }, input(models, viz));
  if (d.kind !== kind) throw new Error(`drew ${d.kind}`);
  return d as Extract<Drawn, { kind: K }>;
};

const range = (n: number, f: (i: number) => number) => Array.from({ length: n }, (_, i) => f(i));
const A = { slot: 0, objects: [obj('a', '/W/a')], result: result(['a'], [range(20, (i) => i + 1)]) }; // 1..20
const B = { slot: 1, objects: [obj('b', '/W/b')], result: result(['b'], [range(400, (i) => i / 10)]) }; // 0..39.9

describe('cleanSpec', () => {
  it("keeps the kind's own fields, clamps numbers, null = the default", () => {
    expect(cleanSpec({ id: 'c1', kind: 'curve', bins: 16, metric: 'max', y: 'area', markers: ['mean', 'p90', 'p10'], height: 1000, range: [0, 8], title: 'Sun', grid: null }))
      .toEqual({ id: 'c1', kind: 'curve', title: 'Sun', range: [0, 8], markers: ['p10', 'p90'], height: 400 }); // a curve has no mean
    expect(cleanSpec({ id: 'h', kind: 'histogram', bins: 2.4, height: 10, grid: false, metric: 'mean', models: [1, 0, 1], parts: ['/A', '/A'], range: 'absolute' }))
      .toEqual({ id: 'h', kind: 'histogram', models: [0, 1], parts: ['/A'], range: 'absolute', bins: 4, grid: false, height: 100 });
    expect(cleanSpec({ id: 'p-1', kind: 'parts', metric: 'below', bins: 'auto', range: 'relative', column: 'sunhours_back' })).toEqual({ id: 'p-1', kind: 'parts', column: 'sunhours_back', metric: 'below' });
  });
  it('names the field of anything else', () => {
    const junk: [unknown, string][] = [
      [null, 'chart'], [[1], 'chart'], [{ kind: 'curve' }, 'id'], [{ id: 'a b', kind: 'curve' }, 'id'], [{ id: 'x', kind: 'toString' }, 'kind'], [{ id: 'x', kind: 'legend' }, 'kind'],
      [{ id: 'x', kind: 'curve', range: 'log' }, 'range'], [{ id: 'x', kind: 'curve', range: [5, 1] }, 'range'], [{ id: 'x', kind: 'histogram', bins: 'many' }, 'bins'],
      [{ id: 'x', kind: 'histogram', range: [5, 5.000000000000001] }, 'range'], [{ id: 'x', kind: 'curve', range: [-1e308, 1e308] }, 'range'], // ticks never step / the span overflows
      [{ id: 'x', kind: 'curve', markers: ['p50'] }, 'markers'], [{ id: 'x', kind: 'curve', grid: 'yes' }, 'grid'], [{ id: 'x', kind: 'parts', metric: 'sum' }, 'metric'],
      [{ id: 'x', kind: 'curve', column: 'Radiation' }, 'column'], [{ id: 'x', kind: 'curve', models: [4] }, 'models'], [{ id: 'x', kind: 'curve', parts: ['W'] }, 'parts'],
      [{ id: 'x', kind: 'curve', title: 'x'.repeat(121) }, 'title'],
    ];
    for (const [raw, field] of junk) expect(cleanSpec(raw)).toMatch(new RegExp(`^${field}: `));
  });
});

describe('putChart', () => {
  it("refuses what a built-in cannot take and a 17th chart of one's own, by field", () => {
    const base = defaultSettings().charts;
    expect(putChart(base, { id: 'curve', kind: 'histogram' })).toMatch(/^kind: /);
    expect(putChart(base, { id: 'hist', kind: 'histogram', parts: ['/W'] })).toMatch(/^parts: /);
    expect(putChart(base, { id: 'p', kind: 'parts', parts: Array.from({ length: 25 }, (_, i) => `/W/${i}`) })).toMatch(/^parts: /); // a parts chart draws 24
    const full = Array.from({ length: 16 }, (_, i) => ({ id: `x${i}`, kind: 'curve' })).reduce<ChartSpec[]>((cs, c) => putChart(cs, c) as ChartSpec[], base);
    expect(full).toHaveLength(18);
    expect(putChart(full, { id: 'x16', kind: 'curve' })).toMatch(/^charts: /);
    expect((putChart(full, { id: 'x3', kind: 'histogram' }) as ChartSpec[])[5]).toEqual({ id: 'x3', kind: 'histogram' }); // replacing one still works
  });
});

describe('chartData', () => {
  it('auto bins: the fewest of any drawn model, so the bins line up; a set number wins', () => {
    const h = draw('histogram', {}, [A, B]);
    expect(h.edges).toHaveLength(13); // A: 20 elements -> 12 bins, B: 400 -> 30
    expect(h.series?.map((s) => [s.slot, s.shares.length])).toEqual([[0, 12], [1, 12]]);
    expect(draw('histogram', { models: [1] }, [A, B]).edges).toHaveLength(31);
    expect(draw('histogram', { bins: 5 }, [A, B]).edges).toHaveLength(6);
  });
  it('relative = the colour scale over every model, absolute = the drawn data, a set range wins', () => {
    const viz = defaultSettings().viz;
    expect(draw('histogram', { models: [0] }, [A, B]).edges[0]).toBe(0); // relative: B's values colour A's chart too
    expect(draw('curve', { models: [0], range: 'absolute' }, [A, B]).domain).toEqual([1, 20]);
    viz.scales.radiation = { min: 0, max: 100 };
    const h = draw('histogram', {}, [A, B], viz);
    expect([h.edges[0], h.edges[h.edges.length - 1]]).toEqual([0, 100]);
    expect(draw('curve', { range: 'absolute' }, [A, B], viz).domain).toEqual([0, 39.9]);
    expect(draw('histogram', { range: [5, 15], bins: 4 }, [A, B], viz).edges).toEqual([5, 7.5, 10, 12.5, 15]);
    expect(draw('curve', { range: [5, 15] }, [A, B], viz).domain).toEqual([5, 15]);
    expect(chartData({ id: 'c', kind: 'curve', column: 'sunhours_front' }, input([A, B])).kind).toBe('empty');
  });
  it('a parts subset restricts the elements; the derived data is cached per result, column and subset', () => {
    const M = { slot: 0, objects: [obj('n', '/S/N'), obj('s', '/S/S')], result: result(['n', 's'], [[1, 2], [10, 20, 30]]) };
    const h = draw('histogram', { parts: ['/S/S'], range: 'absolute' }, [M]);
    expect([h.counts.reduce((a, b) => a + b), h.edges[0], h.edges[h.edges.length - 1], h.markers.mean]).toEqual([3, 10, 30, 20]);
    expect(draw('curve', { parts: ['/S'] }, [M]).cum.v).toHaveLength(5);
    const w = () => undefined;
    expect(dataOf(M.result, 0, M.objects, w)).toBe(dataOf(M.result, 0, M.objects, w));
    expect(dataOf(M.result, 0, M.objects, w, ['s']).rows.map((x) => x.id)).toEqual(['s']);
  });
  it('parts: a row per prim path, matched across models; a path a model lacks has no bar', () => {
    const P = { slot: 0, objects: [obj('a1', '/S/N'), obj('a2', '/S/S')], result: result(['a1', 'a2'], [[1, 2], [10, 20, 30]]) };
    const Q = { slot: 2, objects: [obj('b2', '/S/S'), obj('b1', '/S/N'), obj('b3', '/S/X')], result: result(['b2', 'b1', 'b3'], [[40], [3, 5], [7]]) };
    expect(draw('parts', {}, [P, Q]).groups).toEqual([
      { name: 'N', path: '/S/N', bars: [{ slot: 0, v: 1.5 }, { slot: 2, v: 4 }] },
      { name: 'S', path: '/S/S', bars: [{ slot: 0, v: 20 }, { slot: 2, v: 40 }] },
      { name: 'X', path: '/S/X', bars: [{ slot: 0, v: NaN }, { slot: 2, v: 7 }] },
    ]);
    expect(draw('parts', { parts: ['/S'], metric: 'max' }, [P, Q]).groups[0].bars.map((b) => b.v)).toEqual([30, 40]);
    const viz = defaultSettings().viz;
    viz.ranges.radiation = { lo: 5, hi: null };
    expect(draw('parts', { parts: ['/S/N'], metric: 'below' }, [P, Q], viz).groups[0].bars.map((b) => b.v)).toEqual([1, 0.5]); // 3 of 3, 5
  });
});
