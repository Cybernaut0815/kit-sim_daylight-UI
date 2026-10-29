// Result charts as data: the spec a chart is drawn from (the Results panel's two built-ins, its extras, a report's), its
// check wherever one comes in (the agent, stored settings, report files), the per-result derive cache the panel's tables
// share, and the numbers each kind draws. One colour scale per quantity stays shared by the views and every chart.
import { scaleFor, type Scale } from './gradients';
import { columnStats, cumulative, histogram, percentile, summarize, unionRange, unitFor, type Cumulative, type Stats } from './result';
import { idsUnder, rowNames } from './tree';
import type { Model, ObjectRow, RunResult, Settings } from '../store';

export type ChartKind = 'histogram' | 'curve' | 'parts';
export type Marker = 'mean' | 'median' | 'p10' | 'p90';
export type Metric = 'mean' | 'median' | 'p10' | 'p90' | 'min' | 'max' | 'below' | 'within' | 'above';
/** A chart; a look field left unset takes its kind's default. */
export interface ChartSpec {
  id: string; kind: ChartKind; title?: string;
  column?: string; // 'illuminance_front'; unset = the column shown
  models?: number[]; // slots; unset = every model with a result
  parts?: string[]; // prim paths: the receivers at or under them; unset = every receiver
  range?: 'relative' | 'absolute' | [number, number]; // the x span: the colour scale, the data's, or set
  bins?: number | 'auto';
  markers?: Marker[];
  grid?: boolean;
  height?: number; // viewBox units at width 320
  metric?: Metric; // parts: each bar's value
}

/** Each kind's look fields, in the order the settings button shows them. */
export const FIELDS: Record<ChartKind, readonly ('range' | 'bins' | 'markers' | 'grid' | 'height' | 'metric')[]> = {
  histogram: ['range', 'bins', 'markers', 'grid', 'height'], curve: ['range', 'markers', 'grid', 'height'], parts: ['metric', 'grid'],
};
export const MARKERS: Record<ChartKind, readonly Marker[]> = { histogram: ['mean', 'median', 'p10', 'p90'], curve: ['p10', 'median', 'p90'], parts: [] };
export const METRICS: readonly Metric[] = ['mean', 'median', 'p10', 'p90', 'min', 'max', 'below', 'within', 'above'];
/** The Results panel's own charts, Distribution and Cumulative area: always there, their look editable. */
export const BUILT_IN: readonly ChartSpec[] = [{ id: 'hist', kind: 'histogram' }, { id: 'curve', kind: 'curve' }];
const KINDS = Object.keys(FIELDS);

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
// [min, max] an axis can step through: the span finite and wider than rounding noise (ticks and bin edges add steps to min)
const span = (v: unknown): v is [number, number] =>
  Array.isArray(v) && v.length === 2 && finite(v[0]) && finite(v[1]) && finite(v[1] - v[0]) && v[1] - v[0] > 1e-9 * Math.max(1, Math.abs(v[0]), Math.abs(v[1]));
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(Math.round(v), lo), hi);
// field, its clean value (undefined: junk), what it has to be
const RULES: [keyof ChartSpec, (v: unknown, kind: ChartKind) => unknown, string][] = [
  ['title', (v) => (typeof v === 'string' && v.length <= 120 ? v : undefined), 'text, at most 120 characters'],
  ['column', (v) => (typeof v === 'string' && /^[a-z]+_(front|back)$/.test(v) ? v : undefined), "a result column such as 'radiation_front'"],
  ['models', (v) => (Array.isArray(v) && v.length && v.every((k) => [0, 1, 2, 3].includes(k)) ? [...new Set<number>(v)].sort((a, b) => a - b) : undefined), 'model slots 0 to 3 (A to D), at least one'],
  ['parts', (v, kind) => (Array.isArray(v) && v.length && v.length <= (kind === 'parts' ? 24 : 50) && v.every((p) => typeof p === 'string' && p.startsWith('/') && p.length <= 512) ? [...new Set<string>(v)] : undefined), '1 to 50 prim paths (a parts chart: 24), each starting with /'],
  ['range', (v) => (v === 'relative' || v === 'absolute' ? v : span(v) ? [v[0], v[1]] : undefined), "'relative', 'absolute' or [min, max] with min < max, max - min finite and over 1e-9 of their size"],
  ['bins', (v) => (v === 'auto' ? v : finite(v) ? clamp(v, 4, 100) : undefined), "'auto' or a number of bins, 4 to 100"],
  ['markers', (v, kind) => (Array.isArray(v) && v.every((m) => MARKERS.histogram.includes(m)) ? MARKERS[kind].filter((m) => v.includes(m)) : undefined), `a list of ${MARKERS.histogram.join(', ')}`],
  ['grid', (v) => (typeof v === 'boolean' ? v : undefined), 'true or false'],
  ['height', (v) => (finite(v) ? clamp(v, 100, 400) : undefined), 'a number, 100 to 400'],
  ['metric', (v) => (METRICS.includes(v as Metric) ? v : undefined), `one of ${METRICS.join(', ')}`],
];

/**
 * A chart spec from outside (the agent, a stored record, a report file) -> a clean one, or what is wrong with it, named
 * by its field. Fields of another kind and unknown ones are dropped, null = the default, numbers are clamped (a curve
 * has no mean marker).
 */
export function cleanSpec(raw: unknown): ChartSpec | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'chart: an object with an id and a kind';
  const r = raw as Record<string, unknown>, kind = r.kind as ChartKind;
  if (typeof r.id !== 'string' || !/^[\w-]{1,64}$/.test(r.id)) return 'id: 1 to 64 letters, digits, _ or -';
  if (!KINDS.includes(kind)) return `kind: one of ${KINDS.join(', ')}`;
  const keep: string[] = ['title', 'column', 'models', 'parts', ...FIELDS[kind]], out: Record<string, unknown> = { id: r.id, kind };
  for (const [k, clean, what] of RULES) {
    if (!keep.includes(k) || r[k] === undefined || r[k] === null) continue;
    const v = clean(r[k], kind);
    if (v === undefined) return `${k}: ${what}`;
    out[k] = v;
  }
  return out as unknown as ChartSpec;
}

/**
 * `raw` checked and put in place of the chart with its id, else added; or what is wrong, by field. A built-in keeps its
 * kind and takes only its look; at most 16 charts of one's own.
 */
export function putChart(charts: readonly ChartSpec[], raw: unknown): ChartSpec[] | string {
  const c = cleanSpec(raw);
  if (typeof c === 'string') return c;
  const b = BUILT_IN.find((x) => x.id === c.id), there = charts.some((x) => x.id === c.id);
  if (b && b.kind !== c.kind) return `kind: '${b.id}' is the built-in ${b.kind}; give a chart of your own another id`;
  const other = b && Object.keys(c).find((k) => k !== 'id' && k !== 'kind' && !(FIELDS[b.kind] as readonly string[]).includes(k));
  if (other) return `${other}: the built-in '${b.id}' takes only ${FIELDS[b.kind].join(', ')}; give a chart of your own another id`;
  if (!b && !there && charts.length >= BUILT_IN.length + 16) return 'charts: at most 16 of your own; remove one first';
  return there ? charts.map((x) => (x.id === c.id ? c : x)) : [...charts, c];
}

export type WeightsFor = (id: string, on: 'faces' | 'vertices') => ArrayLike<number> | undefined;
export interface Markers { mean: number; median: number; p10: number; p90: number }
export interface Row { id: string; name: string; g: RunResult['manifest']['meshes'][number]; w: ArrayLike<number>; stats: Stats }
export interface Data { r: RunResult; col: number; rows: Row[]; total: number; cum: Cumulative; markers: Markers; bins: number }

// Per result, column and receiver subset: cumulative() sorts every element, and a selection or a run status re-renders
// the panel; a result's rows never change while it lives (a load, a re-read or a role change drops it).
const cache = new WeakMap<RunResult, Map<string, Data>>();
/** A result's receiver rows (every one, or those in `ids`) in one column: their stats, the cumulative area, the markers. */
export function dataOf(r: RunResult, col: number, objects: readonly ObjectRow[], weightsFor: WeightsFor, ids?: readonly string[]): Data {
  let held = cache.get(r);
  if (!held) cache.set(r, (held = new Map()));
  const key = `${col} ${ids ? ids.join() : '*'}`, hit = held.get(key);
  if (hit) { held.delete(key); held.set(key, hit); return hit; } // the most recently used last
  const keep = ids && new Set(ids), groups = r.manifest.meshes;
  const rows = r.receivers.flatMap((id, i) => {
    if (keep && !keep.has(id)) return [];
    const o = objects.find((x) => x.id === id), g = groups[i], w = weightsFor(id, r.on) ?? new Float64Array(g.count).fill(1);
    return [{ id, name: o?.name ?? g.name, g, w, stats: columnStats(r.values, col, g, w) }];
  });
  const total = rows.reduce((s, x) => s + x.stats.total, 0), area = rows.reduce((s, x) => s + x.stats.area, 0);
  const cum = cumulative(r.values, col, rows.map((x) => x.g), rows.map((x) => x.w));
  const bins = Math.min(64, Math.max(12, Math.round(1.5 * Math.sqrt(cum.v.length)))); // more detail with more elements
  const markers = { mean: area ? total / area : NaN, median: percentile(cum, 0.5), p10: percentile(cum, 0.1), p90: percentile(cum, 0.9) };
  const d = { r, col, rows, total, cum, markers, bins };
  held.set(key, d);
  // ponytail: per result at most 3 full columns' worth of elements (16 B each), least recent out; raise it if many charts thrash it
  const full = groups.reduce((n, g) => n + g.count, 0), size = () => [...held.values()].reduce((n, x) => n + x.cum.v.length, 0);
  while (held.size > 1 && size() > 3 * full) held.delete(held.keys().next().value!);
  return d;
}

export interface ChartInput {
  models: readonly Pick<Model, 'slot' | 'objects' | 'result'>[]; // every open model: the colour scale spans them all
  column: string; // the column shown: a spec without its own draws it
  viz: Settings['viz'];
  weightsFor: WeightsFor;
}
type Common = { scale: Scale; unit: string; grid: boolean };
/** What a chart draws, its look's defaults filled in; several models: a series / curve / bar per model by slot. */
export type Drawn =
  | (Common & { kind: 'histogram'; edges: number[]; shares: number[]; counts: number[]; below: number; above: number; markers: Markers; show: Marker[]; series?: { slot: number; shares: number[] }[]; height: number })
  | (Common & { kind: 'curve'; cum: Cumulative; domain: [number, number]; show: Marker[]; curves?: { slot: number; cum: Cumulative }[]; height: number })
  | (Common & { kind: 'parts'; metric: Metric; groups: { name: string; path: string; bars: { slot: number; v: number }[] }[] }) // v NaN: no value
  | { kind: 'empty'; reason: string };

/** A chart's numbers: its models' receivers (or those under its parts) in its column, on that column's colour scale. */
export function chartData(spec: ChartSpec, input: ChartInput): Drawn {
  const column = spec.column ?? input.column, results = input.models.flatMap((m) => (m.result ? [m.result] : []));
  const scale = scaleFor(column, unionRange(results, column), input.viz), unit = unitFor(column).value, grid = spec.grid ?? true;
  const ms = input.models.filter((m) => m.result?.columns.includes(column) && (!spec.models || spec.models.includes(m.slot)));
  if (!ms.length) return { kind: 'empty', reason: 'No result for this column' };
  const data = (m: (typeof ms)[number], ids?: readonly string[]) => dataOf(m.result!, m.result!.columns.indexOf(column), m.objects, input.weightsFor, ids);

  if (spec.kind === 'parts') { // a row per prim path (matched across models), a bar per model
    const metric = spec.metric ?? 'mean', all = ms.map((m) => ({ m, d: data(m) })), pathOf = new Map(ms.flatMap((m) => m.objects.map((o) => [o.id, o.path] as const)));
    const paths = (spec.parts ?? [...new Set(all.flatMap(({ d }) => d.rows.flatMap((x) => pathOf.get(x.id) ?? [])))]).slice(0, 24); // ponytail: the first 24 parts; a top-N by metric if models have more
    const names = rowNames(paths);
    return {
      kind: 'parts', scale, unit, grid, metric,
      groups: paths.map((path, i) => ({
        name: names[i] || path, path,
        bars: all.map(({ m, d }) => {
          const under = new Set(idsUnder([path], m.objects)), rows = d.rows.filter((x) => under.has(x.id));
          return { slot: m.slot, v: rows.length ? summarize(d.r.values, d.col, rows.map((x) => x.g), rows.map((x) => x.w), scale.lo, scale.hi)[metric] : NaN };
        }),
      })),
    };
  }

  const ds = ms.flatMap((m) => { const d = data(m, spec.parts && idsUnder(spec.parts, m.objects)); return d.cum.v.length ? [{ slot: m.slot, d }] : []; });
  if (!ds.length) return { kind: 'empty', reason: 'No values under these parts' };
  const many = ds.length > 1, first = ds[0].d, want = spec.range ?? 'relative', show = [...(spec.markers ?? MARKERS[spec.kind])];
  const seen: [number, number] = [Math.min(...ds.map(({ d }) => d.cum.v[0])), Math.max(...ds.map(({ d }) => d.cum.v[d.cum.v.length - 1]))]; // absolute: the data's
  const range: [number, number] = Array.isArray(want) ? want : want === 'relative' && scale.vmax > scale.vmin ? [scale.vmin, scale.vmax] : seen;
  if (spec.kind === 'curve') return { kind: 'curve', scale, unit, grid, show, height: spec.height ?? 170, cum: first.cum, domain: range, curves: many ? ds.map(({ slot, d }) => ({ slot, cum: d.cum })) : undefined };
  const bins = typeof spec.bins === 'number' ? spec.bins : Math.min(...ds.map(({ d }) => d.bins)); // auto: the same bins for every model, so a hovered bin lines up
  const hs = ds.map(({ d }) => histogram(d.r.values, d.col, d.rows.map((x) => x.g), d.rows.map((x) => x.w), bins, range));
  return {
    kind: 'histogram', scale, unit, grid, show, height: spec.height ?? 200, edges: hs[0].edges, shares: hs[0].shares, counts: hs[0].counts, markers: first.markers,
    below: hs[0].below, above: Math.max(...hs.map((h) => h.above)), // several: the largest share above of any (the last bin's hover stops at the top)
    series: many ? ds.map(({ slot }, k) => ({ slot, shares: hs[k].shares })) : undefined,
  };
}
