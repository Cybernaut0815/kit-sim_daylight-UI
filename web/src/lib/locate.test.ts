import { describe, expect, it, vi } from 'vitest';
import { LOCATE_TIMEOUT_MS, locate } from './locate';

/** A geolocation that answers `answer` (a position, or an error code). */
const geo = (answer: { lat: number; lon: number } | { code: number; message?: string } | 'throws') => {
  const getCurrentPosition = vi.fn((ok: PositionCallback, fail: PositionErrorCallback, _options?: PositionOptions) => {
    if (answer === 'throws') throw new Error('blocked by permissions policy');
    if ('code' in answer) fail({ code: answer.code, message: answer.message ?? '' } as GeolocationPositionError);
    else ok({ coords: { latitude: answer.lat, longitude: answer.lon } } as GeolocationPosition);
  });
  return { getCurrentPosition } as unknown as Geolocation & { getCurrentPosition: typeof getCurrentPosition };
};

describe('locate', () => {
  it("the browser's position, asked once with a 10 s timeout", async () => {
    const g = geo({ lat: 48.137, lon: 11.575 });
    expect(await locate(g, true)).toEqual({ lat: 48.137, lon: 11.575 });
    expect(g.getCurrentPosition).toHaveBeenCalledTimes(1);
    expect(g.getCurrentPosition.mock.calls[0][2]).toMatchObject({ timeout: LOCATE_TIMEOUT_MS });
    expect(LOCATE_TIMEOUT_MS).toBe(10_000);
  });

  it('refused, unavailable, timed out, insecure or missing: a reason in words, never a position', async () => {
    const reason = async (g: Geolocation | undefined, secure = true) => { const r = await locate(g, secure); expect('error' in r).toBe(true); return 'error' in r ? r.error : ''; };
    expect(await reason(geo({ code: 1 }))).toMatch(/^Location access is not allowed.*site settings/);
    expect(await reason(geo({ code: 2 }))).toMatch(/could not find your position/);
    expect(await reason(geo({ code: 3 }))).toMatch(/longer than 10 s/);
    expect(await reason(geo({ code: 9, message: 'odd' }))).toMatch(/gave no position \(odd\)/);
    expect(await reason(geo('throws'))).toMatch(/refused the request \(blocked by permissions policy\)/);
    expect(await reason(geo({ lat: Number.NaN, lon: 0 }))).toMatch(/could not find your position/);
    const insecure = geo({ lat: 1, lon: 2 });
    expect(await reason(insecure, false)).toMatch(/secure page/);
    expect(insecure.getCurrentPosition).not.toHaveBeenCalled(); // nothing asked
    expect(await reason(undefined)).toMatch(/does not share a position/);
    for (const r of await Promise.all([geo({ code: 1 }), geo({ code: 2 }), geo({ code: 3 })].map((g) => locate(g, true)))) expect('error' in r && r.error).toMatch(/Search a place or click the map instead\.$/);
  });
});
