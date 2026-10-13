// Shell: app bar, inputs panel, viewport, results panel; owns the model, the per-mesh conversion cache and the run.
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { Group } from 'three';
import { fromThree, runRemote, type ObjMesh } from 'daylight-mesh';
import { buildArgs, derivedTz, validate } from './lib/args';
import { pvgisUrl } from './lib/geo';
import { gradientFor, type Scale } from './lib/gradients';
import { listMeshes, loadFiles } from './lib/loaders';
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

const KEY = 'daylight.settings';
// validate() field -> the control that gets focus
const FOCUS: Record<string, string> = { model: 'model-files', lat: 'lat', lon: 'lon', quantities: 'q-radiation', skyDensity: 'sky-density', timeTo: 'time-to-date', timeDate: 'time-date' };

interface Conv { obj: ObjMesh; areas?: Float64Array; vareas?: Float64Array }

export default function App() {
  const [state, dispatch] = useReducer(reducer, undefined, () => {
    let raw: string | null = null;
    try { raw = localStorage.getItem(KEY); } catch { /* storage blocked: defaults */ }
    return initialState(parseSettings(raw));
  });
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme ?? 'light');
  const [group, setGroup] = useState<Group | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const conv = useRef(new Map<string, Conv>()); // mesh id -> ObjMesh (+ areas on demand): converted once, uploaded once, referenced by id
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    try { localStorage.setItem(KEY, serializeSettings(state.settings)); } catch { /* private mode or quota: settings just do not persist */ }
  }, [state.settings]);

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next; // before React paints, so cssVar() reads the new tokens in the same commit
    setTheme(next);
  };

  const onFiles = async (files: File[]) => {
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
      dispatch({ type: 'LOAD', objects });
    } catch (e) {
      setLoadError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const weightsFor = useCallback((id: string, on: 'faces' | 'vertices') => {
    const c = conv.current.get(id);
    if (!c) return undefined;
    const { positions, indices } = c.obj;
    return on === 'faces' ? (c.areas ??= faceAreas(positions, indices)) : (c.vareas ??= vertexAreas(positions, indices));
  }, []);

  const receivers = state.objects.filter((o) => o.role === 'receiver');

  const onRun = async () => {
    const errors = validate(state.settings, receivers.length > 0);
    dispatch({ type: 'ERRORS', errors });
    const first = Object.keys(errors)[0];
    if (first) return document.getElementById(first === 'weather' ? `weather-${state.settings.weather.source}` : FOCUS[first] ?? first)?.focus();
    const { weather, site, sim } = state.settings;
    const epw = weather.source === 'upload' ? weather.file! : weather.source === 'station' ? { url: weather.station!.href } : weather.source === 'pvgis' ? { url: pvgisUrl(site.lat, site.lon) } : undefined;
    const ctrl = new AbortController();
    abort.current = ctrl;
    dispatch({ type: 'RUN', run: { status: 'running' } });
    try {
      const res = await runRemote('', {
        sensors: receivers.map((o) => conv.current.get(o.id)!.obj),
        context: state.objects.filter((o) => o.role === 'shade').map((o) => conv.current.get(o.id)!.obj),
        epw, args: buildArgs(state.settings),
        fetch: (input, init) => fetch(input, { ...init, signal: ctrl.signal }),
      });
      res.manifest.meshes.forEach((m, i) => {
        const o = receivers[i], want = o && (sim.on === 'faces' ? o.tris : o.verts);
        if (!o || m.count !== want) throw new Error(`${o?.name ?? m.name}: the server returned ${m.count} rows, expected ${want}. Reload the model and run again.`);
      });
      dispatch({ type: 'RUN', run: { status: 'done', result: { ...res, receivers: receivers.map((o) => o.id), on: sim.on } } });
    } catch (e) {
      dispatch({ type: 'RUN', run: ctrl.signal.aborted ? { status: 'idle' } : { status: 'error', message: (e as Error).message } });
    }
  };

  const tz = derivedTz(state.settings);
  const result = state.run.status === 'done' ? state.run.result : null;
  const selectedHref = state.settings.weather.source === 'station' ? state.settings.weather.station?.href ?? null : null;
  const column = result ? Math.min(state.column, result.columns.length - 1) : 0;
  // One colour scale for the viewer and the charts: the quantity's gradient, its legend domain (data range unless
  // overridden) and its problem range, all from the persisted viz settings.
  const scale = useMemo<Scale | null>(() => {
    if (!result) return null;
    const q = result.columns[column].split('_')[0], { gradients, scales, ranges } = state.settings.viz, [dmin, dmax] = globalRange(result.values, column);
    return { gradient: gradientFor(q, gradients[q]), vmin: scales[q]?.min ?? dmin, vmax: scales[q]?.max ?? dmax, lo: ranges[q]?.lo ?? null, hi: ranges[q]?.hi ?? null };
  }, [result, column, state.settings.viz]);
  const probeLabel = state.probe && result
    ? `${state.objects.find((o) => o.id === state.probe!.id)?.name ?? ''}: ${fmtNum(state.probe.value)} ${unitFor(result.columns[column]).value}`
    : null;

  return (
    <div className="app-shell" style={knob('--sidebar-w', '0px')}>
      <header className="app-bar">
        <span className="app-bar__brand">
          <a className="zha-lockup" href="/" aria-label="ZHA CODE, home"><span className="zha-lockup__zha">ZHA</span><span className="zha-lockup__team">CODE</span></a>
          <span className="app-bar__app">Daylight</span>
        </span>
        <span className="app-bar__spacer" />
        <button className="icon-btn icon-btn--ghost" type="button" aria-label="Toggle light or dark theme" aria-pressed={theme === 'dark'} onClick={toggleTheme}>
          <Icon name="contrast" />
        </button>
      </header>
      <main className="app-main" id="main">
        <h1 className="sr-only">Daylight simulation</h1>
        <div className="split fill" style={knob('--split-aside', '24rem')}>
          <div className="split split--aside-start fill" style={knob('--split-aside', '22rem')}>
            <aside className="panel stack" style={knob('--stack-gap', 'var(--space-4)')} aria-label="Inputs">
              <ModelPanel objects={state.objects} selected={state.selected} loading={loading} error={loadError} errors={state.errors} onFiles={onFiles} dispatch={dispatch} />
              <hr className="divider" />
              <LocationPanel site={state.settings.site} tz={tz} stations={state.stations} selectedHref={selectedHref} errors={state.errors} theme={theme} dispatch={dispatch} />
              <hr className="divider" />
              <WeatherPanel settings={state.settings} stations={state.stations} errors={state.errors} dispatch={dispatch} />
              <hr className="divider" />
              <TimePanel time={state.settings.time} site={state.settings.site} tz={tz} errors={state.errors} dispatch={dispatch} />
              <hr className="divider" />
              <SettingsPanel sim={state.settings.sim} run={state.run} hasReceiver={receivers.length > 0} errors={state.errors} onRun={onRun} onCancel={() => abort.current?.abort()} dispatch={dispatch} />
            </aside>
            <Viewer group={group} loading={loading} objects={state.objects} selected={state.selected} hovered={state.hovered} colourBy={state.colourBy} result={result} column={column} scale={scale} bin={state.bin} probeLabel={probeLabel} theme={theme} dispatch={dispatch} />
          </div>
          <aside className="panel stack" aria-label="Results">
            <ResultsPanel run={state.run} objects={state.objects} column={column} colourBy={state.colourBy} hovered={state.hovered} selected={state.selected} probe={state.probe} bin={state.bin} scale={scale} viz={state.settings.viz} weightsFor={weightsFor} dispatch={dispatch} />
          </aside>
        </div>
      </main>
    </div>
  );
}
