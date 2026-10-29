// Shell: app bar, inputs panel, the models' views with the run bar, results panel; owns the models (up to four, each in
// its own USD viewer, its meshes converted once), the per-mesh conversion cache, the runs (one batch per click or Auto,
// the models one after another), the comparison (one colour scale over every model), the theme mode and the view
// preferences (sidebar widths, Auto, the views side by side or stacked, linked cameras).
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { Object3D } from 'three';
import { runRemote, type ObjMesh, type RemoteManifest } from 'daylight-mesh';
import type { LocalFile } from 'usd-viewer';
import { Splitter } from './Splitter';
import { buildArgs, derivedTz, epwRef, validate, weatherLeap } from './lib/args';
import { zoneAt } from './lib/zone';
import { extract } from './lib/extract';
import { scaleFor, type Scale } from './lib/gradients';
import { loadFiles, png } from './lib/loaders';
import { opticsArgs, readKey, resolveOptics, runSwitches, type TextureStats } from './lib/optics';
import { rowNames } from './lib/tree';
import { toUsda } from './lib/usda';
import { faceAreas, fmtNum, unionRange, unitFor, vertexAreas } from './lib/result';
import { link, type SavedView } from './lib/views';
import { settled } from './mcp/bridge';
import { UUID, connect, type Ctl } from './mcp/tools';
import { InfoButton } from './panels/InfoPanel';
import { LocationPanel } from './panels/LocationPanel';
import { MaterialsPanel } from './panels/MaterialsPanel';
import { ModelPanel } from './panels/ModelPanel';
import { ResultsPanel, type Compared } from './panels/ResultsPanel';
import { SettingsPanel } from './panels/SettingsPanel';
import { TimePanel } from './panels/TimePanel';
import { WeatherPanel } from './panels/WeatherPanel';
import { inFlight, initialState, parseSettings, reducer, runBatch, serializeSettings, type Model, type ObjectRow, type Role, type RunResult } from './store';
import { Icon, LETTERS, Segmented, Tag, knob } from './ui';
import { Viewer } from './viewer/Viewer';
import { download, type ExportMode, type Format, type PickedModel } from './viewer/download';
import { DownloadMenu, ViewsMenu } from './viewer/Views';
import type { SunView } from './viewer/sunpath';
import { readTexture, viewer } from './viewer/usd';

const KEY = 'daylight.settings', THEME_KEY = 'daylight.theme', UI_KEY = 'daylight.ui';
// One id per browser tab for the server's per-client job limit (sessionStorage: a new tab is a new client).
const CLIENT_ID = (() => { try { return sessionStorage.getItem('daylight.client') ?? (sessionStorage.setItem('daylight.client', crypto.randomUUID()), sessionStorage.getItem('daylight.client')!); } catch { return crypto.randomUUID(); } })();
// validate() field -> the control that gets focus
const FOCUS: Record<string, string> = { model: 'model-files', lat: 'lat', lon: 'lon', quantities: 'q-radiation', skyDensity: 'sky-density', timeTo: 'time-to-date', timeDate: 'time-date', materials: 'materials-status' };
// View preferences, stored apart from the settings: sidebar widths (px; 22rem / 24rem defaults), the sun path, Auto run,
// the subdivision level (the viewer's: 0 = the control cage, -1 = auto, 1..3; every model alike), two or three views
// side by side or stacked, linked cameras.
const UI = { widths: { left: 352, right: 384 }, sunPath: true, auto: false, subdiv: 0, split: 'side' as 'side' | 'stacked', link: true }, MIN_W = 240, MAX_W = 640;
export type UiPrefs = typeof UI;
// Which page this is: index.html declares data-kit (kit-ui), zha.html data-brand (zha-ui).
const KIT = !!document.documentElement.dataset.kit;

type ThemeMode = 'auto' | 'light' | 'dark';
const media = window.matchMedia('(prefers-color-scheme: dark)');
const readTheme = (): ThemeMode => { try { const m = localStorage.getItem(THEME_KEY); return m === 'light' || m === 'dark' ? m : 'auto'; } catch { return 'auto'; } };
const readUi = (): typeof UI => { try { const p = JSON.parse(localStorage.getItem(UI_KEY) ?? 'null') ?? {}; return { ...UI, ...p, widths: { ...UI.widths, ...p.widths } }; } catch { return UI; } };

// A mesh's conversion, kept with its model's slot; make: an instanced shade, built on first use
interface Conv { slot: number; obj?: ObjMesh; make?: () => ObjMesh; areas?: Float64Array; vareas?: Float64Array }
const objOf = (c: Conv) => (c.obj ??= c.make!());
/** A view's model as the app holds it: the viewer's object per row id, the model's own names by prim path (glb / gltf /
 *  obj), a load in progress or its problem, and the open counter (bumped per opened model: the tree resets and the camera
 *  frames; a variant switch keeps both). */
export interface Pane { meshes: ReadonlyMap<string, Object3D>; names: ReadonlyMap<string, string>; loading: boolean; loadError: string | null; stage: number }
const NO_PANE: Pane = { meshes: new Map(), names: new Map(), loading: false, loadError: null, stage: 0 };
const NO_STATS: ReadonlyMap<string, TextureStats | null> = new Map();

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
  const [panes, setPanes] = useState<Readonly<Record<number, Pane>>>({}); // by slot
  const pane = useCallback((slot: number, patch: Partial<Pane> | ((p: Pane) => Partial<Pane>)) => setPanes((all) => {
    const p = all[slot] ?? NO_PANE;
    return { ...all, [slot]: { ...p, ...(typeof patch === 'function' ? patch(p) : patch) } };
  }), []);
  const conv = useRef(new Map<string, Conv>()); // mesh id -> ObjMesh (+ areas on demand): converted once, uploaded once, referenced by id
  const dropConv = (slot: number) => { for (const [id, c] of conv.current) if (c.slot === slot) conv.current.delete(id); };
  const abort = useRef<AbortController | null>(null);
  const jobs = useRef<Record<number, AbortController>>({}); // per slot, its job on its way: removing the model ends it
  const busy = useRef(false), held = useRef(false); // one batch of runs per tab; a click waiting for the materials
  const lastKey = useRef<Record<number, string | null>>({}); // per slot: the key of the last run started
  const [ended, setEnded] = useState(0); // bumped when a batch ends, so Auto re-checks with the settings of that moment
  const [slow, setSlow] = useState(false); // the batch in flight has taken over 0.3 s
  const [sunScale, setSunScale] = useState(1); // the sun path's radius over the one fitted to the model; 1 on every model load
  const [texStats, setTexStats] = useState<Readonly<Record<number, ReadonlyMap<string, TextureStats | null>>>>({}); // per slot (each core numbers its files from /drop/1), by readKey (null: unreadable)
  const reading = useRef(false); // one texture at a time: one decoded image in memory
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
  const setTheme = (m: ThemeMode) => {
    document.documentElement.dataset.theme = m === 'auto' ? system : m; // before React paints, so cssVar() reads the new tokens in the same commit
    try { if (m === 'auto') localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, m); } catch { /* storage blocked */ }
    setMode(m);
  };

  // Of each open stage, by slot: what a re-read needs, and the files as picked (a USD download packs them).
  const model = useRef<Record<number, { mpu: number; own: ReadonlyMap<string, string>; picked: PickedModel }>>({});
  const models = useRef(state.models); // the models now, for the stable callbacks
  models.current = state.models;
  const subdiv = useRef(ui.subdiv);
  subdiv.current = ui.subdiv;
  const [views, setViews] = useState<SavedView[]>([]); // views saved in the app: this session, every view, never in a file

  // A model's drawn meshes -> rows, their conversions and the viewer's objects: after open(), and after a variant switch.
  // roles: the old rows' roles by path (a new mesh is 'none'; a row hidden with the eye or H stays); without them a lone
  // mesh is the receiver.
  const readStage = async (slot: number, roles?: ReadonlyMap<string, Role>) => {
    const { el: usd } = viewer(slot), { mpu, own } = model.current[slot];
    const found = extract(usd.three.items(), usd.three.root, mpu, roles && ((p) => roles.has(p)));
    // An instanced mesh's own path is Hydra's. A point instancer's prototype is re-rooted as <prototype>/ForInstancer<hash>:
    // without that segment it is the prototype prim the tree shows; its row also answers to the instancer, which is what
    // the viewer selects for a click on a copy. Native instances are prims of their own: every copy's path is kept.
    const picks = await Promise.all(found.map((e) => (e.instances ? usd.usd.resolvePick(e.item.rid, 0).catch(() => null) : null)));
    const seen = new Set<string>(), paths: string[] = [], copies: (string[] | undefined)[] = [];
    for (const [i, e] of found.entries()) {
      const p = picks[i];
      let path = p?.instancer ? e.item.path.split('/').filter((s) => !s.startsWith('ForInstancer')).join('/') : p?.path ?? e.item.path;
      for (let k = 2, base = path; seen.has(path); k++) path = `${base}_${k}`; // one prototype of two instancers
      seen.add(path);
      paths.push(path);
      copies.push(!p ? undefined : p.instancer ? [path, p.instancer]
        : await Promise.all(Array.from({ length: e.instances }, (_, j) => usd.usd.resolvePick(e.item.rid, j).then((r) => r?.path ?? path, () => path))));
    }
    const lone: Role = found.length === 1 && !found[0].instances ? 'receiver' : 'none'; // a single mesh runs as is; a scene is assigned by hand
    const labels = rowNames(paths, own), objects: ObjectRow[] = [], map = new Map<string, Object3D>();
    dropConv(slot); // after the awaits: a run started meanwhile still found its meshes
    found.forEach((e, i) => {
      const id = crypto.randomUUID(), name = labels[i], kept = roles ? roles.get(paths[i]) ?? 'none' : lone;
      // The core names a mesh by its id (--optics ID/SLOT); the label stays the row's.
      conv.current.set(id, e.obj ? { slot, obj: Object.assign(e.obj, { id, name: id }) } : { slot, make: () => Object.assign(e.make!(), { id, name: id }) });
      map.set(id, e.item.object!);
      objects.push({ id, name, path: paths[i], tris: e.tris, verts: e.verts, role: kept === 'receiver' && e.instances ? 'none' : kept, materials: e.materials, ...(e.instances ? { instances: e.instances } : {}), ...(copies[i] ? { paths: copies[i] } : {}) });
    });
    return { objects, map };
  };

  const onFiles = useCallback(async (slot: number, picked: File[]) => { // stable: the memoised Model panel keeps its props across runs
    // macOS metadata (._x, .DS_Store, __MACOSX/) is never part of a model: an AppleDouble '._site.usda' would even be taken as the root layer
    const files = picked.filter((f) => !f.name.startsWith('.') && !/(^|\/)__MACOSX\//.test(f.webkitRelativePath));
    if (!files.length) return;
    const { el: usd } = viewer(slot);
    pane(slot, { loading: true, loadError: null });
    let opened = false;
    try {
      // USD opens as picked (a folder keeps its layout, so references into subfolders resolve); glb / gltf / obj become a
      // USDA layer first, with its textures as PNG files beside it, so every model takes the same path.
      // ponytail: a folder with several top-level USD files opens the first by name; add a root chooser when that is a real case
      let own = new Map<string, string>(), source: LocalFile[];
      const warnings: string[] = [];
      if (files.some((f) => /\.usd[acz]?$/i.test(f.name))) {
        source = files.map((f) => ({ path: f.webkitRelativePath || f.name, file: f }));
      } else {
        const usda = toUsda(await loadFiles(files, (m) => warnings.push(m)));
        own = usda.names;
        const stem = files.find((f) => /\.(glb|gltf|obj)$/i.test(f.name))?.name.replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_') || 'model';
        source = [{ path: `${stem}.usda`, file: new File(usda.parts, `${stem}.usda`) }];
        for (const [path, t] of usda.textures) {
          try { source.push({ path, file: await png(t.image, path.slice(path.lastIndexOf('/') + 1)) }); } catch { warnings.push(`Texture ${path} could not be read.`); }
        }
      }
      const kept: [string, File][] = source.map((f) => [f.path, f.file]);
      // open() closes the current stage first: drop its rows and conversions now, so nothing hovers, probes or runs a
      // model that is no longer drawn (its view leaves the linked cameras). A failure before this point keeps the model.
      dropConv(slot);
      held.current = false; // a click held for the old model's materials
      pane(slot, { meshes: new Map(), names: new Map() });
      dispatch({ type: 'LOAD', slot, objects: [] });
      const logged = usd.session.log.length, info = await usd.open(source);
      opened = true;
      model.current[slot] = { mpu: info.metersPerUnit, own, picked: { files: kept, root: info.url.replace(/^\/drop\/\d+\//, ''), info } };
      // Eye toggles, H / Shift+H and variant choices go to the session layer: never saved, nothing to save.
      const session = (await usd.usd.layers()).find((l) => l.session);
      if (session) await usd.usd.setEditTarget(session.identifier);
      // The bare viewer shows its messages nowhere: a referenced file that was not picked, or a failed page, still
      // resolves open() with part of the model. Say so, and keep what loaded.
      const problems = [...usd.session.log.slice(logged).filter((m) => m.level === 'error').map((m) => m.message), ...warnings];
      const { objects, map } = await readStage(slot);
      if (!objects.length) throw new Error(problems[0] ?? 'No visible meshes in this model.');
      pane(slot, { meshes: map, names: own });
      setSunScale(1);
      dispatch({ type: 'LOAD', slot, objects, name: info.url.replace(/^.*\//, '').replace(/\.\w+$/, '') });
      if (problems.length) pane(slot, { loadError: problems.slice(0, 3).join(' ') });
    } catch (e) {
      pane(slot, { loadError: (e as Error).message });
    } finally {
      pane(slot, (p) => ({ loading: false, stage: p.stage + (opened ? 1 : 0) }));
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- readStage reads refs only

  // A variant switch or a subdivision level (session layer, not saved) changes what is drawn: re-read the model's meshes,
  // keeping each path's role. Every such edit resolves once the view has the new meshes.
  const reread = useCallback(async (slot: number, edit: () => Promise<unknown>) => {
    pane(slot, { loading: true, loadError: null });
    try {
      await edit();
      const rows = models.current.find((m) => m.slot === slot)?.objects ?? [];
      if (!rows.length) return; // no model yet: the level applies to the next one
      const { objects, map } = await readStage(slot, new Map(rows.map((o) => [o.path, o.role])));
      pane(slot, { meshes: map });
      dispatch({ type: 'RELOAD', slot, objects });
    } catch (e) {
      pane(slot, { loadError: (e as Error).message });
    } finally {
      pane(slot, { loading: false });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- readStage reads refs only
  const onVariant = useCallback((slot: number, path: string, set: string, variant: string) => void reread(slot, () => viewer(slot).el.usd.setVariant(path, set, variant)), [reread]);
  // The viewers' refinement, one level for every model so they are drawn and run alike: catmullClark / loop meshes drawn
  // (and so simulated) as their smooth surface, creases included.
  const onSubdiv = useCallback((level: number) => {
    setUi((u) => ({ ...u, subdiv: level }));
    for (const m of models.current) { const { el } = viewer(m.slot); void reread(m.slot, () => el.ready.then(() => el.usd.setComplexity(level))); }
  }, [reread]);
  /** Per mesh, over the model's level: a level, or null = back to the model's. Prims that cannot refine are skipped. */
  const onRefine = useCallback((slot: number, paths: string[], level: number | null) => void reread(slot, async () => {
    const { usd } = viewer(slot).el;
    for (const p of paths) await (level === null ? usd.clearRefinement(p) : usd.setRefinement(p, true, level)).catch(() => {});
  }), [reread]);
  // The stored level, once each core is up (a new one starts at 0; this lands before its first open: the same promise,
  // registered first). It then holds across that core's models.
  const slots = state.models.map((m) => m.slot).join();
  useEffect(() => {
    for (const m of models.current) {
      const { el } = viewer(m.slot);
      el.ready.then(() => { if (el.session.refineLevel !== subdiv.current) void el.usd.setComplexity(subdiv.current); }, () => {});
    }
  }, [slots]);
  /** A model goes: its view, its results and its job on its way (deleted on the server; the batch goes on); its element and
   *  core stay for the next model in its slot (dispose() is final). */
  const onRemove = useCallback((slot: number) => {
    dropConv(slot);
    jobs.current[slot]?.abort();
    delete model.current[slot];
    delete lastKey.current[slot];
    setPanes(({ [slot]: _gone, ...rest }) => rest);
    dispatch({ type: 'REMOVE', slot });
    void viewer(slot).el.close().catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- dropConv reads a ref only

  const weightsFor = useCallback((id: string, on: 'faces' | 'vertices') => {
    const c = conv.current.get(id);
    if (!c) return undefined;
    const { positions, indices } = objOf(c);
    return on === 'faces' ? (c.areas ??= faceAreas(positions, indices)) : (c.vareas ??= vertexAreas(positions, indices));
  }, []);
  const meshOf = useCallback((id: string) => { const c = conv.current.get(id); return c && objOf(c); }, []); // a row's mesh as run (model metres, Z up)

  const s = state.settings;
  // Each run mesh's optics per face slot, and the textures its materials still wait for (the diffuse ones only while the
  // reflectance counts), per model. A model's viewer `materials` change only in a flush, and every flush that can change
  // a binding is followed by a re-read of the stage, so its rows key it: kept per slot while its inputs are the same.
  const physical = s.sim.mode === 'physical', reflect = physical && s.sim.bounces > 0;
  const opticsOf = useRef(new Map<number, { inputs: unknown[]; value: ReturnType<typeof resolveOptics> }>());
  const optics = state.models.map((m) => {
    const inputs = [m.objects, m.optics, texStats[m.slot] ?? NO_STATS, reflect], had = opticsOf.current.get(m.slot);
    if (had && had.inputs.every((x, i) => x === inputs[i])) return had.value;
    const value = resolveOptics(m.objects, viewer(m.slot).materials, texStats[m.slot] ?? NO_STATS, m.optics, reflect);
    opticsOf.current.set(m.slot, { inputs, value });
    return value;
  });
  // The textures are read (decoded in a worker) only while their numbers count: physical mode with Transmission or
  // Reflections on; a default or Ladybug run never waits for them.
  const live = physical && (s.sim.transmission || reflect), materialsReady = !live || optics.every((o) => !o.unread.length);
  useEffect(() => {
    const k = optics.findIndex((o) => o.unread.length), r = optics[k]?.unread[0];
    if (!live || !r || reading.current) return; // the read in flight lands first, then the next starts
    reading.current = true;
    const slot = state.models[k].slot;
    void readTexture(viewer(slot).el, r).then((t) => { reading.current = false; setTexStats((all) => ({ ...all, [slot]: new Map(all[slot] ?? NO_STATS).set(readKey(r), t) })); });
  }); // every render: cheap when nothing is unread or a read is in flight
  // Per model: its receivers and shades, its run arguments, and everything the server's response cache keys on (an equal
  // key gives an equal result).
  const epw = epwRef(s), base = buildArgs(s), weather = epw instanceof File ? [epw.name, epw.size, epw.lastModified] : epw?.url ?? null;
  const per = state.models.map((m, i) => {
    const receivers = m.objects.filter((o) => o.role === 'receiver'), shades = m.objects.filter((o) => o.role === 'shade');
    const ids = [receivers.map((o) => o.id), shades.map((o) => o.id)], args = [...base, ...opticsArgs(optics[i].meshes, optics[i].fallback, s.sim)];
    return { m, receivers, shades, args, mesh: JSON.stringify(ids), key: JSON.stringify([args, weather, ...ids]) };
  });
  const meshKeys = useRef<Record<number, string>>({}); // per slot, its receivers and shades now: a job started for others reports nothing
  meshKeys.current = Object.fromEntries(per.map((p) => [p.m.slot, p.mesh]));
  const autoOn = ui.auto && per.some((p) => p.receivers.length > 0); // every mode: an annual run is a fraction of a second too

  // One batch per click (every model with a receiver) or per Auto check (those whose inputs changed): the models' jobs
  // one after another under one cancel; each result lands as its job ends.
  const onRun = async (auto = false) => {
    if (busy.current) return; // one batch per tab: Auto re-checks when it ends, the button is disabled meanwhile
    const todo = per.filter((p) => p.receivers.length && (!auto || p.key !== lastKey.current[p.m.slot])); // no receiver: not run
    for (const p of todo) lastKey.current[p.m.slot] = p.key;
    const errors = validate(s, per.some((p) => p.receivers.length > 0), materialsReady);
    dispatch({ type: 'ERRORS', errors });
    const first = Object.keys(errors)[0];
    if (first) {
      if (first === 'materials') { for (const p of todo) lastKey.current[p.m.slot] = null; if (!auto) held.current = true; } // nothing else wrong: held, not refused, it runs once the materials are read
      if (!auto) { // Auto shows the errors, never steals focus
        const el = document.getElementById(first === 'weather' ? `weather-${s.weather.source}` : FOCUS[first] ?? first);
        for (let d = el?.closest('details'); d; d = d.parentElement?.closest('details')) d.open = true; // a collapsed section opens on its error
        el?.focus();
      }
      return;
    }
    if (!todo.length) return;
    busy.current = true;
    const ctrl = new AbortController(), slowT = setTimeout(() => setSlow(true), 300); // an Auto batch that takes a while says so in the Results
    abort.current = ctrl;
    for (const p of todo) dispatch({ type: 'RUN', slot: p.m.slot, run: { status: 'queued', position: 0 } }); // the later ones wait their turn
    const names = new Map(state.models.flatMap((m) => m.objects.map((o) => [o.id, o.name])));
    try {
      await runBatch(todo.map((p) => {
        const slot = p.m.slot, mine = () => meshKeys.current[slot] === p.mesh; // its model is still the one submitted
        return {
          slot,
          // right before its job: re-loaded, re-assigned or removed since the click (a re-read swaps the conversions before React commits the rows)
          ready: () => mine() && [...p.receivers, ...p.shades].every((o) => conv.current.has(o.id)),
          run: async (signal: AbortSignal) => {
            const t0 = performance.now(); // its own round trip, not the models' before it
            const own = (jobs.current[slot] = new AbortController()), off = () => own.abort(); // the batch's cancel, or its model removed
            signal.addEventListener('abort', off);
            try {
              const res = await runRemote('', {
                sensors: p.receivers.map((o) => objOf(conv.current.get(o.id)!)),
                context: p.shades.map((o) => objOf(conv.current.get(o.id)!)),
                epw, args: p.args, signal: own.signal, clientId: CLIENT_ID,
                onStatus: (job) => { if (mine()) dispatch({ type: 'RUN', slot, run: job.state === 'queued' ? { status: 'queued', position: job.position ?? 0 } : { status: 'running' } }); },
              });
              res.manifest.meshes.forEach((g, i) => {
                const o = p.receivers[i], want = o && (s.sim.on === 'faces' ? o.tris : o.verts);
                if (!o || g.count !== want) throw new Error(`${o?.name ?? g.name}: the server returned ${g.count} rows, expected ${want}. Reload the model and run again.`);
              });
              if (!mine()) throw new Error('changed'); // its model changed during the job: runBatch ends it idle, never a new model's result
              const { values_b64: _decoded, ...manifest } = res.manifest as RemoteManifest & { values_b64?: string }; // decoded into values already: not kept twice
              dispatch({ type: 'RUN', slot, run: { status: 'done', result: { ...res, manifest, receivers: p.receivers.map((o) => o.id), on: s.sim.on, key: p.key, elapsed: (performance.now() - t0) / 1000, switches: runSwitches(s.sim) } } });
            } finally {
              signal.removeEventListener('abort', off);
              if (jobs.current[slot] === own) delete jobs.current[slot];
            }
          },
        };
      }), ctrl.signal, (slot, end) => {
        if (end === 'idle') lastKey.current[slot] = null; // cancelled or changed: the same inputs may run again (Auto included)
        // The server and the core name a mesh by its id: say the row's name (a job id matches no row and stays)
        dispatch({ type: 'RUN', slot, run: end === 'idle' ? { status: 'idle' } : { status: 'error', message: end.message.replace(UUID, (id) => names.get(id) ?? id) } });
      });
    } finally {
      busy.current = false;
      clearTimeout(slowT);
      setSlow(false);
      setEnded((k) => k + 1);
    }
  };
  // Auto: run as soon as a model's inputs differ from its last run and nothing is in flight. While a batch is on its way
  // the changes pile up in the keys; when it ends (ended) the latest settings run the models that changed. Never
  // aborted: a cancel would leave a job on the server and trip the per-client limit, and an instant run is over in
  // milliseconds anyway. A cleared result (roles changed back, a model reloaded) re-arms it for the same inputs.
  const keys = per.map((p) => p.key).join('\n');
  useEffect(() => {
    for (const m of state.models) if (!m.result && m.run.status === 'idle') lastKey.current[m.slot] = null;
    if (autoOn && !busy.current && per.some((p) => p.receivers.length && p.key !== lastKey.current[p.m.slot])) void onRun(true);
  }, [autoOn, keys, ended, state.models]); // eslint-disable-line react-hooks/exhaustive-deps -- onRun is this render's closure: it reads the settings the keys came from
  // Nothing waits for the materials any more (read, or Transmission and Reflections off): Auto re-checks (ended), a click
  // held for them runs.
  useEffect(() => {
    if (!materialsReady) return;
    setEnded((k) => k + 1);
    if (held.current) { held.current = false; void onRun(); }
  }, [materialsReady]); // eslint-disable-line react-hooks/exhaustive-deps -- onRun as above

  // Linked cameras over the views that show a model (one opening a model leaves the set, so its own framing spreads
  // nowhere); the active view leads whenever the set changes (linked on, a model in or out).
  const loaded = state.models.filter((m) => (panes[m.slot]?.meshes.size ?? 0) > 0).map((m) => m.slot);
  useEffect(() => {
    if (!ui.link || loaded.length < 2) return;
    const els = loaded.map((k) => viewer(k).el);
    return link(els, els[loaded.indexOf(state.active)]); // an empty active tab: the first leads
  }, [ui.link, loaded.join()]); // eslint-disable-line react-hooks/exhaustive-deps -- the lead counts only when the set changes

  const zone = useMemo(() => zoneAt(s.site.lat, s.site.lon), [s.site.lat, s.site.lon]); // the site's civil zone (offline lookup)
  const tz = derivedTz(s), leap = weatherLeap(s);
  const sunSite = useMemo(() => ({ lat: s.site.lat, lon: s.site.lon, tz, leap }), [s.site.lat, s.site.lon, tz, leap]);
  const sunView = useMemo<SunView | null>(() => (ui.sunPath ? { site: sunSite, north: s.sim.north, time: s.time, scale: sunScale } : null), [ui.sunPath, sunSite, s.sim.north, s.time, sunScale]);
  const selectedHref = s.weather.source === 'station' ? s.weather.station?.href ?? null : null;
  // The comparison: the result column by name (the reference: the first model in slot order with a result), and one
  // colour scale for the views and the charts over every model's values: the quantity's gradient, its legend domain
  // (the data's unless overridden), its problem range and the two range colours, from the persisted viz settings.
  const ref = state.models.find((m) => m.result)?.result ?? null;
  const column = ref ? Math.min(state.column, ref.columns.length - 1) : 0, shown = ref?.columns[column] ?? null;
  const cols = state.models.map((m) => (m.result && shown ? m.result.columns.indexOf(shown) : -1)); // a result without it counts as none
  const bySlot = [0, 1, 2, 3].map((k) => state.models.find((m) => m.slot === k)?.result ?? null); // fixed length: memo deps
  const results = useMemo(() => bySlot.filter((r): r is RunResult => !!r), bySlot); // eslint-disable-line react-hooks/exhaustive-deps
  const domain = useMemo<[number, number]>(() => (shown ? unionRange(results, shown) : [NaN, NaN]), [results, shown]); // ponytail: O(rows) per new result; cache per result if it shows
  const scale = useMemo<Scale | null>(() => (shown ? scaleFor(shown, domain, s.viz) : null), [shown, domain[0], domain[1], s.viz]); // eslint-disable-line react-hooks/exhaustive-deps -- by value: an equal range repaints nothing
  const stale = per.map((p) => !!p.m.result && !inFlight(p.m.run) && p.m.result.key !== p.key && !(autoOn && p.key !== lastKey.current[p.m.slot])); // unless Auto is about to run it
  const staleKey = stale.map(Number).join('');
  const compared = useMemo<Compared[]>(() => state.models.map((m, i) => ({ ...m, col: cols[i], stale: staleKey[i] === '1' })), [state.models, shown, staleKey]); // eslint-disable-line react-hooks/exhaustive-deps -- cols follow the models and the column: stable across the cursor's moves
  const n = state.models.length, ai = Math.max(0, state.models.findIndex((m) => m.slot === state.active)), am = state.models[ai], ap = panes[am.slot] ?? NO_PANE;
  const [exporting, setExporting] = useState(false), [exportError, setExportError] = useState<{ result: RunResult; message: string } | null>(null); // one download at a time; its error is its result's
  const onDownload = useCallback(async (format: Format, mode: ExportMode) => {
    const picked = model.current[am.slot]?.picked, col = cols[ai], result = am.result;
    if (!result || col < 0 || !picked) return;
    setExporting(true);
    setExportError(null);
    try {
      await download(format, mode, {
        usd: viewer(am.slot).el, result, objects: am.objects, meshes: ap.meshes, column: col, model: picked, weightsFor,
        scales: result.columns.map((c) => scaleFor(c, unionRange(results, c), s.viz)), // the colours on screen: one scale over every model
      });
    } catch (e) {
      setExportError({ result, message: (e as Error).message });
    } finally {
      setExporting(false);
    }
  }, [am, ai, ap.meshes, cols[ai], results, s.viz, weightsFor]); // eslint-disable-line react-hooks/exhaustive-deps -- cols by its active entry
  const probed: Model | undefined = state.probe ? state.models.find((m) => m.objects.some((o) => o.id === state.probe!.id)) : undefined; // its tip only in its own view
  const probeLabel = state.probe && probed && shown
    ? `${probed.objects.find((o) => o.id === state.probe!.id)?.name ?? ''}: ${fmtNum(state.probe.value)} ${unitFor(shown).value}`
    : null;
  const busyBar = state.models.some((m) => inFlight(m.run)) && !autoOn; // a click batch: the button waits and Cancel shows; Auto runs do not flash them

  // The app as the tools in mcp/tools.ts drive it, rewritten on every commit, which also wakes the tools waiting for one;
  // the bridge polls the server for their calls while the page lives, after picking up a hidden session.
  const ctl = useRef<Ctl>(null!);
  useLayoutEffect(() => {
    ctl.current = {
      state, dispatch, panes, ui, setUi, theme: mode, setTheme, sunScale, setSunScale, views, setViews, optics, materialsReady, per, shown, scale, domain,
      exporting, exportError, onFiles, onRemove, onVariant, onSubdiv, onRefine, onRun, onDownload, weightsFor, meshOf,
      busy: () => busy.current, held: () => held.current, cancel: () => abort.current?.abort(), viewer,
    };
    settled();
  });
  useEffect(() => connect(() => ctl.current), []);

  return (
    <div className="app-shell" style={knob('--sidebar-w', '0px')}>
      <header className="app-bar">
        <span className="app-bar__brand">
          {KIT
            ? <a href="/" aria-label="kit-sim, home"><span className="kit-mark">kit-<span className="kit-mark__name">sim</span></span></a>
            : <a className="zha-lockup" href="/zha.html" aria-label="ZHA CODE, home"><span className="zha-lockup__zha">ZHA</span><span className="zha-lockup__team">CODE</span></a>}
          <span className="app-bar__app">Daylight</span>
        </span>
        <span className="app-bar__spacer" />
        <InfoButton />
        <a className="btn btn--ghost" href="/docs" target="_blank" rel="noreferrer" title="API documentation (Swagger UI); machine-readable at /openapi.json">API</a>
        <button className="icon-btn icon-btn--ghost" type="button" aria-label={`Theme: ${mode === 'auto' ? `follows the system, now ${system}` : mode}. Switch to ${nextMode === 'auto' ? 'system' : nextMode}`} title={`Theme: ${mode === 'auto' ? `system (${system})` : mode}`} onClick={() => setTheme(nextMode)}>
          <Icon name="contrast" />
        </button>
      </header>
      <main className="app-main" id="main">
        <h1 className="sr-only">Daylight simulation</h1>
        <div className="split fill" style={knob('--split-aside', `${ui.widths.right}px`)}>
          <div className="split split--aside-start fill" style={knob('--split-aside', `${ui.widths.left}px`)}>
            <div className="panel-wrap">
              <aside className="panel stack" style={knob('--stack-gap', 'var(--space-4)')} aria-label="Inputs">
                <ModelPanel models={state.models} active={am.slot} usd={viewer(am.slot).el} names={ap.names} loading={ap.loading} busy={Object.values(panes).some((p) => p.loading)} error={ap.loadError} errors={state.errors} stage={ap.stage} subdiv={ui.subdiv} onFiles={onFiles} onVariant={onVariant} onSubdiv={onSubdiv} onRefine={onRefine} onRemove={onRemove} dispatch={dispatch} />
                <MaterialsPanel slot={am.slot} title={n > 1 ? `Materials, model ${LETTERS[am.slot]}` : 'Materials'} rows={optics[ai].materials} fallback={optics[ai].fallback} glass={optics[ai].glass} reading={!materialsReady} mode={s.sim.mode} transmission={s.sim.transmission} reflections={reflect} dispatch={dispatch} />
                <LocationPanel site={s.site} tz={tz} zone={zone} north={s.sim.north} stations={state.stations} selectedHref={selectedHref} errors={state.errors} theme={theme} dispatch={dispatch} />
                <TimePanel time={s.time} site={s.site} tz={tz} zone={zone} leap={leap} errors={state.errors} dispatch={dispatch} sunPath={ui.sunPath} sunScale={sunScale} onSunPath={onSunPath} onSunScale={setSunScale} />
                <SettingsPanel sim={s.sim} errors={state.errors} dispatch={dispatch} />
                <WeatherPanel weather={s.weather} site={s.site} epwMeta={s.epwMeta} viz={s.viz} stations={state.stations} errors={state.errors} dispatch={dispatch} />
              </aside>
              <Splitter side="left" value={ui.widths.left} min={MIN_W} max={MAX_W} defaultValue={UI.widths.left} label="Inputs panel width" onChange={(left) => setUi((u) => ({ ...u, widths: { ...u.widths, left } }))} />
            </div>
            {/* the views, then the run bar: with one model it lies over the bottom of the view, with several it is a row under
                them and never covers a model */}
            <div className={`viewports${n > 1 ? ' viewports--many' : ''}`}>
              {/* one view per model, in fixed cells from the moment its tab is added: loads never move them */}
              <div className={`viewports__grid${n === 4 ? ' viewports__grid--four' : n > 1 && ui.split === 'stacked' ? ' viewports__grid--stacked' : ''}`}>
                {state.models.map((m, i) => {
                  const p = panes[m.slot] ?? NO_PANE, f = ui.link ? loaded.find((k) => k !== m.slot) : undefined;
                  return (
                    <Viewer
                      key={m.slot} usd={viewer(m.slot).el} slot={m.slot} follow={f === undefined ? null : viewer(f).el} meshes={p.meshes} stage={p.stage} loading={p.loading} error={n > 1 ? p.loadError : null}
                      objects={m.objects} selected={m.selected} hovered={state.hovered} colourBy={state.colourBy} result={cols[i] >= 0 ? m.result : null} column={Math.max(cols[i], 0)}
                      scale={scale} bin={state.bin} probeLabel={probed === m ? probeLabel : null} theme={theme} dispatch={dispatch} sun={sunView}
                    >
                      {n > 1 && (
                        <button className="chip" type="button" aria-pressed={m.slot === state.active} title={`Model ${LETTERS[m.slot]}: ${m.name || 'no model open yet'}. The Model and Materials panels, Views and Download act on the pressed view; a click in a view presses it`}>
                          <Tag slot={m.slot} name={m.name} />
                        </button>
                      )}
                    </Viewer>
                  );
                })}
              </div>
              {/* left: the Views and Download menus (the active view's); middle: how the views share the space and the camera;
                  right-aligned, the button's label never changes and Cancel appears on its left: the tickbox stays put;
                  progress shows in the Results run lines */}
              <div className="viewport__bar">
                <div className="cluster cluster--between">
                  <div className="cluster">
                    <ViewsMenu usd={viewer(am.slot).el} model={n > 1 ? LETTERS[am.slot] : undefined} disabled={!ap.meshes.size} views={views} onSave={(v) => setViews((l) => [...l, v])} onRemove={(id) => setViews((l) => l.filter((v) => v.id !== id))} />
                    <DownloadMenu model={n > 1 ? LETTERS[am.slot] : undefined} ready={!!am.result && cols[ai] >= 0} exporting={exporting} error={exportError && exportError.result === am.result ? exportError.message : null} onDownload={onDownload} />
                  </div>
                  {n > 1 && (
                    <div className="cluster">
                      {n < 4 && (
                        <span className="viewports__split">
                          <Segmented name="panes" label="Arrange the views" title="Two or three models: side by side, or one above the other. Four always show 2 x 2; a narrow window always stacks them" value={ui.split} options={[['side', 'Side by side'], ['stacked', 'Stacked']] as const} onChange={(split) => setUi((u) => ({ ...u, split }))} />
                        </span>
                      )}
                      <Segmented name="cameras" label="Cameras" title="Linked: orbit, zoom or pick a view in one 3D view and every view takes the same camera, in world coordinates (models in other units or at another origin do not line up). Independent: each view keeps its own" value={ui.link ? 'linked' : 'free'} options={[['linked', 'Linked cameras'], ['free', 'Independent']] as const} onChange={(v) => setUi((u) => ({ ...u, link: v === 'linked' }))} />
                    </div>
                  )}
                  <div className="cluster cluster--end">
                    {/* with several models kept, hidden while idle: the bar under the views never changes its height */}
                    {(busyBar || n > 1) && <button className={`btn btn--ghost${busyBar ? '' : ' viewport__idle'}`} type="button" disabled={!busyBar} onClick={() => abort.current?.abort()}>Cancel</button>}
                    <label title="Runs the simulation whenever the location, the date, the time or a setting changes">
                      <input type="checkbox" id="auto-run" checked={ui.auto} onChange={(e) => setUi((u) => ({ ...u, auto: e.target.checked }))} /> Run on every change
                    </label>
                    <button className="btn btn--primary" type="button" disabled={!per.some((p) => p.receivers.length) || busyBar} aria-busy={busyBar} title={n > 1 ? 'Runs every model with a receiver, one after another; each result shows as it lands' : undefined} onClick={() => void onRun()}>Run simulation</button>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div className="panel-wrap">
            <aside className="panel stack" data-density="compact" aria-label="Results">
              <ResultsPanel models={compared} column={column} colourBy={state.colourBy} hovered={state.hovered} probe={state.probe} bin={state.bin} scale={scale} domain={domain} viz={s.viz} charts={s.charts} auto={autoOn && !slow} weightsFor={weightsFor} dispatch={dispatch} />
            </aside>
            <Splitter side="right" value={ui.widths.right} min={MIN_W} max={MAX_W} defaultValue={UI.widths.right} label="Results panel width" onChange={(right) => setUi((u) => ({ ...u, widths: { ...u.widths, right } }))} />
          </div>
        </div>
      </main>
    </div>
  );
}
