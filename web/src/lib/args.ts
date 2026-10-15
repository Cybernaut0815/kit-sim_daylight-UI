// Settings -> CLI flags for /run (every option explicit, so equal settings give equal request keys), and validation.
import type { Settings } from '../store';
import { quantitiesFor } from '../store';
import { pvgisUrl } from './geo';
import { doy, fmtClock, fmtTime } from './time';

/** The tz the run uses: the user's explicit value, else the EPW header, else round(lon / 15). Always sent: the core
 *  would otherwise default tz before it reads the EPW header. */
export const derivedTz = (s: Settings): number => s.site.tz ?? s.epwMeta?.tz ?? Math.round(s.site.lon / 15);

/** The weather a run sends: the uploaded EPW, or a station / PVGIS URL the server fetches through its cache. */
export function epwRef({ weather, site }: Settings): File | { url: string } | undefined {
  if (weather.source === 'upload') return weather.file ?? undefined;
  if (weather.source === 'station') return weather.station ? { url: weather.station.href } : undefined;
  return weather.source === 'pvgis' ? { url: pvgisUrl(site.lat, site.lon) } : undefined;
}

export function buildArgs(s: Settings): string[] {
  const { site, weather, time, sim } = s;
  const a = ['--lat', String(site.lat), '--lon', String(site.lon), '--tz', String(derivedTz(s))];
  if (weather.source === 'clear-sky') a.push('--clear-sky', '--turbidity', String(weather.turbidity), '--altitude', String(weather.altitude));
  a.push('--mode', sim.mode, '--quantity', sim.quantities.join(','), '--sides', sim.sides, '--on', sim.on,
    '--sky-density', String(sim.skyDensity), '--patch-samples', String(sim.patchSamples),
    '--ground', String(sim.ground), '--north', String(sim.north), '--offset', String(sim.offset));
  if (sim.cullBackfaces) a.push('--cull-backfaces');
  if (!sim.selfOcclude) a.push('--no-self-occlude');
  if (time.mode === 'instant') a.push('--time', fmtTime(time.date, time.hour));
  if (time.mode === 'range') {
    a.push('--from', fmtTime(time.from.date, time.from.hour), '--to', fmtTime(time.to.date, time.to.hour), '--step', String(time.stepMin));
    if (time.from.date !== time.to.date) a.push('--hours', `${fmtClock(time.from.hour)}-${fmtClock(time.to.hour)}`); // the same hours of every day
  }
  return a;
}

/** Field id -> message (cause and fix). Empty when the settings can run. */
export function validate(s: Settings, hasReceiver: boolean): Record<string, string> {
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
  return e;
}
