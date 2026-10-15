// Weather: source, station choice (nearest first), clear-sky parameters, and the EPW digest charts. Every region keeps
// its size while data loads (a disabled select, a one-line status, chart placeholders).
import { memo, useEffect, useMemo, useState, type Dispatch } from 'react';
import { EpwCharts } from '../charts/EpwCharts';
import { epwMonthly } from '../lib/epw';
import { STATION_INDEX_URL, epwHeader, haversineKm, nearestStations, parseStationIndex, proxyUrl, pvgisUrl } from '../lib/geo';
import { gradientFor } from '../lib/gradients';
import { fmtOffset } from '../lib/zone';
import type { Action, Settings, Station, WeatherSource } from '../store';
import { Alert, NumberField, Segmented } from '../ui';

const SOURCES: readonly (readonly [WeatherSource, string])[] = [['station', 'Nearest station'], ['pvgis', 'PVGIS'], ['upload', 'Upload'], ['clear-sky', 'Clear sky']];

interface Props {
  weather: Settings['weather']; site: Settings['site']; epwMeta: Settings['epwMeta']; viz: Settings['viz'];
  stations: Station[] | null; errors: Record<string, string>; dispatch: Dispatch<Action>;
}

export const WeatherPanel = memo(function WeatherPanel({ weather, site, epwMeta, viz, stations, errors, dispatch }: Props) {
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

  // The EPW (tz for the run, monthly digest for the charts): fetched when the reference changes; the reducer clears epwMeta then.
  const ref = weather.source === 'station' ? weather.station?.href ?? null : weather.source === 'pvgis' ? pvgisUrl(site.lat, site.lon) : null;
  const wants = weather.source !== 'clear-sky' && (weather.source === 'upload' ? !!weather.file : !!ref);
  const shows = weather.source === 'station' || weather.source === 'pvgis' || wants; // the EPW block holds its place while the station is still being found
  useEffect(() => {
    setHeaderError(null);
    if (epwMeta || !wants) return;
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const text = weather.source === 'upload'
          ? await weather.file!.text()
          : await fetch(proxyUrl(ref!), { signal: ctrl.signal }).then(async (r) => { if (!r.ok) throw new Error(`proxy ${r.status}: ${(await r.text()).slice(0, 120)}`); return r.text(); });
        const meta = epwHeader(text);
        dispatch({ type: 'EPW_META', meta: { ...meta, monthly: epwMonthly(text, meta.lat, meta.lon, meta.tz) } });
      } catch (e) {
        if (!ctrl.signal.aborted) setHeaderError(`${(e as Error).message}. Pick another station or upload an EPW.`);
      }
    }, weather.source === 'pvgis' ? 800 : 0); // PVGIS: let the marker settle (30 requests/s per IP)
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [epwMeta, wants, weather.source, weather.file, ref, dispatch]);

  // the file's own place and zone (the run moves the site's times into it), and how far it is from the site
  const km = epwMeta ? haversineKm(site.lat, site.lon, epwMeta.lat, epwMeta.lon) : 0;
  const epwLine = epwMeta ? `EPW ${epwMeta.name || 'unnamed'}: ${epwMeta.lat.toFixed(2)}, ${epwMeta.lon.toFixed(2)}, ${fmtOffset(epwMeta.tz)}${epwMeta.leap ? ', leap year' : ''}${km > 50 ? `, ${Math.round(km).toLocaleString('en-GB')} km from the site` : ''}` : '';
  const sel = weather.station;
  const choices = useMemo(() => {
    const near = stations ? nearestStations(stations, site.lat, site.lon, 8) : [];
    if (sel && !near.some((s) => s.href === sel.href)) near.unshift({ ...sel, km: haversineKm(site.lat, site.lon, sel.lat, sel.lon) }); // a far station picked on the map
    return near;
  }, [stations, site.lat, site.lon, sel]);

  return (
    <section className="stack" aria-labelledby="h-weather">
      <h2 id="h-weather">Weather</h2>
      <Segmented name="weather" label="Weather source" value={weather.source} options={SOURCES} onChange={(source) => dispatch({ type: 'WEATHER', patch: { source } })} />
      {weather.source === 'station' && (
        <div className="field">
          <label className="field__label" htmlFor="station">Weather station</label>
          <select
            className="select" id="station" disabled={!stations || !choices.length} value={sel?.href ?? ''}
            onChange={(e) => { const s = choices.find((x) => x.href === e.target.value); if (s) dispatch({ type: 'WEATHER', patch: { station: s } }); }}
          >
            {!stations ? <option value="">Loading the station index</option>
              : !choices.length ? <option value="">No station in the index</option>
                : choices.map((s) => <option key={s.href} value={s.href}>{s.title.replace(/_/g, ' ')}, {Math.round(s.km ?? 0)} km</option>)}
          </select>
          <span className="field__help line">EnergyPlus weather files, nearest first; the map pins pick one too.</span>
        </div>
      )}
      {weather.source === 'station' && indexError && <Alert title="No station index">{indexError} <button className="btn btn--ghost" type="button" onClick={() => setRetry((n) => n + 1)}>Retry</button></Alert>}
      {weather.source === 'pvgis' && <p className="text-muted lines-2">Typical meteorological year from PVGIS (ERA5, modelled rather than measured), limited to 30 requests per second.</p>}
      {weather.source === 'upload' && (
        <div className="field">
          <label className="field__label" htmlFor="epw-file">EPW file</label>
          <input className="input" id="epw-file" type="file" accept=".epw" onChange={(e) => dispatch({ type: 'WEATHER', patch: { file: e.target.files?.[0] ?? null } })} />
          <span className="field__help line">{weather.file ? weather.file.name : 'An hourly EPW, 8760 or 8784 rows'}</span>
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
      {shows && (headerError
        ? <Alert title="Weather file unusable">{headerError}</Alert>
        : <>
            <p className="text-muted line" title={epwLine}>
              {epwMeta
                ? epwLine
                : <><span className="spinner" aria-hidden="true" /> Reading the weather file</>}
            </p>
            <EpwCharts monthly={epwMeta?.monthly ?? null} sun={gradientFor('sunhours', viz.gradients.sunhours)} rad={gradientFor('radiation', viz.gradients.radiation)} />
          </>)}
      {errors.weather && <p className="field__error">{errors.weather}</p>}
    </section>
  );
});
