// App state: types, reducer (the models by slot, the shared settings), the run batch, settings persistence (pure; the
// App does the localStorage I/O).
import type { RemoteManifest } from 'daylight-mesh';
import { BUILT_IN, FIELDS, putChart, type ChartSpec } from './lib/charts';
import type { EpwMonthly } from './lib/epw';
import { nearestStations } from './lib/geo';
import { DEFAULT_ABOVE, DEFAULT_BELOW, SCALINGS, gradientDef, type GradientDef, type Scaling } from './lib/gradients';
import type { OpticsEdit } from './lib/optics';
import type { Topology } from './lib/topology';
import { idsUnder } from './lib/tree';

export type Role = 'receiver' | 'shade' | 'none';
/**
 * A mesh of the stage: its prim path, its drawn triangles and vertices; `shade` false: a receiver that is measured but
 * casts no shade (the core's --no-occlude; absent: it casts shade while receivers block rays); `group`: in the view
 * analysis, a shade (an obstruction) whose rays count for this target group (views --target); `instances`: one mesh
 * drawn that many times; `paths`: every copy's prim path where each copy is its own prim (native instancing), so a click
 * on any finds the row; `materials[k]`: the viewer's material rid of optics slot k (0 = none).
 */
export interface ObjectRow { id: string; name: string; path: string; tris: number; verts: number; role: Role; shade?: false; group?: string; instances?: number; paths?: string[]; materials?: number[] }

/** The two analyses of the same models: daylight, and the view analysis (the core's views tool). */
export type Tab = 'daylight' | 'views';

export type Quantity = 'radiation' | 'direct' | 'diffuse' | 'irradiance' | 'illuminance' | 'sunhours';
export const QUANTITIES: Quantity[] = ['radiation', 'direct', 'diffuse', 'irradiance', 'illuminance', 'sunhours'];
export type SimMode = 'physical' | 'ladybug';
export const quantitiesFor = (mode: SimMode): Quantity[] => (mode === 'ladybug' ? QUANTITIES.filter((q) => q !== 'illuminance') : QUANTITIES);

export interface Station { title: string; href: string; lat: number; lon: number; km?: number }
export interface EpwMeta { lat: number; lon: number; tz: number; name: string; leap: boolean; monthly?: EpwMonthly }
export type WeatherSource = 'upload' | 'station' | 'pvgis' | 'clear-sky';
export interface TimePoint { date: string; hour: number } // 'YYYY-MM-DD', minutes of day (0..1440)

export interface Settings {
  site: { lat: number; lon: number; place: string }; // the time zone always comes from the place (lib/zone.ts)
  weather: { source: WeatherSource; file: File | null; station: Station | null; turbidity: number; altitude: number };
  epwMeta: EpwMeta | null; // header of the EPW the run will use; null until fetched / after the reference changed
  time: { mode: 'annual' | 'instant' | 'range'; date: string; hour: number; from: TimePoint; to: TimePoint; stepMin: number };
  sim: {
    mode: SimMode; quantities: Quantity[]; sides: 'front' | 'back' | 'both'; on: 'faces' | 'vertices';
    cullBackfaces: boolean; selfOcclude: boolean; skyDensity: 1 | 2 | 4; patchSamples: number; ground: number; north: number; offset: number;
    transmission: boolean; fresnel: boolean; // light through glass / porous materials; glass by angle (Radiance glass)
    bounces: number; bounceSamples: number; // reflected light: diffuse reflections 0..20 (0 = off), paths per sensor 64..65536
  };
  // Result colouring per quantity: gradient key, legend domain (null = data range), how the values spread along the
  // gradient (absent: the quantity's default), the problem range (null = open), and the two range colours (hex, shared
  // by every quantity). `library`: the gradients the user made or changed, by key (a preset's key: that preset as
  // changed), shared by every quantity and both analyses.
  viz: {
    gradients: Record<string, string>; scales: Record<string, { min: number | null; max: number | null }>; ranges: Record<string, { lo: number | null; hi: number | null }>;
    colors: { below: string; above: string };
    scalings: Record<string, Scaling>; library: Record<string, GradientDef>;
  };
  charts: ChartSpec[]; // the Results charts in drawing order: the two built-ins (their look), then extras
  viewSim: ViewSim; // the view analysis' settings (its own; north is the site's, sim.north)
}

/**
 * The view analysis' settings, as the core's views flags (docs/views.md): the field `fov` [H, LO, HI] (H 360: all
 * around; LO = HI = 0: horizontal rays, the 2D isovist), `cell` degrees per ray, the eye `offset` along the normal (m),
 * `far` (what open counts as, m), the virtual ground (at `groundZ`, null: the lowest point), `reach` ('' none,
 * 'en17037', or metres 'D,D,...'), whether rays pass glass (`transmission`), and the receivers' blocking.
 */
export interface ViewSim {
  fov: [number, number, number]; cell: number; sides: 'front' | 'back' | 'both'; on: 'faces' | 'vertices'; offset: number; far: number;
  virtualGround: boolean; groundZ: number | null; reach: string; transmission: boolean; cullBackfaces: boolean; selfOcclude: boolean;
}

/** The element under the cursor: object id, element index within the mesh's rows, its value in the current column. */
export interface Probe { id: string; element: number; value: number }

/**
 * A finished run: one float32 column per quantity and side, `data[c][row]` for `columns[c]` (the rows of receiver k
 * from `manifest.meshes[k].first`), and `weights[row]`, that element's area in m² (a face's, or a vertex's share of its
 * faces'): one array per column and one for the weights, never an object per row (a 17M-triangle model has 17M rows).
 */
export interface RunResult {
  data: Float32Array[]; weights: Float32Array; columns: string[]; cache?: Record<string, string>;
  // the job's JSON, with the server's run timing in ms (C4; totalMs = run_s) when it reports one
  manifest: RemoteManifest & { timing?: { prepMs: number; skyMs: number; buildMs: number; traceMs: number; reduceMs: number; bounceMs: number; totalMs: number } };
  receivers: string[]; // object ids in sensor order: manifest.meshes[i] <-> receivers[i]
  /** Per receiver, what its rows are: the file's own faces and points behind the drawn triangles (lib/topology.ts), or
   *  null / absent: the drawn triangles and vertices themselves. */
  forms?: (Topology | null)[];
  on: 'faces' | 'vertices'; // element kind the rows describe (weights: face areas or vertex areas)
  key: string; // the run key (args, weather, mesh ids) it was computed for: differs from the current one = stale
  elapsed: number; // s, click to result (the round trip the user waits for)
  switches?: string; // the optics switches it ran with, in words (lib/optics.ts runSwitches); '' = the defaults
}
/** A run's seconds on the GPU (building the scene, tracing, bounces) by the server's timing; undefined without one. */
export const gpuSeconds = (r: RunResult) => { const t = r.manifest.timing; return t && (t.buildMs + t.traceMs + t.bounceMs) / 1000; };
// running: the share done (0..1) and the seconds to go, once the server reports them
// queued: its meshes uploading (meshes done of total) before the job is made; running: the share done (0..1) and the
// seconds to go, once the server reports them
export type Run = { status: 'idle' } | { status: 'queued'; position: number; upload?: [number, number] } | { status: 'running'; progress?: number; eta_s?: number } | { status: 'error'; message: string } | { status: 'done'; result: RunResult };

/** The viewer's selection: prim paths (any prim: a parent stands for every mesh below it), the active one, who made it. */
export interface Selection { paths: string[]; active: string | null; source: string }
const NO_SELECTION: Selection = { paths: [], active: null, source: 'api' };
const NO_BINS: readonly [number, number][] = []; // one empty selection: clearing an empty one changes nothing

/** A model in a pane: `slot` 0..3 = A..D (its letter, its chart colour, its viewer), fixed for its life. */
export interface Model {
  slot: number;
  name: string; // the open file's stem; '' until one is open
  objects: ObjectRow[];
  selection: Selection;
  selected: Set<string>; // the rows at or under the selection: what the role buttons apply to
  run: Run;
  result: RunResult | null; // the last finished run: stays on screen while the next one is queued, running or failed
  error: string | null; // why the last run failed: kept while the next one runs, so the alert does not blink between Auto runs
  optics: Record<string, OpticsEdit>; // Materials-table edits (lib/optics.ts keys): kept across re-reads, cleared per model; both analyses'
  viewAnalysis: ViewSlice; // the view analysis' own rows (the same rows, its roles), run, result and error
}
/** The view analysis' part of a model: `objects` are the model's rows (same ids, paths and meshes) with its own roles. */
export interface ViewSlice { objects: ObjectRow[]; run: Run; result: RunResult | null; error: string | null }

export interface State {
  models: Model[]; // 1..4, in slot order
  active: number; // the slot the Model and Materials panels, Views and Download act on
  hovered: string | null; // row ids are unique across models
  probe: Probe | null; // element under the cursor in a view
  bin: [number, number] | null; // hovered histogram bin [lo, hi): the views fade everything else
  bins: readonly [number, number][]; // the selected histogram bars as value ranges [lo, hi), neighbours merged: kept bright as the hovered one
  settings: Settings; stations: Station[] | null;
  // the result column shown, by name ('': the first): it stays through new runs, changed roles and new target groups,
  // which move the columns (lib/result columnIndex finds it in a result)
  column: string;
  colourBy: 'plain' | 'value';
  errors: Record<string, string>; // validate() output keyed by field id
  viewAnalysis: { column: string; colourBy: 'plain' | 'value'; errors: Record<string, string> }; // the view analysis' own
}

/** Tagged `tab: 'views'`, an action of one analysis (ROLE, SHADE, RUN, COLUMN, COLOUR_BY, ERRORS) acts on the view
 *  analysis; untagged on daylight, as always (the agent tools never tag). */
type OfTab = { tab?: 'views' };
export const TAGGED: ReadonlySet<string> = new Set(['ROLE', 'SHADE', 'RUN', 'COLUMN', 'COLOUR_BY', 'ERRORS']);
export type Action =
  | { type: 'LOAD'; slot: number; objects: ObjectRow[]; name?: string }
  | { type: 'RELOAD'; slot: number; objects: ObjectRow[] } // the same stage re-read (a variant switch): the selection and each path's no-shade flag stay; the view roles by path
  | ({ type: 'ROLE'; slot: number; ids: string[]; role: Role; group?: string } & OfTab) // a row whose role changes casts shade as its new role does; group: a shade's target group (views)
  | ({ type: 'SHADE'; slot: number; ids: string[]; shade: boolean } & OfTab) // whether the receivers among them cast shade
  | { type: 'SELECT'; slot: number; ids: string[]; additive?: boolean } // rows (the results table): the viewer selects their prims
  | ({ type: 'SELECTION'; slot: number } & Selection) // the viewer's selection changed
  | { type: 'ADD' } // a model to compare, in the lowest free slot, made active
  | { type: 'REMOVE'; slot: number } // never the last one
  | { type: 'ACTIVE'; slot: number }
  | { type: 'HOVER'; id: string | null }
  | { type: 'SITE'; patch: Partial<Settings['site']> }
  | { type: 'WEATHER'; patch: Partial<Settings['weather']> }
  | { type: 'EPW_META'; meta: EpwMeta | null }
  | { type: 'TIME'; patch: Partial<Settings['time']> }
  | { type: 'SIM'; patch: Partial<Settings['sim']> }
  | { type: 'STATIONS'; stations: Station[] }
  | { type: 'VIEW_SIM'; patch: Partial<ViewSim> }
  | { type: 'RESET'; what: SettingsSection } // a settings section's fields back to their defaults
  | ({ type: 'RUN'; slot: number; run: Run } & OfTab)
  | ({ type: 'COLUMN'; column: string } & OfTab)
  | ({ type: 'COLOUR_BY'; colourBy: 'plain' | 'value' } & OfTab)
  | { type: 'PROBE'; probe: Probe | null }
  | { type: 'BIN'; bin: [number, number] | null }
  | { type: 'BINS'; bins: readonly [number, number][] } // the selected bars' ranges ([]: none)
  | { type: 'VIZ'; quantity: string; patch: { gradient?: string; min?: number | null; max?: number | null; lo?: number | null; hi?: number | null; below?: string; above?: string; scaling?: Scaling } }
  | { type: 'GRADIENT'; key: string; gradient: GradientDef | null } // the library: put (a new one, or a preset as changed); null: gone (a preset: back as built in)
  | { type: 'VIZ_RESET'; quantity: string; what: 'scale' | 'range' }
  | ({ type: 'CHART' } & ({ spec: ChartSpec } | { id: string; remove: true } | { id: string; reset: true })) // put in place by id, removed (an extra), its look back to the kind's
  | ({ type: 'ERRORS'; errors: Record<string, string> } & OfTab)
  | { type: 'OPTICS_EDIT'; slot: number; key: string; edit: OpticsEdit } // a material by prim path, or a default row
  | { type: 'OPTICS_RESET'; slot: number; key: string }; // back to the derived (or default) values

const year = new Date().getFullYear();
const solstice = `${year}-06-21`;
export const defaultSettings = (): Settings => ({
  site: { lat: 51.5074, lon: -0.1278, place: 'London, United Kingdom' },
  weather: { source: 'station', file: null, station: null, turbidity: 3, altitude: 0 },
  epwMeta: null,
  time: { mode: 'annual', date: solstice, hour: 720, from: { date: solstice, hour: 480 }, to: { date: solstice, hour: 1080 }, stepMin: 60 },
  sim: { mode: 'physical', quantities: QUANTITIES, sides: 'front', on: 'faces', cullBackfaces: false, selfOcclude: true, skyDensity: 1, patchSamples: 1, ground: 0.2, north: 0, offset: 0, transmission: false, fresnel: true, bounces: 0, bounceSamples: 1024 },
  viz: { gradients: {}, scales: {}, ranges: {}, colors: { below: DEFAULT_BELOW, above: DEFAULT_ABOVE }, scalings: {}, library: {} },
  charts: BUILT_IN.map((c) => ({ ...c })),
  viewSim: { fov: [120, -70, 50], cell: 2, sides: 'front', on: 'faces', offset: 0, far: 1000, virtualGround: true, groundZ: null, reach: '', transmission: false, cullBackfaces: false, selfOcclude: true },
});

/** The View settings sections' fields: what each section's reset puts back. */
const VIEW_SECTIONS = {
  'view-field': ['fov', 'cell'], 'view-eye': ['sides', 'on', 'offset'], 'view-distance': ['far', 'reach'],
  'view-ground': ['virtualGround', 'groundZ', 'transmission', 'cullBackfaces', 'selfOcclude'],
} as const satisfies Record<string, readonly (keyof ViewSim)[]>;
/** The settings sections a reset acts on: Simulation (all but north, the Location's), Time, and each View settings one. */
export type SettingsSection = 'sim' | 'time' | keyof typeof VIEW_SECTIONS;

const IDLE: Run = { status: 'idle' };
const model = (slot: number): Model => ({ slot, name: '', objects: [], selection: NO_SELECTION, selected: new Set(), run: IDLE, result: null, error: null, optics: {}, viewAnalysis: { objects: [], run: IDLE, result: null, error: null } });

export const initialState = (settings = defaultSettings()): State => ({
  models: [model(0)], active: 0, hovered: null, probe: null, bin: null, bins: NO_BINS, settings, stations: null, column: '', colourBy: 'plain', errors: {},
  viewAnalysis: { column: '', colourBy: 'plain', errors: {} },
});

// The view analysis seen as daylight is: its rows, run, result and error (per model) and its column, colouring and errors
// in daylight's fields, and daylight's in viewAnalysis. Each its own inverse, cached both ways (swap(swap(x)) === x), so
// the models an action leaves alone keep their identity and the views tab's memos hold across hovers.
const swappedModel = new WeakMap<Model, Model>(), swappedState = new WeakMap<State, State>();
export function swapModel(m: Model): Model {
  let t = swappedModel.get(m);
  if (!t) {
    const { objects, run, result, error, viewAnalysis: v } = m;
    t = { ...m, objects: v.objects, run: v.run, result: v.result, error: v.error, viewAnalysis: { objects, run, result, error } };
    swappedModel.set(m, t).set(t, m);
  }
  return t;
}
export function swapState(s: State): State {
  let t = swappedState.get(s);
  if (!t) {
    const { column, colourBy, errors, viewAnalysis: v } = s;
    t = { ...s, models: s.models.map(swapModel), column: v.column, colourBy: v.colourBy, errors: v.errors, viewAnalysis: { column, colourBy, errors } };
    swappedState.set(s, t).set(t, s);
  }
  return t;
}
/** A target group (views --target GROUP): letters, digits, _ and -. */
export const GROUP = /^[A-Za-z0-9_-]{1,64}$/;
/** Row `o` with the view role `role` from the row it had (by path), if any: its no-shade flag (a receiver) or group (a shade). */
const viewRole = (o: ObjectRow, role: Role, was?: ObjectRow): ObjectRow => {
  const { shade: _s, group: _g, ...rest } = o;
  return { ...rest, role, ...(role === 'receiver' && was?.shade === false ? { shade: false as const } : {}), ...(role === 'shade' && was?.group ? { group: was.group } : {}) };
};

// A job still on its way when the model or the roles change keeps its status (the button stays busy until it ends);
// its result is then dropped at RUN done, because its receivers are gone.
export const inFlight = (r: Run) => r.status === 'queued' || r.status === 'running';
const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((q) => b.includes(q as Quantity));
/** f over the model in `slot`: the same state when there is none (a load or a job that outlived its model) or f keeps it. */
const put = (s: State, slot: number, f: (m: Model) => Model): State => {
  const models = s.models.map((m) => (m.slot === slot ? f(m) : m));
  return models.every((m, i) => m === s.models[i]) ? s : { ...s, models };
};
/** A model still shows a result: the shared colouring stays; else it starts over, as for one model. (The shown column
 *  is a name and always stays.) */
const kept = (models: readonly Model[]) => models.some((m) => m.result);
/** Row `o` casting shade (no flag), or not. */
const shading = (o: ObjectRow, shade: boolean): ObjectRow => { const { shade: _was, ...rest } = o; return shade ? rest : { ...rest, shade: false }; };
const only = (c: ChartSpec, keep: (k: string) => boolean) => Object.fromEntries(Object.entries(c).filter(([k]) => keep(k))) as ChartSpec;
const lookOf = (c: ChartSpec): readonly string[] => FIELDS[c.kind];
/** putChart, where a refusal leaves the list as it is (the agent's tool reports it; stored junk is dropped). */
const put1 = (charts: ChartSpec[], raw: unknown): ChartSpec[] => { const r = putChart(charts, raw); return typeof r === 'string' ? charts : r; };

/**
 * Models' jobs one after another (one in flight per tab; the server allows two per client): before each, a cancel or a
 * model changed since the click (`ready` false: re-read, re-assigned or removed) ends it unrun; a failure is that model's
 * alone, and ends idle when its model changed meanwhile. A success is the job's own dispatch.
 */
export async function runBatch(jobs: readonly { slot: number; ready: () => boolean; run: (signal: AbortSignal) => Promise<void> }[], signal: AbortSignal, settle: (slot: number, end: 'idle' | Error) => void): Promise<void> {
  for (const j of jobs) {
    if (signal.aborted || !j.ready()) { settle(j.slot, 'idle'); continue; }
    try { await j.run(signal); } catch (e) { settle(j.slot, signal.aborted || !j.ready() ? 'idle' : (e as Error)); }
  }
}

/** A model still shows a view analysis result. */
const keptViews = (models: readonly Model[]) => models.some((m) => m.viewAnalysis.result);
/** The view analysis' colouring starts over when no model shows one of its results. */
const viewsKept = (s: State): State => (keptViews(s.models) ? s : { ...s, viewAnalysis: { ...s.viewAnalysis, colourBy: 'plain' } });

export function reducer(s: State, a: Action): State {
  if ('tab' in a && a.tab === 'views') { // the view analysis' action: daylight's rules on its slice; nothing changed = the same state
    const t = swapState(s), n = analysis(t, a);
    return n === t ? s : swapState(n);
  }
  return analysis(s, a);
}

function analysis(s: State, a: Action): State {
  switch (a.type) {
    case 'LOAD': { // both analyses take the rows (the same ids and default roles); a job on its way keeps its status
      const n = put(s, a.slot, (m) => ({
        ...model(m.slot), name: a.name ?? '', objects: a.objects, run: inFlight(m.run) ? m.run : IDLE,
        viewAnalysis: { objects: a.objects, run: inFlight(m.viewAnalysis.run) ? m.viewAnalysis.run : IDLE, result: null, error: null },
      }));
      return n === s ? s : viewsKept({ ...n, hovered: null, ...(kept(n.models) ? {} : { colourBy: 'plain' as const }) });
    }
    case 'ROLE': { // instanced rows draw one mesh many times: Shade or Ignore only (rows and colours are per drawn mesh)
      const ids = new Set(a.ids), group = a.role === 'shade' ? a.group : undefined; // a Set: a model of 14k meshes, all re-assigned, is 14k lookups, not 14k x 14k compares
      const n = put(s, a.slot, (m) => {
        const objects = m.objects.map((o) => (ids.has(o.id) && (o.role !== a.role || o.group !== group) && !(a.role === 'receiver' && o.instances)
          ? (({ group: _g, ...r }) => ({ ...r, role: a.role, ...(group ? { group } : {}) }))(shading(o, true)) : o));
        return objects.every((o, i) => o === m.objects[i]) ? m : { ...m, objects, run: inFlight(m.run) ? m.run : IDLE, result: null, error: null }; // nothing changed: keep the result
      });
      return n; // the shown column stays: the next run shows it again
    }
    case 'SHADE': { // the same receivers with other run arguments: the result stays, stale where the arguments differ
      const ids = new Set(a.ids);
      return put(s, a.slot, (m) => {
        const objects = m.objects.map((o) => (ids.has(o.id) && o.role === 'receiver' && (o.shade ?? true) !== a.shade ? shading(o, a.shade) : o));
        return objects.every((o, i) => o === m.objects[i]) ? m : { ...m, objects };
      });
    }
    case 'SELECT':
      return put(s, a.slot, (m) => {
        if (!a.additive) return { ...m, selected: new Set(a.ids) };
        const next = new Set(m.selected);
        for (const id of a.ids) next.has(id) ? next.delete(id) : next.add(id);
        return { ...m, selected: next };
      });
    case 'RELOAD': { // the re-read rows keep their roles by path (App's readStage), and a receiver its no-shade flag here
      const n = put(s, a.slot, (m) => {
        const free = new Set(m.objects.filter((o) => o.shade === false).map((o) => o.path));
        const objects = free.size ? a.objects.map((o) => (o.role === 'receiver' && free.has(o.path) ? shading(o, false) : o)) : a.objects;
        // the view analysis' roles by path too: a new path is none, an instanced one no receiver
        const v = m.viewAnalysis, was = new Map(v.objects.map((o) => [o.path, o]));
        const vobjects = objects.map((o) => { const w = was.get(o.path), role = !w || (w.role === 'receiver' && o.instances) ? 'none' : w.role; return viewRole(o, role, w); });
        return {
          ...m, objects, selected: new Set(idsUnder(m.selection.paths, objects)), run: inFlight(m.run) ? m.run : IDLE, result: null, error: null,
          viewAnalysis: { objects: vobjects, run: inFlight(v.run) ? v.run : IDLE, result: null, error: null },
        };
      });
      return n === s ? s : viewsKept({ ...n, hovered: null, probe: null });
    }
    case 'SELECTION':
      return put(s, a.slot, (m) => ({ ...m, selection: { paths: a.paths, active: a.active, source: a.source }, selected: new Set(idsUnder(a.paths, m.objects)) }));
    case 'ADD': {
      const slot = [0, 1, 2, 3].find((k) => !s.models.some((m) => m.slot === k));
      return slot === undefined ? s : { ...s, models: [...s.models, model(slot)].sort((x, y) => x.slot - y.slot), active: slot };
    }
    case 'REMOVE': {
      const i = s.models.findIndex((m) => m.slot === a.slot);
      if (i < 0 || s.models.length === 1) return s;
      const models = s.models.filter((m) => m.slot !== a.slot), active = s.active === a.slot ? (models[i] ?? models[i - 1]).slot : s.active; // the next tab, else the one before
      return viewsKept({ ...s, models, active, hovered: null, probe: null, ...(kept(models) ? {} : { colourBy: 'plain' as const }) });
    }
    case 'ACTIVE':
      return s.active === a.slot || !s.models.some((m) => m.slot === a.slot) ? s : { ...s, active: a.slot };
    case 'HOVER':
      return s.hovered === a.id ? s : { ...s, hovered: a.id };
    case 'SITE': {
      const site = { ...s.settings.site, ...a.patch };
      const moved = site.lat !== s.settings.site.lat || site.lon !== s.settings.site.lon;
      let { weather, epwMeta } = s.settings;
      if (moved) {
        // the nearest station, or none until the index arrives (STATIONS then picks the nearest)
        weather = { ...weather, station: s.stations ? nearestStations(s.stations, site.lat, site.lon, 1)[0] ?? null : null };
        if (weather.source !== 'upload') epwMeta = null; // station / PVGIS reference changed: the header is re-fetched, the server re-serves from its cache
      }
      return { ...s, settings: { ...s.settings, site, weather, epwMeta } };
    }
    case 'WEATHER': {
      const weather = { ...s.settings.weather, ...a.patch };
      const refChanged = 'source' in a.patch || 'station' in a.patch || 'file' in a.patch;
      return { ...s, settings: { ...s.settings, weather, epwMeta: refChanged ? null : s.settings.epwMeta } };
    }
    case 'EPW_META':
      return { ...s, settings: { ...s.settings, epwMeta: a.meta } };
    case 'TIME':
      return { ...s, settings: { ...s.settings, time: { ...s.settings.time, ...a.patch } } };
    case 'SIM': {
      const prev = s.settings.sim;
      const sim = { ...prev, ...a.patch };
      if (sim.mode !== prev.mode) {
        // the default is "every quantity valid for the mode"; keep that default across a mode switch, else just drop what is invalid
        sim.quantities = sameSet(prev.quantities, quantitiesFor(prev.mode)) ? quantitiesFor(sim.mode) : prev.quantities.filter((q) => quantitiesFor(sim.mode).includes(q));
        if (sim.mode === 'ladybug' && sim.skyDensity === 4) sim.skyDensity = 2;
      }
      return { ...s, settings: { ...s.settings, sim } };
    }
    case 'VIEW_SIM':
      return { ...s, settings: { ...s.settings, viewSim: { ...s.settings.viewSim, ...a.patch } } };
    case 'RESET': { // the defaults as a whole, not through SIM: its mode switch would keep custom quantities
      const d = defaultSettings();
      if (a.what === 'sim') return { ...s, settings: { ...s.settings, sim: { ...d.sim, north: s.settings.sim.north } } };
      if (a.what === 'time') return { ...s, settings: { ...s.settings, time: d.time } };
      const patch: Partial<ViewSim> = Object.fromEntries(VIEW_SECTIONS[a.what].map((k) => [k, d.viewSim[k]]));
      return { ...s, settings: { ...s.settings, viewSim: { ...s.settings.viewSim, ...patch } } };
    }
    case 'STATIONS': {
      const { lat, lon } = s.settings.site;
      const station = s.settings.weather.station ?? nearestStations(a.stations, lat, lon, 1)[0] ?? null;
      return { ...s, stations: a.stations, settings: { ...s.settings, weather: { ...s.settings.weather, station } } };
    }
    case 'RUN': { // the last result stays until the next one lands; the first result of any model shows its values
      const m = s.models.find((x) => x.slot === a.slot), r = a.run, done = r.status === 'done';
      if (!m || (r.status === 'running' && m.run.status === 'running' && r.progress === m.run.progress && r.eta_s === m.run.eta_s) || (r.status === 'queued' && m.run.status === 'queued' && r.position === m.run.position && r.upload?.[0] === m.run.upload?.[0])) return s;
      if (done) { // the model or the roles changed while it ran: dropped (a Set: 14k receivers are 14k lookups)
        const receiving = new Set(m.objects.flatMap((o) => (o.role === 'receiver' ? [o.id] : [])));
        if (!r.result.receivers.every((id) => receiving.has(id))) return put(s, a.slot, (x) => ({ ...x, run: IDLE }));
      }
      return {
        ...put(s, a.slot, (x) => ({ ...x, run: r, result: done ? r.result : x.result, error: r.status === 'error' ? r.message : done || r.status === 'idle' ? null : x.error })),
        probe: done ? null : s.probe, bin: done ? null : s.bin, bins: done ? NO_BINS : s.bins, colourBy: done && !kept(s.models) ? 'value' : s.colourBy, // the column is found by name where it is read
        errors: (r.status === 'running' || r.status === 'queued') && Object.keys(s.errors).length ? {} : s.errors,
      };
    }
    case 'COLUMN': // another result: its values are others, the selected bars go
      return a.column === s.column ? s : { ...s, column: a.column, bins: NO_BINS };
    case 'BINS':
      return !a.bins.length && !s.bins.length ? s : { ...s, bins: a.bins.length ? a.bins : NO_BINS };
    case 'COLOUR_BY':
      return { ...s, colourBy: a.colourBy };
    case 'PROBE':
      return s.probe === a.probe || (s.probe && a.probe && s.probe.id === a.probe.id && s.probe.element === a.probe.element) ? s : { ...s, probe: a.probe };
    case 'BIN':
      return { ...s, bin: a.bin };
    case 'VIZ': {
      const { gradients, scales, ranges, colors, scalings, library } = s.settings.viz, q = a.quantity, p = a.patch;
      const viz = {
        library, scalings: p.scaling !== undefined ? { ...scalings, [q]: p.scaling } : scalings,
        gradients: p.gradient !== undefined ? { ...gradients, [q]: p.gradient } : gradients,
        scales: p.min !== undefined || p.max !== undefined ? { ...scales, [q]: { min: p.min !== undefined ? p.min : scales[q]?.min ?? null, max: p.max !== undefined ? p.max : scales[q]?.max ?? null } } : scales,
        ranges: p.lo !== undefined || p.hi !== undefined ? { ...ranges, [q]: { lo: p.lo !== undefined ? p.lo : ranges[q]?.lo ?? null, hi: p.hi !== undefined ? p.hi : ranges[q]?.hi ?? null } } : ranges,
        colors: { below: p.below ?? colors.below, above: p.above ?? colors.above },
      };
      return { ...s, settings: { ...s.settings, viz } };
    }
    case 'VIZ_RESET': {
      const { gradients, scales, ranges, scalings } = s.settings.viz, q = a.quantity;
      const drop = <T,>(r: Record<string, T>) => { const { [q]: _gone, ...rest } = r; return rest; };
      const viz = a.what === 'scale'
        ? { ...s.settings.viz, gradients: drop(gradients), scales: drop(scales), scalings: drop(scalings) }
        : { ...s.settings.viz, ranges: drop(ranges), colors: { below: DEFAULT_BELOW, above: DEFAULT_ABOVE } };
      return { ...s, settings: { ...s.settings, viz } };
    }
    case 'GRADIENT': { // as stored (gradientDef): a definition that is none changes nothing
      const { [a.key]: _was, ...rest } = s.settings.viz.library, g = a.gradient && gradientDef(a.gradient);
      if (a.gradient && !g) return s;
      return { ...s, settings: { ...s.settings, viz: { ...s.settings.viz, library: g ? { ...rest, [a.key]: g } : rest } } };
    }
    case 'CHART': { // a built-in is never removed
      const cs = s.settings.charts, old = 'spec' in a ? undefined : cs.find((c) => c.id === a.id);
      let charts = cs;
      if ('spec' in a) charts = put1(cs, a.spec);
      else if (old && 'reset' in a) charts = put1(cs, only(old, (k) => !lookOf(old).includes(k)));
      else if (old && !BUILT_IN.some((b) => b.id === old.id)) charts = cs.filter((c) => c !== old);
      return charts === cs ? s : { ...s, settings: { ...s.settings, charts } };
    }
    case 'ERRORS': // a run clicks through here every time: no errors before and after = no re-render
      return !Object.keys(a.errors).length && !Object.keys(s.errors).length ? s : { ...s, errors: a.errors };
    case 'OPTICS_EDIT':
      return put(s, a.slot, (m) => ({ ...m, optics: { ...m.optics, [a.key]: a.edit } }));
    case 'OPTICS_RESET':
      return put(s, a.slot, (m) => {
        if (!(a.key in m.optics)) return m;
        const { [a.key]: _gone, ...optics } = m.optics;
        return { ...m, optics };
      });
  }
}

/** Settings -> JSON for localStorage (the File cannot be stored; the user re-picks it, and its header goes with it). */
export const serializeSettings = (s: Settings): string =>
  JSON.stringify({ ...s, weather: { ...s.weather, file: null }, epwMeta: s.weather.source === 'upload' ? null : s.epwMeta }); // the header of a file that is not kept either

/** A stored view analysis' settings over the defaults, each field of the default's type or the default. */
function viewSimOf(raw: unknown, d: ViewSim): ViewSim {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>, out = { ...d } as Record<string, unknown>;
  for (const k of Object.keys(d) as (keyof ViewSim)[]) {
    const v = p[k], want = d[k];
    if (k === 'fov') { if (Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x))) out.fov = v; }
    else if (k === 'groundZ') { if (v === null || (typeof v === 'number' && Number.isFinite(v))) out.groundZ = v; }
    else if (typeof v === typeof want && (typeof v !== 'number' || Number.isFinite(v))) out[k] = v;
  }
  return out as unknown as ViewSim;
}

/** JSON (or null) -> Settings, each group spread over the defaults so a stale or partial record still loads. */
export function parseSettings(raw: string | null): Settings {
  const d = defaultSettings();
  if (!raw) return d;
  try {
    const p = JSON.parse(raw) as Partial<Record<keyof Settings, object>>;
    const viz = (p.viz ?? {}) as Partial<Settings['viz']>, site = (p.site ?? {}) as Record<string, unknown>; // an old record's tz override is dropped
    const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
    return {
      site: { lat: num(site.lat, d.site.lat), lon: num(site.lon, d.site.lon), place: typeof site.place === 'string' ? site.place : d.site.place }, weather: { ...d.weather, ...p.weather, file: null },
      epwMeta: (p.epwMeta as EpwMeta | null | undefined) ?? null, time: { ...d.time, ...p.time }, sim: { ...d.sim, ...p.sim },
      viz: {
        gradients: { ...viz.gradients }, scales: { ...viz.scales }, ranges: { ...viz.ranges }, colors: { ...d.viz.colors, ...viz.colors },
        scalings: Object.fromEntries(Object.entries(viz.scalings ?? {}).filter(([, v]) => SCALINGS.some(([k]) => k === v))),
        library: Object.fromEntries(Object.entries(viz.library ?? {}).flatMap(([key, g]) => { const def = gradientDef(g); return def ? [[key, def]] : []; })),
      },
      charts: (Array.isArray(p.charts) ? p.charts : []).reduce<ChartSpec[]>(put1, d.charts), // over the built-ins; junk is dropped
      viewSim: viewSimOf(p.viewSim, d.viewSim),
    };
  } catch {
    return d;
  }
}
