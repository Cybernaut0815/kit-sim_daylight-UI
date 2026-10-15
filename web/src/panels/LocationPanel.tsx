import { memo, useEffect, useRef, useState, type Dispatch } from 'react';
import { photonReverse, photonSearch, type Place } from '../lib/geo';
import { SiteMap } from '../map/SiteMap';
import type { Action, Settings, Station } from '../store';
import { NumberField, knob } from '../ui';

interface Props {
  site: Settings['site']; tz: number; stations: Station[] | null; selectedHref: string | null; errors: Record<string, string>; theme: string; dispatch: Dispatch<Action>;
}

export const LocationPanel = memo(function LocationPanel({ site, tz, stations, selectedHref, errors, theme, dispatch }: Props) {
  const [q, setQ] = useState('');
  const [places, setPlaces] = useState<Place[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);
  const memo = useRef(new Map<string, Place[]>()); // Photon asks for fair use: one round trip per distinct query
  const seq = useRef(0);

  useEffect(() => {
    const key = q.trim().toLowerCase();
    if (key.length < 3) return setPlaces([]);
    const hit = memo.current.get(key);
    if (hit) return setPlaces(hit);
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      photonSearch(q, { lat: site.lat, lon: site.lon }, ctrl.signal)
        .then((r) => { memo.current.set(key, r); setPlaces(r); setSearchError(null); })
        .catch((e) => { if (!ctrl.signal.aborted) setSearchError(`Place search failed: ${(e as Error).message}. Click the map or type coordinates instead.`); });
    }, 300);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps -- the bias is read when the search fires, not a trigger

  const choose = (v: string) => {
    setQ(v);
    const p = places.find((x) => x.name === v);
    if (p) dispatch({ type: 'SITE', patch: { lat: p.lat, lon: p.lon, place: p.name } });
  };
  const pick = (lat: number, lon: number) => {
    const n = ++seq.current;
    dispatch({ type: 'SITE', patch: { lat, lon, place: `${lat.toFixed(4)}, ${lon.toFixed(4)}` } });
    photonReverse(lat, lon).then((place) => { if (seq.current === n) dispatch({ type: 'SITE', patch: { place } }); }).catch(() => undefined); // coordinates stay as the name
  };

  return (
    <section className="stack" aria-labelledby="h-location">
      <h2 id="h-location">Location</h2>
      <div className="field">
        <label className="field__label" htmlFor="place">Search a place</label>
        <input className="input" id="place" type="search" list="places" autoComplete="off" placeholder="City, address or landmark" value={q} onChange={(e) => choose(e.target.value)} />
        <datalist id="places">{places.map((p) => <option key={`${p.lat},${p.lon}`} value={p.name} />)}</datalist>
        {searchError ? <span className="field__error">{searchError}</span> : <span className="field__help">Or click the map, drag the marker, or type coordinates.</span>}
      </div>
      <SiteMap lat={site.lat} lon={site.lon} stations={stations} selectedHref={selectedHref} theme={theme} onPick={pick} onStation={(station) => dispatch({ type: 'WEATHER', patch: { source: 'station', station } })} />
      <p className="text-muted line" title={site.place}>{site.place}</p>
      <div className="grid" style={knob('--grid-min', '5rem')}>
        <NumberField id="lat" label="Latitude" value={site.lat} step={0.0001} min={-90} max={90} error={errors.lat} onCommit={(v) => { if (Number.isFinite(v) && v !== site.lat) pick(v, site.lon); }} />
        <NumberField id="lon" label="Longitude" value={site.lon} step={0.0001} min={-180} max={180} error={errors.lon} onCommit={(v) => { if (Number.isFinite(v) && v !== site.lon) pick(site.lat, v); }} />
        <NumberField id="tz" label="Time zone" value={tz} step={1} min={-12} max={14} help={site.tz === null ? 'Derived; edit to override' : 'Explicit; clear to derive'} onCommit={(v) => dispatch({ type: 'SITE', patch: { tz: Number.isFinite(v) ? v : null } })} />
      </div>
    </section>
  );
});
