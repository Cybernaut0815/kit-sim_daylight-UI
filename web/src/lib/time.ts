// Calendar helpers for the time panel: day of year <-> 'YYYY-MM-DD', CLI timestamps.
import type { Settings } from '../store';

export const pad = (n: number): string => String(n).padStart(2, '0');
const utc = (date: string) => new Date(`${date}T00:00:00Z`);

export const daysInYear = (year: number): number => (Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / 864e5;
export const yearOf = (date: string): number => utc(date).getUTCFullYear();

/** 0-based day of year of 'YYYY-MM-DD' (its own year's calendar). */
export const doy = (date: string): number => (utc(date).getTime() - Date.UTC(yearOf(date), 0, 1)) / 864e5;

/** Inverse of doy(): clamps into the year. */
export function dateFromDoy(n: number, year: number): string {
  const d = new Date(Date.UTC(year, 0, 1 + Math.min(Math.max(Math.round(n), 0), daysInYear(year) - 1)));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** 'YYYY-MM-DD' -> '21 Jun'. */
export const fmtDay = (date: string): string => utc(date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/** Minutes of day -> 'HH:MM' (1440 -> '24:00'). */
export const fmtClock = (minutes: number): string => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;

/** Core timestamp 'MM-DDTHH:MM' in the core's calendar (2017, or 2016 for a leap weather year). 24:00 rolls into the
 *  next day as the core counts days (Feb 28 24:00 is Feb 29 only in a leap weather year; the core rejects hour 24);
 *  12-31 24:00 caps at 23:59 so the range stays inside the year (the end is exclusive: no step is lost for steps that
 *  divide 60). Feb 29 without a leap weather year stays as it is: the core rejects it and validate() says so. */
export function fmtTime(date: string, minutes: number, leap = false): string {
  const [, m, day] = date.split('-').map(Number), y = leap ? 2016 : 2017;
  if (!leap && m === 2 && day === 29) return `02-29T${pad(Math.floor(minutes / 60) % 24)}:${pad(minutes % 60)}`;
  const d = new Date(Date.UTC(y, m - 1, day) + minutes * 60e3);
  if (d.getUTCFullYear() !== y) return `12-31T23:59`;
  return `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** Snap step of the time controls and the sun-path handles: 10 min for an instant, the range step for a range. */
export const timeStep = (t: Settings['time']): number => (t.mode === 'range' ? t.stepMin : 10);
