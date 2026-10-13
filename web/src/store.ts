// App state: types, reducer, slot assignment, settings persistence (pure; the App does the localStorage I/O).
import type { RemoteManifest } from 'daylight-mesh';
import { nearestStations } from './lib/geo';

export type Role = 'receiver' | 'shade' | 'none';
export interface ObjectRow { id: string; name: string; tris: number; verts: number; role: Role; slot?: number }

export type Quantity = 'radiation' | 'direct' | 'diffuse' | 'irradiance' | 'illuminance' | 'sunhours';
export const QUANTITIES: Quantity[] = ['radiation', 'direct', 'diffuse', 'irradiance', 'illuminance', 'sunhours'];
export type SimMode = 'physical' | 'ladybug';
export const quantitiesFor = (mode: SimMode): Quantity[] => (mode === 'ladybug' ? QUANTITIES.filter((q) => q !== 'illuminance') : QUANTITIES);

export interface Station { title: string; href: string; lat: number; lon: number; km?: number }
export interface EpwMeta { lat: number; lon: number; tz: number; name: string; leap: boolean }
export type WeatherSource = 'upload' | 'station' | 'pvgis' | 'clear-sky';
export interface TimePoint { date: string; hour: number } // 'YYYY-MM-DD', minutes of day (0..1440)

export interface Settings {
  site: { lat: number; lon: number; tz: number | null; place: string }; // tz null = derived (EPW header, else round(lon/15))
  weather: { source: WeatherSource; file: File | null; station: Station | null; turbidity: number; altitude: number };
  epwMeta: EpwMeta | null; // header of the EPW the run will use; null until fetched / after the reference changed
  time: { mode: 'annual' | 'instant' | 'range'; date: string; hour: number; from: TimePoint; to: TimePoint; stepMin: number };
  sim: {
    mode: SimMode; quantities: Quantity[]; sides: 'front' | 'back' | 'both'; on: 'faces' | 'vertices';
    cullBackfaces: boolean; selfOcclude: boolean; skyDensity: 1 | 2 | 4; patchSamples: number; ground: number; north: number; offset: number;
  };
}

export interface RunResult {
  values: Float64Array[]; columns: string[]; manifest: RemoteManifest; cache?: Record<string, string>;
  receivers: string[]; // object ids in sensor order: manifest.meshes[i] <-> receivers[i]
  on: 'faces' | 'vertices'; // element kind the rows describe (weights: face areas or vertex areas)
}
export type Run = { status: 'idle' } | { status: 'running' } | { status: 'error'; message: string } | { status: 'done'; result: RunResult };

export interface State {
  objects: ObjectRow[]; selected: Set<string>; hovered: string | null;
  settings: Settings; stations: Station[] | null; run: Run; column: number; colourBy: 'mesh' | 'value';
  errors: Record<string, string>; // validate() output keyed by field id
}

export type Action =
  | { type: 'LOAD'; objects: ObjectRow[] }
  | { type: 'ROLE'; ids: string[]; role: Role }
  | { type: 'SELECT'; ids: string[]; additive?: boolean }
  | { type: 'HOVER'; id: string | null }
  | { type: 'SITE'; patch: Partial<Settings['site']> }
  | { type: 'WEATHER'; patch: Partial<Settings['weather']> }
  | { type: 'EPW_META'; meta: EpwMeta | null }
  | { type: 'TIME'; patch: Partial<Settings['time']> }
  | { type: 'SIM'; patch: Partial<Settings['sim']> }
  | { type: 'STATIONS'; stations: Station[] }
  | { type: 'RUN'; run: Run }
  | { type: 'COLUMN'; column: number }
  | { type: 'COLOUR_BY'; colourBy: 'mesh' | 'value' }
  | { type: 'ERRORS'; errors: Record<string, string> };

const year = new Date().getFullYear();
const solstice = `${year}-06-21`;
export const defaultSettings = (): Settings => ({
  site: { lat: 51.5074, lon: -0.1278, tz: null, place: 'London, United Kingdom' },
  weather: { source: 'station', file: null, station: null, turbidity: 3, altitude: 0 },
  epwMeta: null,
  time: { mode: 'annual', date: solstice, hour: 720, from: { date: solstice, hour: 480 }, to: { date: solstice, hour: 1080 }, stepMin: 60 },
  sim: { mode: 'physical', quantities: QUANTITIES, sides: 'front', on: 'faces', cullBackfaces: false, selfOcclude: true, skyDensity: 1, patchSamples: 1, ground: 0.2, north: 0, offset: 0 },
});

export const initialState = (settings = defaultSettings()): State => ({
  objects: [], selected: new Set(), hovered: null, settings, stations: null, run: { status: 'idle' }, column: 0, colourBy: 'mesh', errors: {},
});

/** Chart slot -> token. Slots 0..7 are --chart-cat-1..8; a 9th+ receiver folds into --chart-cat-other (DESIGN.md §Charts). */
export const slotVar = (slot: number | undefined): string => (slot !== undefined && slot < 8 ? `--chart-cat-${slot + 1}` : '--chart-cat-other');

// Receivers keep their slot for life; a new receiver takes the lowest free one, so nothing repaints when others change.
function assignSlots(objects: ObjectRow[]): ObjectRow[] {
  const used = new Set(objects.filter((o) => o.role === 'receiver' && o.slot !== undefined).map((o) => o.slot));
  return objects.map((o) => {
    if (o.role !== 'receiver') return o.slot === undefined ? o : { ...o, slot: undefined };
    if (o.slot !== undefined) return o;
    let slot = 0;
    while (used.has(slot)) slot++;
    used.add(slot);
    return { ...o, slot };
  });
}

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((q) => b.includes(q as Quantity));

export function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'LOAD':
      return { ...s, objects: assignSlots(a.objects), selected: new Set(), hovered: null, run: { status: 'idle' }, column: 0, colourBy: 'mesh' };
    case 'ROLE':
      return { ...s, objects: assignSlots(s.objects.map((o) => (a.ids.includes(o.id) ? { ...o, role: a.role } : o))), run: { status: 'idle' }, column: 0 };
    case 'SELECT': {
      if (!a.additive) return { ...s, selected: new Set(a.ids) };
      const next = new Set(s.selected);
      for (const id of a.ids) next.has(id) ? next.delete(id) : next.add(id);
      return { ...s, selected: next };
    }
    case 'HOVER':
      return s.hovered === a.id ? s : { ...s, hovered: a.id };
    case 'SITE': {
      const site = { ...s.settings.site, ...a.patch };
      const moved = site.lat !== s.settings.site.lat || site.lon !== s.settings.site.lon;
      let { weather, epwMeta } = s.settings;
      if (moved) {
        if (s.stations) weather = { ...weather, station: nearestStations(s.stations, site.lat, site.lon, 1)[0] ?? null };
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
    case 'RUN':
      return { ...s, run: a.run, column: a.run.status === 'done' ? Math.min(s.column, a.run.result.columns.length - 1) : s.column, errors: a.run.status === 'running' ? {} : s.errors };
    case 'COLUMN':
      return { ...s, column: a.column };
    case 'COLOUR_BY':
      return { ...s, colourBy: a.colourBy };
    case 'ERRORS':
      return { ...s, errors: a.errors };
  }
}

/** Settings -> JSON for localStorage (the File cannot be stored; the user re-picks it). */
export const serializeSettings = (s: Settings): string => JSON.stringify({ ...s, weather: { ...s.weather, file: null } });

/** JSON (or null) -> Settings, each group spread over the defaults so a stale or partial record still loads. */
export function parseSettings(raw: string | null): Settings {
  const d = defaultSettings();
  if (!raw) return d;
  try {
    const p = JSON.parse(raw) as Partial<Record<keyof Settings, object>>;
    return {
      site: { ...d.site, ...p.site }, weather: { ...d.weather, ...p.weather, file: null },
      epwMeta: (p.epwMeta as EpwMeta | null | undefined) ?? null, time: { ...d.time, ...p.time }, sim: { ...d.sim, ...p.sim },
    };
  } catch {
    return d;
  }
}
