// Calendar helpers for the time panel: day of year <-> 'YYYY-MM-DD', CLI timestamps, suncalc day bounds.
import { getPosition, getTimes } from 'suncalc';
import type { TimePoint } from '../store';

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

/** Minutes of day -> 'HH:MM' (1440 -> '24:00'). */
export const fmtClock = (minutes: number): string => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;

/** Core timestamp 'MM-DDTHH:MM'. 24:00 rolls into the next day (the core rejects hour 24); 12-31 24:00 caps at 23:59
 *  so the range stays inside the year (the end is exclusive, so no step is lost for steps that divide 60). */
export function fmtTime(date: string, minutes: number): string {
  const d = new Date(utc(date).getTime() + minutes * 60e3);
  if (d.getUTCFullYear() !== yearOf(date)) return `12-31T23:59`;
  return `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** Position in the year, in minutes, for ordering two TimePoints. */
export const toMinutes = (t: TimePoint): number => doy(t.date) * 1440 + t.hour;

/** Sunrise / sunset as minutes of standard-time day `tz` at the site, via suncalc. Polar day -> [0, 1440], polar night -> [0, 0]. */
export function dayBounds(lat: number, lon: number, tz: number, date: string): { sunrise: number; sunset: number } {
  const noon = new Date(utc(date).getTime() + (12 - tz) * 36e5); // local standard noon as a UTC instant
  const { sunrise, sunset } = getTimes(noon, lat, lon);
  const local = (d: Date) => (d.getUTCHours() * 60 + d.getUTCMinutes() + tz * 60 + 2880) % 1440;
  if (!sunrise || !sunset || Number.isNaN(sunrise.getTime()) || Number.isNaN(sunset.getTime())) {
    return getPosition(noon, lat, lon).altitude > 0 ? { sunrise: 0, sunset: 1440 } : { sunrise: 0, sunset: 0 };
  }
  return { sunrise: local(sunrise), sunset: local(sunset) };
}
