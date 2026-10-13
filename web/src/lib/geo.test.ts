import { describe, expect, it } from 'vitest';
import { epwHeader, haversineKm, nearestStations, parseStationIndex, proxyUrl, pvgisUrl } from './geo';

describe('distances', () => {
  it('London to Paris is about 344 km', () => {
    expect(haversineKm(51.5074, -0.1278, 48.8566, 2.3522)).toBeCloseTo(343.5, 0);
  });
  it('nearest sorts and annotates km', () => {
    const idx = [
      { title: 'far', href: 'f', lat: 0, lon: 0 },
      { title: 'near', href: 'n', lat: 51.2, lon: -0.2 },
      { title: 'mid', href: 'm', lat: 48.9, lon: 2.3 },
    ];
    const n = nearestStations(idx, 51.5, -0.1, 2);
    expect(n.map((s) => s.title)).toEqual(['near', 'mid']);
    expect(n[0].km).toBeLessThan(40);
  });
});

describe('station index', () => {
  it('pulls the href out of the anchor string and swaps [lon, lat]', () => {
    const geojson = {
      features: [
        { properties: { title: 'Berlin', epw: '<a href=https://energyplus-weather.s3.amazonaws.com/x/DEU_Berlin.epw>Download Weather File</a>' }, geometry: { coordinates: [13.4, 52.5] } },
        { properties: { title: 'no epw', epw: '' }, geometry: { coordinates: [1, 2] } },
        { properties: { title: 'quoted', epw: '<a href="https://h/q.epw">Download</a>' }, geometry: { coordinates: [3, 4] } },
      ],
    };
    const s = parseStationIndex(geojson);
    expect(s).toHaveLength(2);
    expect(s[0]).toEqual({ title: 'Berlin', href: 'https://energyplus-weather.s3.amazonaws.com/x/DEU_Berlin.epw', lat: 52.5, lon: 13.4 });
    expect(s[1].href).toBe('https://h/q.epw');
    expect(parseStationIndex(null)).toEqual([]);
  });
});

describe('EPW header', () => {
  const head = 'LOCATION,Berlin,-,DEU,IWEC Data,103840,52.47,13.40,1.0,49.0\n' + 'DESIGN CONDITIONS,0\n'.repeat(7);
  it('reads lat, lon, tz, name and the leap flag from the row count', () => {
    const m = epwHeader(head + '1,1,1,1,0\n'.repeat(8760));
    expect(m).toMatchObject({ lat: 52.47, lon: 13.4, tz: 1, name: 'Berlin, DEU', leap: false });
    expect(epwHeader(head + '1,1,1,1,0\n'.repeat(8784)).leap).toBe(true);
  });
  it('accepts the PVGIS header shape', () => {
    expect(epwHeader('LOCATION,unknown,-,unknown,ECMWF/ERA,unknown,52.52,13.41,1,47\n').tz).toBe(1);
  });
  it('rejects non-EPW text', () => {
    expect(() => epwHeader('<!doctype html>')).toThrow(/LOCATION/);
    expect(() => epwHeader('LOCATION,a,b,c,d,e,x,y,z')).toThrow(/numeric/);
  });
});

describe('urls', () => {
  it('encodes the proxied url and rounds PVGIS coordinates', () => {
    expect(pvgisUrl(52.52001, 13.405)).toBe('https://re.jrc.ec.europa.eu/api/v5_3/tmy?lat=52.5200&lon=13.4050&outputformat=epw');
    expect(proxyUrl('https://a/b?c=1&d=2')).toBe('/proxy?url=https%3A%2F%2Fa%2Fb%3Fc%3D1%26d%3D2');
  });
});
