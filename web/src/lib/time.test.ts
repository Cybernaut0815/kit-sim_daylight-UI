import { describe, expect, it } from 'vitest';
import { defaultSettings } from '../store';
import { dateFromDoy, dayBounds, daysInYear, doy, fmtClock, fmtTime, timeStep } from './time';

describe('day of year', () => {
  it('round-trips through the calendar', () => {
    expect(doy('2025-01-01')).toBe(0);
    expect(doy('2025-12-31')).toBe(364);
    expect(doy('2024-12-31')).toBe(365);
    expect(daysInYear(2024)).toBe(366);
    expect(dateFromDoy(171, 2025)).toBe('2025-06-21');
    expect(dateFromDoy(doy('2025-06-21'), 2025)).toBe('2025-06-21');
    expect(dateFromDoy(-5, 2025)).toBe('2025-01-01');
    expect(dateFromDoy(400, 2025)).toBe('2025-12-31');
  });
});

describe('timestamps', () => {
  it('formats the core timestamp and rolls 24:00 into the next day', () => {
    expect(fmtTime('2025-06-21', 750)).toBe('06-21T12:30');
    expect(fmtTime('2025-06-21', 1440)).toBe('06-22T00:00');
    expect(fmtTime('2025-12-31', 1440)).toBe('12-31T23:59');
    expect(fmtClock(1440)).toBe('24:00');
    expect(fmtClock(65)).toBe('01:05');
  });
  it('snaps instants to 10 minutes and ranges to their step', () => {
    const t = defaultSettings().time;
    expect(timeStep({ ...t, mode: 'instant', stepMin: 30 })).toBe(10);
    expect(timeStep({ ...t, mode: 'range', stepMin: 30 })).toBe(30);
  });
});

describe('dayBounds', () => {
  it('London midsummer in standard time (UTC)', () => {
    const b = dayBounds(51.5074, -0.1278, 0, '2025-06-21');
    expect(b.sunrise).toBeGreaterThan(3 * 60 + 30);
    expect(b.sunrise).toBeLessThan(4 * 60);
    expect(b.sunset).toBeGreaterThan(20 * 60);
    expect(b.sunset).toBeLessThan(20 * 60 + 40);
  });
  it('shifts with the zone and handles polar day and night', () => {
    const utc = dayBounds(52.5, 13.4, 0, '2025-03-21'), cet = dayBounds(52.5, 13.4, 1, '2025-03-21');
    expect(cet.sunrise - utc.sunrise).toBe(60);
    expect(dayBounds(78, 15, 1, '2025-06-21')).toEqual({ sunrise: 0, sunset: 1440 });
    expect(dayBounds(78, 15, 1, '2025-12-21')).toEqual({ sunrise: 0, sunset: 0 });
  });
});
