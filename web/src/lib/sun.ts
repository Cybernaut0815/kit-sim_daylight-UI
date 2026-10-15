// Sun maths for the 3D sun-path diagram: the core's NOAA sun (solar.cpp, ported line for line so the drawn sun is the
// simulated one), its calendar and steps, diagram-frame vectors, path sampling and the date drag. Pure: no three.js, no DOM.
import type { Settings } from '../store';
import { dateFromDoy, daysInYear, fmtTime } from './time';

export interface Sun { alt: number; azi: number; dec: number; up: boolean } // deg; azi clockwise from true north; alt refracted; up = alt >= 0
export interface Site { lat: number; lon: number; tz: number; leap: boolean } // leap: the core's weather year is a leap year (2016 anchor)

const rad = (d: number) => (d * Math.PI) / 180, deg = (r: number) => (r * 180) / Math.PI;
const pymod = (a: number, m: number) => { const r = a % m; return r < 0 ? r + m : r; }; // JS % == C fmod
const DIM = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31], dim = (m: number, leap: boolean) => DIM[m - 1] + (leap && m === 2 ? 1 : 0);

/** printf("%.2f") as a number: toFixed rounds exact binary ties up, C to even; the only exact ties are odd / 8 (03:00, 15:00 differ). */
export const round2 = (x: number): number => ((x * 8) % 2 === 1 ? (2 * Math.round(x * 50)) / 100 : Number(x.toFixed(2)));

/** solar.cpp sun_noaa in the same operation order: ladybug Sunpath semantics, fixed year 2017 (2016 when leap). */
export function sunNoaa(lat: number, lon: number, tz: number, month: number, day: number, hourFrac: number, leap: boolean): Sun {
  let hour = Math.trunc(hourFrac), minute = Math.round((hourFrac - hour) * 60);
  if (minute === 60) { hour++; minute = 0; }
  let doy = day; for (let m = 1; m < month; m++) doy += dim(m, leap);
  // days_from_1900(2016 | 2017) = 42368 | 42734 (static_assert in solar.cpp)
  const jd = (leap ? 42368 : 42734) + doy + 1 + 2415018.5 + round2((minute + hour * 60) / 1440) - tz / 24, jc = (jd - 2451545) / 36525;
  const L0 = pymod(280.46646 + jc * (36000.76983 + jc * 0.0003032), 360), M = 357.52911 + jc * (35999.05029 - 0.0001537 * jc);
  const e = 0.016708634 - jc * (0.000042037 + 0.0000001267 * jc);
  const C = Math.sin(rad(M)) * (1.914602 - jc * (0.004817 + 0.000014 * jc)) + Math.sin(rad(2 * M)) * (0.019993 - 0.000101 * jc) + Math.sin(rad(3 * M)) * 0.000289;
  const om = rad(125.04 - 1934.136 * jc), lam = rad(L0 + C - 0.00569 - 0.00478 * Math.sin(om));
  const eps = rad(23 + (26 + (21.448 - jc * (46.815 + jc * (0.00059 - jc * 0.001813))) / 60) / 60 + 0.00256 * Math.cos(om));
  const dec = Math.asin(Math.sin(eps) * Math.sin(lam)), t2 = Math.tan(eps / 2), y = t2 * t2;
  const eot = 4 * deg(y * Math.sin(2 * rad(L0)) - 2 * e * Math.sin(rad(M)) + 4 * e * y * Math.sin(rad(M)) * Math.cos(2 * rad(L0)) - 0.5 * y * y * Math.sin(4 * rad(L0)) - 1.25 * e * e * Math.sin(2 * rad(M)));
  const tst = pymod(hourFrac * 60 + eot + 4 * lon - 60 * tz, 1440), H = tst < 0 ? tst / 4 + 180 : tst / 4 - 180, la = rad(lat);
  const zen = Math.acos(Math.sin(la) * Math.sin(dec) + Math.cos(la) * Math.cos(dec) * Math.cos(rad(H)));
  const alt0 = 90 - deg(zen), t = Math.tan(rad(alt0));
  const r = alt0 > 85 ? 0 : alt0 > 5 ? 58.1 / t - 0.07 / (t * t * t) + 0.000086 / (t * t * t * t * t) // refraction, arcseconds
    : alt0 > -0.575 ? 1735 + alt0 * (-518.2 + alt0 * (103.4 + alt0 * (-12.79 + alt0 * 0.711))) : -20.772 / t;
  const alt = alt0 + r / 3600, a = (Math.sin(la) * Math.cos(zen) - Math.sin(dec)) / (Math.cos(la) * Math.sin(zen)); // unrefracted zenith
  const azi = a >= -1 && a <= 1 ? pymod(H > 0 ? deg(Math.acos(a)) + 180 : 540 - deg(Math.acos(a)), 360) : a > 0 ? 180 : 0; // exact noon
  return { alt, azi, dec: deg(dec), up: alt >= 0 };
}

/** parse_hoy: '[YYYY-]MM-DDTHH:MM' -> hour of year; NaN where the core rejects it (hour 24, Feb 29 unless leap, ...). */
export function parseHoy(ts: string, leap: boolean): number {
  const m = /^(?:\d+-)?(\d+)-(\d+)T(\d+):(\d+)$/.exec(ts);
  if (!m) return NaN;
  const [mo, d, h, mi] = m.slice(1).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > dim(mo, leap) || h > 23 || mi > 59) return NaN;
  let hoy = 24 * (d - 1) + h + mi / 60;
  for (let k = 1; k < mo; k++) hoy += 24 * dim(k, leap);
  return hoy;
}

/** hoy_to_date: hour of year -> month, day (1-based), hour of day. */
export function hoyToDate(hoy: number, leap: boolean): { month: number; day: number; hour: number } {
  let d = Math.floor(hoy / 24), month = 1;
  const hour = hoy - d * 24;
  while (month < 12 && d >= dim(month, leap)) d -= dim(month++, leap);
  return { month, day: d + 1, hour };
}

/** The sun the core uses at an hour of year (make_steps -> hoy_to_date -> sun_noaa). NaN hoy -> NaN sun. */
export const sunAt = (site: Site, hoy: number): Sun => {
  const d = hoyToDate(hoy, site.leap);
  return sunNoaa(site.lat, site.lon, site.tz, d.month, d.day, d.hour, site.leap);
};

/** Unit vector towards the sun in the diagram frame: +Y up, true north -Z, east +X (the group's rotation.y = north). */
export const sunDir = (alt: number, azi: number): [number, number, number] => {
  const a = rad(alt), A = rad(azi);
  return [Math.cos(a) * Math.sin(A), Math.sin(a), -Math.cos(a) * Math.cos(A)];
};

/** Inverse of sunDir for any non-zero vector (no normalising needed); azi in [0, 360). */
export const altAzi = (x: number, y: number, z: number): { alt: number; azi: number } =>
  ({ alt: deg(Math.atan2(y, Math.hypot(x, z))), azi: (deg(Math.atan2(x, -z)) + 360) % 360 });

/** Declination (deg) of the sky direction (alt, azi) seen from latitude lat, i.e. the day arc it lies on. */
export const decOf = (lat: number, alt: number, azi: number): number =>
  deg(Math.asin(Math.min(1, Math.max(-1, Math.sin(rad(lat)) * Math.sin(rad(alt)) + Math.cos(rad(lat)) * Math.cos(rad(alt)) * Math.cos(rad(azi))))));

/** The hours of year make_steps evaluates, from the strings buildArgs sends: --time, or --from --to --step plus
 *  --hours from.hour-to.hour when the dates differ. [] for annual, or where the core rejects the input. */
export function stepHoys(t: Settings['time'], leap: boolean): number[] {
  if (t.mode === 'annual') return [];
  if (t.mode === 'instant') { const h = parseHoy(fmtTime(t.date, t.hour, leap), leap); return Number.isNaN(h) ? [] : [h]; }
  const nh = leap ? 8784 : 8760, step = t.stepMin / 60, t0 = parseHoy(fmtTime(t.from.date, t.from.hour, leap), leap);
  const t1 = Math.min(parseHoy(fmtTime(t.to.date, t.to.hour, leap), leap), nh), daily = t.from.date !== t.to.date, out: number[] = [];
  if (!(t0 >= 0 && t0 < nh && t1 > t0 && step > 0)) return out;
  for (let k = 0; ; k++) {
    const hoy = t0 + k * step;
    if (hoy >= t1 - 1e-9) break;
    let hod = (hoy - 24 * Math.floor(hoy / 24)) * 60; // minutes into the day: the --hours window
    if (hod >= 1440 - 1e-6) hod -= 1440; // a midnight step that lands at 24n - eps (step 10 min), as the core
    if (!daily || (hod >= t.from.hour - 1e-6 && hod < t.to.hour - 1e-6)) out.push(hoy);
  }
  return out;
}

export interface Path { min: number[]; xyz: number[]; alt: number[] } // per sample: minute of day, unit vector (3 numbers), altitude deg

/** One day of the core's calendar ('MM-DD') every stepMin minutes, 00:00 to 24:00 inclusive; empty where the core rejects the date. */
export function dayPath(site: Site, mmdd: string, stepMin = 5): Path {
  const h0 = parseHoy(`${mmdd}T00:00`, site.leap), p: Path = { min: [], xyz: [], alt: [] };
  if (Number.isNaN(h0)) return p;
  for (let k = 0, n = Math.ceil(1440 / stepMin); k <= n; k++) {
    const m = Math.min(k * stepMin, 1440), s = sunAt(site, h0 + m / 60);
    p.min.push(m); p.xyz.push(...sunDir(s.alt, s.azi)); p.alt.push(s.alt);
  }
  return p;
}

/** The sun at one minute of day on every day of the core's year (the analemma). */
export function analemma(site: Site, minute: number): { day: number[]; xyz: number[]; alt: number[] } {
  const p = { day: [] as number[], xyz: [] as number[], alt: [] as number[] };
  for (let d = 0; d < (site.leap ? 366 : 365); d++) {
    const s = sunAt(site, d * 24 + minute / 60);
    p.day.push(d); p.xyz.push(...sunDir(s.alt, s.azi)); p.alt.push(s.alt);
  }
  return p;
}

/** Declination at 12:00 per UI calendar day of `year`, as the core reads that date; NaN where the core rejects it
 *  (Feb 29 of a leap UI year without a leap weather year). What the date drag searches. */
export const decTable = (site: Site, year: number): number[] =>
  Array.from({ length: daysInYear(year) }, (_, d) => sunAt(site, parseHoy(fmtTime(dateFromDoy(d, year), 720, site.leap), site.leap)).dec);

/** Sunrise and sunset in minutes of the standard-time day, as the sun path draws them: where the refracted altitude
 *  crosses 0, interpolated between 5-min samples. Polar day [0, 1440]; polar night, or a date the core rejects, [0, 0].
 *  Sunset before sunrise means it falls after midnight (the day band wraps). */
export function dayBounds(site: Site, date: string): { sunrise: number; sunset: number } {
  const p = dayPath(site, fmtTime(date, 0, site.leap).slice(0, 5), 5);
  let sunrise = NaN, sunset = NaN;
  for (let i = 1; i < p.alt.length; i++) {
    const a = p.alt[i - 1], b = p.alt[i], at = p.min[i - 1] + ((p.min[i] - p.min[i - 1]) * a) / (a - b);
    if (a < 0 && b >= 0) sunrise = at;
    if (a >= 0 && b < 0) sunset = at;
  }
  if (Number.isNaN(sunrise) && Number.isNaN(sunset)) return p.alt[0] >= 0 ? { sunrise: 0, sunset: 1440 } : { sunrise: 0, sunset: 0 };
  return { sunrise: Number.isNaN(sunrise) ? 0 : Math.round(sunrise), sunset: Number.isNaN(sunset) ? 1440 : Math.round(sunset) };
}

/** Minute of day of the sample of a day path nearest in direction to u (a unit vector of the diagram frame). */
export function nearestMinute(p: Path, u: number[]): number {
  let best = -Infinity, at = NaN;
  for (let i = 0; i < p.min.length; i++) {
    const d = p.xyz[3 * i] * u[0] + p.xyz[3 * i + 1] * u[1] + p.xyz[3 * i + 2] * u[2];
    if (d > best) { best = d; at = p.min[i]; }
  }
  return at;
}

export interface DayDrag { half: 1 | -1; latch: boolean } // +1 rising half (Dec -> Jun solstice), -1 falling half

const ext = (dec: number[]) => { let hi = 0, lo = 0; dec.forEach((v, d) => { if (v > dec[hi]) hi = d; if (v < dec[lo]) lo = d; }); return { hi, lo }; };

/** The half-year a date drag starts in; on a solstice day the one that runs forward in time. */
export function startDayDrag(dec: number[], d: number): DayDrag {
  const { hi, lo } = ext(dec), n = dec.length;
  if (Math.abs(d - hi) <= 1) return { half: -1, latch: false }; // June solstice
  if (Math.min(Math.abs(d - lo), n - Math.abs(d - lo)) <= 1) return { half: 1, latch: false }; // December solstice
  return { half: d <= hi || d >= lo ? 1 : -1, latch: false };
}

/** Day under a dragged day arc: nearest declination to `target` within the current half-year (mutates s). Overshooting a
 *  solstice arc by more than m deg flips the half once (the date runs on through the solstice); back inside re-arms it.
 *  Keeps `cur` unless clearly beaten (0.01 deg), skips NaN days, searches [first, last] only. Inside bounds narrower than
 *  the year (one end of a multi-day range) the rising half is two stretches (Jan..Jun, late Dec): only the one next to
 *  cur counts, and the half flips only at a solstice inside the bounds, so an end never jumps across New Year. -1 when
 *  no day qualifies. */
export function dragDay(dec: number[], target: number, s: DayDrag, cur: number, first = 0, last = dec.length - 1, m = 1.5): number {
  const { hi, lo } = ext(dec), max = dec[hi], min = dec[lo], year = first === 0 && last === dec.length - 1;
  const inHalf = (d: number) => (d === hi || d === lo || (d <= hi || d >= lo) === (s.half === 1)) && (year || s.half === -1 || (d <= hi) === (2 * cur < hi + lo));
  const sol = target > max ? hi : lo;
  if (target > max + m || target < min - m) { if (!s.latch && sol >= first && sol <= last && inHalf(sol)) { s.half = s.half === 1 ? -1 : 1; s.latch = true; } }
  else if (target <= max && target >= min) s.latch = false;
  const t = Math.min(max, Math.max(min, target));
  let best = cur >= first && cur <= last && Number.isFinite(dec[cur]) && inHalf(cur) ? cur : -1;
  for (let d = first; d <= last; d++)
    if (Number.isFinite(dec[d]) && inHalf(d) && (best < 0 || Math.abs(dec[d] - t) < Math.abs(dec[best] - t) - 0.01)) best = d;
  return best;
}
