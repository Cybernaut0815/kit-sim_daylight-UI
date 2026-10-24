// Settings -> CLI flags for /run (every option explicit, so equal settings give equal request keys), and validation.
import type { Settings } from '../store';
import { quantitiesFor } from '../store';
import { pvgisUrl } from './geo';
import { doy, fmtClock, fmtTime } from './time';
import { zoneAt } from './zone';

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
 * Field id -> message (cause and fix), in the order of the fields. Empty when the settings can run. `materialsReady`:
 * every texture the run's materials read is decoded (or failed); until then a run whose optics count (physical,
 * transmission on) is held, never started on half-read materials. The hold comes last: a field error keeps the focus.
 */
export function validate(s: Settings, hasReceiver: boolean, materialsReady = true): Record<string, string> {
  const e: Record<string, string> = {};
  const { site, weather, time, sim } = s;
  if (!hasReceiver) e.model = 'No receiver mesh. Select a mesh and mark it as a receiver.';
  if (!(Math.abs(site.lat) <= 90)) e.lat = 'Latitude must be between -90 and 90.';
  if (!(Math.abs(site.lon) <= 180)) e.lon = 'Longitude must be between -180 and 180.';
  if (sim.quantities.length === 0) e.quantities = 'Pick at least one quantity.';
  const invalid = sim.quantities.filter((q) => !quantitiesFor(sim.mode).includes(q));
  if (invalid.length) e.quantities = `${invalid.join(', ')} is not available in ${sim.mode} mode. Untick it or switch to physical.`;
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
  if (!materialsReady && sim.mode === 'physical' && sim.transmission) e.materials = 'Reading the materials…';
  return e;
}
