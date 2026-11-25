// Results in numbers, as the Results panel gives them: a column's area-weighted summary over every receiver and per row
// (mesh, prim path or side faced), the differences between models, and a run's provenance. One quoting for each source
// results reads: an analysis' last runs, a saved set's kept results, a combined view.
import { facingOf, type Facing, type Vec3 } from '../../lib/frame';
import { SIDE_HELP, helpFor, roundNum, roundPct, splitColumn, summarize, unitFor, type Summary } from '../../lib/result';
import { idsUnder } from '../../lib/tree';
import { inputKeysOf } from '../../sets/combine';
import type { Model, ObjectRow, RunResult } from '../../store';
import { stableKey, weightsOf, type Args, type Ctl } from './common';

const NUMS = ['area', 'min', 'p10', 'median', 'mean', 'p90', 'max', 'total'] as const;
/** A summary as results quotes it: values as the app rounds them; shares in %, of the problem range when one is set
 *  (`ranged`) and per threshold x below x and at or above it. */
export function quoted(u: Summary, th: readonly number[], ranged: boolean) {
  return {
    elements: u.elements, ...Object.fromEntries(NUMS.map((k) => [k, roundNum(u[k])])),
    ...(ranged ? { below: roundPct(u.below), within: roundPct(u.within), above: roundPct(u.above) } : {}),
    ...(th.length ? { thresholds: th.map((x, i) => ({ x, below: roundPct(1 - u.atLeast[i]), atOrAbove: roundPct(u.atLeast[i]) })) } : {}),
  };
}
/** u minus the reference's v: values in the column's unit, shares in percentage points, both as the Results panel shows
 *  them; a difference within float noise is 0 (two equal shares differ by 0, not 1.11e-14). */
export function difference(u: Summary, v: Summary, th: readonly number[], ranged: boolean) {
  const pts = (d: number) => roundNum(Math.abs(d) < 1e-9 ? 0 : 100 * d) + 0; // + 0: no -0
  const minus = (a: number, b: number) => roundNum(Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(a), Math.abs(b)) ? 0 : a - b);
  return {
    ...Object.fromEntries(NUMS.map((k) => [k, minus(u[k], v[k])])),
    ...(ranged ? { below: pts(u.below - v.below), within: pts(u.within - v.within), above: pts(u.above - v.above) } : {}),
    ...(th.length ? { thresholds: th.map((x, i) => ({ x, below: pts(v.atLeast[i] - u.atLeast[i]), atOrAbove: pts(u.atLeast[i] - v.atLeast[i]) })) } : {}),
  };
}
/** The north a result ran with (its run key starts with the core's arguments): its facings' compass. A combined result's
 *  key holds its inputs' run keys instead: the first input run's north (0 without one). */
const northOf = (r: Pick<RunResult, 'key'>): number => {
  const [args] = JSON.parse(r.key) as [unknown];
  if (Array.isArray(args)) return Number(args[args.indexOf('--north') + 1]);
  const run = inputKeysOf(r.key).find((k) => k !== null);
  return run ? northOf({ key: run }) : 0;
};
/** A View analysis run as results quotes it (no period or weather): elements, the core's arguments (mesh ids as prim
 *  paths), timing, the server cache. */
export const viewProvenance = (r: RunResult, rows: readonly ObjectRow[]) => ({
  elements: r.on, args: (JSON.parse(stableKey(r.key, rows)) as [string[]])[0], seconds: roundNum(r.elapsed), ...(r.manifest.run_s !== undefined ? { compute: roundNum(r.manifest.run_s) } : {}), ...(r.cache ? { cache: r.cache } : {}),
});
/** A result's run as results quotes it: period, hours and sun directions evaluated, weather, the core's arguments (mesh ids
 *  as prim paths), timing, the server cache. */
export function provenance(r: RunResult, rows: readonly ObjectRow[]) {
  const [args, weather] = JSON.parse(stableKey(r.key, rows)) as [string[], unknown], arg = (k: string) => args[args.indexOf(k) + 1];
  return {
    period: args.includes('--time') ? `instant ${arg('--time')}` : args.includes('--from') ? `${arg('--from')} to ${arg('--to')} every ${arg('--step')} min${args.includes('--hours') ? `, ${arg('--hours')} each day` : ''}` : 'annual',
    hours: r.manifest.duration_h, sunDirections: r.manifest.dirs?.sun, elements: r.on, weather: typeof weather === 'string' ? weather : Array.isArray(weather) ? weather[0] : 'none',
    args, seconds: roundNum(r.elapsed), ...(r.manifest.run_s !== undefined ? { compute: roundNum(r.manifest.run_s) } : {}), ...(r.cache ? { cache: r.cache } : {}), ...(r.switches ? { switches: r.switches } : {}),
  };
}

const SIDES: readonly Facing[] = ['N', 'E', 'S', 'W', 'up', 'down'];
/**
 * results by 'facing': a result's elements by the side they face (frame.ts facingOf), N, E, S, W, up, down, each side with
 * its elements' values in one column (`col`: the column's value per result row) and their areas. `meshes`: the
 * receivers' rows [first, first + count), meshes in those rows (model metres; `faceStart`: the triangles of each face
 * row, absent: a row per triangle) and element areas `w`. An element faces along the sum of its triangles'
 * (b - a) × (c - a): a face's own, or a vertex's faces' (the core's sensor normal); a back column's turned round.
 * Elements with no normal (degenerate) are left out.
 */
export function bySide(col: ArrayLike<number>, meshes: Iterable<{ first: number; count: number; positions: ArrayLike<number>; indices: ArrayLike<number>; faceStart?: ArrayLike<number>; w: ArrayLike<number> }>, on: 'faces' | 'vertices', north: number, back: boolean): { facing: Facing; values: number[]; w: number[] }[] {
  const out = new Map<Facing, { values: number[]; w: number[] }>(), s = back ? -1 : 1;
  for (const { first, count, positions: P, indices: I, faceStart, w } of meshes) {
    const n = new Float64Array(3 * count);
    for (let f = 0, row = 0; f < I.length / 3; f++) {
      const a = 3 * I[3 * f], b = 3 * I[3 * f + 1], c = 3 * I[3 * f + 2];
      const u = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]], v = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
      const x = u[1] * v[2] - u[2] * v[1], y = u[2] * v[0] - u[0] * v[2], z = u[0] * v[1] - u[1] * v[0];
      while (faceStart && faceStart[row + 1] <= f) row++; // the face row triangle f belongs to
      for (const e of on === 'faces' ? [faceStart ? row : f] : [I[3 * f], I[3 * f + 1], I[3 * f + 2]]) if (e < count) { n[3 * e] += x; n[3 * e + 1] += y; n[3 * e + 2] += z; }
    }
    for (let e = 0; e < count; e++) {
      const v: Vec3 = [s * n[3 * e], s * n[3 * e + 1], s * n[3 * e + 2]];
      if (!(Math.hypot(...v) > 0)) continue;
      const side = facingOf(v, north), g = out.get(side) ?? { values: [], w: [] };
      out.set(side, g);
      g.values.push(col[first + e]);
      g.w.push(w[e]);
    }
  }
  return SIDES.flatMap((facing) => { const g = out.get(facing); return g ? [{ facing, ...g }] : []; });
}

/**
 * A model's result in one column as results gives it, the problem range [lo, hi] and the thresholds applied: over every
 * receiver (`whole`) and per row: per prim path of `paths` ('parts'), per receiver mesh, the largest area first ('mesh'),
 * or per side faced ('facing'), the last two over the receivers under `paths` (every one without).
 */
export function summaries(x: Pick<Ctl, 'meshOf'>, m: Pick<Model, 'objects' | 'result'>, column: string, by: 'parts' | 'mesh' | 'facing', paths: readonly string[] | undefined, lo: number | null, hi: number | null, th: readonly number[] = []) {
  const r = m.result!, col = r.data[r.columns.indexOf(column)], w = weightsOf(r), g = r.manifest.meshes;
  const sum = (ks: number[]) => summarize(col, ks.map((k) => g[k]), ks.map((k) => w[k]), lo, hi, th), under = (ps: readonly string[]) => { const ids = new Set(idsUnder(ps, m.objects)); return r.receivers.flatMap((id, k) => (ids.has(id) ? [k] : [])); };
  const ks = paths ? under(paths) : r.receivers.map((_, k) => k), pathOf = new Map(m.objects.map((o) => [o.id, o.path])); // mesh and facing rows: the receivers under paths
  const rows: { key: string; head: object; u: Summary }[] = by === 'parts' ? paths!.map((p) => ({ key: p, head: { path: p }, u: sum(under([p])) }))
    : by === 'mesh' ? ks.map((k) => { const p = pathOf.get(r.receivers[k]) ?? g[k].name; return { key: p, head: { mesh: p }, u: sum([k]) }; }).sort((p, o) => o.u.area - p.u.area)
      : bySide(col, (function* () { for (const k of ks) { const o = x.meshOf(r.receivers[k], r); if (o) yield { first: g[k].first, count: g[k].count, positions: o.positions, indices: o.indices, faceStart: o.faceStart, w: w[k] }; } })(), r.on, northOf(r), column.endsWith('_back'))
        .map((f) => ({ key: f.facing, head: { facing: f.facing }, u: summarize(f.values, [{ first: 0, count: f.values.length }], [f.w], lo, hi, th) }));
  return { whole: sum(r.receivers.map((_, k) => k)), rows };
}
type Sums = ReturnType<typeof summaries>;

/** A column as results heads its reply: its unit, its total's (value x area) and what it means. */
export function columnFacts(column: string) {
  const [q, side] = splitColumn(column), u = unitFor(column);
  return { column, unit: u.value, totalUnit: u.total, meaning: `${helpFor(q)} ${SIDE_HELP[side] ?? ''}`.trim() };
}
/** results' rows arguments: paths, by (parts with paths, else mesh), thresholds and limit. */
export function rowArgs(a: Args) {
  const paths: string[] | undefined = a.paths, by: 'mesh' | 'parts' | 'facing' = a.by ?? (paths ? 'parts' : 'mesh');
  if (by === 'parts' && !paths) throw new Error("paths: by 'parts' takes the prim paths (model_tree)");
  return { paths, by, th: (a.thresholds ?? []) as number[], limit: (a.limit ?? 50) as number };
}
/** results' models: each model's own fields (`head`), then its whole row and rows quoted; the first with a result is the
 *  reference, and the others carry their differences to it, row by row (by mesh path, prim path or side). Without a
 *  result (`sums` null): result null. */
export function compared(each: readonly { head: object; sums: Sums | null }[], th: readonly number[], ranged: boolean, limit: number) {
  const ref = each.find((e) => e.sums)?.sums, refRows = new Map(ref?.rows.map((row) => [row.key, row.u]) ?? []);
  return each.map(({ head, sums }) => ({
    ...head,
    ...(sums ? {
      whole: { ...quoted(sums.whole, th, ranged), ...(sums !== ref ? { diff: difference(sums.whole, ref!.whole, th, ranged) } : {}) },
      rows: sums.rows.slice(0, limit).map((row) => { const v = sums !== ref ? refRows.get(row.key) : undefined; return { ...row.head, ...quoted(row.u, th, ranged), ...(v ? { diff: difference(row.u, v, th, ranged) } : {}) }; }),
      ...(sums.rows.length > limit ? { moreRows: sums.rows.length - limit } : {}),
    } : { result: null }),
  }));
}
