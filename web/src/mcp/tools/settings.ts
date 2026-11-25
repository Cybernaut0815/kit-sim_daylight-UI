// The settings tools: site_info (the site, its sun and weather) and update_settings (the Location, Time, Simulation,
// Weather and View settings panels, the Results panel's colours and charts), with the settings as both take and give
// them (publicSettings: app_state's copy goes back unchanged) and the View analysis' ray grid in numbers.
import { flushSync } from 'react-dom';
import { validateViews, weatherLeap } from '../../lib/args';
import { BUILT_IN, FIELDS, putChart, type ChartSpec } from '../../lib/charts';
import { STATION_INDEX_URL, haversineKm, nearestStations, parseStationIndex, photonReverse, photonSearch, proxyUrl } from '../../lib/geo';
import { MAX_STOPS, defaultScaling, gradientDef, gradientFor } from '../../lib/gradients';
import { locate } from '../../lib/locate';
import { roundNum, splitColumn } from '../../lib/result';
import { dayBounds, parseHoy, sunAt } from '../../lib/sun';
import { fmtClock, fmtTime, yearOf } from '../../lib/time';
import { rayGrid } from '../../lib/viewfield';
import { zoneAt } from '../../lib/zone';
import { QUANTITIES, reducer, type Action, type Settings, type SettingsSection, type State, type Station, type TimePoint, type ViewSim } from '../../store';
import { HEADLESS, exclusive } from '../bridge';
import { LETTERS, base, done, isJson, letter, local, ok, problems, tabOf, type Args, type Ctl, type Handler } from './common';

// ---------------------------------------------------------------------------------------------- weather inputs
export const pathOf = new WeakMap<File, string>(); // weather files opened by path: the settings show the path
/** A local .epw by absolute path. */
export async function epwFile(path: string): Promise<File> {
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

// ---------------------------------------------------------------------------------------------- settings in and out
/** The settings as update_settings takes them (times 'HH:MM', the station by title, chart models by letter, the user's
 *  gradients as library entries): app_state's copy goes back unchanged. */
export function publicSettings(s: Settings) {
  const { site, sim, time: t, weather: w, viz } = s, at = (p: TimePoint) => ({ date: p.date, hour: fmtClock(p.hour) });
  return {
    site, sim, view: s.viewSim,
    time: { mode: t.mode, date: t.date, hour: fmtClock(t.hour), from: at(t.from), to: at(t.to), step: t.stepMin },
    weather: { source: w.source, station: w.station?.title ?? null, file: w.file && (pathOf.get(w.file) ?? w.file.name), turbidity: w.turbidity, altitude: w.altitude },
    viz: {
      belowColour: viz.colors.below, aboveColour: viz.colors.above,
      quantities: Object.fromEntries(QUANTITIES.map((q) => [q, {
        gradient: gradientFor(q, viz.gradients[q], viz.library).key, scaling: viz.scalings[q] ?? defaultScaling(q), min: viz.scales[q]?.min ?? null, max: viz.scales[q]?.max ?? null, lo: viz.ranges[q]?.lo ?? null, hi: viz.ranges[q]?.hi ?? null,
      }])),
      library: Object.entries(viz.library).map(([key, g]) => ({ key, ...g })),
    },
    charts: s.charts.map((c) => (c.models ? { ...c, models: c.models.map(letter) } : c)),
  };
}
/** The View analysis' ray grid as its settings panel quotes it: columns x rows, rays per element, the field's extent in
 *  degrees (azimuth about the gaze, all around from north; elevation) and a window field's gaze. */
export function fieldOf(v: ViewSim) {
  const g = rayGrid(v.fov, v.cell);
  return { grid: `${g.cols} x ${g.rows}`, rays: g.cols * g.rows, azimuth: g.az, elevation: g.el, ...(g.all ? {} : { gaze: v.gaze }) };
}
/** A mode switch alone, before a SIM patch with the mode: the switch picks the quantities (and sky density) for the
 *  mode, which would undo the patch's own. */
export const simMode = (mode: Settings['sim']['mode']): Action => ({ type: 'SIM', patch: { mode } });
/** 'HH:MM', 00:00 to 24:00 -> minutes of day. */
export function minutesOf(field: string, hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number), v = 60 * h + m;
  if (!(m < 60 && v <= 1440)) throw new Error(`${field}: a time from 00:00 to 24:00`);
  return v;
}
/** 'YYYY-MM-DD' as given, when it names a real date (the schema checked its shape). */
export function dateOf(field: string, d: string): string {
  const t = Date.parse(`${d}T00:00:00Z`);
  if (Number.isNaN(t) || !new Date(t).toISOString().startsWith(d)) throw new Error(`${field}: no such date`);
  return d;
}

/** viz.library's entries as GRADIENT actions: a gradient put (its stops checked as the editor keeps them) or removed. */
function libraryActions(entries: readonly Args[]): Action[] {
  return entries.map((g, i): Action => {
    const at = `viz.library[${i}]`;
    if (g.remove) {
      const other = Object.keys(g).find((k) => k !== 'key' && k !== 'remove');
      if (other) throw new Error(`${at}.${other}: not with remove`);
      return { type: 'GRADIENT', key: g.key, gradient: null };
    }
    if (!g.stops) throw new Error(`${at}.stops: a gradient put takes its stops (2 to ${MAX_STOPS} colours)`);
    const p = g.positions as number[] | undefined;
    if (p && (p.length !== g.stops.length || p.some((v, k) => k > 0 && v < p[k - 1]))) throw new Error(`${at}.positions: one per stop, ascending within 0 to 1`);
    const def = gradientDef({ label: g.label ?? g.key, stops: g.stops, positions: p });
    if (!def) throw new Error(`${at}.stops: 2 to ${MAX_STOPS} colours, '#rrggbb'`);
    return { type: 'GRADIENT', key: g.key, gradient: def };
  });
}

/**
 * update_settings' arguments -> the actions the panels dispatch for them (RESET, SITE, WEATHER, TIME, SIM, VIEW_SIM,
 * GRADIENT, VIZ, CHART), each value checked; a site query is geocoded and a weather file fetched before (`file`), a
 * station is found in `s`'s index, and each chart is checked against the ones before it. `shown`: the column shown,
 * whose quantity viz takes by default.
 */
export function settingsActions(a: Args, s: State, shown: string | null, file?: File): Action[] {
  const out = ((a.reset ?? []) as SettingsSection[]).map((what): Action => ({ type: 'RESET', what })), { site: s0, time: t0 } = s.settings;
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
  if (a.view) out.push({ type: 'VIEW_SIM', patch: viewPatch(a.view, s.settings.viewSim) });
  if (a.viz) {
    const { library = [], quantity: named, reset, gradient, scaling, min, max, lo, hi, belowColour, aboveColour } = a.viz;
    out.push(...libraryActions(library)); // first: gradient may pick one of them
    const patch = Object.fromEntries(Object.entries({ gradient, scaling, min, max, lo, hi, below: belowColour, above: aboveColour }).filter(([, v]) => v !== undefined));
    if (reset || Object.keys(patch).length) {
      const quantity = named ?? (shown ? splitColumn(shown)[0] : undefined);
      if (!quantity) throw new Error('viz.quantity: no result is shown yet; name the quantity');
      if (reset) out.push({ type: 'VIZ_RESET', quantity, what: reset }); // first: the other fields go over it
      if (Object.keys(patch).length) out.push({ type: 'VIZ', quantity, patch });
    }
  }
  let st = s; // the charts so far
  for (const [i, raw] of ((a.charts ?? []) as Args[]).entries()) {
    const { remove, reset, ...given } = raw, old = st.settings.charts.find((c) => c.id === given.id), at = `charts[${i}]`;
    let act: Action;
    if (remove || reset) {
      if (!old) throw new Error(`${at}.id: no chart '${given.id}' (${st.settings.charts.map((c) => c.id).join(', ')})`);
      if (remove && BUILT_IN.some((b) => b.id === old.id)) throw new Error(`${at}.remove: '${old.id}' is built in; reset it instead`);
      act = remove ? { type: 'CHART', id: old.id, remove: true } : { type: 'CHART', id: old.id, reset: true };
    } else { // an existing chart: only the given fields change; a field of another kind is refused, as in save_report (a
      // model not open is kept: the app keeps a removed model's letter in its charts too, and app_state's copy comes back)
      const kind: string | undefined = given.kind ?? old?.kind, look = kind && Object.hasOwn(FIELDS, kind) ? FIELDS[kind as ChartSpec['kind']] : null; // no kind: putChart says so
      const own = ['id', 'kind', 'title', 'column', 'models', 'parts', ...(look ?? [])], other = Object.keys(given).find((k) => !own.includes(k));
      if (look && other) throw new Error(`${at}.${other}: not a field of a ${kind} chart (${own.join(', ')})`);
      const spec = { ...old, ...given, ...(given.models ? { models: given.models.map((l: string) => LETTERS.indexOf(l)) } : {}) } as ChartSpec, r = putChart(st.settings.charts, spec);
      if (typeof r === 'string') throw new Error(r.startsWith('charts:') ? `${at}${r.slice(6)}` : `${at}.${r}`); // 'charts[2]: at most 16 ...', 'charts[0].bins: ...'
      act = { type: 'CHART', spec };
    }
    out.push(act);
    st = reducer(st, act);
  }
  return out;
}

/** A view block (update_settings, save_set; its schema checked) as the View analysis' settings patch, checked with the
 *  settings it lands on as its panel checks them (lib/args validateViews: the field and cell, far, reach); a problem
 *  throws, naming its field. */
export function viewPatch(v: Args, now: ViewSim): Partial<ViewSim> {
  const patch: Partial<ViewSim> = { ...v, ...(v.fov ? { fov: [...v.fov] as ViewSim['fov'] } : {}) }, e = validateViews({ ...now, ...patch }, [], true);
  const k = (['fov', 'cell', 'far', 'reach'] as const).find((f) => e[f]);
  if (k) throw new Error(`view.${k}: ${e[k]}`);
  return patch;
}

// ---------------------------------------------------------------------------------------------- the tools
export const SETTINGS_HANDLERS: Record<string, Handler> = {
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
    const ways = site ? [site.query !== undefined && 'query', site.locate && 'locate', (site.lat !== undefined || site.lon !== undefined) && 'lat'].filter(Boolean) : [];
    if (ways.length > 1) throw new Error(`site.${ways[0]}: give one of query, locate, or lat and lon`);
    let alternatives: { place: string; lat: number; lon: number }[] = [];
    if (site?.query !== undefined) {
      const found = await photonSearch(site.query, { lat: s0.lat, lon: s0.lon }).catch((e: Error) => { throw new Error(`site.query: the place search failed (${e.message}); give lat and lon`); });
      if (!found.length) throw new Error(`site.query: no place found for '${site.query}'; try another name, or give lat and lon`);
      Object.assign(site, { lat: found[0].lat, lon: found[0].lon, place: site.place ?? found[0].name });
      alternatives = found.slice(1).map((p) => ({ place: p.name, lat: p.lat, lon: p.lon }));
    }
    if (site?.locate) {
      const at = await locate();
      if ('error' in at) throw new Error(`site.locate: ${at.error}${HEADLESS ? ' This is the hidden instance: nobody is there to allow it; give query, or lat and lon.' : ''}`);
      Object.assign(site, { lat: at.lat, lon: at.lon });
    }
    const file = a.weather?.file === undefined ? undefined : await epwFile(a.weather.file);
    if (a.weather?.station !== undefined) await stationIndex(c).catch((e: Error) => { throw new Error(`weather.station: ${e.message}; try again, or use source pvgis`); });
    await exclusive(() => {
      const acts = settingsActions({ ...a, site }, c().state, tabOf(c(), c().ui.tab).shown, file), { dispatch } = c();
      flushSync(() => { for (const x of acts) dispatch(x); });
    });
    if (site && site.place === undefined && (site.lat !== undefined || site.lon !== undefined)) { // named later, as the Location panel names a picked point
      const { lat, lon, place } = c().state.settings.site;
      photonReverse(lat, lon).then((name) => { const n = c().state.settings.site; if (n.lat === lat && n.lon === lon && n.place === place) c().dispatch({ type: 'SITE', patch: { place: name } }); }, () => {});
    }
    const x = c();
    return ok({ settings: publicSettings(x.state.settings), field: fieldOf(x.state.settings.viewSim), problems: problems(x), ...(alternatives.length ? { alternatives } : {}) });
  },
};
