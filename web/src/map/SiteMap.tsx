// MapLibre site locator: dark OpenFreeMap style repainted from zha tokens, draggable marker, station pins.
import type { FeatureCollection } from 'geojson';
import { Map as MLMap, Marker, setWorkerUrl, type GeoJSONSource, type MapMouseEvent } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { useEffect, useRef, useState } from 'react';
import { cssVar } from '../lib/cssVar';
import type { Station } from '../store';

setWorkerUrl(workerUrl); // MapLibre 6 ships its worker as a separate module; Vite bundles it and hands back the URL

const STYLE = 'https://tiles.openfreemap.org/styles/dark';

interface Props {
  lat: number; lon: number; stations: Station[] | null; selectedHref: string | null; theme: string;
  onPick: (lat: number, lon: number) => void; onStation: (s: Station) => void;
}

// ponytail: blanket repaint by layer type, no hierarchy; a hand-tuned style JSON if the locator map needs more
function repaint(map: MLMap) {
  for (const l of map.getStyle().layers) {
    if (l.id === 'stations') continue;
    switch (l.type) {
      case 'background': map.setPaintProperty(l.id, 'background-color', cssVar('--bg-page')); break;
      case 'fill': {
        const c = cssVar(l.id === 'water' ? '--bg-surface-2' : '--bg-surface-3');
        map.setPaintProperty(l.id, 'fill-color', c);
        map.setPaintProperty(l.id, 'fill-outline-color', c);
        break;
      }
      case 'line': map.setPaintProperty(l.id, 'line-color', cssVar(l.id.startsWith('boundary') ? '--border-default' : '--border-subtle')); break;
      case 'symbol':
        map.setPaintProperty(l.id, 'text-color', cssVar('--chart-text'));
        map.setPaintProperty(l.id, 'text-halo-color', cssVar('--bg-page'));
        break;
    }
  }
}

const fc = (stations: Station[]): FeatureCollection => ({
  type: 'FeatureCollection',
  features: stations.map((s) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [s.lon, s.lat] }, properties: { title: s.title, href: s.href, lat: s.lat, lon: s.lon } })),
});

export function SiteMap(p: Props) {
  const host = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const marker = useRef<Marker | null>(null);
  const latest = useRef(p);
  latest.current = p;
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const map = new MLMap({ container: host.current!, style: STYLE, center: [latest.current.lon, latest.current.lat], zoom: 4, attributionControl: { compact: true } });
    mapRef.current = map;
    map.on('style.load', () => {
      repaint(map);
      map.addSource('stations', { type: 'geojson', data: fc([]) });
      map.addLayer({ id: 'stations', type: 'circle', source: 'stations', paint: { 'circle-radius': 4, 'circle-color': cssVar('--text-disabled'), 'circle-stroke-width': 1, 'circle-stroke-color': cssVar('--bg-page') } });
      setReady(true);
    });
    const hits = (e: MapMouseEvent) => (map.getLayer('stations') ? map.queryRenderedFeatures(e.point, { layers: ['stations'] }) : []);
    map.on('click', (e) => {
      const f = hits(e)[0];
      if (f) {
        const q = f.properties as Record<string, string | number>;
        latest.current.onStation({ title: String(q.title), href: String(q.href), lat: Number(q.lat), lon: Number(q.lon) });
      } else latest.current.onPick(e.lngLat.lat, e.lngLat.lng);
    });
    map.on('mousemove', (e) => { map.getCanvas().style.cursor = hits(e).length ? 'pointer' : ''; });
    return () => { map.remove(); mapRef.current = null; setReady(false); };
  }, []);

  // The marker colour is baked into its SVG: rebuild it when the theme changes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    marker.current?.remove();
    const m = new Marker({ color: cssVar('--accent-fill'), draggable: true }).setLngLat([latest.current.lon, latest.current.lat]).addTo(map);
    m.on('dragend', () => { const { lat, lng } = m.getLngLat(); latest.current.onPick(lat, lng); });
    marker.current = m;
  }, [p.theme]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    marker.current?.setLngLat([p.lon, p.lat]);
    if (!map.getBounds().contains([p.lon, p.lat])) map.easeTo({ center: [p.lon, p.lat], zoom: Math.max(map.getZoom(), 6) }); // a search result far away; a click or drag stays put
  }, [p.lat, p.lon]);

  useEffect(() => {
    const map = mapRef.current;
    if (map && ready) (map.getSource('stations') as GeoJSONSource | undefined)?.setData(fc(p.stations ?? []));
  }, [p.stations, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    repaint(map);
    map.setPaintProperty('stations', 'circle-color', ['case', ['==', ['get', 'href'], p.selectedHref ?? ''], cssVar('--accent'), cssVar('--text-disabled')]);
    map.setPaintProperty('stations', 'circle-stroke-color', cssVar('--bg-page'));
  }, [p.selectedHref, p.theme, ready]);

  return <div ref={host} className="map" role="region" aria-label="Site map: click to set the site, drag the marker, click a station pin to use its weather" />;
}
