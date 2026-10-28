// App state: types, reducer (the models by slot, the shared settings), the run batch, settings persistence (pure; the
// App does the localStorage I/O).
import type { RemoteManifest } from 'daylight-mesh';
import type { EpwMonthly } from './lib/epw';
import { nearestStations } from './lib/geo';
import { DEFAULT_ABOVE, DEFAULT_BELOW } from './lib/gradients';
import type { OpticsEdit } from './lib/optics';
import { idsUnder } from './lib/tree';

export type Role = 'receiver' | 'shade' | 'none';
/**
 * A mesh of the stage: its prim path, its drawn triangles and vertices; `instances`: one mesh drawn that many times;
 * `paths`: every copy's prim path where each copy is its own prim (native instancing), so a click on any finds the row;
 * `materials[k]`: the viewer's material rid of optics slot k (0 = none).
 */
export interface ObjectRow { id: string; name: string; path: string; tris: number; verts: number; role: Role; instances?: number; paths?: string[]; materials?: number[] }

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
  // Result colouring per quantity: gradient key, legend domain (null = data range), the problem range (null = open),
  // and the two range colours (hex, shared by every quantity).
  viz: {
    gradients: Record<string, string>; scales: Record<string, { min: number | null; max: number | null }>; ranges: Record<string, { lo: number | null; hi: number | null }>;
    colors: { below: string; above: string };
  };
}

/** The element under the cursor: object id, element index within the mesh's rows, its value in the current column. */
export interface Probe { id: string; element: number; value: number }

export interface RunResult {
  values: Float64Array[]; columns: string[]; manifest: RemoteManifest; cache?: Record<string, string>;
  receivers: string[]; // object ids in sensor order: manifest.meshes[i] <-> receivers[i]
  on: 'faces' | 'vertices'; // element kind the rows describe (weights: face areas or vertex areas)
  key: string; // the run key (args, weather, mesh ids) it was computed for: differs from the current one = stale
  elapsed: number; // s, click to result (the round trip the user waits for)
  switches?: string; // the optics switches it ran with, in words (lib/optics.ts runSwitches); '' = the defaults
}
export type Run = { status: 'idle' } | { status: 'queued'; position: number } | { status: 'running' } | { status: 'error'; message: string } | { status: 'done'; result: RunResult };

/** The viewer's selection: prim paths (any prim: a parent stands for every mesh below it), the active one, who made it. */
export interface Selection { paths: string[]; active: string | null; source: string }
const NO_SELECTION: Selection = { paths: [], active: null, source: 'api' };

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
  optics: Record<string, OpticsEdit>; // Materials-table edits (lib/optics.ts keys): kept across re-reads, cleared per model
}

export interface State {
  models: Model[]; // 1..4, in slot order
  active: number; // the slot the Model and Materials panels, Views and Download act on
  hovered: string | null; // row ids are unique across models
  probe: Probe | null; // element under the cursor in a view
  bin: [number, number] | null; // hovered histogram bin [lo, hi): the views fade everything else
  settings: Settings; stations: Station[] | null;
  column: number; // the result column shown: an index into the first result in slot order, found by name in the others
  colourBy: 'plain' | 'value';
  errors: Record<string, string>; // validate() output keyed by field id
}

export type Action =
  | { type: 'LOAD'; slot: number; objects: ObjectRow[]; name?: string }
  | { type: 'RELOAD'; slot: number; objects: ObjectRow[] } // the same stage re-read (a variant switch): the selection stays
  | { type: 'ROLE'; slot: number; ids: string[]; role: Role }
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
  | { type: 'RUN'; slot: number; run: Run }
  | { type: 'COLUMN'; column: number }
  | { type: 'COLOUR_BY'; colourBy: 'plain' | 'value' }
  | { type: 'PROBE'; probe: Probe | null }
  | { type: 'BIN'; bin: [number, number] | null }
  | { type: 'VIZ'; quantity: string; patch: { gradient?: string; min?: number | null; max?: number | null; lo?: number | null; hi?: number | null; below?: string; above?: string } }
  | { type: 'VIZ_RESET'; quantity: string; what: 'scale' | 'range' }
  | { type: 'ERRORS'; errors: Record<string, string> }
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
  viz: { gradients: {}, scales: {}, ranges: {}, colors: { below: DEFAULT_BELOW, above: DEFAULT_ABOVE } },
});

const IDLE: Run = { status: 'idle' };
const model = (slot: number): Model => ({ slot, name: '', objects: [], selection: NO_SELECTION, selected: new Set(), run: IDLE, result: null, error: null, optics: {} });

export const initialState = (settings = defaultSettings()): State => ({
  models: [model(0)], active: 0, hovered: null, probe: null, bin: null, settings, stations: null, column: 0, colourBy: 'plain', errors: {},
});

// A job still on its way when the model or the roles change keeps its status (the button stays busy until it ends);
// its result is then dropped at RUN done, because its receivers are gone.
export const inFlight = (r: Run) => r.status === 'queued' || r.status === 'running';
const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((q) => b.includes(q as Quantity));
/** f over the model in `slot`: the same state when there is none (a load or a job that outlived its model) or f keeps it. */
const put = (s: State, slot: number, f: (m: Model) => Model): State => {
  const models = s.models.map((m) => (m.slot === slot ? f(m) : m));
  return models.every((m, i) => m === s.models[i]) ? s : { ...s, models };
};
/** A model still shows a result: the shared column (and colouring) stay; else they start over, as for one model. */
const kept = (models: readonly Model[]) => models.some((m) => m.result);

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

export function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'LOAD': {
      const n = put(s, a.slot, (m) => ({ ...model(m.slot), name: a.name ?? '', objects: a.objects, run: inFlight(m.run) ? m.run : IDLE }));
      return n === s ? s : { ...n, hovered: null, ...(kept(n.models) ? {} : { column: 0, colourBy: 'plain' as const }) };
    }
    case 'ROLE': { // instanced rows draw one mesh many times: Shade or Ignore only (rows and colours are per drawn mesh)
      const n = put(s, a.slot, (m) => {
        const objects = m.objects.map((o) => (a.ids.includes(o.id) && o.role !== a.role && !(a.role === 'receiver' && o.instances) ? { ...o, role: a.role } : o));
        return objects.every((o, i) => o === m.objects[i]) ? m : { ...m, objects, run: inFlight(m.run) ? m.run : IDLE, result: null, error: null }; // nothing changed: keep the result
      });
      return n === s || kept(n.models) ? n : { ...n, column: 0 };
    }
    case 'SELECT':
      return put(s, a.slot, (m) => {
        if (!a.additive) return { ...m, selected: new Set(a.ids) };
        const next = new Set(m.selected);
        for (const id of a.ids) next.has(id) ? next.delete(id) : next.add(id);
        return { ...m, selected: next };
      });
    case 'RELOAD': {
      const n = put(s, a.slot, (m) => ({ ...m, objects: a.objects, selected: new Set(idsUnder(m.selection.paths, a.objects)), run: inFlight(m.run) ? m.run : IDLE, result: null, error: null }));
      return n === s ? s : { ...n, hovered: null, probe: null, ...(kept(n.models) ? {} : { column: 0 }) };
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
      return { ...s, models, active, hovered: null, probe: null, ...(kept(models) ? {} : { column: 0, colourBy: 'plain' as const }) };
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
    case 'STATIONS': {
      const { lat, lon } = s.settings.site;
      const station = s.settings.weather.station ?? nearestStations(a.stations, lat, lon, 1)[0] ?? null;
      return { ...s, stations: a.stations, settings: { ...s.settings, weather: { ...s.settings.weather, station } } };
    }
    case 'RUN': { // the last result stays until the next one lands; the first result of any model shows its values
      const m = s.models.find((x) => x.slot === a.slot), r = a.run, done = r.status === 'done';
      if (!m || (r.status === 'running' && m.run.status === 'running') || (r.status === 'queued' && m.run.status === 'queued' && r.position === m.run.position)) return s;
      if (done && !r.result.receivers.every((id) => m.objects.some((o) => o.id === id && o.role === 'receiver'))) return put(s, a.slot, (x) => ({ ...x, run: IDLE })); // the model or the roles changed while it ran
      return {
        ...put(s, a.slot, (x) => ({ ...x, run: r, result: done ? r.result : x.result, error: r.status === 'error' ? r.message : done || r.status === 'idle' ? null : x.error })),
        probe: done ? null : s.probe, bin: done ? null : s.bin, colourBy: done && !kept(s.models) ? 'value' : s.colourBy, // the column is clamped where it is read
        errors: (r.status === 'running' || r.status === 'queued') && Object.keys(s.errors).length ? {} : s.errors,
      };
    }
    case 'COLUMN':
      return { ...s, column: a.column };
    case 'COLOUR_BY':
      return { ...s, colourBy: a.colourBy };
    case 'PROBE':
      return s.probe === a.probe || (s.probe && a.probe && s.probe.id === a.probe.id && s.probe.element === a.probe.element) ? s : { ...s, probe: a.probe };
    case 'BIN':
      return { ...s, bin: a.bin };
    case 'VIZ': {
      const { gradients, scales, ranges, colors } = s.settings.viz, q = a.quantity, p = a.patch;
      const viz = {
        gradients: p.gradient !== undefined ? { ...gradients, [q]: p.gradient } : gradients,
        scales: p.min !== undefined || p.max !== undefined ? { ...scales, [q]: { min: p.min !== undefined ? p.min : scales[q]?.min ?? null, max: p.max !== undefined ? p.max : scales[q]?.max ?? null } } : scales,
        ranges: p.lo !== undefined || p.hi !== undefined ? { ...ranges, [q]: { lo: p.lo !== undefined ? p.lo : ranges[q]?.lo ?? null, hi: p.hi !== undefined ? p.hi : ranges[q]?.hi ?? null } } : ranges,
        colors: { below: p.below ?? colors.below, above: p.above ?? colors.above },
      };
      return { ...s, settings: { ...s.settings, viz } };
    }
    case 'VIZ_RESET': {
      const { gradients, scales, ranges } = s.settings.viz, q = a.quantity;
      const drop = <T,>(r: Record<string, T>) => { const { [q]: _gone, ...rest } = r; return rest; };
      const viz = a.what === 'scale'
        ? { ...s.settings.viz, gradients: drop(gradients), scales: drop(scales) }
        : { ...s.settings.viz, ranges: drop(ranges), colors: { below: DEFAULT_BELOW, above: DEFAULT_ABOVE } };
      return { ...s, settings: { ...s.settings, viz } };
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
      viz: { gradients: { ...viz.gradients }, scales: { ...viz.scales }, ranges: { ...viz.ranges }, colors: { ...d.viz.colors, ...viz.colors } },
    };
  } catch {
    return d;
  }
}
