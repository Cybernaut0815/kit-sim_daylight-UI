import { useEffect, useMemo, useState, type Dispatch } from 'react';
import { STATION_INDEX_URL, epwHeader, haversineKm, nearestStations, parseStationIndex, proxyUrl, pvgisUrl } from '../lib/geo';
import type { Action, Settings, Station, WeatherSource } from '../store';
import { Alert, NumberField, Segmented } from '../ui';

const SOURCES: readonly (readonly [WeatherSource, string])[] = [['station', 'Nearest station'], ['pvgis', 'PVGIS'], ['upload', 'Upload'], ['clear-sky', 'Clear sky']];

interface Props { settings: Settings; stations: Station[] | null; errors: Record<string, string>; dispatch: Dispatch<Action> }

export function WeatherPanel({ settings, stations, errors, dispatch }: Props) {
  const { weather, site, epwMeta } = settings;
  const [indexError, setIndexError] = useState<string | null>(null);
  const [headerError, setHeaderError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  // The station index, once per page load (the server caches the 3.8 MB download on disk).
  useEffect(() => {
    if (weather.source !== 'station' || stations) return;
    let gone = false;
    setIndexError(null);
    fetch(proxyUrl(STATION_INDEX_URL))
      .then(async (r) => { if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 120)}`); return r.json(); })
      .then((j) => { if (!gone) dispatch({ type: 'STATIONS', stations: parseStationIndex(j) }); })
      .catch((e) => { if (!gone) setIndexError(`Station index failed (${(e as Error).message}). Retry, or use PVGIS or an upload.`); });
    return () => { gone = true; };
  }, [weather.source, stations, retry, dispatch]);

  // The EPW header (tz for the run, a sanity check): fetched when the reference changes; the reducer clears epwMeta then.
  const ref = weather.source === 'station' ? weather.station?.href ?? null : weather.source === 'pvgis' ? pvgisUrl(site.lat, site.lon) : null;
  const wants = weather.source !== 'clear-sky' && (weather.source === 'upload' ? !!weather.file : !!ref);
  useEffect(() => {
    setHeaderError(null);
    if (epwMeta || !wants) return;
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const text = weather.source === 'upload'
          ? await weather.file!.text()
          : await fetch(proxyUrl(ref!), { signal: ctrl.signal }).then(async (r) => { if (!r.ok) throw new Error(`proxy ${r.status}: ${(await r.text()).slice(0, 120)}`); return r.text(); });
        dispatch({ type: 'EPW_META', meta: epwHeader(text) });
      } catch (e) {
        if (!ctrl.signal.aborted) setHeaderError(`${(e as Error).message}. Pick another station or upload an EPW.`);
      }
    }, weather.source === 'pvgis' ? 800 : 0); // PVGIS: let the marker settle (30 requests/s per IP)
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [epwMeta, wants, weather.source, weather.file, ref, dispatch]);

  const nearest = useMemo(() => (stations ? nearestStations(stations, site.lat, site.lon, 5) : []), [stations, site.lat, site.lon]);
  const sel = weather.station;

  return (
    <section className="stack" aria-labelledby="h-weather">
      <h2 id="h-weather">Weather</h2>
      <Segmented name="weather" label="Weather source" value={weather.source} options={SOURCES} onChange={(source) => dispatch({ type: 'WEATHER', patch: { source } })} />
      {weather.source === 'station' && (stations === null
        ? (indexError
          ? <Alert title="No station index">{indexError} <button className="btn btn--ghost" type="button" onClick={() => setRetry((n) => n + 1)}>Retry</button></Alert>
          : <p className="text-muted"><span className="spinner" aria-hidden="true" /> Loading the station index</p>)
        : sel
          ? <div className="stack stack--tight">
              <div className="cluster">
                <span className="badge badge--info"><span className="dot" />{Math.round(haversineKm(site.lat, site.lon, sel.lat, sel.lon))} km</span>
                <span>{sel.title}</span>
              </div>
              <div className="cluster">
                {nearest.filter((s) => s.href !== sel.href).slice(0, 4).map((s) => (
                  <button key={s.href} className="chip" type="button" onClick={() => dispatch({ type: 'WEATHER', patch: { station: s } })}>{s.title}, {Math.round(s.km!)} km</button>
                ))}
              </div>
            </div>
          : <p className="text-muted">No station in the index. Use PVGIS or an upload.</p>)}
      {weather.source === 'pvgis' && <p className="text-muted">Typical meteorological year from PVGIS (ERA5, modelled rather than measured). Limited to 30 requests per second.</p>}
      {weather.source === 'upload' && (
        <div className="field">
          <label className="field__label" htmlFor="epw-file">EPW file</label>
          <input className="input" id="epw-file" type="file" accept=".epw" onChange={(e) => dispatch({ type: 'WEATHER', patch: { file: e.target.files?.[0] ?? null } })} />
          {weather.file && <span className="field__help">{weather.file.name}</span>}
        </div>
      )}
      {weather.source === 'clear-sky' && (
        <>
          <label className="slider-row">
            <span>Linke turbidity</span>
            <input type="range" min={2} max={7} step={0.1} value={weather.turbidity} onChange={(e) => dispatch({ type: 'WEATHER', patch: { turbidity: e.target.valueAsNumber } })} />
            <span className="slider-row__value">{weather.turbidity.toFixed(1)}</span>
          </label>
          <NumberField id="altitude" label="Site altitude (m)" value={weather.altitude} step={1} help="2 very clear mountain air, 3 clear, 4 to 5 hazy or urban, 6 to 7 polluted" onCommit={(v) => { if (Number.isFinite(v)) dispatch({ type: 'WEATHER', patch: { altitude: v } }); }} />
        </>
      )}
      {wants && (headerError
        ? <Alert title="Weather file unusable">{headerError}</Alert>
        : epwMeta
          ? <p className="text-muted">EPW {epwMeta.name || 'unnamed'}: {epwMeta.lat.toFixed(2)}, {epwMeta.lon.toFixed(2)}, UTC{epwMeta.tz >= 0 ? '+' : ''}{epwMeta.tz}{epwMeta.leap ? ', leap year' : ''}</p>
          : <p className="text-muted"><span className="spinner" aria-hidden="true" /> Reading the EPW header</p>)}
      {errors.weather && <p className="field__error">{errors.weather}</p>}
    </section>
  );
}
