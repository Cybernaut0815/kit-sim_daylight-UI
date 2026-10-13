// Site and weather sources: distances, the NREL station index, EPW headers, Photon geocoding, proxy URLs.
import type { EpwMeta, Station } from '../store';

export const STATION_INDEX_URL = 'https://raw.githubusercontent.com/NREL/EnergyPlus/develop/weather/master.geojson';
export const PHOTON = 'https://photon.komoot.io';

/** Server-side download through the allowlisted cache (S3 and PVGIS send no CORS headers). */
export const proxyUrl = (url: string): string => `/proxy?url=${encodeURIComponent(url)}`;

/** PVGIS TMY as EPW. Coordinates rounded to 4 dp so the URL (the server's cache key) is stable while dragging. */
export const pvgisUrl = (lat: number, lon: number): string => `https://re.jrc.ec.europa.eu/api/v5_3/tmy?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}&outputformat=epw`;

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180, dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

interface StationFeature { properties?: { title?: string; epw?: string }; geometry?: { coordinates?: number[] } }

/** NREL master.geojson -> stations. `properties.epw` is an HTML anchor: the href is the .epw URL. */
export function parseStationIndex(geojson: unknown): Station[] {
  const features = ((geojson as { features?: StationFeature[] })?.features ?? []);
  const out: Station[] = [];
  for (const f of features) {
    const href = /href=["']?([^"' >]+)/.exec(f.properties?.epw ?? '')?.[1];
    const [lon, lat] = f.geometry?.coordinates ?? [];
    if (href && Number.isFinite(lat) && Number.isFinite(lon)) out.push({ title: f.properties?.title ?? href.split('/').pop() ?? href, href, lat: lat!, lon: lon! });
  }
  return out;
}

/** The n closest stations, nearest first, each with its distance in km. */
export function nearestStations(index: Station[], lat: number, lon: number, n: number): Station[] {
  // ponytail: full sort of ~2.5k rows per call; a partial select if the index ever grows
  return index.map((s) => ({ ...s, km: haversineKm(lat, lon, s.lat, s.lon) })).sort((a, b) => a.km! - b.km!).slice(0, n);
}

/** EPW LOCATION line -> site metadata. Columns (0-based): 1 city, 3 country, 6 lat, 7 lon, 8 tz. leap = 8784 data rows. */
export function epwHeader(text: string): EpwMeta {
  const nl = text.indexOf('\n');
  const first = (nl < 0 ? text : text.slice(0, nl)).trim().split(',');
  if (first[0]?.toUpperCase() !== 'LOCATION' || first.length < 9) throw new Error('not an EPW file: the first line must be LOCATION,...');
  const [lat, lon, tz] = [6, 7, 8].map((i) => Number(first[i]));
  if (![lat, lon, tz].every(Number.isFinite)) throw new Error('EPW LOCATION line has no numeric latitude, longitude, time zone');
  let rows = 0;
  for (let i = nl; i >= 0; i = text.indexOf('\n', i + 1)) rows++;
  if (!text.endsWith('\n')) rows++;
  return { lat, lon, tz, name: [first[1], first[3]].filter((s) => s && s !== '-').join(', '), leap: rows - 8 >= 8784 };
}

export interface Place { name: string; lat: number; lon: number }

interface PhotonFeature { properties: Record<string, string | undefined>; geometry: { coordinates: [number, number] } }
const placeName = (p: Record<string, string | undefined>) => [...new Set([p.name, p.city, p.state, p.country].filter(Boolean))].join(', ');

export async function photonSearch(q: string, bias?: { lat: number; lon: number }, signal?: AbortSignal): Promise<Place[]> {
  const biasQ = bias ? `&lat=${bias.lat}&lon=${bias.lon}` : '';
  const res = await fetch(`${PHOTON}/api/?q=${encodeURIComponent(q)}&limit=6&lang=en${biasQ}`, { signal });
  if (!res.ok) throw new Error(`Photon search failed (${res.status})`);
  const { features } = (await res.json()) as { features: PhotonFeature[] };
  return features.map((f) => ({ name: placeName(f.properties), lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] }));
}

export async function photonReverse(lat: number, lon: number, signal?: AbortSignal): Promise<string> {
  const res = await fetch(`${PHOTON}/reverse?lat=${lat}&lon=${lon}&lang=en`, { signal });
  if (!res.ok) throw new Error(`Photon reverse failed (${res.status})`);
  const { features } = (await res.json()) as { features: PhotonFeature[] };
  return features[0] ? placeName(features[0].properties) : `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
}
