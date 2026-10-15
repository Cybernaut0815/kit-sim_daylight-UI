import { describe, expect, it } from 'vitest';
import { fmtOffset, zoneAt } from './zone';

describe('zoneAt', () => {
  it('gives the civil standard offset and the DST amount of a site', () => {
    expect(zoneAt(40.4168, -3.7038, 2026)).toEqual({ name: 'Europe/Madrid', std: 1, dst: 1 }); // round(lon/15) would say 0
    expect(zoneAt(28.6139, 77.209, 2026)).toEqual({ name: 'Asia/Kolkata', std: 5.5, dst: 0 });
    expect(zoneAt(27.7172, 85.324, 2026)).toEqual({ name: 'Asia/Kathmandu', std: 5.75, dst: 0 });
    expect(zoneAt(-33.8688, 151.2093, 2026)).toEqual({ name: 'Australia/Sydney', std: 10, dst: 1 }); // DST across New Year
    expect(zoneAt(64.146, -21.9422, 2026)).toEqual({ name: 'Atlantic/Reykjavik', std: 0, dst: 0 });
    expect(zoneAt(-34.6037, -58.3816, 2026)).toMatchObject({ std: -3, dst: 0 });
  });
  it('open ocean: the nautical offset without a name', () => {
    const z = zoneAt(0, -30, 2026);
    expect(z.name).toBe('');
    expect(z.std).toBe(-2);
  });
  it('formats offsets', () => {
    expect([fmtOffset(0), fmtOffset(1), fmtOffset(5.5), fmtOffset(5.75), fmtOffset(-3.5), fmtOffset(-10)]).toEqual(['UTC', 'UTC+1', 'UTC+5:30', 'UTC+5:45', 'UTC-3:30', 'UTC-10']);
  });
});
