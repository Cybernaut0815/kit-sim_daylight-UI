// The site's civil time zone: the IANA zone at a lat/lon (@photostructure/tz-lookup, offline, CC0) and, from the
// browser's Intl, its standard UTC offset and daylight-saving amount over a year. The app works in local standard time
// (as EPW files, EnergyPlus and Ladybug do); the DST amount is only shown.
import tzlookup from '@photostructure/tz-lookup';

export interface Zone { name: string; std: number; dst: number } // IANA name ('' = none), standard offset h, DST h (0 = none)

const cache = new Map<string, Zone>();

/** UTC offset in hours of an instant as Intl names it: 'GMT', 'GMT+05:45', 'GMT-03:30'. */
function offsetAt(f: Intl.DateTimeFormat, t: number): number {
  const m = /([+-])(\d{1,2}):?(\d{2})?/.exec(f.formatToParts(t).find((p) => p.type === 'timeZoneName')?.value ?? '');
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) + Number(m[3] ?? 0) / 60) : 0;
}

/** The civil zone at a site. Standard offset = the smallest offset over the year (DST only ever adds; every day is
 *  scanned, so Morocco's Ramadan change and southern summers count), DST = the largest minus it. Open ocean gives an
 *  'Etc/GMT±N' zone: its offset without a name. A failed lookup (a zone the browser does not know) falls back to
 *  round(lon / 15), also without a name. */
export function zoneAt(lat: number, lon: number, year = new Date().getFullYear()): Zone {
  const key = `${lat.toFixed(4)},${lon.toFixed(4)},${year}`;
  let z = cache.get(key);
  if (!z) {
    try {
      const name = tzlookup(lat, lon), f = new Intl.DateTimeFormat('en-US', { timeZone: name, timeZoneName: 'longOffset' });
      let lo = Infinity, hi = -Infinity;
      for (let t = Date.UTC(year, 0, 1, 12); t < Date.UTC(year + 1, 0, 1); t += 864e5) { const o = offsetAt(f, t); lo = Math.min(lo, o); hi = Math.max(hi, o); }
      z = { name: name.startsWith('Etc/') ? '' : name, std: lo, dst: hi - lo };
    } catch {
      z = { name: '', std: Math.round(lon / 15), dst: 0 };
    }
    cache.set(key, z);
  }
  return z;
}

/** Hours -> 'UTC+1', 'UTC+5:30', 'UTC-3:30', 'UTC'. */
export function fmtOffset(h: number): string {
  if (!h) return 'UTC';
  const a = Math.abs(h), m = Math.round((a % 1) * 60);
  return `UTC${h < 0 ? '-' : '+'}${Math.floor(a)}${m ? `:${String(m).padStart(2, '0')}` : ''}`;
}
