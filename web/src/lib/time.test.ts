import { describe, expect, it } from 'vitest';
import { defaultSettings } from '../store';
import { dateFromDoy, daysInYear, doy, fmtClock, fmtTime, timeStep } from './time';

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
    // 24:00 rolls over in the core's calendar, whatever the UI year
    expect(fmtTime('2026-02-28', 1440, true)).toBe('02-29T00:00');
    expect(fmtTime('2026-02-28', 1440, false)).toBe('03-01T00:00');
    expect(fmtTime('2028-02-28', 1440, false)).toBe('03-01T00:00');
    expect(fmtTime('2028-02-29', 600, false)).toBe('02-29T10:00'); // not in the weather year: left for the core to reject
    expect(fmtTime('2028-03-01', 0, true)).toBe('03-01T00:00');
    expect(fmtClock(1440)).toBe('24:00');
    expect(fmtClock(65)).toBe('01:05');
  });
  it('snaps instants to 10 minutes and ranges to their step', () => {
    const t = defaultSettings().time;
    expect(timeStep({ ...t, mode: 'instant', stepMin: 30 })).toBe(10);
    expect(timeStep({ ...t, mode: 'range', stepMin: 30 })).toBe(30);
  });
});
