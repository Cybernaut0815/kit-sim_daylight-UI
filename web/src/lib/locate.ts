// The user's own position, as the browser knows it (never the server's): one geolocation request per click, so the
// browser asks for access first. Every way it fails is a reason in words and changes nothing.
export type Located = { lat: number; lon: number } | { error: string };

export const LOCATE_TIMEOUT_MS = 10_000;
const MAP = 'Search a place or click the map instead.';
/** GeolocationPositionError codes: 1 denied, 2 unavailable, 3 timeout. */
const WHY: Record<number, string> = {
  1: `Location access is not allowed for this page. Allow it in the browser's site settings (the icon left of the address), then try again. ${MAP}`,
  2: `The browser could not find your position (location services off, or no signal). ${MAP}`,
  3: `Finding your position took longer than ${LOCATE_TIMEOUT_MS / 1000} s. Try again. ${MAP}`,
};

/** Where the browser says the user is; `geo` and `secure`: the browser's own unless given (tests). */
export function locate(geo: Geolocation | undefined = globalThis.navigator?.geolocation, secure: boolean = globalThis.isSecureContext ?? false): Promise<Located> {
  if (!secure) return Promise.resolve({ error: `The browser shares your position only with a secure page (https, or localhost). ${MAP}` });
  if (!geo) return Promise.resolve({ error: `This browser does not share a position. ${MAP}` });
  return new Promise((resolve) => {
    try {
      geo.getCurrentPosition(
        ({ coords: { latitude: lat, longitude: lon } }) => resolve(Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : { error: WHY[2] }),
        (e) => resolve({ error: WHY[e.code] ?? `The browser gave no position (${e.message}). ${MAP}` }),
        { timeout: LOCATE_TIMEOUT_MS, maximumAge: 60_000 },
      );
    } catch (e) { // a permissions policy may refuse it outright
      resolve({ error: `The browser refused the request (${(e as Error).message}). ${MAP}` });
    }
  });
}
