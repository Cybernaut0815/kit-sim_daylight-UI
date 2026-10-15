// Shell: app bar, inputs panel, viewport with the run bar, results panel; owns the model, the per-mesh conversion
// cache, the run (by click or Auto), the theme mode and the view preferences (sidebar widths, Auto).
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { Group } from 'three';
import { fromThree, runRemote, type ObjMesh } from 'daylight-mesh';
import { Splitter } from './Splitter';
import { buildArgs, derivedTz, epwRef, validate } from './lib/args';
import { gradientFor, type Scale } from './lib/gradients';
import { listMeshes, loadFiles } from './lib/loaders';
import { buildTree, type TreeNode } from './lib/tree';
import { faceAreas, fmtNum, globalRange, unitFor, vertexAreas } from './lib/result';
import { LocationPanel } from './panels/LocationPanel';
import { ModelPanel } from './panels/ModelPanel';
import { ResultsPanel } from './panels/ResultsPanel';
import { SettingsPanel } from './panels/SettingsPanel';
import { TimePanel } from './panels/TimePanel';
import { WeatherPanel } from './panels/WeatherPanel';
import { initialState, parseSettings, reducer, serializeSettings, type ObjectRow } from './store';
import { Icon, knob } from './ui';
import { Viewer } from './viewer/Viewer';
import type { SunView } from './viewer/sunpath';

const KEY = 'daylight.settings', THEME_KEY = 'daylight.theme', UI_KEY = 'daylight.ui';
// One id per browser tab for the server's per-client job limit (sessionStorage: a new tab is a new client).
const CLIENT_ID = (() => { try { return sessionStorage.getItem('daylight.client') ?? (sessionStorage.setItem('daylight.client', crypto.randomUUID()), sessionStorage.getItem('daylight.client')!); } catch { return crypto.randomUUID(); } })();
// validate() field -> the control that gets focus
const FOCUS: Record<string, string> = { model: 'model-files', lat: 'lat', lon: 'lon', quantities: 'q-radiation', skyDensity: 'sky-density', timeTo: 'time-to-date', timeDate: 'time-date' };
// View preferences, stored apart from the settings: sidebar widths (px; 22rem / 24rem defaults), the sun path, Auto run.
const UI = { widths: { left: 352, right: 384 }, sunPath: true, auto: false }, MIN_W = 240, MAX_W = 640;

type ThemeMode = 'auto' | 'light' | 'dark';
const media = window.matchMedia('(prefers-color-scheme: dark)');
const readTheme = (): ThemeMode => { try { const m = localStorage.getItem(THEME_KEY); return m === 'light' || m === 'dark' ? m : 'auto'; } catch { return 'auto'; } };
const readUi = (): typeof UI => { try { const p = JSON.parse(localStorage.getItem(UI_KEY) ?? 'null') ?? {}; return { ...UI, ...p, widths: { ...UI.widths, ...p.widths } }; } catch { return UI; } };

interface Conv { obj: ObjMesh; areas?: Float64Array; vareas?: Float64Array }

export default function App() {
  const [state, dispatch] = useReducer(reducer, undefined, () => {
    let raw: string | null = null;
    try { raw = localStorage.getItem(KEY); } catch { /* storage blocked: defaults */ }
    return initialState(parseSettings(raw));
  });
  const [mode, setMode] = useState<ThemeMode>(readTheme);
  const [system, setSystem] = useState<'light' | 'dark'>(media.matches ? 'dark' : 'light');
  const theme = mode === 'auto' ? system : mode;
  const [ui, setUi] = useState(readUi);
  const [group, setGroup] = useState<Group | null>(null);
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const conv = useRef(new Map<string, Conv>()); // mesh id -> ObjMesh (+ areas on demand): converted once, uploaded once, referenced by id
  const abort = useRef<AbortController | null>(null);
  const busy = useRef(false), lastKey = useRef<string | null>(null); // one run per tab; the key of the last run started
  const [ended, setEnded] = useState(0); // bumped when a run ends, so Auto re-checks with the settings of that moment
  const [slow, setSlow] = useState(false); // the run in flight has taken over 0.3 s
  const [sunScale, setSunScale] = useState(1); // the sun path's radius over the one fitted to the model; 1 on every model load
  const onSunPath = useCallback((on: boolean) => setUi((u) => ({ ...u, sunPath: on })), []);

  useEffect(() => {
    try { localStorage.setItem(KEY, serializeSettings(state.settings)); } catch { /* private mode or quota: settings just do not persist */ }
  }, [state.settings]);
  useEffect(() => {
    try { localStorage.setItem(UI_KEY, JSON.stringify(ui)); } catch { /* same */ }
  }, [ui]);
  // The browser / OS setting drives the theme while the mode is "auto" (index.html applies it before the first paint).
  useEffect(() => {
    const onChange = (e: MediaQueryListEvent) => {
      const t = e.matches ? 'dark' : 'light';
      if (mode === 'auto') document.documentElement.dataset.theme = t;
      setSystem(t);
    };
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [mode]);

  const nextMode: ThemeMode = mode === 'auto' ? 'light' : mode === 'light' ? 'dark' : 'auto';
  const cycleTheme = () => {
    document.documentElement.dataset.theme = nextMode === 'auto' ? system : nextMode; // before React paints, so cssVar() reads the new tokens in the same commit
    try { if (nextMode === 'auto') localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, nextMode); } catch { /* storage blocked */ }
    setMode(nextMode);
  };

  const onFiles = useCallback(async (files: File[]) => { // stable: the memoised Model panel keeps its props across runs
    setLoading(true);
    setLoadError(null);
    try {
      const g = await loadFiles(files);
      g.updateMatrixWorld(true);
      conv.current.clear();
      const meshes = listMeshes(g);
      const role = meshes.length === 1 ? 'receiver' : 'none'; // a single mesh runs as is; a scene is assigned by hand
      // ponytail: every mesh converted at load (one pass, about 2x geometry memory); convert per role lazily if huge models hurt
      const objects: ObjectRow[] = meshes.map((m) => {
        const id = crypto.randomUUID();
        m.userData.id = id;
        const obj = fromThree([m])[0];
        obj.id = id;
        obj.name = m.name;
        conv.current.set(id, { obj });
        const pos = m.geometry.attributes.position;
        return { id, name: m.name, tris: (m.geometry.index ? m.geometry.index.count : pos.count) / 3, verts: pos.count, role };
      });
      setGroup(g);
      setSunScale(1);
      setTree(buildTree(g, meshes));
      dispatch({ type: 'LOAD', objects });
    } catch (e) {
      setLoadError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  const weightsFor = useCallback((id: string, on: 'faces' | 'vertices') => {
    const c = conv.current.get(id);
    if (!c) return undefined;
    const { positions, indices } = c.obj;
    return on === 'faces' ? (c.areas ??= faceAreas(positions, indices)) : (c.vareas ??= vertexAreas(positions, indices));
  }, []);

  const s = state.settings;
  const receivers = state.objects.filter((o) => o.role === 'receiver'), shades = state.objects.filter((o) => o.role === 'shade');
  const running = state.run.status === 'running' || state.run.status === 'queued';
  const args = buildArgs(s), epw = epwRef(s);
  // Everything the server's response cache keys on: an equal key gives an equal result.
  const runKey = JSON.stringify([args, epw instanceof File ? [epw.name, epw.size, epw.lastModified] : epw?.url ?? null, receivers.map((o) => o.id), shades.map((o) => o.id)]);
  const annual = s.time.mode === 'annual';
  const autoOn = ui.auto && !annual && receivers.length > 0;
  const meshKey = useRef(''); // the receivers and shades now: a job started for others reports no error here
  meshKey.current = JSON.stringify([receivers.map((o) => o.id), shades.map((o) => o.id)]);

  const onRun = async (auto = false) => {
    if (busy.current) return; // one job per tab: Auto re-checks when it ends, the button is disabled meanwhile
    lastKey.current = runKey;
    const errors = validate(s, receivers.length > 0);
    dispatch({ type: 'ERRORS', errors });
    const first = Object.keys(errors)[0];
    if (first) {
      if (!auto) document.getElementById(first === 'weather' ? `weather-${s.weather.source}` : FOCUS[first] ?? first)?.focus(); // Auto shows the errors, never steals focus
      return;
    }
    busy.current = true;
    const t0 = performance.now(), ctrl = new AbortController(), mine = meshKey.current;
    const slowT = setTimeout(() => setSlow(true), 300); // an Auto run that takes a while says so in the Results
    abort.current = ctrl;
    dispatch({ type: 'RUN', run: { status: 'queued', position: 0 } });
    try {
      const res = await runRemote('', {
        sensors: receivers.map((o) => conv.current.get(o.id)!.obj),
        context: shades.map((o) => conv.current.get(o.id)!.obj),
        epw, args, signal: ctrl.signal, clientId: CLIENT_ID,
        onStatus: (job) => dispatch({ type: 'RUN', run: job.state === 'queued' ? { status: 'queued', position: job.position ?? 0 } : { status: 'running' } }),
      });
      res.manifest.meshes.forEach((m, i) => {
        const o = receivers[i], want = o && (s.sim.on === 'faces' ? o.tris : o.verts);
        if (!o || m.count !== want) throw new Error(`${o?.name ?? m.name}: the server returned ${m.count} rows, expected ${want}. Reload the model and run again.`);
      });
      dispatch({ type: 'RUN', run: { status: 'done', result: { ...res, receivers: receivers.map((o) => o.id), on: s.sim.on, key: runKey, elapsed: (performance.now() - t0) / 1000 } } });
    } catch (e) {
      if (ctrl.signal.aborted) lastKey.current = null; // cancelled: the same inputs may run again (Auto included)
      dispatch({ type: 'RUN', run: ctrl.signal.aborted || meshKey.current !== mine ? { status: 'idle' } : { status: 'error', message: (e as Error).message } });
    } finally {
      busy.current = false;
      clearTimeout(slowT);
      setSlow(false);
      setEnded((n) => n + 1);
    }
  };
  // Auto: run as soon as the inputs differ from the last run and nothing is in flight. While a run is on its way the
  // changes pile up in runKey; when it ends (ended) the latest settings get one run. Never aborted: a cancel would leave
  // a job on the server and trip the per-client limit, and an instant run is over in milliseconds anyway.
  // A cleared result (roles changed back, a model reloaded) re-arms it for the same inputs.
  useEffect(() => {
    if (!state.result && state.run.status === 'idle') lastKey.current = null;
    if (autoOn && !busy.current && runKey !== lastKey.current) void onRun(true);
  }, [autoOn, runKey, ended, state.result, state.run.status]); // eslint-disable-line react-hooks/exhaustive-deps -- onRun is this render's closure: it reads the settings runKey came from

  const tz = derivedTz(s), leap = s.weather.source !== 'clear-sky' && !!s.epwMeta?.leap; // the core's weather year (clear sky: never leap)
  const sunSite = useMemo(() => ({ lat: s.site.lat, lon: s.site.lon, tz, leap }), [s.site.lat, s.site.lon, tz, leap]);
  const sunView = useMemo<SunView | null>(() => (ui.sunPath ? { site: sunSite, north: s.sim.north, time: s.time, scale: sunScale } : null), [ui.sunPath, sunSite, s.sim.north, s.time, sunScale]);
  const result = state.result;
  const stale = !!result && !running && result.key !== runKey && !(autoOn && runKey !== lastKey.current); // unless Auto is about to run
  const selectedHref = s.weather.source === 'station' ? s.weather.station?.href ?? null : null;
  const column = result ? Math.min(state.column, result.columns.length - 1) : 0;
  // One colour scale for the viewer and the charts: the quantity's gradient, its legend domain (data range unless
  // overridden), its problem range and the two range colours, all from the persisted viz settings.
  const scale = useMemo<Scale | null>(() => {
    if (!result) return null;
    const q = result.columns[column].split('_')[0], { gradients, scales, ranges, colors } = s.viz, [dmin, dmax] = globalRange(result.values, column);
    return { gradient: gradientFor(q, gradients[q]), vmin: scales[q]?.min ?? dmin, vmax: scales[q]?.max ?? dmax, lo: ranges[q]?.lo ?? null, hi: ranges[q]?.hi ?? null, below: colors.below, above: colors.above };
  }, [result, column, s.viz]);
  const probeLabel = state.probe && result
    ? `${state.objects.find((o) => o.id === state.probe!.id)?.name ?? ''}: ${fmtNum(state.probe.value)} ${unitFor(result.columns[column]).value}`
    : null;
  const busyBar = running && !autoOn; // a click run: the button waits and Cancel shows; Auto runs do not flash them

  return (
    <div className="app-shell" style={knob('--sidebar-w', '0px')}>
      <header className="app-bar">
        <span className="app-bar__brand">
          <a className="zha-lockup" href="/" aria-label="ZHA CODE, home"><span className="zha-lockup__zha">ZHA</span><span className="zha-lockup__team">CODE</span></a>
          <span className="app-bar__app">Daylight</span>
        </span>
        <span className="app-bar__spacer" />
        <a className="btn btn--ghost" href="/docs" target="_blank" rel="noreferrer" title="API documentation (Swagger UI); machine-readable at /openapi.json">API</a>
        <button className="icon-btn icon-btn--ghost" type="button" aria-label={`Theme: ${mode === 'auto' ? `follows the system, now ${system}` : mode}. Switch to ${nextMode === 'auto' ? 'system' : nextMode}`} title={`Theme: ${mode === 'auto' ? `system (${system})` : mode}`} onClick={cycleTheme}>
          <Icon name="contrast" />
        </button>
      </header>
      <main className="app-main" id="main">
        <h1 className="sr-only">Daylight simulation</h1>
        <div className="split fill" style={knob('--split-aside', `${ui.widths.right}px`)}>
          <div className="split split--aside-start fill" style={knob('--split-aside', `${ui.widths.left}px`)}>
            <div className="panel-wrap">
              <aside className="panel stack" style={knob('--stack-gap', 'var(--space-4)')} aria-label="Inputs">
                <ModelPanel tree={tree} objects={state.objects} selected={state.selected} loading={loading} error={loadError} errors={state.errors} onFiles={onFiles} dispatch={dispatch} />
                <hr className="divider" />
                <LocationPanel site={s.site} tz={tz} stations={state.stations} selectedHref={selectedHref} errors={state.errors} theme={theme} dispatch={dispatch} />
                <hr className="divider" />
                <WeatherPanel weather={s.weather} site={s.site} epwMeta={s.epwMeta} viz={s.viz} stations={state.stations} errors={state.errors} dispatch={dispatch} />
                <hr className="divider" />
                <TimePanel time={s.time} site={s.site} tz={tz} leap={leap} errors={state.errors} dispatch={dispatch} sunPath={ui.sunPath} sunScale={sunScale} onSunPath={onSunPath} onSunScale={setSunScale} />
                <hr className="divider" />
                <SettingsPanel sim={s.sim} errors={state.errors} dispatch={dispatch} />
              </aside>
              <Splitter side="left" value={ui.widths.left} min={MIN_W} max={MAX_W} defaultValue={UI.widths.left} label="Inputs panel width" onChange={(left) => setUi((u) => ({ ...u, widths: { ...u.widths, left } }))} />
            </div>
            <Viewer group={group} loading={loading} objects={state.objects} selected={state.selected} hovered={state.hovered} colourBy={state.colourBy} result={result} column={column} scale={scale} bin={state.bin} probeLabel={probeLabel} theme={theme} dispatch={dispatch} sun={sunView}>
              {/* right-aligned, the button's label never changes and Cancel appears on the left: the tickbox stays put;
                  progress shows in the Results run line */}
              <div className="cluster cluster--end">
                {busyBar && <button className="btn btn--ghost" type="button" onClick={() => abort.current?.abort()}>Cancel</button>}
                <label title={annual ? 'Annual runs are not repeated automatically' : 'Runs the simulation whenever the date, time, location or a setting changes'}>
                  <input type="checkbox" id="auto-run" checked={ui.auto} disabled={annual} aria-describedby={annual ? 'auto-run-why' : undefined} onChange={(e) => setUi((u) => ({ ...u, auto: e.target.checked }))} /> Run on every change
                  {annual && <span id="auto-run-why" className="sr-only">Annual runs are not repeated automatically.</span>}
                </label>
                <button className="btn btn--primary" type="button" disabled={!receivers.length || busyBar} aria-busy={busyBar} onClick={() => void onRun()}>Run simulation</button>
              </div>
            </Viewer>
          </div>
          <div className="panel-wrap">
            <aside className="panel stack" aria-label="Results">
              <ResultsPanel result={result} run={state.run} error={state.error} stale={stale} auto={autoOn && !slow} objects={state.objects} column={column} colourBy={state.colourBy} hovered={state.hovered} selected={state.selected} probe={state.probe} bin={state.bin} scale={scale} viz={s.viz} weightsFor={weightsFor} dispatch={dispatch} />
            </aside>
            <Splitter side="right" value={ui.widths.right} min={MIN_W} max={MAX_W} defaultValue={UI.widths.right} label="Results panel width" onChange={(right) => setUi((u) => ({ ...u, widths: { ...u.widths, right } }))} />
          </div>
        </div>
      </main>
    </div>
  );
}
