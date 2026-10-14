// Monthly digest of an EPW: sunshine hours (DNI >= 120 W/m2, the WMO sunshine-duration threshold), possible daylight
// hours (sunrise to sunset at the file's site), and the horizontal / normal radiation sums.
import { dateFromDoy, dayBounds } from './time';

export interface EpwMonthly { sunshine: number[]; daylight: number[]; ghi: number[]; dni: number[]; dhi: number[] } // h, h, kWh/m2, kWh/m2, kWh/m2

const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const zeros = () => new Array<number>(12).fill(0);

/** EPW text -> monthly sums; rows start after the 8 header lines, hour by hour from Jan 1; 9999 = missing, skipped. */
export function epwMonthly(text: string, lat: number, lon: number, tz: number): EpwMonthly {
  const rows: string[] = [];
  let from = 0;
  for (let line = 0; from < text.length; line++) {
    const to = text.indexOf('\n', from), l = (to < 0 ? text.slice(from) : text.slice(from, to)).trim();
    if (line >= 8 && l) rows.push(l);
    if (to < 0) break;
    from = to + 1;
  }
  const leap = rows.length >= 8784, days = DAYS.slice();
  if (leap) days[1] = 29;
  const m: EpwMonthly = { sunshine: zeros(), daylight: zeros(), ghi: zeros(), dni: zeros(), dhi: zeros() };
  let r = 0;
  for (let mo = 0; mo < 12; mo++) {
    for (let d = 0; d < days[mo]; d++) {
      for (let h = 0; h < 24; h++, r++) {
        const c = rows[r]?.split(',');
        if (!c || c.length < 16) continue;
        const ghi = Number(c[13]), dni = Number(c[14]), dhi = Number(c[15]); // Wh/m2 over the hour
        if (ghi < 9999) m.ghi[mo] += ghi / 1000;
        if (dni < 9999) { m.dni[mo] += dni / 1000; if (dni >= 120) m.sunshine[mo]++; }
        if (dhi < 9999) m.dhi[mo] += dhi / 1000;
      }
    }
  }
  const year = leap ? 2024 : 2023;
  for (let doy = 0, mo = 0, dm = 0; doy < (leap ? 366 : 365); doy++) {
    const b = dayBounds(lat, lon, tz, dateFromDoy(doy, year));
    m.daylight[mo] += Math.max(0, b.sunset - b.sunrise) / 60;
    if (++dm === days[mo]) { mo++; dm = 0; }
  }
  return m;
}

export const sum = (a: number[]): number => a.reduce((s, v) => s + v, 0);
