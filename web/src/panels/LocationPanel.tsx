// Location: place search (results float under the field), the map (click, drag the marker, or click a station pin: the
// site moves there and takes its weather), coordinates, the place's time zone (read only) and model north.
import { memo, useEffect, useRef, useState, type Dispatch, type FocusEvent, type KeyboardEvent } from 'react';
import { photonReverse, photonSearch, type Place } from '../lib/geo';
import { fmtOffset, type Zone } from '../lib/zone';
import { SiteMap } from '../map/SiteMap';
import type { Action, Settings, Station } from '../store';
import { NumberField, ResetButton, Section, knob } from '../ui';

interface Props {
  site: Settings['site']; tz: number; zone: Zone; north: number; stations: Station[] | null; selectedHref: string | null;
  errors: Record<string, string>; theme: string; dispatch: Dispatch<Action>;
}

export const LocationPanel = memo(function LocationPanel({ site, tz, zone, north, stations, selectedHref, errors, theme, dispatch }: Props) {
  const [q, setQ] = useState('');
  const [found, setFound] = useState<{ key: string; places: Place[] }>({ key: '', places: [] }); // the results and the query they answer
  const [open, setOpen] = useState(false); // the results list may show (the field has focus, nothing chosen yet)
  const [searchError, setSearchError] = useState<string | null>(null);
  const memo = useRef(new Map<string, Place[]>()); // Photon asks for fair use: one round trip per distinct query
  const seq = useRef(0);
  const want = useRef<string | null>(null); // Enter came before the answer to this query: take its first place when it lands
  const input = useRef<HTMLInputElement>(null), list = useRef<HTMLDivElement>(null);
  const key = q.trim().toLowerCase(), places = found.places, fresh = found.key === key;

  useEffect(() => {
    if (key.length < 3) return setFound({ key, places: [] });
    const hit = memo.current.get(key);
    if (hit) return setFound({ key, places: hit });
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      photonSearch(q, { lat: site.lat, lon: site.lon }, ctrl.signal)
        .then((r) => { memo.current.set(key, r); setFound({ key, places: r }); setSearchError(null); })
        .catch((e) => { if (!ctrl.signal.aborted) setSearchError(`Place search failed: ${(e as Error).message}. Click the map or type coordinates instead.`); });
    }, 300);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps -- q goes with its key; the bias is read when the search fires, not a trigger

  // The results float under the field in the top layer (a manual popover), so nothing below moves while they come and
  // go; they appear when Photon answers, however long after the last key that is (a datalist did not).
  const showing = open && places.length > 0;
  useEffect(() => {
    const m = list.current, i = input.current;
    if (!m || !i) return;
    if (!showing) { if (m.matches(':popover-open')) m.hidePopover(); return; }
    const place = () => { const r = i.getBoundingClientRect(); m.style.top = `${r.bottom + 4}px`; m.style.left = `${r.left}px`; m.style.width = `${r.width}px`; }; // JS owns its place, as with the readout
    place();
    if (!m.matches(':popover-open')) m.showPopover();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => { window.removeEventListener('scroll', place, true); window.removeEventListener('resize', place); };
  }, [showing, places]);

  const choose = (p: Place) => {
    ++seq.current; // a reverse lookup still on its way must not rename this place
    want.current = null;
    memo.current.set(p.name.trim().toLowerCase(), [p]); // the field now holds its name: no search for it
    setQ(p.name);
    setOpen(false);
    dispatch({ type: 'SITE', patch: { lat: p.lat, lon: p.lon, place: p.name } });
  };
  useEffect(() => {
    if (want.current === null || want.current !== found.key) return;
    want.current = null;
    if (found.places.length) choose(found.places[0]);
  }, [found]); // eslint-disable-line react-hooks/exhaustive-deps -- choose is new every render; the answer is the trigger
  const pick = (lat: number, lon: number) => {
    const n = ++seq.current;
    dispatch({ type: 'SITE', patch: { lat, lon, place: `${lat.toFixed(4)}, ${lon.toFixed(4)}` } });
    photonReverse(lat, lon).then((place) => { if (seq.current === n) dispatch({ type: 'SITE', patch: { place } }); }).catch(() => undefined); // coordinates stay as the name
  };
  const options = () => [...(list.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
  const onFieldKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return; // an input method is still composing the text
    if (e.key === 'Enter') {
      e.preventDefault();
      if (fresh) { if (places.length) choose(places[0]); } // the first place of what is typed, never of an earlier query
      else if (key.length >= 3) want.current = key;
    } else if (e.key === 'ArrowDown' && showing) { e.preventDefault(); options()[0]?.focus(); }
    else if (e.key === 'Escape' && showing) { e.preventDefault(); setOpen(false); } // closes the list; the text stays (a search field clears itself on Escape)
  };
  const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const all = options(), i = all.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const j = i + (e.key === 'ArrowDown' ? 1 : -1); if (j < 0) input.current?.focus(); else all[Math.min(j, all.length - 1)]?.focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); input.current?.focus(); setOpen(false); } // after the focus, which opens the list
  };
  const onLeave = (e: FocusEvent<HTMLDivElement>) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false); }; // focus left the field and its results
  const north0 = ((Math.round(north) % 360) + 360) % 360;

  return (
    <Section id="location" title="Location">
      <div className="field" onBlur={onLeave}>
        <label className="field__label" htmlFor="place">Search a place</label>
        <input
          ref={input} className="input" id="place" type="search" role="combobox" aria-autocomplete="list" aria-controls="place-results" aria-expanded={showing}
          autoComplete="off" placeholder="City, address or landmark" value={q}
          onChange={(e) => { want.current = null; setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onKeyDown={onFieldKey}
        />
        {/* a press keeps the focus in the field (Safari never focuses a button on click, so the field's blur would close
            the list before the click lands); the click still picks */}
        <div ref={list} className="menu" popover="manual" onKeyDown={onListKey} onMouseDown={(e) => e.preventDefault()}>
          <div id="place-results" className="menu__list" role="listbox" aria-label="Places found">
            {places.map((p, i) => (
              <button key={`${i}:${p.name}`} type="button" role="option" aria-selected={false} className="menu__item" onClick={() => choose(p)}><span>{p.name}</span></button>
            ))}
          </div>
        </div>
        {searchError ? <span className="field__error">{searchError}</span> : <span className="field__help">Enter picks the first place. Or click the map, drag the marker, or type coordinates.</span>}
      </div>
      <SiteMap
        lat={site.lat} lon={site.lon} stations={stations} selectedHref={selectedHref} theme={theme} onPick={pick}
        onStation={(station) => { pick(station.lat, station.lon); dispatch({ type: 'WEATHER', patch: { source: 'station', station } }); }}
      />
      <p className="text-muted line" title={site.place}>{site.place}</p>
      <div className="grid" style={knob('--grid-min', '5rem')}>
        <NumberField id="lat" label="Latitude" value={site.lat} step={0.0001} min={-90} max={90} error={errors.lat} onCommit={(v) => { if (Number.isFinite(v) && v !== site.lat) pick(v, site.lon); }} />
        <NumberField id="lon" label="Longitude" value={site.lon} step={0.0001} min={-180} max={180} error={errors.lon} onCommit={(v) => { if (Number.isFinite(v) && v !== site.lon) pick(site.lat, v); }} />
        <div className="field">
          <label className="field__label" htmlFor="tz">Time zone</label>
          <input className="input" id="tz" readOnly value={fmtOffset(tz)} aria-describedby="tz-help" />
          <span className="field__help line" id="tz-help" title={zone.name || 'From the longitude'}>{zone.name || 'From the longitude'}</span>
        </div>
      </div>
      <div className="row-fill">
        <label className="slider-row">
          <span>North</span>
          <input id="north" type="range" min={0} max={359} step={1} value={north0} aria-describedby="north-help" aria-valuetext={`${north0} degrees`} onChange={(e) => dispatch({ type: 'SIM', patch: { north: e.target.valueAsNumber } })} />
          <span className="slider-row__value">{north0}°</span>
        </label>
        <ResetButton what="north" onClick={() => dispatch({ type: 'SIM', patch: { north: 0 } })} />
      </div>
      <p className="field__help" id="north-help">Counter-clockwise from the model's +Y axis (90° = west). Or turn the compass ring of the sun path in the 3D view.</p>
    </Section>
  );
});
