// Settings -> CLI flags for /run (every option explicit, so equal settings give equal request keys), and validation.
import type { ObjectRow, Settings, ViewSim } from '../store';
import { GROUP, QUANTITIES, quantitiesFor } from '../store';
import { pvgisUrl } from './geo';
import { doy, fmtClock, fmtTime } from './time';
import { zoneAt } from './zone';

/** The most values one run returns (rows x columns, 512 MB of float32 in the tab): the server's limit too (server.cpp kMaxValues). */
const MAX_VALUES = 2 ** 27;

/** The clock of every time the user picks: the site's civil standard offset, from the place. Sent as --tz; the core keeps
 *  EPW rows in their own zone and moves these times into it, so any weather source gives the same sun. */
export const derivedTz = (s: Settings): number => zoneAt(s.site.lat, s.site.lon).std;

/** Whether the core's weather year is a leap year (clear sky never is). */
export const weatherLeap = (s: Settings): boolean => s.weather.source !== 'clear-sky' && !!s.epwMeta?.leap;

/** The weather a run sends: the uploaded EPW, or a station / PVGIS URL the server fetches through its cache. */
export function epwRef({ weather, site }: Settings): File | { url: string } | undefined {
  if (weather.source === 'upload') return weather.file ?? undefined;
  if (weather.source === 'station') return weather.station ? { url: weather.station.href } : undefined;
  return weather.source === 'pvgis' ? { url: pvgisUrl(site.lat, site.lon) } : undefined;
}

export function buildArgs(s: Settings): string[] {
  const { site, weather, time, sim } = s;
  const a = ['--lat', String(site.lat), '--lon', String(site.lon), '--tz', String(derivedTz(s))], leap = weatherLeap(s);
  if (weather.source === 'clear-sky') a.push('--clear-sky', '--turbidity', String(weather.turbidity), '--altitude', String(weather.altitude));
  a.push('--mode', sim.mode, '--quantity', sim.quantities.join(','), '--sides', sim.sides, '--on', sim.on,
    '--sky-density', String(sim.skyDensity), '--patch-samples', String(sim.patchSamples),
    '--ground', String(sim.ground), '--north', String(sim.north), '--offset', String(sim.offset));
  if (sim.cullBackfaces) a.push('--cull-backfaces');
  if (!sim.selfOcclude) a.push('--no-self-occlude');
  if (time.mode === 'instant') a.push('--time', fmtTime(time.date, time.hour, leap));
  if (time.mode === 'range') {
    a.push('--from', fmtTime(time.from.date, time.from.hour, leap), '--to', fmtTime(time.to.date, time.to.hour, leap), '--step', String(time.stepMin));
    if (time.from.date !== time.to.date) a.push('--hours', `${fmtClock(time.from.hour)}-${fmtClock(time.to.hour)}`); // the same hours of every day
  }
  return a;
}

/**
 * The simulation settings a run of `elements` receiver faces or vertices sends: over 1,000,000 the default 1024
 * reflection samples become 256 (the reflection pass costs elements x samples paths: at that size 1024 takes many
 * minutes); any other number runs as set.
 * ponytail: 1024 picked by hand reads as the default; give bounceSamples an 'auto' value if a big model must run 1024
 */
export const simFor = (sim: Settings['sim'], elements: number): Settings['sim'] => (sim.bounceSamples === 1024 && elements > 1e6 ? { ...sim, bounceSamples: 256 } : sim);

/** A model's receivers that cast no shade, as the core's --no-occlude (mesh ids in the order of their paths, so a run key
 *  with its ids as paths stays the same across re-reads); none while receivers do not block rays, when none casts shade
 *  anyway and the core builds the same scene. */
export function noOccludeArgs(receivers: readonly Pick<ObjectRow, 'id' | 'path' | 'shade'>[], sim: Pick<Settings['sim'], 'selfOcclude'>): string[] {
  const ids = sim.selfOcclude ? receivers.filter((o) => o.shade === false).sort((x, y) => (x.path < y.path ? -1 : 1)).map((o) => o.id) : [];
  return ids.length ? ['--no-occlude', ids.join(';')] : [];
}

/**
 * Field id -> message (cause and fix), in the order of the fields. Empty when the settings can run. `materialsReady`:
 * every texture the run's materials read is decoded (or failed); until then a run whose optics count (physical,
 * Transmission or Reflections on) is held, never started on half-read materials. The hold comes last: a field error
 * keeps the focus. `rows`: the receiver faces or vertices of the largest model, the rows its run returns.
 */
export function validate(s: Settings, hasReceiver: boolean, materialsReady = true, rows = 0): Record<string, string> {
  const e: Record<string, string> = {};
  const { site, weather, time, sim } = s;
  if (!hasReceiver) e.model = 'No receiver mesh. Select a mesh and mark it as a receiver.';
  if (!(Math.abs(site.lat) <= 90)) e.lat = 'Latitude must be between -90 and 90.';
  if (!(Math.abs(site.lon) <= 180)) e.lon = 'Longitude must be between -180 and 180.';
  if (sim.quantities.length === 0) e.quantities = 'Pick at least one quantity.';
  const invalid = sim.quantities.filter((q) => !quantitiesFor(sim.mode).includes(q));
  if (invalid.length) e.quantities = `${invalid.join(', ')} is not available in ${sim.mode} mode. Untick it or switch to physical.`;
  // a result holds rows x columns float32 values: refused before any upload above what one run can return
  const cols = sim.quantities.length * (sim.sides === 'both' ? 2 : 1), n = (v: number) => v.toLocaleString('en-GB');
  if (!e.quantities && rows * cols > MAX_VALUES) e.quantities = `${n(rows)} ${sim.on} × ${cols} result columns = ${n(rows * cols)} values, over the ${n(MAX_VALUES)} one run can return. Pick fewer quantities or one side, or fewer receivers.`;
  if (sim.mode === 'ladybug' && sim.skyDensity === 4) e.skyDensity = 'Ladybug mode supports sky density 1 or 2.';
  const needsWeather = sim.quantities.some((q) => q !== 'sunhours');
  if (needsWeather) {
    if (weather.source === 'upload' && !weather.file) e.weather = 'Every quantity except sun hours needs weather. Choose an EPW file or another source.';
    if (weather.source === 'station' && !weather.station) e.weather = 'No station selected. Wait for the index or pick another source.';
  }
  if (time.mode === 'range') { // every day from the start date to the end date, from the start time to the end time
    if (doy(time.to.date) < doy(time.from.date)) e.timeTo = 'The end date must not be before the start date.';
    else if (time.from.hour >= time.to.hour) e.timeTo = 'The end time must be after the start time.';
  }
  if (time.mode === 'instant' && !time.date) e.timeDate = 'Pick a date.';
  const feb29 = (date: string) => date.slice(5) === '02-29', noFeb29 = 'Feb 29 is not in the weather year. Pick Feb 28 or Mar 1.';
  const notLeap = (s.weather.source === 'clear-sky' || !!s.epwMeta) && !weatherLeap(s); // known only once the weather header is read
  if (notLeap && time.mode === 'instant' && feb29(time.date)) e.timeDate = noFeb29;
  if (notLeap && time.mode === 'range' && (feb29(time.from.date) || feb29(time.to.date))) e.timeTo = noFeb29;
  if (!materialsReady && sim.mode === 'physical' && (sim.transmission || sim.bounces > 0)) e.materials = 'Reading the materials…';
  return e;
}

/** The view analysis' flags (the core's views; every option explicit, as buildArgs, but the gaze all around, where it
 *  does nothing: its runs keep their keys), north the site's. */
export function viewArgs(v: ViewSim, north: number): string[] {
  const a = ['--fov', v.fov.join(','), '--cell', String(v.cell), '--sides', v.sides, '--on', v.on, '--offset', String(v.offset), '--far', String(v.far),
    '--virtual-ground', v.virtualGround ? 'on' : 'off', '--north', String(north)];
  if (v.fov[0] < 360) a.push('--gaze', v.gaze);
  if (v.virtualGround && v.groundZ !== null) a.push('--ground-z', String(v.groundZ));
  if (v.reach.trim()) a.push('--reach', v.reach.replace(/\s+/g, ''));
  if (v.cullBackfaces) a.push('--cull-backfaces');
  if (!v.selfOcclude) a.push('--no-self-occlude');
  return a;
}

/** A model's targets as views --target ID=GROUP;... (shades with a group, in the order of their paths, as noOccludeArgs). */
export function targetArgs(rows: readonly Pick<ObjectRow, 'id' | 'path' | 'role' | 'group'>[]): string[] {
  const t = rows.filter((o) => o.role === 'shade' && o.group).sort((x, y) => (x.path < y.path ? -1 : 1)).map((o) => `${o.id}=${o.group}`);
  return t.length ? ['--target', t.join(';')] : [];
}

/** Group names the core keeps for its own columns, and the daylight quantities (both analyses share colour settings by name). */
const RESERVED = /^(sky|ground|obstruction|obstruction_total|glazing|volume|area|distance.*|reach.*|.*_distance|.*_distance_min)$/;
/** A --reach value: '' (none), 'en17037', or 1 to 8 distinct positive metres. */
export const reachOk = (r: string) => {
  const t = r.replace(/\s+/g, '');
  if (!t || t === 'en17037') return true;
  const d = t.split(',').map(Number);
  return d.length <= 8 && d.every((x) => x > 0 && Number.isFinite(x)) && new Set(d.map((x) => `${x}`)).size === d.length;
};

/**
 * The view analysis' field id -> message, as validate(): no receiver, the field and cell (at most 2^20 rays per element;
 * the default isovist all around needs 3 columns and, not flat, 2 rows), far, reach, the target groups of every model (at
 * most 16, names the core takes), and the materials while glass is passed and they are still read.
 */
export function validateViews(v: ViewSim, groups: readonly string[], hasReceiver: boolean, materialsReady = true): Record<string, string> {
  const e: Record<string, string> = {}, [h, lo, hi] = v.fov, flat = lo === 0 && hi === 0;
  if (!hasReceiver) e.model = 'No receiver mesh. Select a mesh and mark it as a receiver.';
  const used = [...new Set(groups)], bad = used.find((g) => !GROUP.test(g) || RESERVED.test(g) || (QUANTITIES as readonly string[]).includes(g));
  if (bad !== undefined) e.groups = `Target group "${bad}": letters, digits, _ and - only, and not sky, ground, obstruction, obstruction_total, glazing, volume, area, a daylight quantity or a name starting with distance or reach.`;
  else if (used.length > 16) e.groups = `${used.length} target groups: at most 16.`;
  if (!((h > 0 && h <= 180) || h === 360)) e.fov = 'The field is up to 180° wide about the normal, or 360° all around.';
  else if (!flat && !(lo >= -90 && lo < hi && hi <= 90)) e.fov = 'The field runs from a lower to a higher elevation, -90° to 90° (or 0 to 0: horizontal rays).';
  const cols = Math.max(1, Math.round(h / v.cell)), rows = Math.max(1, Math.round((hi - lo) / v.cell));
  if (!(v.cell > 0) || !Number.isFinite(v.cell)) e.cell = 'The cell must be more than 0°.';
  else if (cols * rows > 2 ** 20) e.cell = `${cols} × ${rows} rays per element, over 1,048,576: take a coarser cell.`;
  else if (!e.fov && h === 360 && (cols < 3 || (!flat && rows < 2))) e.cell = 'The isovist all around needs at least 3 columns and 2 rows: a finer cell, a taller field, or 0 to 0 for the horizontal one.';
  if (!(v.far > 0.1) || !Number.isFinite(v.far)) e.far = 'Far must be more than 0.1 m.';
  if (!reachOk(v.reach)) e.reach = 'Reach: EN 17037, or up to 8 different distances in metres, separated by commas.';
  if (!materialsReady && v.transmission) e.materials = 'Reading the materials…';
  return e;
}
