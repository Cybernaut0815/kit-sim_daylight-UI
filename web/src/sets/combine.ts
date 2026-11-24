// A combined view's values for one model, from its input sets' results (pure). Per element of a mesh, each input that
// covers the mesh (its `meshes` paths with every mesh under them; absent: all its receivers) and has a finite value
// there gives x = fn(v); the inputs then combine by the view's op (weighted mean, weighted sum, min, max, or the product
// of x^w). An element no input covers is NaN (unpainted). Each mesh takes its rows (layout, weights, form) from the first
// input that covers it; an input whose element kind or row count differs on a mesh is skipped there and listed.
import type { RunResult } from '../store';
import type { CombinedInput, CombinedView, Fn } from './model';

/** One input's result on a model: the result, its column's index (-1: the column is not in it), and the set's name. */
export interface InputRun { result: RunResult; col: number; name: string }
/** What a model's combination used: the inputs with a result of the `of` given, and the meshes skipped, in words. */
export interface CombineInfo { used: number; of: number; mismatches: string[] }

export const columnOf = (v: Pick<CombinedView, 'id'>) => `combined_${v.id}`;
/** The run keys of the input results a combined result's `key` was made from, in input order (null: an input without
 *  one); [] for a key that is not a combined result's. */
export const inputKeysOf = (key: string): (string | null)[] => { const k = JSON.parse(key) as unknown[]; return typeof k[0] === 'string' && Array.isArray(k[3]) ? (k[3] as (string | null)[]) : []; };
/** Whether prim path `p` is at or under one of `roots`. */
export const under = (p: string, roots: readonly string[]) => roots.some((r) => r === '/' || p === r || p.startsWith(`${r}/`));

/** The bounds `apply` reads per function, in order, each with its label in the editor (raw and log: none). */
export const BOUNDS: Record<Fn, readonly (readonly ['lo' | 'hi', string])[]> = {
  raw: [], normalise: [['lo', '0 at'], ['hi', '1 at']], invert: [['lo', '1 at'], ['hi', '0 at']], log: [], threshold: [['lo', 'Threshold']], band: [['lo', 'From'], ['hi', 'To']],
};

/** `fn` of value `v`, with the input's bounds (lo..hi: normalise's range, threshold's lo, band's lo and hi); NaN: none. */
export function apply(fn: Fn, v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return NaN;
  const norm = () => (hi > lo ? Math.min(1, Math.max(0, (v - lo) / (hi - lo))) : v >= hi ? 1 : 0);
  switch (fn) {
    case 'raw': return v;
    case 'normalise': return norm();
    case 'invert': return 1 - norm();
    case 'log': return v > 0 ? Math.log10(v) : NaN;
    case 'threshold': return v >= lo ? 1 : 0;
    case 'band': return v >= lo && v <= hi ? 1 : 0;
  }
}

/** Input `i`'s bounds: its own lo and hi, else its values' range over every model (`range`); threshold's lo defaults to
 *  the middle of that range. */
export function boundsOf(i: Pick<CombinedInput, 'fn' | 'lo' | 'hi'>, range: readonly [number, number]): [number, number] {
  const [a, b] = Number.isFinite(range[0]) && Number.isFinite(range[1]) ? range : [0, 1];
  return [i.lo ?? (i.fn === 'threshold' ? (a + b) / 2 : a), i.hi ?? b];
}

/** The range of input `i`'s column over the meshes it covers, every model's (`runs[m]`: model m's run of it or null;
 *  `pathOf[m]`: model m's prim path of a row id). */
export function inputRange(i: Pick<CombinedInput, 'meshes'>, runs: readonly (InputRun | null)[], pathOf: readonly ((id: string) => string | undefined)[]): [number, number] {
  let lo = Infinity, hi = -Infinity;
  runs.forEach((run, m) => {
    if (!run || run.col < 0) return;
    const { result: r, col } = run, d = r.data[col];
    r.manifest.meshes.forEach((g, k) => {
      const p = pathOf[m](r.receivers[k]);
      if (i.meshes && (!p || !under(p, i.meshes))) return;
      for (let e = g.first; e < g.first + g.count; e++) { const v = d[e]; if (v < lo) lo = v; if (v > hi) hi = v; }
    });
  });
  return lo <= hi ? [lo, hi] : [NaN, NaN];
}

/**
 * View `view` on one model: `runs[i]` its input i's run (null: no result), `bounds[i]` that input's lo and hi (boundsOf
 * over every model), `pathOf` the model's prim path of a row id. null when no input covers anything (nothing to show).
 */
export function combine(view: CombinedView, runs: readonly (InputRun | null)[], bounds: readonly (readonly [number, number])[], pathOf: (id: string) => string | undefined): { result: RunResult | null; info: CombineInfo } {
  const mismatches: string[] = [], inputs = view.inputs;
  const covers = (i: number, id: string) => { const m = inputs[i].meshes, p = pathOf(id); return !m || (!!p && under(p, m)); };
  const live = runs.map((r) => (r && r.col >= 0 ? r : null)), first = live.find(Boolean);
  const info = (): CombineInfo => ({ used: live.filter(Boolean).length, of: inputs.length, mismatches: [...new Set(mismatches)] });
  const per = (k: 'faces' | 'vertices') => (k === 'faces' ? 'face' : 'vertex');
  if (!first) return { result: null, info: info() };
  const on = first.result.on;
  // the layout: each mesh from the first input covering it, in input order
  const layout: { id: string; src: number; k: number; count: number }[] = [], seen = new Set<string>();
  live.forEach((run, i) => run?.result.receivers.forEach((id, k) => {
    if (seen.has(id) || !covers(i, id)) return;
    const name = run.result.manifest.meshes[k]?.name ?? id;
    if (run.result.on !== on) { mismatches.push(`${run.name}: ${name} has values per ${per(run.result.on)}, the view per ${per(on)}`); return; }
    seen.add(id);
    layout.push({ id, src: i, k, count: run.result.manifest.meshes[k].count });
  }));
  if (!layout.length) return { result: null, info: info() };
  const total = layout.reduce((n, g) => n + g.count, 0), values = new Float32Array(total), weights = new Float32Array(total);
  const xs = new Float64Array(inputs.length), ws = new Float64Array(inputs.length);
  const meshes: RunResult['manifest']['meshes'] = [], forms: RunResult['forms'] = [];
  let at = 0;
  for (const g of layout) {
    const src = live[g.src]!.result, sg = src.manifest.meshes[g.k];
    weights.set(src.weights.subarray(sg.first, sg.first + g.count), at);
    meshes.push({ ...sg, first: at });
    forms.push(src.forms?.[g.k] ?? null);
    // the inputs on this mesh: its row offset in each, or -1 (not covering, no result, or skipped as a mismatch)
    const offs = live.map((run, i) => {
      if (!run || !covers(i, g.id) || inputs[i].weight <= 0) return -1;
      const k = run.result.receivers.indexOf(g.id), m = run.result.manifest.meshes[k];
      if (k < 0) return -1;
      if (run.result.on !== on || m.count !== g.count) {
        mismatches.push(run.result.on !== on ? `${run.name}: ${m.name} has values per ${per(run.result.on)}, the view per ${per(on)}` : `${run.name}: ${m.name} has ${m.count} rows, the view ${g.count}`);
        return -1;
      }
      return m.first;
    });
    for (let e = 0; e < g.count; e++) {
      let n = 0;
      offs.forEach((o, i) => {
        if (o < 0) return;
        const x = apply(inputs[i].fn, live[i]!.result.data[live[i]!.col][o + e], bounds[i][0], bounds[i][1]);
        if (Number.isFinite(x)) { xs[n] = x; ws[n] = inputs[i].weight; n++; }
      });
      values[at + e] = n ? reduce(view.op, xs, ws, n) : NaN;
    }
    at += g.count;
  }
  const column = columnOf(view);
  return {
    result: {
      data: [values], weights, columns: [column], receivers: layout.map((g) => g.id), forms, on, elapsed: 0,
      key: JSON.stringify([view.op, inputs, bounds, live.map((r) => r?.result.key ?? null)]),
      manifest: { columns: [column], meshes } as unknown as RunResult['manifest'],
    },
    info: info(),
  };
}

/** Op over the first n values x with weights w (each > 0). */
function reduce(op: CombinedView['op'], x: Float64Array, w: Float64Array, n: number): number {
  let a = op === 'min' ? Infinity : op === 'max' ? -Infinity : op === 'product' ? 1 : 0, sw = 0;
  for (let i = 0; i < n; i++) {
    if (op === 'mean') { a += w[i] * x[i]; sw += w[i]; }
    else if (op === 'sum') a += w[i] * x[i];
    else if (op === 'min') a = Math.min(a, x[i]);
    else if (op === 'max') a = Math.max(a, x[i]);
    else a *= x[i] ** w[i];
  }
  return op === 'mean' ? a / sw : a;
}
