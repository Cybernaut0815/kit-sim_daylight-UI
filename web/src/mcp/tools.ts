// The agent's tools (server/mcp.json: their names, arguments and what each does), run in the app tab against App's
// controller. A call's arguments are checked against its tool's inputSchema; its handler then reads the controller again
// after every await (c()), applies a change with flushSync (one commit, after which c() is current) and waits for App's
// async work (a load, a re-read, a run, a download) with until(), answering 'running' when that outlasts the call's
// budget (the work goes on). A thrown 'field: what to do' answers isError. Replies are compact JSON, numbers rounded as
// the app shows them (NaN -> null). The hidden instance keeps a record of its session on the server (PUT /session); a UI
// tab picks it up as its bridge starts (pickup), and calls wait until it has (within their budget).
import type { Dispatch, SetStateAction } from 'react';
import { flushSync } from 'react-dom';
import { Matrix4, Vector3, type InstancedMesh, type Mesh, type Object3D } from 'three';
import type { ObjMesh } from 'daylight-mesh';
import type { ViewState } from 'usd-viewer';
import type { Pane, UiPrefs } from '../App';
import { validate, weatherLeap } from '../lib/args';
import { BUILT_IN, putChart, type ChartSpec, type WeightsFor } from '../lib/charts';
import { boxToWorld, cornersOf, describeView, facingOf, findCritical, frameView, meanNormal, viewDir, type Box, type Facing, type Points, type Vec3 } from '../lib/frame';
import { STATION_INDEX_URL, haversineKm, nearestStations, parseStationIndex, photonReverse, photonSearch, proxyUrl } from '../lib/geo';
import { gradientFor, type Scale } from '../lib/gradients';
import { DEFAULT_KEY, GLASS_KEY, PRESETS, editOptics, type Optics, type resolveOptics } from '../lib/optics';
import { QUANTITY_HELP, SIDE_HELP, fmtNum, roundNum, roundPct, summarize, unitFor, type Summary } from '../lib/result';
import { dayBounds, parseHoy, sunAt } from '../lib/sun';
import { fmtClock, fmtTime, yearOf } from '../lib/time';
import { idsUnder, primQuery, underIndex } from '../lib/tree';
import { stageView, type SavedView } from '../lib/views';
import { zoneAt } from '../lib/zone';
import { changed, outcome, type Pdf } from '../report/generate';
import { parseReports, readiness, validateSpec, type AppModel, type AppView, type Draft, type Report, type Stored } from '../report/spec';
import { QUANTITIES, inFlight, parseSettings, reducer, serializeSettings, type Action, type Model, type ObjectRow, type RunResult, type Settings, type State, type Station, type TimePoint } from '../store';
import { selectionFill } from '../viewer/Viewer';
import { capture } from '../viewer/capture';
import type { ExportMode, Format } from '../viewer/download';
import type { Slot } from '../viewer/usd';
import mcp from '../../../server/mcp.json';
import guide from './guide.md?raw';
import reportGuide from './report.md?raw';
import { HEADLESS, exclusive, fail, startBridge, until, type CallToolResult } from './bridge';
// kit-ui's skills as its package ships them (from v0.2.1; none in an older one): the 'report' and 'kit-ui' topics
const SKILLS = import.meta.glob<string>('/node_modules/kit-ui/skills/*/*.md', { query: '?raw', import: 'default', eager: true, exhaustive: true });
const skill = (file: string) => Object.entries(SKILLS).find(([k]) => k.endsWith(`/skills/${file}`))?.[1];

type Theme = 'auto' | 'light' | 'dark';
/** App as the tools drive it: App rewrites it on every commit. */
export interface Ctl {
  state: State; dispatch: Dispatch<Action>;
  panes: Readonly<Record<number, Pane>>; // by slot
  ui: UiPrefs; setUi: Dispatch<SetStateAction<UiPrefs>>;
  theme: Theme; setTheme: (mode: Theme) => void; // the mode (auto: the system's)
  sunScale: number; setSunScale: (scale: number) => void;
  views: SavedView[]; setViews: Dispatch<SetStateAction<SavedView[]>>;
  optics: ReturnType<typeof resolveOptics>[]; materialsReady: boolean; // optics per model, in state.models order
  per: { m: Model; receivers: ObjectRow[]; shades: ObjectRow[]; key: string }[]; // per model, in order: its run key now
  shown: string | null; scale: Scale | null; domain: [number, number]; // the column every view shows, its colour scale, every model's data range
  exporting: boolean; exportError: { result: RunResult; message: string } | null;
  onFiles: (slot: number, files: File[]) => Promise<void>; onRemove: (slot: number) => void;
  onVariant: (slot: number, path: string, set: string, variant: string) => void; onSubdiv: (level: number) => void;
  onRefine: (slot: number, paths: string[], level: number | null) => void;
  onRun: () => Promise<void>; onDownload: (format: Format, mode: ExportMode) => Promise<void>;
  weightsFor: WeightsFor; meshOf: (id: string) => ObjMesh | undefined; // a mesh's element areas; its ObjMesh (model metres, Z up)
  busy: () => boolean; held: () => boolean; cancel: () => void; // a batch on its way; a click waiting for the materials; Cancel
  viewer: (slot: number) => Slot;
  variants: (slot: number) => AppModel['choices']; // the variant choices made in the app since the slot's file opened
  fileOf: (slot: number) => string | undefined; // the file the slot opened (within a picked folder: its path there)
  reports: Stored[] | null; refreshReports: () => Promise<void>; // GET /reports (null: no report routes here); fetch it again
  generate: (id: string) => Promise<Pdf>; generation: (id: string) => { generating: boolean; lastError: string | null }; // report/generate.ts
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- checked against the tool's inputSchema before a handler runs
type Args = Record<string, any>;
/** A tool: its checked arguments, the controller now, and when its budget ends (Date.now() ms). */
type Handler = (a: Args, c: () => Ctl, end: number) => Promise<CallToolResult>;

const LETTERS = 'ABCD', letter = (slot: number) => LETTERS[slot];
const BUDGET = 42e3; // ms per call for App's async work; the bridge answers by 45 s whatever happens
const ok = (o: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(o) }] });
const base = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;
/** App's async work ended within the call's budget (else it goes on, and the reply says running). */
const done = (pred: () => boolean, end: number, what: string) => until(pred, end - Date.now(), what).then(() => true, () => false);

/** One tool call, its budget ending at `end`: an unknown tool, bad arguments and a thrown error answer isError. */
async function invoke(name: string, args: Record<string, unknown>, c: () => Ctl, end: number): Promise<CallToolResult> {
  const tool = TOOLS.find((t) => t.name === name), handler = HANDLERS[name];
  if (!tool || !handler) return fail(`${name}: ${tool ? 'not available in this build yet' : `no such tool (${TOOLS.map((t) => t.name).join(', ')})`}`);
  const why = check(tool.inputSchema, args);
  if (why) return fail(why);
  try {
    return await handler(args, c, end);
  } catch (e) {
    return fail((e as Error).message);
  }
}

let gate: Promise<unknown> = Promise.resolve(); // a pickup on its way: calls wait for it
// said once, at the start of the next reply the agent gets: where it now works
let note = HEADLESS ? `Working in a hidden app instance; opening ${location.origin}/ in a browser shows this session. It started empty: the models, roles and results of an app tab closed earlier do not carry over, and its settings are its own (see app_state). ` : '';
/** One tool call from the bridge, once a pickup has ended (a pickup that outlasts the call's budget answers isError, and
 *  the call does not run); in the hidden instance a change is added to its session. */
async function call(name: string, args: Record<string, unknown>, c: () => Ctl): Promise<CallToolResult> {
  const end = Date.now() + BUDGET; // from receipt: the bridge's 45 s run from here too
  let timer: ReturnType<typeof setTimeout> | undefined;
  const picked = await Promise.race([gate.then(() => true), new Promise<boolean>((r) => { timer = setTimeout(() => r(false), end - 1e3 - Date.now()); })]);
  clearTimeout(timer);
  if (!picked) return fail(`${name}: the app is still taking over the hidden session; call app_state again in a moment`);
  const active = c().state.active, res = await invoke(name, args, c, end);
  if (HEADLESS) await record(name, args, res, active, c);
  if (!note || Date.now() > end + 2e3) return res; // past the bridge's 45 s nobody reads this reply: the next one says it
  const [first, ...rest] = res.content, said = note;
  note = '';
  return { ...res, content: first?.type === 'text' ? [{ type: 'text', text: said + first.text }, ...rest] : [{ type: 'text', text: said.trim() }, ...res.content] };
}
/** The tab's bridge, for App to start once: calls answered against its controller; a UI tab first picks up the hidden
 *  instance's session. */
export function connect(c: () => Ctl): () => void {
  if (!HEADLESS) pickup(c);
  return startBridge((name, args) => call(name, args, c));
}

// ---------------------------------------------------------------------------------------------- arguments
interface Schema {
  type?: string | string[]; enum?: unknown[]; anyOf?: Schema[]; pattern?: string; minimum?: number; maximum?: number;
  minLength?: number; maxLength?: number; minItems?: number; maxItems?: number; items?: Schema;
  properties?: Record<string, Schema>; required?: string[]; additionalProperties?: boolean;
}
export const TOOLS = mcp.tools as unknown as { name: string; inputSchema: Schema; annotations?: { readOnlyHint?: boolean } }[];
const is = (t: string, v: unknown) =>
  t === 'integer' ? Number.isInteger(v) : t === 'number' ? Number.isFinite(v) : t === 'array' ? Array.isArray(v)
    : t === 'object' ? !!v && typeof v === 'object' && !Array.isArray(v) : t === 'null' ? v === null : typeof v === t;
const WORDS: Record<string, string> = {
  '^\\d{4}-\\d{2}-\\d{2}$': 'a date, YYYY-MM-DD', '^\\d{2}:\\d{2}$': "a time, 'HH:MM'", '^/': 'a prim path, starting with /', '^[a-z0-9-]{1,64}$': '1 to 64 lowercase letters, digits or -',
};
const span = (lo?: number, hi?: number) => (lo === hi ? `${lo}` : lo !== undefined && hi !== undefined ? `${lo} to ${hi}` : lo !== undefined ? `at least ${lo}` : `at most ${hi}`);

/** What is wrong with `v` under a tool's inputSchema (the parts mcp.json uses), by its path, e.g. 'time.step: one of
 *  10, 15, 30, 60'; '' when nothing. */
export function check(s: Schema, v: unknown, at = 'arguments'): string {
  const no = (what: string) => `${at}: ${what}`, types = s.type === undefined ? [] : [s.type].flat();
  if (types.length && !types.some((t) => is(t, v))) return no(s.enum ? `one of ${s.enum.join(', ')}` : types.join(' or '));
  if (s.enum && !s.enum.includes(v)) return no(`one of ${s.enum.join(', ')}`);
  if (s.anyOf) {
    const why = s.anyOf.map((x) => check(x, v, at)); // the alternative of the value's type says what is wrong
    if (why.every(Boolean)) return why.find((_, i) => [s.anyOf![i].type ?? []].flat().some((t) => is(t, v))) ?? why[0];
  }
  if (typeof v === 'string') {
    if (s.pattern && !new RegExp(s.pattern).test(v)) return no(WORDS[s.pattern] ?? `as ${s.pattern}`);
    if (v.length < (s.minLength ?? 0) || v.length > (s.maxLength ?? Infinity)) return no(`${span(s.minLength, s.maxLength)} characters`);
  }
  if (typeof v === 'number' && (v < (s.minimum ?? -Infinity) || v > (s.maximum ?? Infinity))) return no(span(s.minimum, s.maximum));
  if (Array.isArray(v)) {
    if (v.length < (s.minItems ?? 0) || v.length > (s.maxItems ?? Infinity)) return no(`${span(s.minItems, s.maxItems)} items`);
    for (const [i, x] of v.entries()) { const w = s.items && check(s.items, x, `${at}[${i}]`); if (w) return w; }
  }
  if (s.properties && is('object', v)) {
    const o = v as Record<string, unknown>, sub = (k: string) => (at === 'arguments' ? k : `${at}.${k}`);
    for (const k of s.required ?? []) if (o[k] === undefined) return `${sub(k)}: required`;
    for (const [k, x] of Object.entries(o)) {
      const p = Object.hasOwn(s.properties, k) ? s.properties[k] : undefined;
      if (!p && s.additionalProperties === false) return `${sub(k)}: not an argument here (${Object.keys(s.properties).join(', ') || 'none'})`;
      const w = p && check(p, x, sub(k));
      if (w) return w;
    }
  }
  return '';
}

// ---------------------------------------------------------------------------------------------- helpers
/** The model in slot `l` (default the active one); a refusal names `field`, the argument that gave the letter. */
function modelOf(x: Ctl, l?: string, field = 'model'): Model {
  const slot = l === undefined ? x.state.active : LETTERS.indexOf(l), m = x.state.models.find((k) => k.slot === slot);
  if (!m) throw new Error(`${field}: no model in slot ${l}; open one with open_model, or use ${x.state.models.map((k) => letter(k.slot)).join(', ')}`);
  return m;
}
/** The model in slot `l` with meshes, not loading. */
function loadedOf(x: Ctl, l?: string, field = 'model'): Model {
  const m = modelOf(x, l, field), L = letter(m.slot);
  if (x.panes[m.slot]?.loading) throw new Error(`${field}: model ${L} is loading; call app_state until it has loaded`);
  if (!m.objects.length) throw new Error(`${field}: model ${L} has no model open; open one with open_model`);
  return m;
}
const roles = (m: Model) => Object.fromEntries((['receiver', 'shade', 'none'] as const).map((r) => [r, m.objects.filter((o) => o.role === r).length]));
const problems = (x: Ctl) => validate(x.state.settings, x.per.some((p) => p.receivers.length > 0), x.materialsReady);
const loadedSlots = (x: Ctl) => x.state.models.filter((m) => (x.panes[m.slot]?.meshes.size ?? 0) > 0).map((m) => m.slot);
const display = (x: Ctl) => ({
  active: letter(x.state.active), column: x.shown, colourBy: x.state.colourBy, highlight: x.state.bin, theme: x.theme,
  sunPath: x.ui.sunPath, sunScale: x.sunScale, split: x.ui.split, link: x.ui.link, auto: x.ui.auto,
});

export const UUID = /[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/g;
/** A run key with its mesh ids (new per page load and per re-read) as the rows' prim paths: equal inputs, equal key. */
export const stableKey = (key: string, rows: readonly ObjectRow[]) => { const path = new Map(rows.map((o) => [o.id, o.path])); return key.replace(UUID, (id) => path.get(id) ?? id); };
/** Model i's result against the inputs now: running (a job on its way), fresh or stale; null without one. */
function freshness(x: Pick<Ctl, 'per'>, i: number): 'running' | 'fresh' | 'stale' | null {
  const { m, key } = x.per[i];
  return inFlight(m.run) ? 'running' : !m.result ? null : stableKey(m.result.key, m.objects) === stableKey(key, m.objects) ? 'fresh' : 'stale';
}
/** A stable run key's settings: its arguments and weather (the receivers and shades apart). */
const runOf = (key: string) => JSON.stringify((JSON.parse(key) as unknown[]).slice(0, 2));
// per slot, open_model's paths, the open counter that open gave its pane and the model's name once loaded
const opened = new Map<number, { paths: string[]; stage: number; name?: string }>();
/** The app as a report sees it (report/spec.ts): the models' files (and paths, opened by open_model), variant choices,
 *  roles and results; the column shown, the problem ranges. From the controller, or from App's render (its Reports menu). */
export const appView = (x: Pick<Ctl, 'shown' | 'state' | 'panes' | 'variants' | 'per'>): AppView => ({
  shown: x.shown, ranges: x.state.settings.viz.ranges,
  models: x.state.models.map((m, i) => {
    const o = opened.get(m.slot), mine = o && o.stage === x.panes[m.slot]?.stage && (o.name ?? m.name) === m.name; // not a file opened in the app since
    return {
      model: letter(m.slot), file: m.objects.length ? m.name : '', ...(mine ? { open: o.paths } : {}), loading: !!x.panes[m.slot]?.loading, choices: x.variants(m.slot),
      receivers: x.per[i].receivers.map((r) => r.path), shades: x.per[i].shades.map((r) => r.path),
      result: freshness(x, i), key: m.result && runOf(stableKey(m.result.key, m.objects)), inputs: runOf(stableKey(x.per[i].key, m.objects)), columns: m.result?.columns ?? [],
    };
  }),
});
/** A result's element areas per receiver, m² (1 each where the mesh is gone). */
export const weightsOf = (x: Pick<Ctl, 'weightsFor'>, r: RunResult) => r.receivers.map((id, k) => x.weightsFor(id, r.on) ?? new Float64Array(r.manifest.meshes[k].count).fill(1));
/** Per model: its run status, timing and the shown column's mean, P10 and P90. */
function runLines(x: Ctl) {
  return x.state.models.map((m, i) => {
    const r = m.result, f = freshness(x, i), col = r && x.shown ? r.columns.indexOf(x.shown) : -1, sum = r && col >= 0 ? summarize(r.values, col, r.manifest.meshes, weightsOf(x, r)) : null;
    const status = m.run.status === 'error' ? 'failed' : inFlight(m.run) ? m.run.status : !x.per[i].receivers.length ? 'no receiver' : f === 'fresh' ? 'done' : f ?? 'not run';
    return {
      model: letter(m.slot), status, ...(m.error ? { error: m.error } : {}),
      ...(r ? { seconds: roundNum(r.elapsed), ...(r.manifest.run_s !== undefined ? { compute: roundNum(r.manifest.run_s) } : {}) } : {}),
      ...(sum ? { column: x.shown, unit: unitFor(x.shown!).value, mean: roundNum(sum.mean), p10: roundNum(sum.p10), p90: roundNum(sum.p90) } : {}),
    };
  });
}
/** A Materials table row as get_materials and edit_material answer it. */
const materialRow = (material: string, p: Optics) => ({ material, kind: p.kind, rho: roundNum(p.rho), tau: roundNum(p.tau), source: p.source, ...(p.warning ? { warning: p.warning } : {}) });
/** A view's eye-to-target distance, m. */
const reach = (v: ViewState, mpu: number) => Math.hypot(...v.eye.map((e, k) => e - v.target[k])) * mpu;
/** A model's camera as set_camera answers it: exact (copy it into view arguments), in words, and its distance in m. */
function viewOf(x: Ctl, slot: number) {
  const { el } = x.viewer(slot), v = el.view, mpu = el.stage?.metersPerUnit ?? 1;
  return { model: letter(slot), view: v, description: describeView(v, x.state.settings.sim.north, mpu), distance: roundNum(reach(v, mpu)) };
}

// ---------------------------------------------------------------------------------------------- statistics
const NUMS = ['area', 'min', 'p10', 'median', 'mean', 'p90', 'max', 'total'] as const;
/** A summary as results quotes it: values as the app rounds them; shares in %, of the problem range when one is set
 *  (`ranged`) and per threshold x below x and at or above it. */
function quoted(u: Summary, th: readonly number[], ranged: boolean) {
  return {
    elements: u.elements, ...Object.fromEntries(NUMS.map((k) => [k, roundNum(u[k])])),
    ...(ranged ? { below: roundPct(u.below), within: roundPct(u.within), above: roundPct(u.above) } : {}),
    ...(th.length ? { thresholds: th.map((x, i) => ({ x, below: roundPct(1 - u.atLeast[i]), atOrAbove: roundPct(u.atLeast[i]) })) } : {}),
  };
}
/** u minus the reference's v: values in the column's unit, shares in percentage points. */
function difference(u: Summary, v: Summary, th: readonly number[], ranged: boolean) {
  const pts = (d: number) => roundNum(100 * d);
  return {
    ...Object.fromEntries(NUMS.map((k) => [k, roundNum(u[k] - v[k])])),
    ...(ranged ? { below: pts(u.below - v.below), within: pts(u.within - v.within), above: pts(u.above - v.above) } : {}),
    ...(th.length ? { thresholds: th.map((x, i) => ({ x, below: pts(v.atLeast[i] - u.atLeast[i]), atOrAbove: pts(u.atLeast[i] - v.atLeast[i]) })) } : {}),
  };
}
/** The north a result ran with (its run key starts with the core's arguments): its facings' compass. */
const northOf = (r: RunResult) => { const [args] = JSON.parse(r.key) as [string[]]; return Number(args[args.indexOf('--north') + 1]); };
/** A result's run as results quotes it: period, hours and sun directions evaluated, weather, the core's arguments (mesh ids
 *  as prim paths), timing, the server cache. */
export function provenance(r: RunResult, rows: readonly ObjectRow[]) {
  const [args, weather] = JSON.parse(stableKey(r.key, rows)) as [string[], unknown], arg = (k: string) => args[args.indexOf(k) + 1];
  return {
    period: args.includes('--time') ? `instant ${arg('--time')}` : args.includes('--from') ? `${arg('--from')} to ${arg('--to')} every ${arg('--step')} min${args.includes('--hours') ? `, ${arg('--hours')} each day` : ''}` : 'annual',
    hours: r.manifest.duration_h, sunDirections: r.manifest.dirs.sun, elements: r.on, weather: typeof weather === 'string' ? weather : Array.isArray(weather) ? weather[0] : 'none',
    args, seconds: roundNum(r.elapsed), ...(r.manifest.run_s !== undefined ? { compute: roundNum(r.manifest.run_s) } : {}), ...(r.cache ? { cache: r.cache } : {}), ...(r.switches ? { switches: r.switches } : {}),
  };
}

const SIDES: readonly Facing[] = ['N', 'E', 'S', 'W', 'up', 'down'];
/**
 * results by 'facing': a result's elements by the side they face (frame.ts facingOf), N, E, S, W, up, down, each side with
 * its rows and areas. `meshes`: the receivers' rows [first, first + count), ObjMeshes (model metres) and element areas
 * `w`. An element faces along its face's (b - a) × (c - a), or a vertex along the sum of its faces' (the core's sensor
 * normal); a back column's turned round. Elements with no normal (degenerate) are left out.
 */
export function bySide(values: readonly Float64Array[], meshes: readonly { first: number; count: number; positions: ArrayLike<number>; indices: ArrayLike<number>; w: ArrayLike<number> }[], on: 'faces' | 'vertices', north: number, back: boolean): { facing: Facing; rows: Float64Array[]; w: number[] }[] {
  const out = new Map<Facing, { rows: Float64Array[]; w: number[] }>(), s = back ? -1 : 1;
  for (const { first, count, positions: P, indices: I, w } of meshes) {
    const n = new Float64Array(3 * count);
    for (let f = 0; f < I.length / 3; f++) {
      const a = 3 * I[3 * f], b = 3 * I[3 * f + 1], c = 3 * I[3 * f + 2];
      const u = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]], v = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
      const x = u[1] * v[2] - u[2] * v[1], y = u[2] * v[0] - u[0] * v[2], z = u[0] * v[1] - u[1] * v[0];
      for (const e of on === 'faces' ? [f] : [I[3 * f], I[3 * f + 1], I[3 * f + 2]]) if (e < count) { n[3 * e] += x; n[3 * e + 1] += y; n[3 * e + 2] += z; }
    }
    for (let e = 0; e < count; e++) {
      const v: Vec3 = [s * n[3 * e], s * n[3 * e + 1], s * n[3 * e + 2]];
      if (!(Math.hypot(...v) > 0)) continue;
      const side = facingOf(v, north), g = out.get(side) ?? { rows: [], w: [] };
      out.set(side, g);
      g.rows.push(values[first + e]);
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
export function summaries(x: Pick<Ctl, 'weightsFor' | 'meshOf'>, m: Pick<Model, 'objects' | 'result'>, column: string, by: 'parts' | 'mesh' | 'facing', paths: readonly string[] | undefined, lo: number | null, hi: number | null, th: readonly number[] = []) {
  const r = m.result!, col = r.columns.indexOf(column), w = weightsOf(x, r), g = r.manifest.meshes;
  const sum = (ks: number[]) => summarize(r.values, col, ks.map((k) => g[k]), ks.map((k) => w[k]), lo, hi, th), under = (ps: readonly string[]) => { const ids = new Set(idsUnder(ps, m.objects)); return r.receivers.flatMap((id, k) => (ids.has(id) ? [k] : [])); };
  const ks = paths ? under(paths) : r.receivers.map((_, k) => k), pathOf = new Map(m.objects.map((o) => [o.id, o.path])); // mesh and facing rows: the receivers under paths
  const rows: { key: string; head: object; u: Summary }[] = by === 'parts' ? paths!.map((p) => ({ key: p, head: { path: p }, u: sum(under([p])) }))
    : by === 'mesh' ? ks.map((k) => { const p = pathOf.get(r.receivers[k]) ?? g[k].name; return { key: p, head: { mesh: p }, u: sum([k]) }; }).sort((p, o) => o.u.area - p.u.area)
      : bySide(r.values, ks.flatMap((k) => { const o = x.meshOf(r.receivers[k]); return o ? [{ first: g[k].first, count: g[k].count, positions: o.positions, indices: o.indices, w: w[k] }] : []; }), r.on, northOf(r), column.endsWith('_back'))
        .map((f) => ({ key: f.facing, head: { facing: f.facing }, u: summarize(f.rows, col, [{ first: 0, count: f.rows.length }], [f.w], lo, hi, th) }));
  return { whole: sum(r.receivers.map((_, k) => k)), rows };
}

// ---------------------------------------------------------------------------------------------- framing and shots
const cm = (v: number) => Math.round(100 * v) / 100; // a model coordinate as quoted, m
/** A view's width / height on screen (16:10 while it has no size). */
const aspectOf = (x: Ctl, slot: number) => { const d = x.viewer(slot).el.three.renderer.domElement; return d.clientWidth > 0 && d.clientHeight > 0 ? d.clientWidth / d.clientHeight : 1.6; };
/** direction, elevation, aspect and projection shape a frame only. */
function frameOnly(a: Args) {
  const k = ['direction', 'elevation', 'aspect', 'projection'].find((f) => a[f] !== undefined);
  if (k && !a.frame) throw new Error(`${k}: goes with frame (frame {} = the whole model)`);
}
/** Drawn objects' vertices in world, an instancer's per copy: a frame fits these, not their axis-aligned boxes.
 *  ponytail: every vertex of every copy, twice per frame; per-copy boxes if a big instancer makes framing slow */
function drawnPoints(objs: readonly Object3D[]): Points {
  for (const o of objs) o.updateWorldMatrix(true, true); // a hidden tab draws no frame that would
  const v = new Vector3(), w = new Matrix4();
  return (f) => {
    for (const root of objs) root.traverse((o) => {
      const p = (o as Mesh).geometry?.getAttribute('position'), im = (o as InstancedMesh).isInstancedMesh ? (o as InstancedMesh) : null;
      for (let k = 0; p && k < (im ? im.count : 1); k++) {
        if (im) im.getMatrixAt(k, w).premultiply(o.matrixWorld);
        else w.copy(o.matrixWorld);
        for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i).applyMatrix4(w); f(v.x, v.y, v.z); }
      }
    });
  };
}
/**
 * set_camera's and screenshot's frame: the drawn meshes at or under frame.paths (every mesh without), or frame.box (model
 * metres), fitted to `aspect` from a.direction at a.elevation in the view's lens (or a.projection). auto faces
 * frame.normal, else the framed meshes (their backs for a back column).
 */
function framed(x: Ctl, m: Model, a: Args, aspect: number, back: boolean): { view: ViewState; cut: number } {
  const { el } = x.viewer(m.slot), f = a.frame as { paths?: string[]; box?: Box; normal?: Vec3 };
  if (f.paths && f.box) throw new Error('frame: give paths or box, not both');
  let pts: Points, normal = f.normal;
  if (f.box) pts = cornersOf(boxToWorld(f.box, el.stage?.metersPerUnit ?? 1));
  else {
    const ids = new Set(f.paths ? idsUnder(f.paths, m.objects) : m.objects.map((o) => o.id));
    const objs = [...ids].flatMap((id) => x.panes[m.slot]?.meshes.get(id) ?? []);
    if (!objs.length) throw new Error(`frame.paths: no meshes at or under ${f.paths?.join(', ')} in model ${letter(m.slot)}; find prims with model_tree`);
    pts = drawnPoints(objs);
    normal ??= meanNormal(m.objects.flatMap((o) => (ids.has(o.id) && !o.instances ? x.meshOf(o.id) ?? [] : []))).map((v) => (back ? -v : v)) as Vec3;
  }
  try {
    return frameView(pts, viewDir(a.direction ?? 'auto', x.state.settings.sim.north, normal, a.elevation ?? 20), { fov: el.view.fov, aspect, projection: a.projection ?? el.view.projection });
  } catch (e) {
    throw new Error(`frame.${(e as Error).message}`); // 'box: no extent; ...'
  }
}

const LONG = 1568, MAX_B64 = 800e3; // an image the agent gets: px on its long side; base64 characters per reply
/** A screenshot as the agent gets it: at most 8 MP asked; sent with the long side at most 1568 px, the aspect kept
 *  unless the short side would fall under 16 px (`reshaped`: it is 16 px then). */
export function shotSize(width: number, height: number): { width: number; height: number; reshaped: boolean } {
  if (width * height > 8e6) throw new Error(`width: ${width} x ${height} px is over 8 megapixels; ask for a smaller width or height`);
  const k = Math.min(1, LONG / Math.max(width, height)), w = Math.round(k * width), h = Math.round(k * height);
  return { width: Math.max(16, w), height: Math.max(16, h), reshaped: Math.min(w, h) < 16 };
}
/** One MessageChannel task (not throttled in a hidden tab, unlike timers). */
const tick = () => new Promise<void>((r) => { const ch = new MessageChannel(); ch.port1.onmessage = () => { ch.port1.close(); r(); }; ch.port2.postMessage(null); });

/** How the views look for shots: the column by name, the colouring, the sun path, the ground grid (the overlay frame()
 *  skips), a quantity's colour scale Min and Max (`pin`), no bin highlight and no selection fill (`clean`). */
export interface Look { column?: string; colourBy?: 'plain' | 'value'; sunPath?: boolean; grid?: boolean; pin?: { quantity: string; min: number; max: number }; clean?: boolean }
let staging = 0; // looks staged now
/** A look is staged for shots: App keeps it out of the stored settings and view preferences (the restore stores them). */
export const isStaging = () => staging > 0;
/** fn with the views of `slots` showing `look` (each part only when given) and no pointer hover or probe (a bin highlight
 *  and the selection stay, unless clean); all of it put back after fn, also when it throws. */
export async function staged<T>(c: () => Ctl, slots: readonly number[], look: Look, fn: () => Promise<T>): Promise<T> {
  const x = c(), ref = x.state.models.find((m) => m.result)?.result, col = look.column === undefined ? -1 : ref?.columns.indexOf(look.column) ?? -1;
  if (look.column !== undefined && col < 0) throw new Error(`column: ${look.column} is not in the first result's columns (${ref?.columns.join(', ') ?? 'no result'}), which the views show; run again`);
  const was = { column: x.state.column, colourBy: x.state.colourBy, sunPath: x.ui.sunPath, bin: x.state.bin, scale: look.pin && x.state.settings.viz.scales[look.pin.quantity] };
  const grids = look.grid === undefined ? [] : slots.flatMap((k) => x.viewer(k).el.three.overlay.children.filter((o) => o.userData.frame === false).map((o) => [o, o.visible] as const));
  const fill = look.clean && slots.length ? x.viewer(slots[0]).el : null; // the selection fill: one material for every view
  staging++;
  try {
    flushSync(() => {
      x.dispatch({ type: 'HOVER', id: null });
      x.dispatch({ type: 'PROBE', probe: null }); // the pointer's, not the shot's
      if (look.column !== undefined) x.dispatch({ type: 'COLUMN', column: col });
      if (look.colourBy) x.dispatch({ type: 'COLOUR_BY', colourBy: look.colourBy });
      if (look.sunPath !== undefined) x.setUi((u) => ({ ...u, sunPath: look.sunPath! }));
      if (look.pin) x.dispatch({ type: 'VIZ', quantity: look.pin.quantity, patch: { min: look.pin.min, max: look.pin.max } });
      if (look.clean) x.dispatch({ type: 'BIN', bin: null });
    });
    if (fill) fill.highlight = { color: '#000000', opacity: 0 }; // after the commit: a colouring change sets it again
    for (const [o] of grids) o.visible = look.grid!;
    // ponytail: one MessageChannel task lets Viewer.tsx's paint (it awaits a dynamic import before colouring a receiver
    // the first time) land; wait for a paint-done signal from the Viewer if a shot ever shows a receiver uncoloured
    await tick();
    return await fn();
  } finally {
    staging--;
    for (const [o, v] of grids) o.visible = v;
    flushSync(() => {
      const z = c();
      if (look.column !== undefined) z.dispatch({ type: 'COLUMN', column: was.column });
      if (look.colourBy) z.dispatch({ type: 'COLOUR_BY', colourBy: was.colourBy });
      if (look.sunPath !== undefined) z.setUi((u) => ({ ...u, sunPath: was.sunPath }));
      if (look.pin) z.dispatch({ type: 'VIZ', quantity: look.pin.quantity, patch: { min: was.scale?.min ?? null, max: was.scale?.max ?? null } });
      if (look.clean) z.dispatch({ type: 'BIN', bin: was.bin });
    });
    if (fill) fill.highlight = selectionFill(c().state.colourBy === 'value' && !!c().scale);
  }
}
export async function b64(blob: Blob): Promise<string> {
  const u = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}

/** GET /files: a file's bytes, or a folder's listing (JSON); the server's refusal names the argument. */
async function local(path: string, field: string): Promise<Response> {
  const r = await fetch(`/files?path=${encodeURIComponent(path)}`).catch(() => null);
  if (!r?.ok) throw new Error(`${field}: ${r ? (await r.text()).replace(/^error: /, '').trim() : 'the server cannot be reached'}`);
  return r;
}
const isJson = (r: Response) => !!r.headers.get('Content-Type')?.startsWith('application/json');
/** A model's files by absolute path, as the Model panel's pickers give them: the files, or one folder's files fetched one
 *  after another, each with its path under the folder (the folder's name first), as a folder pick has it. */
async function modelFiles(paths: string[]): Promise<File[]> {
  const out: File[] = [];
  for (const [i, path] of paths.entries()) {
    const r = await local(path, `paths[${i}]`);
    if (!isJson(r)) { out.push(new File([await r.blob()], base(path))); continue; }
    if (paths.length > 1) throw new Error(`paths[${i}]: a folder; give one folder alone, or the model's files`);
    const { files } = (await r.json()) as { files: { path: string }[] };
    if (!files.length) throw new Error(`paths[0]: no model files in ${path}`);
    for (const f of files) {
      const file = new File([await (await local(`${path.replace(/[\\/]+$/, '')}/${f.path}`, 'paths[0]')).blob()], base(f.path));
      // ponytail: the folder layout rides on webkitRelativePath set on the File (what onFiles and loaders.ts read); hand
      // onFiles LocalFile paths if a browser ever refuses that
      out.push(Object.defineProperty(file, 'webkitRelativePath', { value: `${base(path)}/${f.path}` }));
    }
  }
  return out;
}
const pathOf = new WeakMap<File, string>(); // weather files opened by path: the settings show the path
/** A local .epw by absolute path. */
async function epwFile(path: string): Promise<File> {
  if (!/\.epw$/i.test(path)) throw new Error('weather.file: the absolute path of an .epw file');
  const r = await local(path, 'weather.file');
  if (isJson(r)) throw new Error('weather.file: a folder; give the .epw file');
  // stamped by its bytes, not by this fetch: App's run key holds the file's name, size and lastModified, so the same file
  // opened again (a later call, a pickup) keeps its key, and a report on it stays ready
  const bytes = await r.arrayBuffer(), h = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const f = new File([bytes], base(path), { lastModified: h.subarray(0, 6).reduce((n, b) => n * 256 + b, 0) });
  pathOf.set(f, path);
  return f;
}
/** The station index: the Weather panel loads it for the station source only, the tools fetch it the same way. */
async function stationIndex(c: () => Ctl): Promise<Station[]> {
  if (!c().state.stations) {
    const r = await fetch(proxyUrl(STATION_INDEX_URL));
    if (!r.ok) throw new Error(`the station index did not load (${r.status})`);
    const stations = parseStationIndex(await r.json());
    if (!c().state.stations) flushSync(() => c().dispatch({ type: 'STATIONS', stations }));
  }
  return c().state.stations!;
}

// ---------------------------------------------------------------------------------------------- settings
/** The settings as update_settings takes them (times 'HH:MM', the station by title, chart models by letter): app_state's
 *  copy goes back unchanged. */
export function publicSettings(s: Settings) {
  const { site, sim, time: t, weather: w, viz } = s, at = (p: TimePoint) => ({ date: p.date, hour: fmtClock(p.hour) });
  return {
    site, sim,
    time: { mode: t.mode, date: t.date, hour: fmtClock(t.hour), from: at(t.from), to: at(t.to), step: t.stepMin },
    weather: { source: w.source, station: w.station?.title ?? null, file: w.file && (pathOf.get(w.file) ?? w.file.name), turbidity: w.turbidity, altitude: w.altitude },
    viz: {
      belowColour: viz.colors.below, aboveColour: viz.colors.above,
      quantities: Object.fromEntries(QUANTITIES.map((q) => [q, {
        gradient: gradientFor(q, viz.gradients[q]).key, min: viz.scales[q]?.min ?? null, max: viz.scales[q]?.max ?? null, below: viz.ranges[q]?.lo ?? null, above: viz.ranges[q]?.hi ?? null,
      }])),
    },
    charts: s.charts.map((c) => (c.models ? { ...c, models: c.models.map(letter) } : c)),
  };
}
/** A mode switch alone, before a SIM patch with the mode: the switch picks the quantities (and sky density) for the
 *  mode, which would undo the patch's own. */
const simMode = (mode: Settings['sim']['mode']): Action => ({ type: 'SIM', patch: { mode } });
/** 'HH:MM', 00:00 to 24:00 -> minutes of day. */
function minutesOf(field: string, hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number), v = 60 * h + m;
  if (!(m < 60 && v <= 1440)) throw new Error(`${field}: a time from 00:00 to 24:00`);
  return v;
}
function dateOf(field: string, d: string): string {
  const t = Date.parse(`${d}T00:00:00Z`);
  if (Number.isNaN(t) || !new Date(t).toISOString().startsWith(d)) throw new Error(`${field}: no such date`);
  return d;
}

/**
 * update_settings' arguments -> the actions the panels dispatch for them (SITE, WEATHER, TIME, SIM, VIZ, CHART), each value
 * checked; a site query is geocoded and a weather file fetched before (`file`), a station is found in `s`'s index, and
 * each chart is checked against the ones before it. `shown`: the column shown, whose quantity viz takes by default.
 */
export function settingsActions(a: Args, s: State, shown: string | null, file?: File): Action[] {
  const out: Action[] = [], { site: s0, time: t0 } = s.settings;
  if (a.site) {
    const { lat = s0.lat, lon = s0.lon, place } = a.site, moved = lat !== s0.lat || lon !== s0.lon;
    if (moved || place !== undefined) out.push({ type: 'SITE', patch: { lat, lon, place: place ?? (moved ? `${lat.toFixed(4)}, ${lon.toFixed(4)}` : s0.place) } });
  }
  if (a.weather) {
    const w = a.weather, patch: Partial<Settings['weather']> = {};
    if (w.source && w.source !== s.settings.weather.source) patch.source = w.source;
    if (w.station !== undefined) {
      const k = w.station.toLowerCase(), st = s.stations?.find((x) => x.href === w.station || x.title.toLowerCase() === k || x.title.replace(/_/g, ' ').toLowerCase() === k);
      if (!st) throw new Error(`weather.station: no station '${w.station}' in the index; pass a title from site_info's nearest stations`);
      Object.assign(patch, { source: 'station', station: st });
    }
    if (file) Object.assign(patch, { source: 'upload', file });
    if (w.turbidity !== undefined) patch.turbidity = w.turbidity;
    if (w.altitude !== undefined) patch.altitude = w.altitude;
    if (Object.keys(patch).length) out.push({ type: 'WEATHER', patch });
  }
  if (a.time) {
    const t = a.time, patch: Partial<Settings['time']> = {};
    const point = (k: 'from' | 'to'): TimePoint => ({
      date: t[k].date === undefined ? t0[k].date : dateOf(`time.${k}.date`, t[k].date), hour: t[k].hour === undefined ? t0[k].hour : minutesOf(`time.${k}.hour`, t[k].hour),
    });
    if (t.mode) patch.mode = t.mode;
    if (t.date !== undefined) patch.date = dateOf('time.date', t.date);
    if (t.hour !== undefined) patch.hour = minutesOf('time.hour', t.hour);
    if (t.from) patch.from = point('from');
    if (t.to) patch.to = point('to');
    if (t.step !== undefined) patch.stepMin = t.step;
    out.push({ type: 'TIME', patch });
  }
  if (a.sim) out.push(...(a.sim.mode ? [simMode(a.sim.mode)] : []), { type: 'SIM', patch: a.sim });
  if (a.viz) {
    const { quantity = shown?.split('_')[0], reset, gradient, min, max, below, above, belowColour, aboveColour } = a.viz;
    if (!quantity) throw new Error('viz.quantity: no result is shown yet; name the quantity');
    if (reset) out.push({ type: 'VIZ_RESET', quantity, what: reset }); // first: the other fields go over it
    const patch = Object.fromEntries(Object.entries({ gradient, min, max, lo: below, hi: above, below: belowColour, above: aboveColour }).filter(([, v]) => v !== undefined));
    if (Object.keys(patch).length) out.push({ type: 'VIZ', quantity, patch });
  }
  let st = s; // the charts so far
  for (const [i, raw] of ((a.charts ?? []) as Args[]).entries()) {
    const { remove, reset, ...given } = raw, old = st.settings.charts.find((c) => c.id === given.id), at = `charts[${i}]`;
    let act: Action;
    if (remove || reset) {
      if (!old) throw new Error(`${at}.id: no chart '${given.id}' (${st.settings.charts.map((c) => c.id).join(', ')})`);
      if (remove && BUILT_IN.some((b) => b.id === old.id)) throw new Error(`${at}.remove: '${old.id}' is built in; reset it instead`);
      act = remove ? { type: 'CHART', id: old.id, remove: true } : { type: 'CHART', id: old.id, reset: true };
    } else { // an existing chart: only the given fields change
      const spec = { ...old, ...given, ...(given.models ? { models: given.models.map((l: string) => LETTERS.indexOf(l)) } : {}) } as ChartSpec, r = putChart(st.settings.charts, spec);
      if (typeof r === 'string') throw new Error(`${at} ${r}`);
      act = { type: 'CHART', spec };
    }
    out.push(act);
    st = reducer(st, act);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------- reports
const said = async (r: Response) => (await r.text()).replace(/^error: /, '').trim();
/** The stored reports (GET /reports), each spec parsed. */
export async function storedReports(): Promise<Stored[]> {
  const r = await fetch('/reports').catch(() => null);
  if (!r?.ok || !isJson(r)) throw new Error(`reports: ${r ? await said(r) : 'the server cannot be reached'}`);
  return parseReports(await r.json());
}
/** Stored report `id`; its refusal names the ids there are. */
export async function storedReport(id: string): Promise<Stored> {
  const all = await storedReports(), e = all.find((s) => s.id === id);
  if (!e) throw new Error(`id: no report ${id}${all.length ? ` (${all.map((s) => s.id).join(', ')})` : ''}`);
  return e;
}
/** A report stored (PUT /reports/{id}), created kept from the one it replaces (`old`), updated now and after old's: every
 *  save of a report, also an edit in the app (`d` the edited report: its own stamps give way), goes through here. */
export async function putReport(d: Draft & Partial<Pick<Report, 'created' | 'updated'>>, old?: Report): Promise<Report> {
  const now = new Date(Math.max(Date.now(), (Date.parse(old?.updated ?? '') || 0) + 1)).toISOString();
  const { id, title, created: _c, updated: _u, ...rest } = d, r: Report = { id, title, created: old?.created ?? now, updated: now, ...rest };
  const res = await fetch(`/reports/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(r) }).catch(() => null);
  if (!res?.ok) throw new Error(`spec: not stored (${res ? await said(res) : 'the server cannot be reached'})`);
  changed(id);
  return r;
}
const waiting = new Set<string>(); // the reports generate_report answered 'generating' for: the next call gets that generation

// ---------------------------------------------------------------------------------------------- the tools
// Read-only tools run at once; the others change state under exclusive(), and wait for App outside it.
export const HANDLERS: Record<string, Handler> = {
  async app_state(_a, c) {
    const x = c(), s = x.state;
    return ok({
      tab: { kind: HEADLESS ? 'hidden' : 'UI', visible: document.visibilityState === 'visible', discarded: (document as Document & { wasDiscarded?: boolean }).wasDiscarded === true },
      models: s.models.map((m, i) => ({
        model: letter(m.slot), name: m.name || null, loading: !!x.panes[m.slot]?.loading, problems: x.panes[m.slot]?.loadError ?? null,
        meshes: roles(m), faces: m.objects.reduce((n, o) => n + o.tris, 0), run: m.run.status === 'error' ? 'failed' : m.run.status, ...(m.error ? { error: m.error } : {}), result: freshness(x, i),
        ...(x.panes[m.slot]?.meshes.size ? { view: x.viewer(m.slot).el.view } : {}), // its camera now, exact
      })),
      display: display(x), subdivision: x.ui.subdiv, settings: publicSettings(s.settings), problems: problems(x), views: x.views.map(({ name, view }) => ({ name, view })),
      reports: (x.reports ?? []).map((e) => ({ id: e.id, title: e.spec.title, models: e.spec.models.map((m) => m.model), updated: e.spec.updated, pdf: e.pdf, ...x.generation(e.id) })),
    });
  },

  async guide(a) {
    const ui = [skill('kit-ui/SKILL.md'), skill('kit-ui/reference.md')].filter(Boolean).join('\n\n---\n\n'), kr = skill('kit-report/SKILL.md');
    const text = a.topic === 'daylight' ? guide : a.topic === 'kit-ui' ? ui : kr
      ? `${reportGuide}\n\n---\n\nThe kit-ui kit-report skill, for reference: the app lays the report out and prints it (its sections 1, 3 and 4); its data rules (2) and read-back (5) apply to what you write.\n\n${kr}`
      : reportGuide;
    return text ? { content: [{ type: 'text', text }] } : fail("topic: 'kit-ui' is not in this build (its kit-ui package ships no skills); read 'daylight' or 'report'");
  },

  async site_info(a, c, end) {
    const stations = await stationIndex(c).catch(() => null), w = c().state.settings.weather;
    if (w.source !== 'clear-sky' && (w.source === 'upload' ? w.file : w.source === 'pvgis' || w.station)) await done(() => !!c().state.settings.epwMeta, Math.min(end, Date.now() + 15e3), 'the weather file'); // the Weather panel reads it
    const s = c().state.settings, { lat, lon } = s.site, z = zoneAt(lat, lon), leap = weatherLeap(s), site = { lat, lon, tz: z.std, leap }, e = s.epwMeta, t = s.time;
    const dates: string[] = a.dates ?? (t.mode === 'annual' ? ['03-21', '06-21', '12-21'].map((d) => `${yearOf(t.date)}-${d}`) : t.mode === 'instant' ? [t.date] : [...new Set([t.from.date, t.to.date])]);
    const hours: number[] | undefined = a.hours?.map((h: string, i: number) => minutesOf(`hours[${i}]`, h));
    const sun = (date: string, min: number) => sunAt(site, parseHoy(fmtTime(date, min, leap), leap)); // the core's sun
    return ok({
      place: s.site.place, lat, lon, zone: z.name || null, utcOffset: z.std, dstHours: z.dst, north: s.sim.north, weather: publicSettings(s).weather,
      epw: e && {
        name: e.name, lat: e.lat, lon: e.lon, utcOffset: e.tz, leap: e.leap, km: roundNum(haversineKm(lat, lon, e.lat, e.lon)),
        ...(e.monthly ? { monthly: Object.fromEntries(Object.entries(e.monthly).map(([k, v]) => [k, v.map(roundNum)])) } : {}),
      },
      stations: stations && nearestStations(stations, lat, lon, 8).map((st) => ({ title: st.title, km: roundNum(st.km!) })),
      days: dates.map((d, i) => {
        const b = dayBounds(site, dateOf(`dates[${i}]`, d));
        return {
          date: d, sunrise: fmtClock(b.sunrise), sunset: fmtClock(b.sunset), dayLength: roundNum((b.sunset - b.sunrise + (b.sunset < b.sunrise ? 1440 : 0)) / 60),
          sun: (hours ?? Array.from({ length: 24 }, (_, h) => 60 * h).filter((m) => sun(d, m).up)).map((m) => { const p = sun(d, m); return { time: fmtClock(m), altitude: roundNum(p.alt), azimuth: roundNum(p.azi) }; }),
        };
      }),
    });
  },

  async update_settings(a, c) {
    const site = a.site && { ...a.site }, s0 = c().state.settings.site;
    let alternatives: { place: string; lat: number; lon: number }[] = [];
    if (site?.query !== undefined) {
      if (site.lat !== undefined || site.lon !== undefined) throw new Error('site.query: give a query, or lat and lon, not both');
      const found = await photonSearch(site.query, { lat: s0.lat, lon: s0.lon }).catch((e: Error) => { throw new Error(`site.query: the place search failed (${e.message}); give lat and lon`); });
      if (!found.length) throw new Error(`site.query: no place found for '${site.query}'; try another name, or give lat and lon`);
      Object.assign(site, { lat: found[0].lat, lon: found[0].lon, place: site.place ?? found[0].name });
      alternatives = found.slice(1).map((p) => ({ place: p.name, lat: p.lat, lon: p.lon }));
    }
    const file = a.weather?.file === undefined ? undefined : await epwFile(a.weather.file);
    if (a.weather?.station !== undefined) await stationIndex(c).catch((e: Error) => { throw new Error(`weather.station: ${e.message}; try again, or use source pvgis`); });
    await exclusive(() => {
      const acts = settingsActions({ ...a, site }, c().state, c().shown, file), { dispatch } = c();
      flushSync(() => { for (const x of acts) dispatch(x); });
    });
    if (site && site.place === undefined && (site.lat !== undefined || site.lon !== undefined)) { // named later, as the Location panel names a picked point
      const { lat, lon, place } = c().state.settings.site;
      photonReverse(lat, lon).then((name) => { const n = c().state.settings.site; if (n.lat === lat && n.lon === lon && n.place === place) c().dispatch({ type: 'SITE', patch: { place: name } }); }, () => {});
    }
    const x = c();
    return ok({ settings: publicSettings(x.state.settings), problems: problems(x), ...(alternatives.length ? { alternatives } : {}) });
  },

  async open_model(a, c, end) {
    const files = await modelFiles(a.paths);
    const slot = await exclusive(() => {
      const x = c(), s = x.state, free = [0, 1, 2, 3].find((k) => !s.models.some((m) => m.slot === k));
      const empty = (k: number) => !s.models.find((m) => m.slot === k)?.objects.length && !x.panes[k]?.loading;
      const k = a.model === undefined ? (empty(s.active) ? s.active : free) : LETTERS.indexOf(a.model);
      if (k === undefined) throw new Error('model: four models are open; give model to replace one, or remove_model first');
      if (x.panes[k]?.loading) throw new Error(`model: model ${letter(k)} is loading; wait for it (app_state), or open into another slot`);
      if (!s.models.some((m) => m.slot === k)) {
        if (k !== free) throw new Error(`model: slot ${letter(k)} is not open; replace ${s.models.map((m) => letter(m.slot)).join(', ')}, or add ${letter(free!)} (or leave model out)`);
        flushSync(() => x.dispatch({ type: 'ADD' }));
      }
      opened.set(k, { paths: a.paths, stage: (x.panes[k]?.stage ?? 0) + 1 }); // the counter once this open has loaded
      flushSync(() => void c().onFiles(k, files));
      return k;
    });
    if (!(await done(() => !c().panes[slot]?.loading, end, 'the model to load'))) return ok({ model: letter(slot), status: 'running', note: 'still loading: call app_state until it has loaded (do not open it again)' });
    const x = c(), m = modelOf(x, letter(slot)), p = x.panes[slot], { el } = x.viewer(slot), o = opened.get(slot);
    if (o && o.stage === p?.stage) o.name = m.name;
    if (!m.objects.length) return fail(`paths: ${p?.loadError ?? 'no meshes in this model'}`);
    const top = await el.usd.children('/');
    return ok({
      model: letter(slot), name: m.name, metersPerUnit: el.stage?.metersPerUnit ?? 1, upAxis: el.stage?.upAxis, meshes: roles(m), faces: m.objects.reduce((n, o) => n + o.tris, 0),
      top: top.slice(0, 20).map((t) => t.path), ...(top.length > 20 ? { moreTop: top.length - 20 } : {}), problems: p?.loadError ?? null,
    });
  },

  async remove_model(a, c) {
    return exclusive(() => {
      const x = c(), m = modelOf(x, a.model);
      if (x.state.models.length === 1) throw new Error('model: the last model cannot be removed; open another model into it with open_model');
      if (Object.values(x.panes).some((p) => p.loading)) throw new Error('model: a model is loading; try again once it has loaded (app_state)');
      flushSync(() => x.onRemove(m.slot));
      opened.delete(m.slot);
      return ok({ removed: a.model, models: c().state.models.map((k) => letter(k.slot)), active: letter(c().state.active) });
    });
  },

  async model_tree(a, c) {
    const m = loadedOf(c(), a.model), L = letter(m.slot), { el } = c().viewer(m.slot), limit: number = a.limit ?? 100;
    if (a.query !== undefined) {
      const found = await el.usd.find(...primQuery(a.query), limit + 1);
      return ok({ model: L, query: a.query, prims: found.slice(0, limit), ...(found.length > limit ? { more: true } : {}) });
    }
    const root: string = a.path ?? '/';
    if (root !== '/' && !(await el.usd.prim(root).catch(() => null))) throw new Error(`path: no prim ${root} in model ${L}; list from '/', or search with query`);
    const under = underIndex(m.objects), byId = new Map(m.objects.map((o) => [o.id, o])), names = c().panes[m.slot]?.names, out: object[] = [];
    let level = [root], more = false;
    for (let d = 0; d < (a.depth ?? 2) && level.length && !more; d++) { // level by level: the top of the tree first
      const next: string[] = [];
      for (const p of level) {
        for (const s of await el.usd.children(p)) {
          if (out.length >= limit) { more = true; break; }
          const rows = (under.get(s.path) ?? []).map((id) => byId.get(id)!), first = rows[0]?.role;
          out.push({
            path: s.path, name: names?.get(s.path) ?? s.name, type: s.typeName, children: s.hasChildren,
            ...(rows.length ? { meshes: rows.length, triangles: rows.reduce((n, o) => n + o.tris, 0), role: rows.every((o) => o.role === first) ? first : 'mixed' } : {}),
            visible: s.visible, locked: el.session.isLocked(s.path),
            ...(s.hasVariantSets ? { variants: ((await el.usd.prim(s.path).catch(() => null))?.variantSets ?? []).map((v) => ({ set: v.name, values: v.variants, selected: v.selection })) } : {}),
          });
          if (s.hasChildren) next.push(s.path);
        }
        if (more) break;
      }
      level = next;
    }
    return ok({ model: L, path: root, prims: out, ...(more ? { more: true } : {}) });
  },

  async set_roles(a, c) {
    return exclusive(() => {
      const m = loadedOf(c(), a.model), L = letter(m.slot), ids = idsUnder(a.paths, m.objects), was = new Map(m.objects.map((o) => [o.id, o.role]));
      flushSync(() => c().dispatch({ type: 'ROLE', slot: m.slot, ids, role: a.role }));
      const now = modelOf(c(), L), changed = now.objects.filter((o) => was.get(o.id) !== o.role).map((o) => o.path);
      const hit = new Set(ids), instanced = a.role === 'receiver' ? now.objects.filter((o) => hit.has(o.id) && o.instances).length : 0;
      return ok({
        model: L, meshes: roles(now), changed: changed.slice(0, 50), ...(changed.length > 50 ? { moreChanged: changed.length - 50 } : {}),
        unmatched: (a.paths as string[]).filter((p) => !idsUnder([p], m.objects).length), ...(instanced ? { instanced, note: 'instanced meshes can only shade or be ignored' } : {}),
      });
    });
  },

  async set_visibility(a, c) {
    return exclusive(async () => {
      const m = loadedOf(c(), a.model), L = letter(m.slot), { el } = c().viewer(m.slot), roots = (await el.usd.children('/')).map((s) => s.path);
      const [hide, show, isolate, lock, unlock, select] = await Promise.all(['hide', 'show', 'isolate', 'lock', 'unlock', 'select'].map(async (k) => {
        const out: string[] = []; // '/': every top prim
        for (const [i, p] of ((a[k] ?? []) as string[]).entries()) {
          if (p === '/') out.push(...roots);
          else if (await el.usd.prim(p).catch(() => null)) out.push(p);
          else throw new Error(`${k}[${i}]: no prim ${p} in model ${L}; find it with model_tree`);
        }
        return out;
      }));
      if (a.showAll) await el.usd.showAll();
      if (hide.length) await el.usd.hide(hide);
      for (const p of show) await el.usd.setVisible(p, true);
      if (isolate.length) await el.usd.isolate(isolate);
      for (const p of lock) el.session.setLocked(p, true);
      for (const p of unlock) el.session.setLocked(p, false);
      if (a.select) flushSync(() => el.select(select)); // the viewer's selectionchange -> SELECTION, in this commit
      // hidden: the highest prims with meshes under them that are not shown, as the tree's eyes show them (the drawn objects
      // cannot tell: a hidden instancer's is rebuilt with no instances)
      // ponytail: one children() call per shown prim above a mesh; ask the core for the hidden prims if huge stages make it slow
      const under = underIndex(modelOf(c(), L).objects), hidden: string[] = [];
      for (let level = ['/']; level.length;) {
        const next: string[] = [];
        for (const p of level) {
          for (const s of await el.usd.children(p)) {
            if (!under.has(s.path)) continue; // no mesh at or under it
            if (!s.visible) hidden.push(s.path);
            else if (s.hasChildren) next.push(s.path);
          }
        }
        level = next;
      }
      return ok({ model: L, hidden, locked: [...el.session.locked], selected: [...el.selection] });
    });
  },

  async set_geometry(a, c, end) {
    const m = loadedOf(c(), a.model), slot = m.slot, L = letter(slot), running = { model: L, status: 'running', note: 'still re-reading: call app_state until it has loaded' };
    if (!a.variant && !a.subdivision) throw new Error('variant: give variant or subdivision');
    if (a.variant) {
      const { path, set, value } = a.variant, sets = (await c().viewer(slot).el.usd.prim(path).catch(() => null))?.variantSets, vs = sets?.find((v) => v.name === set);
      if (!sets) throw new Error(`variant.path: no prim ${path} in model ${L}; find it with model_tree`);
      if (!vs) throw new Error(`variant.set: ${path} has no variant set '${set}'${sets.length ? ` (${sets.map((v) => v.name).join(', ')})` : ''}`);
      if (!vs.variants.includes(value)) throw new Error(`variant.value: '${value}' is not in set '${set}' (${vs.variants.join(', ')})`);
      await exclusive(() => flushSync(() => c().onVariant(slot, path, set, value)));
      if (!(await done(() => !c().panes[slot]?.loading, end, 'the re-read'))) return ok(running);
    }
    if (a.subdivision) {
      const { level, paths } = a.subdivision;
      if (paths) {
        if (level === -1) throw new Error("subdivision.level: -1 applies to every model; with paths give 0 to 3 or 'model'");
        const now = modelOf(c(), L), ids = new Set(idsUnder(paths, now.objects)), meshes = now.objects.filter((o) => ids.has(o.id) && !o.instances).map((o) => o.path);
        if (!meshes.length) throw new Error('subdivision.paths: no meshes under them (instanced meshes do not refine)');
        await exclusive(() => flushSync(() => c().onRefine(slot, meshes, level === 'model' ? null : level)));
      } else {
        if (level === 'model') throw new Error("subdivision.level: 'model' needs paths");
        await exclusive(() => flushSync(() => c().onSubdiv(level)));
      }
      if (!(await done(() => !Object.values(c().panes).some((p) => p.loading), end, 'the re-read'))) return ok(running);
    }
    const x = c(), now = modelOf(x, L);
    return ok({ model: L, meshes: roles(now), subdivision: x.ui.subdiv, problems: x.panes[slot]?.loadError ?? null, note: 'results cleared: run' });
  },

  async get_materials(a, c) {
    const x = c(), m = modelOf(x, a.model), o = x.optics[x.state.models.indexOf(m)], { mode, transmission, bounces } = x.state.settings.sim;
    return ok({
      model: letter(m.slot), counts: { tau: mode === 'physical' && transmission, rho: mode === 'physical' && bounces > 0 }, reading: !x.materialsReady,
      rows: [materialRow(DEFAULT_KEY, o.fallback), materialRow(GLASS_KEY, o.glass), ...o.materials.map((r) => materialRow(r.path, r.optics))],
      presets: PRESETS.map(({ name, kind, rho, tau }) => ({ name, kind, rho, tau })),
    });
  },

  async edit_material(a, c) {
    return exclusive(() => {
      const x = c(), m = modelOf(x, a.model), L = letter(m.slot), key: string = a.material;
      const rowOf = (y: Ctl) => { const o = y.optics[y.state.models.findIndex((k) => k.slot === m.slot)]; return key === DEFAULT_KEY ? o.fallback : key === GLASS_KEY ? o.glass : o.materials.find((r) => r.path === key)?.optics; };
      const cur = rowOf(x), o = x.optics[x.state.models.indexOf(m)], values = a.kind !== undefined || a.rho !== undefined || a.tau !== undefined;
      if (!cur) throw new Error(`material: no material ${key} on model ${L}'s receivers or shades; see get_materials`);
      if ([a.reset === true, a.preset !== undefined, values].filter(Boolean).length !== 1) throw new Error('preset: give one of reset, a preset, or kind, rho and/or tau');
      const p = a.preset !== undefined && PRESETS.find((q) => q.name.toLowerCase() === a.preset.toLowerCase());
      if (p === undefined) throw new Error(`preset: no preset '${a.preset}' (${PRESETS.map((q) => q.name).join(', ')})`);
      flushSync(() => x.dispatch(a.reset ? { type: 'OPTICS_RESET', slot: m.slot, key }
        : { type: 'OPTICS_EDIT', slot: m.slot, key, edit: p ? { rho: p.rho, tau: p.tau, kind: p.kind } : editOptics(cur, { kind: a.kind, rho: a.rho, tau: a.tau }, o.fallback, o.glass) }));
      return ok({ model: L, ...materialRow(key, rowOf(c())!) });
    });
  },

  async run(a, c, end) {
    const going = () => { const x = c(); return x.busy() || x.held() || x.state.models.some((m) => inFlight(m.run)); };
    if (a.cancel) {
      if (c().busy()) { c().cancel(); await done(() => !c().busy(), end, 'the cancel'); }
      return ok({ status: c().busy() ? 'cancelling' : 'stopped', models: runLines(c()) });
    }
    const started = await exclusive(() => {
      if (going()) return false; // join the batch on its way
      flushSync(() => void c().onRun());
      return true;
    });
    const refused = started ? Object.entries(c().state.errors).filter(([k]) => k !== 'materials') : []; // materials: held until they are read
    if (refused.length) return fail(JSON.stringify({ status: 'refused', problems: Object.fromEntries(refused), fix: 'update_settings, set_roles or edit_material' }));
    const finished = await done(() => !going(), Math.min(end, Date.now() + 1000 * (a.wait ?? 40)), 'the run');
    return ok({ status: finished ? 'done' : 'running', models: runLines(c()) });
  },

  async results(a, c) {
    const x = c(), s = x.state, named: string[] | undefined = a.models;
    const ms = named ? named.map((l, i) => { const m = modelOf(x, l, `models[${i}]`); if (!m.result) throw new Error(`models[${i}]: model ${l} has no result; run first`); return m; }) : s.models.filter((m) => m.result);
    if (!ms.length) throw new Error('models: no model has a result yet; run first');
    const column: string = a.column ?? x.shown ?? ms[0].result!.columns[0], [q, side] = column.split('_'), lacks = ms.find((m) => !m.result!.columns.includes(column));
    if (lacks) throw new Error(`column: model ${letter(lacks.slot)}'s result has no ${column} (${lacks.result!.columns.join(', ')}); run again`);
    const paths: string[] | undefined = a.paths, by: 'mesh' | 'parts' | 'facing' = a.by ?? (paths ? 'parts' : 'mesh'), th: number[] = a.thresholds ?? [], limit: number = a.limit ?? 50;
    if (by === 'parts' && !paths) throw new Error("paths: by 'parts' takes the prim paths (model_tree)");
    const { lo = null, hi = null } = s.settings.viz.ranges[q] ?? {}, ranged = lo !== null || hi !== null;
    const each = ms.map((m) => ({ m, ...summaries(x, m, column, by, paths, lo, hi, th) }));
    const [ref] = each, refRows = new Map(ref.rows.map((row) => [row.key, row.u])); // the differences: to the first model, row by row
    return ok({
      column, unit: unitFor(column).value, totalUnit: unitFor(column).total, meaning: `${QUANTITY_HELP[q]} ${SIDE_HELP[side]}`, problemRange: { below: lo, above: hi }, by,
      models: each.map(({ m, whole, rows }, j) => ({
        model: letter(m.slot), name: m.name, result: freshness(x, s.models.indexOf(m)),
        whole: { ...quoted(whole, th, ranged), ...(j ? { diff: difference(whole, ref.whole, th, ranged) } : {}) },
        rows: rows.slice(0, limit).map((row) => { const v = j ? refRows.get(row.key) : undefined; return { ...row.head, ...quoted(row.u, th, ranged), ...(v ? { diff: difference(row.u, v, th, ranged) } : {}) }; }),
        ...(rows.length > limit ? { moreRows: rows.length - limit } : {}), run: provenance(m.result!, m.objects),
      })),
    });
  },

  async find_critical(a, c) {
    const x = c(), m = loadedOf(x, a.model), L = letter(m.slot), r = m.result, f = freshness(x, x.state.models.indexOf(m));
    if (!r) throw new Error(`model: model ${L} has no result; run first`);
    if (f !== 'fresh') throw new Error(`model: model ${L}'s result is ${f === 'running' ? 'being replaced by a run on its way; call run to wait for it' : 'stale (inputs changed since it ran); run first'}`);
    const column: string = a.column ?? x.shown!, col = r.columns.indexOf(column), q = column.split('_')[0], range = x.state.settings.viz.ranges[q];
    if (col < 0) throw new Error(`column: not in model ${L}'s result (${r.columns.join(', ')})`);
    const given = a.below !== undefined || a.above !== undefined, below: number | undefined = given ? a.below : range?.lo ?? undefined, above: number | undefined = given ? a.above : range?.hi ?? undefined;
    if (below === undefined && above === undefined) throw new Error(`below: the problem range of ${q} is empty; give below or above (${unitFor(column).value}), or set the range with update_settings viz`);
    const mpu = x.viewer(m.slot).el.stage?.metersPerUnit ?? 1, w = weightsOf(x, r), rows = new Map(m.objects.map((o) => [o.id, o]));
    const meshes = r.receivers.flatMap((id, k) => {
      const o = x.meshOf(id), row = rows.get(id), g = r.manifest.meshes[k];
      return o && row ? [{ id, name: row.name, path: row.path, first: g.first, count: g.count, positions: o.positions, indices: o.indices, w: w[k] }] : [];
    });
    const out = findCritical({ values: r.values, col, column, on: r.on, meshes, north: x.state.settings.sim.north, mpu, below, above, limit: a.limit ?? 8 }), xyz = (v: Vec3) => v.map(cm);
    return ok({
      model: L, column, unit: unitFor(column).value, below: below ?? null, above: above ?? null, problemArea: roundNum(out.problemArea), problemShare: roundPct(out.problemShare),
      groups: out.clusters.map((g) => ({
        mesh: g.path, facing: g.facing, side: g.side, elements: g.elements, area: roundNum(g.area), share: roundPct(g.share), mean: roundNum(g.mean), worst: roundNum(g.worst),
        centre: xyz(g.centroid), box: { min: xyz(g.box.min), max: xyz(g.box.max) }, normal: g.normal.map((v) => Math.round(1000 * v) / 1000), view: g.view, near: roundNum(g.near * mpu),
      })),
    });
  },

  async set_display(a, c) {
    return exclusive(() => {
      const x = c(), ref = x.state.models.find((m) => m.result)?.result;
      if (a.active) modelOf(x, a.active, 'active');
      if (a.column && !ref) throw new Error('column: no result yet; run first');
      if (a.column && !ref!.columns.includes(a.column)) throw new Error(`column: not in the result (${ref!.columns.join(', ')})`);
      if (a.highlight && !(a.highlight[0] < a.highlight[1])) throw new Error('highlight: [lo, hi] with lo < hi');
      const ui = Object.fromEntries(['sunPath', 'split', 'link', 'auto'].filter((k) => a[k] !== undefined).map((k) => [k, a[k]]));
      flushSync(() => {
        if (a.active) x.dispatch({ type: 'ACTIVE', slot: LETTERS.indexOf(a.active) });
        if (a.column) x.dispatch({ type: 'COLUMN', column: ref!.columns.indexOf(a.column) });
        if (a.colourBy) x.dispatch({ type: 'COLOUR_BY', colourBy: a.colourBy });
        if (a.highlight !== undefined) x.dispatch({ type: 'BIN', bin: a.highlight });
        if (a.theme) x.setTheme(a.theme);
        if (a.sunScale !== undefined) x.setSunScale(a.sunScale);
        if (Object.keys(ui).length) x.setUi((u) => ({ ...u, ...ui }));
      });
      return ok(display(c()));
    });
  },

  async set_camera(a, c) {
    return exclusive(() => {
      const x = c(), m = loadedOf(x, a.model), { el } = x.viewer(m.slot);
      if ([a.view, a.camera, a.frame].filter((v) => v !== undefined).length > 1) throw new Error('view: give one of view, camera or frame');
      frameOnly(a);
      let near: number | undefined; // a frame's cutaway, m
      if (a.frame) {
        const f = framed(x, m, a, a.aspect ?? aspectOf(x, m.slot), !!x.shown?.endsWith('_back'));
        el.view = f.view;
        near = roundNum(f.cut * (el.stage?.metersPerUnit ?? 1));
      } else if (a.view) el.view = a.view;
      else if (a.camera !== undefined) {
        const cam = el.cameras.find((k) => k.path === a.camera), saved = x.views.find((v) => v.name === a.camera);
        if (!cam && !saved) throw new Error(`camera: no stage camera or saved view '${a.camera}' (cameras: ${el.cameras.map((k) => k.path).join(', ') || 'none'}; saved views: ${x.views.map((v) => v.name).join(', ') || 'none'})`);
        el.view = cam ? stageView(el.three.root, cam) : saved!.view;
      } else el.frame(); // the whole model, as Views > Whole model
      // linked cameras follow per drawn frame, and a hidden tab draws none: every view takes it now
      if (x.ui.link) for (const k of loadedSlots(x)) if (k !== m.slot) x.viewer(k).el.view = el.view;
      return ok({ ...viewOf(x, m.slot), ...(near !== undefined ? { near } : {}) });
    });
  },

  async save_view(a, c) {
    return exclusive(() => {
      const x = c(), name = a.name.trim(), names = () => c().views.map((v) => v.name);
      if (!name) throw new Error('name: not blank');
      if (a.remove) {
        if (!x.views.some((v) => v.name === name)) throw new Error(`name: no saved view '${name}' (${names().join(', ') || 'none saved'})`);
        flushSync(() => x.setViews((l) => l.filter((v) => v.name !== name)));
        return ok({ removed: name, views: names() });
      }
      const m = loadedOf(x, a.model), view = x.viewer(m.slot).el.view; // a name taken: that view now shows this camera
      flushSync(() => x.setViews((l) => (l.some((v) => v.name === name) ? l.map((v) => (v.name === name ? { ...v, view } : v)) : [...l, { id: crypto.randomUUID(), name, view }])));
      return ok({ saved: { name, model: letter(m.slot), view }, views: names() });
    });
  },

  async screenshot(a, c) {
    const W: number = a.width ?? 1280, H: number = a.height ?? 800, size = shotSize(W, H);
    if (a.view && a.frame) throw new Error('view: give view or frame, not both');
    frameOnly(a);
    return exclusive(async () => {
      const x = c(), ms = ((a.models ?? [letter(x.state.active)]) as string[]).map((l, i) => loadedOf(x, l, a.models ? `models[${i}]` : 'models')), ref = x.state.models.find((m) => m.result)?.result;
      if (a.column && !ref?.columns.includes(a.column)) throw new Error(`column: ${ref ? `not in the results (${ref.columns.join(', ')})` : 'no result yet; run first'}`);
      // the shot's own column, colouring, sun path and grid, restored after it
      return staged(c, ms.map((m) => m.slot), { column: a.column, colourBy: a.colourBy, sunPath: a.sunPath, grid: a.grid }, async () => {
        const y = c(), sc = y.scale, north = y.state.settings.sim.north, out: CallToolResult['content'] = [];
        for (const m of ms) {
          const { el } = y.viewer(m.slot), mpu = el.stage?.metersPerUnit ?? 1, L = letter(m.slot);
          const fr = a.frame ? framed(y, m, a, size.width / size.height, !!y.shown?.endsWith('_back')) : null, view = a.view ?? fr?.view ?? el.view;
          const shot = await capture(el, { width: size.width, height: size.height, view, near: a.near === undefined ? undefined : a.near / mpu, type: 'image/jpeg', quality: 0.85 })
            .catch((e: Error) => { throw new Error(e.message.replace(/less than (\S+) here$/, (_, v: string) => `less than ${fmtNum(Number(v) * mpu)} m here`)); }); // near's limit: stage units -> m
          // the reply's base64 within budget: a lower JPEG quality first, then fewer pixels (from the first JPEG)
          let data = await b64(shot), q = 0.85, w = size.width, h = size.height;
          const bmp = data.length > MAX_B64 / ms.length ? await createImageBitmap(shot) : null;
          while (bmp && data.length > MAX_B64 / ms.length && w > 16 && h > 16) {
            if (q > 0.5) q -= 0.15;
            else [w, h] = [Math.max(16, Math.round(0.75 * w)), Math.max(16, Math.round(0.75 * h))];
            const cv = new OffscreenCanvas(w, h);
            cv.getContext('2d')!.drawImage(bmp, 0, 0, w, h);
            data = await b64(await cv.convertToBlob({ type: 'image/jpeg', quality: q }));
          }
          bmp?.close();
          const value = y.state.colourBy === 'value' && !!sc && !!y.shown && !!m.result?.columns.includes(y.shown), unit = y.shown ? unitFor(y.shown).value : '';
          const colours = !value ? "the model's own (plain view)"
            : `${y.shown} in ${unit}, ${sc!.gradient.label} from ${fmtNum(sc!.vmin)} (low) to ${fmtNum(sc!.vmax)} (high)${sc!.lo !== null ? `; under ${fmtNum(sc!.lo)} ${sc!.below}` : ''}${sc!.hi !== null ? `; over ${fmtNum(sc!.hi)} ${sc!.above}` : ''}; meshes without a value plain grey`;
          out.push({ type: 'image', data, mimeType: 'image/jpeg' }, {
            type: 'text',
            text: `Model ${L} (${m.name}): ${w} x ${h} px${w !== W || h !== H ? ` (${W} x ${H} asked; images come at most ${LONG} px on the long side${size.reshaped ? ' and at least 16 px on the short one, so the aspect differs' : ''}${w !== size.width ? ', fewer to keep the reply under 800 KB' : ''})` : ''}, JPEG quality ${q.toFixed(2)}. Camera: ${describeView(view, north, mpu)}; ${fmtNum(reach(view, mpu))} m away${a.near !== undefined ? `; geometry nearer than ${fmtNum(a.near)} m cut away` : fr ? `; near ${roundNum(fr.cut * mpu)} would cut away what stands in front of the frame` : ''}. Colours: ${colours}.`,
          });
        }
        return { content: out };
      });
    });
  },

  async download_result(a, c, end) {
    return exclusive(async () => {
      const x = c(), m = loadedOf(x, a.model), L = letter(m.slot), mode: ExportMode = a.mode ?? 'replace';
      if (!m.result) throw new Error(`model: model ${L} has no result; run first`);
      if (!x.shown || !m.result.columns.includes(x.shown)) throw new Error(`model: model ${L}'s result has no ${x.shown} column; run it again`);
      flushSync(() => x.dispatch({ type: 'ACTIVE', slot: m.slot })); // the Download menu acts on the active model
      flushSync(() => void c().onDownload(a.format, mode));
      if (!(await done(() => !c().exporting, end, 'the download'))) return ok({ model: L, status: 'running', note: 'still writing the file' });
      const e = c().exportError;
      if (e && e.result === m.result) return fail(`download failed: ${e.message}`);
      return ok({
        model: L, format: a.format, ...(a.format.startsWith('usd') ? { mode } : {}), column: x.shown, saved: "the browser's downloads folder",
        note: "several downloads from a background tab can trigger the browser's 'automatic downloads' prompt, after which it blocks them",
      });
    });
  },

  async get_report(a, c) {
    const e = await storedReport(a.id), problems = readiness(e.spec, appView(c()), c().generation(a.id).generating);
    const { ranges: _r, blocks, ...spec } = e.spec; // the spec as save_report takes it: what the save adds left out
    return ok({ spec: { ...spec, blocks: blocks.map((b) => (b.type === 'chart' ? { type: b.type, chart: b.chart, caption: b.caption } : b)) }, pdf: e.pdf, ready: !problems.length, problems });
  },

  async save_report(a, c) {
    return exclusive(async () => {
      const d = validateSpec(a.spec, appView(c()));
      if (Array.isArray(d)) return fail(`spec: ${d.length} problem${d.length > 1 ? 's' : ''}; fix ${d.length > 1 ? 'them' : 'it'} and save again:\n${d.join('\n')}`);
      const old = (await storedReports()).find((e) => e.id === d.id)?.spec, since: unknown = a.updated ?? a.spec.updated; // get_report's spec carries its updated
      if (old && since !== old.updated) {
        throw new Error(since === undefined ? `updated: report ${d.id} exists (updated ${old.updated}); to replace it, call get_report, merge, and save with its updated, or save under another id`
          : `updated: report ${d.id} changed in the app since (${since}), last at ${old.updated}: call get_report, merge, and save again`);
      }
      if (!old && a.updated !== undefined) throw new Error(`updated: there is no report ${d.id} to replace; leave updated out to create it`);
      const r = await putReport(d, old);
      await c().refreshReports();
      const problems = readiness(r, appView(c()), c().generation(r.id).generating);
      return ok({ id: r.id, updated: r.updated, ready: !problems.length, problems });
    });
  },

  async delete_report(a, c) {
    if (c().generation(a.id).generating) return fail(`id: a PDF of ${a.id} is being generated; call generate_report until it answers, then delete`);
    const r = await fetch(`/reports/${a.id}`, { method: 'DELETE' }).catch(() => null);
    if (r?.status === 404) return fail(`id: no report ${a.id}`);
    if (r?.status === 409) return fail('the PDF is open in another program: close it and delete again');
    if (!r?.ok) return fail(`id: not deleted (${r ? await said(r) : 'the server cannot be reached'})`);
    changed(a.id);
    await c().refreshReports();
    return ok({ deleted: a.id, reports: (c().reports ?? []).map((e) => e.id) });
  },

  async generate_report(a, c, end) {
    // a call after 'generating': that generation's PDF or error once it has ended (unless the report was saved since)
    const kept = waiting.delete(a.id) && !c().generation(a.id).generating ? outcome(a.id) : undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pdf = kept ? Promise.resolve('pdf' in kept ? { p: kept.pdf } : { e: new Error(kept.error) })
      : c().generate(a.id).then((p) => ({ p }), (e: Error) => ({ e })); // a second call meanwhile gets the same generation
    const r = await Promise.race([pdf, new Promise<null>((done) => { timer = setTimeout(done, Math.max(0, Math.min(40e3, end - Date.now())), null); })]);
    clearTimeout(timer);
    if (!r) {
      waiting.add(a.id);
      return ok({ id: a.id, status: 'generating', note: 'call generate_report again for the result' });
    }
    if ('e' in r) return fail(/^(?:id|blocks\[\d+\]): /.test(r.e.message) ? r.e.message : `${a.id}: ${r.e.message}`); // a field it names, else the report
    return ok({ id: a.id, ...r.p });
  },
};

// ---------------------------------------------------------------------------------------------- the hidden instance's session
/** What the hidden instance did, for a UI tab to pick up: its settings (serializeSettings; `epw`: the path of a weather
 *  file opened by path), its subdivision level (a view preference of its own browser profile that shapes the meshes run),
 *  its state-changing calls in order, and whether a model had a result (or a run on its way). */
interface Session { settings: string; subdiv: number; epw?: string; steps: { name: string; arguments: Args }[]; ran: boolean }
const STEPS = new Set(['open_model', 'remove_model', 'set_roles', 'set_geometry', 'edit_material', 'set_visibility', 'set_display', 'set_camera', 'save_view']);
const steps: Session['steps'] = [];
const textOf = (r: CallToolResult) => r.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join(' ');

/** The hidden instance, after a call that changed something: a step kept so that it replays alike (the model it acted on
 *  named, as the active one may differ then; set_camera as the view it gave, as a frame fits this page's view and the
 *  app's has another shape), and the session sent (PUT /session) before the reply. */
async function record(name: string, args: Args, res: CallToolResult, active: number, c: () => Ctl): Promise<void> {
  const tool = TOOLS.find((t) => t.name === name);
  if (res.isError || !tool || tool.annotations?.readOnlyHint) return;
  if (STEPS.has(name)) {
    const reply = JSON.parse(textOf(res)) as { model?: string; view?: unknown };
    const model: string | undefined = name === 'open_model' ? reply.model : args.model ?? (tool.inputSchema.properties?.model ? letter(active) : undefined);
    steps.push({ name, arguments: { ...(name === 'set_camera' ? { view: reply.view } : args), ...(model ? { model } : {}) } });
  }
  const s = c().state, w = s.settings.weather, epw = w.source === 'upload' && w.file ? pathOf.get(w.file) : undefined;
  const session: Session = { settings: serializeSettings(s.settings), subdiv: c().ui.subdiv, ...(epw ? { epw } : {}), steps, ran: s.models.some((m) => m.result || inFlight(m.run)) };
  await fetch('/session', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(session) }).catch(() => {});
}

/**
 * A UI tab, as its bridge starts: the hidden instance's session (GET /session), if there is one, done again here: its
 * settings and subdivision level, its steps through the same handlers (a failure skipped and noted), a run when it had
 * results, and after that the column, colouring and highlight its set_display steps gave (a run resets them; without a
 * result the colouring alone). Then DELETE /session, also when there was none: it ends the hidden instance (one that only
 * answered questions leaves no session). Calls wait for it (gate): the next one sees the picked-up app, and its reply
 * says so.
 */
function pickup(c: () => Ctl): void {
  gate = gate.then(async () => {
    const r = await fetch('/session').catch(() => null);
    if (!r || r.status === 403 || r.headers.get('Content-Type')?.startsWith('text/html')) return; // no agent routes here: a LAN tab, mock mode, a static host
    try {
      if (!r.ok || !isJson(r)) return;
      const rec = (await r.json()) as Session, p = parseSettings(rec.settings), failed: string[] = [], shown: Args = {};
      const loaded = () => done(() => !Object.values(c().panes).some((q) => q.loading), Date.now() + 120e3, 'the models');
      const step = async (name: string, args: Args) => {
        const res = await invoke(name, args, c, Date.now() + BUDGET);
        if (res.isError) failed.push(`${name}: ${textOf(res)}`);
        await loaded(); // a load that answered running
      };
      const file = rec.epw ? await epwFile(rec.epw).catch((e: Error) => { failed.push(e.message); return null; }) : null;
      flushSync(() => {
        const d = c().dispatch;
        d({ type: 'SITE', patch: p.site });
        d({ type: 'WEATHER', patch: { ...p.weather, file } }); // after SITE, which picks the station nearest the site
        d({ type: 'TIME', patch: p.time });
        d(simMode(p.sim.mode));
        d({ type: 'SIM', patch: p.sim });
        for (const quantity of QUANTITIES) {
          const g = p.viz.gradients[quantity], sc = p.viz.scales[quantity], rg = p.viz.ranges[quantity];
          d({ type: 'VIZ_RESET', quantity, what: 'scale' });
          d({ type: 'VIZ_RESET', quantity, what: 'range' });
          d({ type: 'VIZ', quantity, patch: { ...(g ? { gradient: g } : {}), min: sc?.min ?? null, max: sc?.max ?? null, lo: rg?.lo ?? null, hi: rg?.hi ?? null, below: p.viz.colors.below, above: p.viz.colors.above } });
        }
        for (const ch of c().state.settings.charts) if (!p.charts.some((k) => k.id === ch.id)) d({ type: 'CHART', id: ch.id, remove: true });
        for (const spec of p.charts) d({ type: 'CHART', spec });
      });
      if (rec.subdiv !== undefined && rec.subdiv !== c().ui.subdiv) { // before the models open: they are read at it
        flushSync(() => c().onSubdiv(rec.subdiv));
        await loaded();
      }
      for (const { name, arguments: args } of rec.steps) {
        if (name !== 'set_display') { await step(name, args); continue; }
        const { column, colourBy, highlight, ...rest } = args;
        Object.assign(shown, Object.fromEntries(Object.entries({ column, colourBy, highlight }).filter(([, v]) => v !== undefined)));
        if (Object.keys(rest).length) await step(name, rest);
      }
      if (rec.ran) await step('run', {});
      else { delete shown.column; delete shown.highlight; } // no result to show them on, as in the hidden instance
      if (Object.keys(shown).length) await step('set_display', shown);
      note = `Now in the app open in the user's browser; picked up ${rec.steps.length} steps (failures: ${failed.join('; ') || 'none'}). `;
    } finally {
      await fetch('/session', { method: 'DELETE' }).catch(() => {});
    }
  }).catch(() => {});
}
