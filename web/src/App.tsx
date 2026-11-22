// Shell: app bar, inputs panel, the models' views with the run bar, results panel; owns the models (up to four, each in
// its own USD viewer, its meshes built on demand), the per-mesh builders and content ids, the runs (one batch per click or Auto,
// the models one after another), the comparison (one colour scale over every model), the theme mode, the view
// preferences (sidebar widths, Auto, the views side by side or stacked, linked cameras) and the section every view shows.
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { flushSync } from 'react-dom';
import type { Object3D } from 'three';
import { runRemote } from 'daylight-mesh';
import type { LocalFile, SectionGizmo, SectionSource, ViewState } from 'usd-viewer';
import { Splitter } from './Splitter';
import type { ChartEdit } from './charts/ChartSettings';
import { buildArgs, derivedTz, epwRef, noOccludeArgs, simFor, targetArgs, validate, validateViews, viewArgs, weatherLeap } from './lib/args';
import { BUILT_IN } from './lib/charts';
import { zoneAt } from './lib/zone';
import { extract, jobMeshes, same, type Extracted, type Hashed, type RowMesh } from './lib/extract';
import { scaleFor, type Scale } from './lib/gradients';
import { loadFiles, png } from './lib/loaders';
import { opticsArgs, readKey, resolveOptics, runSwitches, type TextureStats } from './lib/optics';
import { rowNames } from './lib/tree';
import { toUsda } from './lib/usda';
import { faceAreas, fmtNum, roundNum, unionRange, unitFor, vertexAreas } from './lib/result';
import { rowAreas } from './lib/topology';
import { NONE, active, describe, fromStage, toStage, type Section } from './lib/section';
import { link, type SavedView } from './lib/views';
import { exclusive, settled } from './mcp/bridge';
import { UUID, appView, connect, inShot, isStaging, putReport, storedReport, type Ctl } from './mcp/tools';
import { InfoButton } from './panels/InfoPanel';
import { LocationPanel } from './panels/LocationPanel';
import { MaterialsPanel } from './panels/MaterialsPanel';
import { ModelPanel } from './panels/ModelPanel';
import { ResultsPanel, type Compared } from './panels/ResultsPanel';
import { SettingsPanel } from './panels/SettingsPanel';
import { TimePanel } from './panels/TimePanel';
import { ViewSettingsPanel } from './panels/ViewSettingsPanel';
import { WeatherPanel } from './panels/WeatherPanel';
import { changed, generate, generation } from './report/generate';
import { editChart, parseReports, type AppModel, type Report, type Stored } from './report/spec';
import { TAGGED, inFlight, initialState, parseSettings, reducer, runBatch, serializeSettings, swapModel, type Action, type Model, type ObjectRow, type Role, type RunResult, type Settings, type Tab } from './store';
import { Icon, LETTERS, Segmented, Tag, knob } from './ui';
import { Viewer } from './viewer/Viewer';
import { download, type ExportMode, type Format, type PickedModel } from './viewer/download';
import { DownloadMenu, ReportsMenu, SectionMenu, ViewsMenu } from './viewer/Views';
import type { SunView } from './viewer/sunpath';
import { readTexture, viewer } from './viewer/usd';

const KEY = 'daylight.settings', THEME_KEY = 'daylight.theme', UI_KEY = 'daylight.ui';
// One id per browser tab for the server's per-client job limit (sessionStorage: a new tab is a new client).
const CLIENT_ID = (() => { try { return sessionStorage.getItem('daylight.client') ?? (sessionStorage.setItem('daylight.client', crypto.randomUUID()), sessionStorage.getItem('daylight.client')!); } catch { return crypto.randomUUID(); } })();
// validate() field -> the control that gets focus
const FOCUS: Record<string, string> = { model: 'model-files', lat: 'lat', lon: 'lon', quantities: 'q-radiation', skyDensity: 'sky-density', timeTo: 'time-to-date', timeDate: 'time-date', materials: 'materials-status' };
// validateViews() field -> the control that gets focus
const VIEW_FOCUS: Record<string, string> = { model: 'model-files', groups: 'target-group', fov: 'view-fov-lo', cell: 'view-cell', far: 'view-far', reach: 'view-reach', materials: 'materials-status' };
// View preferences, stored apart from the settings: sidebar widths (px; 22rem / 24rem defaults), the sun path, Auto run,
// the subdivision level (the viewer's: 0 = the control cage, -1 = auto, 1..3; every model alike), two or three views
// side by side or stacked, linked cameras, the analysis shown (its tab).
const UI = { widths: { left: 352, right: 384 }, sunPath: true, auto: false, subdiv: 0, split: 'side' as 'side' | 'stacked', link: true, tab: 'daylight' as Tab }, MIN_W = 240, MAX_W = 640;
export type UiPrefs = typeof UI;

type ThemeMode = 'auto' | 'light' | 'dark';
const media = window.matchMedia('(prefers-color-scheme: dark)');
const readTheme = (): ThemeMode => { try { const m = localStorage.getItem(THEME_KEY); return m === 'light' || m === 'dark' ? m : 'auto'; } catch { return 'auto'; } };
const readUi = (): typeof UI => { try { const p = JSON.parse(localStorage.getItem(UI_KEY) ?? 'null') ?? {}; return { ...UI, ...p, widths: { ...UI.widths, ...p.widths }, tab: p.tab === 'views' ? 'views' : 'daylight' }; } catch { return UI; } };

// A row's mesh, built on demand (lib/extract.ts), with its model's slot; once a run has hashed it, its content id
type Conv = Hashed & Pick<Extracted, 'make' | 'topology' | 'receiver'> & { slot: number };
/** A mesh's server id or core name (C1: content ids, twins id_2, ...) in a server or core message. */
const CORE = /[0-9a-f]{64}(?:_\d+)?/g;
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
  const conv = useRef(new Map<string, Conv>()); // row id -> its mesh's builders and, once hashed, its content id
  const dropConv = (slot: number) => { for (const [id, c] of conv.current) if (c.slot === slot) conv.current.delete(id); };
  // the two analyses' runs (useAnalysis, below), for the stable callbacks: a model removed or opened ends its jobs in both
  const analyses = useRef<Pick<Analysis, 'jobs' | 'lastKey' | 'held'>[]>([]);
  const [sunScale, setSunScale] = useState(1); // the sun path's radius over the one fitted to the model; 1 on every model load
  // Per model (slot), the prim paths of the meshes its sun path is fitted to instead of the whole model: picked in the
  // Time panel from the selection, for this session; gone when the slot opens another model.
  const [sunAround, setSunAround] = useState<Readonly<Record<number, readonly string[]>>>({});
  // the section every view shows (lib/section.ts, model metres): view only, this session; never a setting, a run input or
  // a key, and never cleared by a new model, a variant switch or a re-read
  const [section, setSection] = useState<Section>(NONE);
  const sectionNow = useRef(section); // for the listeners and callbacks
  sectionNow.current = section;
  const [texStats, setTexStats] = useState<Readonly<Record<number, ReadonlyMap<string, TextureStats | null>>>>({}); // per slot (each core numbers its files from /drop/1), by readKey (null: unreadable)
  const reading = useRef(false); // one texture at a time: one decoded image in memory
  const onSunPath = useCallback((on: boolean) => setUi((u) => ({ ...u, sunPath: on })), []);

  // not while a shot's look is staged (a report's pinned scale, the sun path off): its restore stores the user's again
  useEffect(() => {
    if (isStaging()) return;
    try { localStorage.setItem(KEY, serializeSettings(state.settings)); } catch { /* private mode or quota: settings just do not persist */ }
  }, [state.settings]);
  useEffect(() => {
    if (isStaging()) return;
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
  const [savedViews, setSavedViews] = useState<SavedView[]>([]); // views saved in the app: this session, every view, never in a file
  const choices = useRef<Record<number, AppModel['choices']>>({}); // per slot, the variant choices made since its file opened: [the file's own, chosen]
  const [reports, setReports] = useState<Stored[] | null>(null); // the stored reports (null: none here: no agent routes, a LAN tab, mock mode)
  // whether this tab may use the agent routes (GET /health: --mcp, and this machine): only then the bridge and the reports
  // (a server without them would log a 404 for each request, on every load and window focus)
  const [agents, setAgents] = useState(false);
  useEffect(() => { // asked again every 3 s while the server cannot be reached: a tab opened while it was down connects once it is up
    let timer = 0;
    const ask = () => void fetch('/health').then((r) => r.json()).then((h: { agents?: unknown }) => setAgents(h.agents === true), () => { timer = window.setTimeout(ask, 3000); });
    ask();
    return () => clearTimeout(timer);
  }, []);
  const listed = useRef(''); // GET /reports' last answer
  /** The reports fetched again and set (`always`: also when unchanged, for a generation's state to show). */
  const refreshReports = useCallback(async (always = true) => {
    const r = await fetch('/reports').catch(() => null);
    if (!r?.ok || !r.headers.get('Content-Type')?.startsWith('application/json')) return;
    const text = await r.text();
    if (!always && text === listed.current) return;
    listed.current = text;
    const list = parseReports(JSON.parse(text));
    flushSync(() => setReports(list)); // committed when this resolves: a tool reads the new list right after
  }, []);
  useEffect(() => {
    if (!agents) return;
    const onFocus = () => void refreshReports(false);
    onFocus();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [agents, refreshReports]);
  const variants = useCallback((slot: number) => choices.current[slot] ?? {}, []);
  // A report changed here (a chart's settings in Results, a view's Update in Views): one change at a time with the tool
  // calls, on the report as stored now, saved with a later updated, so that a save_report made before it is refused. A
  // failure shows where the change was made: under the report's charts in Results, and in the Reports menu, which opens
  // for a view's (its Views menu has closed).
  const [reportError, setReportError] = useState<{ id?: string; title: string; message: string } | null>(null); // the last change or delete that failed
  const editReport = useCallback((id: string, edit: (r: Report) => Report | null, menu = false) => exclusive(async () => {
    setReportError(null);
    try {
      const old = (await storedReport(id)).spec, next = edit(old);
      if (next) await putReport(next, old);
    } catch (e) {
      setReportError({ id, title: 'Report not changed', message: (e as Error).message.replace(/^(id|spec): /, '') });
      const m = menu ? document.getElementById('reports-menu') : null;
      if (m && !m.matches(':popover-open')) m.showPopover();
    }
    await refreshReports();
  }), [refreshReports]);
  const onReportChart = useCallback((id: string, e: ChartEdit) => {
    if ('remove' in e && !confirm('Remove this chart from the report, with its caption? This cannot be undone.')) return;
    void editReport(id, (r) => editChart(r, e));
  }, [editReport]);
  // a view block takes the camera `view` (stage units, `mpu` m each); its cutaway moves with it, keeping its distance in
  // front of the target (a camera moved closer cuts less), and goes once the camera is nearer than that, or looks from
  // another side (more than 2° off: the cut, set for the old side, would slice into what it shows; the live view has none).
  // It takes the section shown too (none when it is off or empty).
  const onReportView = useCallback((id: string, i: number, name: string, view: ViewState, mpu: number) => void editReport(id, (r) => {
    const b = r.blocks[i], cut = sectionNow.current; // the block the menu showed, unless the report changed since
    if (b?.type !== 'view' || b.name !== name) return null;
    const dir = (v: ViewState) => v.eye.map((e, k) => e - v.target[k]), reach = (v: ViewState) => Math.hypot(...dir(v)) * mpu, { near: was, section: _was, ...rest } = b;
    const [p, q] = [dir(view), dir(b.view)], turned = p[0] * q[0] + p[1] * q[1] + p[2] * q[2] < Math.cos(Math.PI / 90) * Math.hypot(...p) * Math.hypot(...q);
    const near = was === undefined || turned ? 0 : roundNum(was + reach(view) - reach(b.view));
    return { ...r, blocks: r.blocks.with(i, { ...rest, view, ...(near > 0 ? { near } : {}), ...(active(cut) ? { section: cut } : {}) }) };
  }, true), [editReport]);
  const onReportDelete = useCallback(async (id: string) => {
    setReportError(null);
    const r = await fetch(`/reports/${id}`, { method: 'DELETE' }).catch(() => null); // 404: gone already
    if (r?.ok || r?.status === 404) changed(id);
    else setReportError({ title: 'Report not deleted', message: r?.status === 409 ? 'The PDF is open in another program: close it and delete again.' : r ? (await r.text()).replace(/^error: /, '') : 'The server cannot be reached.' });
    await refreshReports();
  }, [refreshReports]);

  // A model's drawn meshes -> rows, their conversions and the viewer's objects: after open(), and after a variant switch.
  // roles: the old rows' roles by path (a new mesh is 'none'; a row hidden with the eye or H stays); without them a lone
  // mesh is the receiver.
  const readStage = async (slot: number, roles?: ReadonlyMap<string, Role>) => {
    const { el: usd } = viewer(slot), { mpu, own } = model.current[slot];
    const found = extract(usd.three.items(), usd.three.root, mpu, roles && ((p) => roles.has(p)), (rid) => usd.usd.meshMap(rid));
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
      // The row id is the app's; the server and the core name the mesh by its content, per job (jobMeshes).
      conv.current.set(id, { slot, make: e.make, dmesh: e.dmesh, stamp: e.stamp, topology: e.topology, receiver: e.receiver });
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
      for (const a of analyses.current) a.held.current = false; // a click held for the old model's materials
      pane(slot, { meshes: new Map(), names: new Map() });
      dispatch({ type: 'LOAD', slot, objects: [] });
      const logged = usd.session.log.length, info = await usd.open(source);
      opened = true;
      delete choices.current[slot];
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
      setSunAround(({ [slot]: _gone, ...rest }) => rest);
      dispatch({ type: 'LOAD', slot, objects, name: info.url.replace(/^.*\//, '').replace(/\.\w+$/, '') });
      if (problems.length) pane(slot, { loadError: problems.slice(0, 3).join(' ') });
    } catch (e) {
      pane(slot, { loadError: (e as Error).message });
    } finally {
      pane(slot, (p) => ({ loading: false, stage: p.stage + (opened ? 1 : 0) }));
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- readStage reads refs only

  // A variant switch or a subdivision level (session layer, not saved) changes what is drawn: re-read the model's meshes,
  // keeping each path's role (and, in RELOAD, a receiver's no-shade flag). Every such edit resolves once the view has the
  // new meshes.
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
  const onVariant = useCallback((slot: number, path: string, set: string, variant: string) => void reread(slot, async () => {
    const { usd } = viewer(slot).el, sets = ((choices.current[slot] ??= {})[path] ??= {});
    const own = sets[set]?.[0] ?? (await usd.prim(path)).variantSets.find((v) => v.name === set)?.selection ?? '';
    await usd.setVariant(path, set, variant);
    sets[set] = [own, variant];
  }), [reread]);
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

  // The section in every view with a stage, in that stage's units and axes; again whenever a stage opens there (which
  // clears it). Edited in a view (its gizmo, its own menu), it comes back in model metres and the other views follow, but
  // that view keeps its own numbers: rounded ones would fight the drag (`from`: the view each such section came from, so
  // an effect that runs after the next drag step still skips it). A view showing a shot's own section is the shot's until
  // it puts this one back. A change from the Section menu takes the gizmo to its entry once the views have it (attach:
  // undefined leaves it as it is); a whole section from an agent or a report's view lets it go (null): the viewer keeps
  // the gizmo's index, which may then be another entry. gizmoIn: the view the gizmo is in.
  const from = useRef(new WeakMap<Section, number>()), attach = useRef<SectionGizmo | null | undefined>(undefined), gizmoIn = useRef(state.active);
  const stages = state.models.map((m) => `${m.slot}:${panes[m.slot]?.stage ?? 0}`).join();
  useEffect(() => {
    for (const m of models.current) {
      const { el } = viewer(m.slot), st = el.stage;
      if (st && from.current.get(section) !== m.slot && !inShot(el)) el.section = toStage(section, st.metersPerUnit, st.upAxis);
    }
    if (attach.current !== undefined) viewer(gizmoIn.current).el.sectionGizmo = attach.current; // before a new active view takes it (below)
    attach.current = undefined;
  }, [section, stages]);
  useEffect(() => {
    const offs = models.current.map(({ slot }) => {
      const { el } = viewer(slot);
      const on = (e: Event) => {
        const { source } = (e as CustomEvent<{ source: SectionSource }>).detail, st = el.stage;
        if (!st || inShot(el)) return;
        if (source === 'stage') el.section = toStage(sectionNow.current, st.metersPerUnit, st.upAxis);
        else if (source === 'gizmo' || source === 'ui') {
          const next = fromStage(el.section, st.metersPerUnit, st.upAxis);
          from.current.set(next, slot);
          setSection(next);
        }
      };
      el.addEventListener('sectionchange', on);
      return () => el.removeEventListener('sectionchange', on);
    });
    return () => offs.forEach((off) => off());
  }, [slots]);
  const onSection = useCallback((next: Section, gizmo?: SectionGizmo | null) => {
    if (gizmo !== undefined && next !== sectionNow.current) attach.current = gizmo; // the same section commits nothing: attach would wait for the next change
    setSection(next);
  }, []);
  // The gizmo edits the section in the active view only: it goes along when another view becomes the active one.
  useEffect(() => {
    if (gizmoIn.current === state.active) return;
    const from = viewer(gizmoIn.current).el, g = from.sectionGizmo;
    gizmoIn.current = state.active;
    from.sectionGizmo = null;
    if (g) viewer(state.active).el.sectionGizmo = g;
  }, [state.active]);
  /** A model goes: its view, its results and its job on its way (deleted on the server; the batch goes on); its element and
   *  core stay for the next model in its slot (dispose() is final). */
  const onRemove = useCallback((slot: number) => {
    dropConv(slot);
    for (const a of analyses.current) { a.jobs.current[slot]?.abort(); delete a.lastKey.current[slot]; }
    delete model.current[slot];
    delete choices.current[slot];
    setPanes(({ [slot]: _gone, ...rest }) => rest);
    setSunAround(({ [slot]: _gone, ...rest }) => rest);
    dispatch({ type: 'REMOVE', slot });
    void viewer(slot).el.close().catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- dropConv reads a ref only

  // A row's mesh (model metres, Z up), built per call: as drawn, or with a result the mesh its rows name (a receiver sent
  // as the file's own faces and points: lib/extract RowMesh)
  const meshOf = useCallback((id: string, r?: RunResult | null): RowMesh | undefined => {
    const cv = conv.current.get(id), form = r?.forms?.[r.receivers.indexOf(id)];
    return form && cv?.receiver ? cv.receiver(form).mesh() : cv?.make();
  }, []);

  const s = state.settings, v = s.viewSim, views = ui.tab === 'views';
  // The view analysis' own actions (ROLE, SHADE, RUN, COLUMN, COLOUR_BY, ERRORS) tagged for its slice of the store; the
  // others as they are. Stable, so the memoised panels keep their props.
  const dispatchViews = useCallback((a: Action) => dispatch(TAGGED.has(a.type) ? ({ ...a, tab: 'views' } as Action) : a), []);
  const vModels = useMemo(() => state.models.map(swapModel), [state.models]); // the view analysis' models, seen as daylight's
  const physical = s.sim.mode === 'physical', reflect = physical && s.sim.bounces > 0;
  // Daylight per model: the settings it runs with (a big model's reflection samples: lib/args.ts simFor), its run
  // arguments (the receivers that cast no shade among them) and the weather the server's response cache keys on.
  const epw = epwRef(s), base = buildArgs(s), weather = epw instanceof File ? [epw.name, epw.size, epw.lastModified] : epw?.url ?? null;
  const shared = { conv, texStats, setTexStats, reading, auto: ui.auto, viz: s.viz };
  const D = useAnalysis({
    ...shared, models: state.models, column: state.column, visible: !views, dispatch, reflect, live: physical && (s.sim.transmission || reflect), on: s.sim.on, epw, weather, ladybug: !physical,
    argsOf: (receivers, _shades, o, elements) => { const sim = simFor(s.sim, elements); return { args: [...base, ...opticsArgs(o.meshes, o.fallback, sim), ...noOccludeArgs(receivers, s.sim)], switches: runSwitches(sim) }; },
    check: (per, ready) => validate(s, per.some((p) => p.receivers.length > 0), ready, Math.max(0, ...per.map((p) => p.elements))),
    focus: (f) => (f === 'weather' ? `weather-${s.weather.source}` : FOCUS[f] ?? f),
  });
  // The view analysis: the same models, meshes and materials, its own roles, settings and runs (the core's views, no
  // weather); glass counts only while rays pass it.
  const vBase = viewArgs(v, s.sim.north);
  const V = useAnalysis({
    ...shared, models: vModels, column: state.viewAnalysis.column, visible: views, dispatch: dispatchViews, reflect: false, live: v.transmission, on: v.on, weather: null, tool: 'views',
    argsOf: (receivers, shades, o) => ({
      args: [...vBase, ...opticsArgs(o.meshes, o.fallback, { mode: 'physical', transmission: v.transmission, fresnel: true }), ...noOccludeArgs(receivers, v), ...targetArgs(shades)],
      switches: v.transmission ? 'Rays pass glass' : '',
    }),
    check: (per, ready) => validateViews(v, per.flatMap((p) => p.shades.flatMap((o) => (o.group ? [o.group] : []))), per.some((p) => p.receivers.length > 0), ready),
    focus: (f) => VIEW_FOCUS[f] ?? f,
  });
  analyses.current = [D, V];
  const A = views ? V : D, colourBy = views ? state.viewAnalysis.colourBy : state.colourBy; // the tab's analysis: what the screen shows

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
  const n = state.models.length, ai = Math.max(0, state.models.findIndex((m) => m.slot === state.active)), am = A.models[ai], ap = panes[am.slot] ?? NO_PANE;
  // The sun path around the selected meshes of the active model, or its whole model again (stable: the Time panel is memoised)
  const activeModel = useRef(am);
  activeModel.current = am;
  const onSunFit = useCallback((on: boolean) => {
    const m = activeModel.current, paths = on ? m.objects.filter((o) => m.selected.has(o.id)).map((o) => o.path) : [];
    setSunAround(({ [m.slot]: _was, ...rest }) => (paths.length ? { ...rest, [m.slot]: paths } : rest));
  }, []);
  const charts = useMemo(() => (views ? s.charts.filter((c) => BUILT_IN.some((b) => b.id === c.id)) : s.charts), [views, s.charts]); // the views tab: the built-ins, their look shared
  const groups = useMemo(() => [...new Set(vModels.flatMap((m) => m.objects.flatMap((o) => (o.role === 'shade' && o.group ? [o.group] : []))))], [vModels]); // the target groups in use
  // one download at a time; its error is its result's, by run key (holding the result itself would keep a replaced one's
  // values alive)
  const [exporting, setExporting] = useState(false), [exportError, setExportError] = useState<{ key: string; message: string } | null>(null);
  /** The active model's result of analysis X as a file (the Download menu: the tab's; the agent tools: daylight's). */
  const downloadOf = (X: Analysis) => async (format: Format, mode: ExportMode) => {
    const xm = X.models[ai], picked = model.current[xm.slot]?.picked, col = X.cols[ai], result = xm.result;
    if (!result || col < 0 || !picked) return;
    setExporting(true);
    setExportError(null);
    try {
      await download(format, mode, {
        usd: viewer(xm.slot).el, result, objects: xm.objects, meshes: ap.meshes, column: col, model: picked,
        scales: result.columns.map((c) => scaleFor(c, unionRange(X.results, c), s.viz, X.results)), // the colours on screen: one scale over every model
      });
    } catch (e) {
      setExportError({ key: result.key, message: (e as Error).message });
    } finally {
      setExporting(false);
    }
  };
  const onDownload = useCallback(downloadOf(A), [A.models[ai], ai, ap.meshes, A.cols[ai], A.results, s.viz]); // eslint-disable-line react-hooks/exhaustive-deps -- the tab's analysis by its active model, cols by its active entry
  const probed: Model | undefined = state.probe ? A.models.find((m) => m.objects.some((o) => o.id === state.probe!.id)) : undefined; // its tip only in its own view
  const probeLabel = state.probe && probed && A.shown
    ? `${probed.objects.find((o) => o.id === state.probe!.id)?.name ?? ''}: ${fmtNum(state.probe.value)} ${unitFor(A.shown).value}`
    : null;
  // the app as the Reports menu checks a report against it, while there are reports: per change of the models, roles,
  // results, column or problem ranges, never per hover (daylight's: reports are daylight's)
  const reportApp = useMemo(() => (reports?.length ? appView({ shown: D.shown, state, panes, per: D.per, variants }) : null), [reports, D.shown, state.models, s.viz.ranges, panes, D.keys]); // eslint-disable-line react-hooks/exhaustive-deps -- state and per by the parts appView reads
  const sectionWords = active(section) ? describe(section) : null; // the views' scene info

  // The app as the tools in mcp/tools.ts drive it, rewritten on every commit, which also wakes the tools waiting for one;
  // where the agent routes answer this tab, the bridge polls the server for their calls while the page lives, after
  // picking up a hidden session. The tools act on daylight, whichever tab shows.
  const ctl = useRef<Ctl>(null!);
  useLayoutEffect(() => {
    ctl.current = {
      state, dispatch, panes, ui, setUi, theme: mode, setTheme, sunScale, setSunScale, section, setSection: (s) => onSection(s, null), views: savedViews, setViews: setSavedViews,
      optics: D.optics, materialsReady: D.materialsReady, per: D.per, shown: D.shown, scale: D.scale, domain: D.domain,
      exporting, exportError, onFiles, onRemove, onVariant, onSubdiv, onRefine, onRun: D.onRun, onDownload: downloadOf(D), meshOf,
      busy: () => D.busy.current, held: () => D.held.current, cancel: () => D.abort.current?.abort(), viewer,
      variants, reports, refreshReports, generate: (id) => generate(id, () => ctl.current), generation, fileOf: (slot) => model.current[slot]?.picked.root,
    };
    settled();
  });
  useEffect(() => (agents ? connect(() => ctl.current) : undefined), [agents]);

  // A tab switch shows the other analysis' roles, results and colours: the cursor's and the bin's marks go
  const onTab = (t: Tab) => { dispatch({ type: 'PROBE', probe: null }); dispatch({ type: 'BIN', bin: null }); setUi((u) => ({ ...u, tab: t })); };
  const tabs: [Tab, string][] = [['daylight', 'Daylight'], ['views', 'View analysis']];
  return (
    <div className="app-shell" style={knob('--sidebar-w', '0px')}>
      <header className="app-bar">
        <span className="app-bar__brand">
          <a href="/" aria-label="kit-sim, home"><span className="kit-mark">kit-<span className="kit-mark__name">sim</span></span></a>
        </span>
        {/* the two analyses of the same models: their own roles, settings and results */}
        <div className="tabs" role="group" aria-label="Analysis">
          {tabs.map(([t, label]) => (
            <button key={t} className="tabs__tab" type="button" aria-current={ui.tab === t ? 'page' : undefined} onClick={() => onTab(t)}>{label}</button>
          ))}
        </div>
        <span className="app-bar__spacer" />
        <InfoButton />
        <a className="btn btn--ghost" href="/docs" target="_blank" rel="noreferrer" title="API documentation (Swagger UI); machine-readable at /openapi.json">API</a>
        <button className="icon-btn icon-btn--ghost" type="button" aria-label={`Theme: ${mode === 'auto' ? `follows the system, now ${system}` : mode}. Switch to ${nextMode === 'auto' ? 'system' : nextMode}`} title={`Theme: ${mode === 'auto' ? `system (${system})` : mode}`} onClick={() => setTheme(nextMode)}>
          <Icon name="contrast" />
        </button>
      </header>
      <main className="app-main" id="main">
        <h1 className="sr-only">{views ? 'View analysis' : 'Daylight simulation'}</h1>
        <div className="split fill" style={knob('--split-aside', `${ui.widths.right}px`)}>
          <div className="split split--aside-start fill" style={knob('--split-aside', `${ui.widths.left}px`)}>
            <div className="panel-wrap">
              <aside className="panel stack" style={knob('--stack-gap', 'var(--space-4)')} aria-label="Inputs">
                <ModelPanel models={A.models} active={am.slot} usd={viewer(am.slot).el} names={ap.names} loading={ap.loading} busy={Object.values(panes).some((p) => p.loading)} error={ap.loadError} errors={views ? state.viewAnalysis.errors : state.errors} stage={ap.stage} subdiv={ui.subdiv} selfOcclude={views ? v.selfOcclude : s.sim.selfOcclude} analysis={ui.tab} groups={groups} onFiles={onFiles} onVariant={onVariant} onSubdiv={onSubdiv} onRefine={onRefine} onRemove={onRemove} dispatch={views ? dispatchViews : dispatch} />
                <MaterialsPanel slot={am.slot} title={n > 1 ? `Materials, model ${LETTERS[am.slot]}` : 'Materials'} rows={A.optics[ai].materials} fallback={A.optics[ai].fallback} glass={A.optics[ai].glass} reading={!A.materialsReady} mode={views ? 'physical' : s.sim.mode} transmission={views ? v.transmission : s.sim.transmission} reflections={!views && reflect} dispatch={dispatch} />
                {/* daylight's own inputs stay mounted on the view analysis tab (the weather header, the map), hidden */}
                <div className="panel-group" hidden={views}>
                  <LocationPanel site={s.site} tz={tz} zone={zone} north={s.sim.north} stations={state.stations} selectedHref={selectedHref} errors={state.errors} theme={theme} dispatch={dispatch} />
                  <TimePanel time={s.time} site={s.site} tz={tz} zone={zone} leap={leap} errors={state.errors} dispatch={dispatch} sunPath={ui.sunPath} sunScale={sunScale} onSunPath={onSunPath} onSunScale={setSunScale} sunFit={sunAround[am.slot]?.length ?? 0} canSunFit={am.selected.size > 0} onSunFit={onSunFit} />
                  <SettingsPanel sim={s.sim} errors={state.errors} dispatch={dispatch} />
                  <WeatherPanel weather={s.weather} site={s.site} epwMeta={s.epwMeta} viz={s.viz} stations={state.stations} errors={state.errors} dispatch={dispatch} />
                </div>
                {views && <ViewSettingsPanel v={v} north={s.sim.north} errors={state.viewAnalysis.errors} dispatch={dispatch} />}
              </aside>
              <Splitter side="left" value={ui.widths.left} min={MIN_W} max={MAX_W} defaultValue={UI.widths.left} label="Inputs panel width" onChange={(left) => setUi((u) => ({ ...u, widths: { ...u.widths, left } }))} />
            </div>
            {/* the views, then the run bar: with one model it lies over the bottom of the view, with several it is a row under
                them and never covers a model */}
            <div className={`viewports${n > 1 ? ' viewports--many' : ''}`}>
              {/* one view per model, in fixed cells from the moment its tab is added: loads never move them */}
              <div className={`viewports__grid${n === 4 ? ' viewports__grid--four' : n > 1 && ui.split === 'stacked' ? ' viewports__grid--stacked' : ''}`}>
                {A.models.map((m, i) => {
                  const p = panes[m.slot] ?? NO_PANE, f = ui.link ? loaded.find((k) => k !== m.slot) : undefined;
                  return (
                    <Viewer
                      key={m.slot} usd={viewer(m.slot).el} slot={m.slot} follow={f === undefined ? null : viewer(f).el} meshes={p.meshes} stage={p.stage} loading={p.loading} error={n > 1 ? p.loadError : null}
                      objects={m.objects} selected={m.selected} hovered={state.hovered} colourBy={colourBy} result={A.cols[i] >= 0 ? m.result : null} column={Math.max(A.cols[i], 0)}
                      scale={A.scale} bin={state.bin} probeLabel={probed === m ? probeLabel : null} theme={theme} dispatch={dispatch} sun={views ? null : sunView} around={sunAround[m.slot] ?? null} section={sectionWords} analysis={ui.tab}
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
              {/* left: the Views, Section and Download menus (the active view's); middle: how the views share the space and the
                  camera; right-aligned, the button's label never changes and Cancel appears on its left: the tickbox stays
                  put; progress shows in the Results run lines */}
              <div className="viewport__bar">
                <div className="cluster cluster--between">
                  <div className="cluster">
                    <ViewsMenu usd={viewer(am.slot).el} model={n > 1 ? LETTERS[am.slot] : undefined} disabled={!ap.meshes.size} views={savedViews} reports={reports} onSave={(sv) => setSavedViews((l) => [...l, sv])} onRemove={(id) => setSavedViews((l) => l.filter((sv) => sv.id !== id))} onReportView={onReportView} onSection={(sc) => onSection(sc, null)} />
                    <SectionMenu usd={viewer(am.slot).el} section={section} selected={am.selection.paths.length > 0} disabled={!ap.meshes.size} onChange={onSection} />
                    <DownloadMenu model={n > 1 ? LETTERS[am.slot] : undefined} ready={!!am.result && A.cols[ai] >= 0} exporting={exporting} error={exportError && exportError.key === am.result?.key ? exportError.message : null} onDownload={onDownload} />
                    {/* only while there are reports (daylight's); a generation's failure shows as its lastError */}
                    {!views && reports?.length && reportApp ? <ReportsMenu reports={reports} app={reportApp} error={reportError} onOpen={refreshReports} onDelete={(id) => void onReportDelete(id)} onGenerate={(id) => { setReportError(null); ctl.current.generate(id).catch(() => {}); }} /> : null}
                  </div>
                  {n > 1 && (
                    <div className="cluster">
                      {n < 4 && (
                        <span className="viewports__split">
                          <Segmented name="panes" label="Arrange the views" title="Two or three models: side by side, or one above the other. Four always show 2 x 2; a narrow window always stacks them" value={ui.split} options={[['side', 'Side by side'], ['stacked', 'Stacked']] as const} onChange={(split) => setUi((u) => ({ ...u, split }))} />
                        </span>
                      )}
                      <Segmented name="cameras" label="Cameras" title="Linked: orbit, zoom or pick a view in one 3D view and every view takes the same camera, in world coordinates (models in other units or at another origin do not line up). Independent: each view keeps its own" value={ui.link ? 'linked' : 'free'} options={[['linked', 'Linked cameras'], ['free', 'Independent']] as const} onChange={(x) => setUi((u) => ({ ...u, link: x === 'linked' }))} />
                    </div>
                  )}
                  <div className="cluster cluster--end">
                    {/* with several models kept, hidden while idle: the bar under the views never changes its height */}
                    {(A.busyBar || n > 1) && <button className={`btn btn--ghost${A.busyBar ? '' : ' viewport__idle'}`} type="button" disabled={!A.busyBar} onClick={() => A.abort.current?.abort()}>Cancel</button>}
                    <label title={views ? 'Runs the view analysis whenever a view setting or a role changes' : 'Runs the simulation whenever the location, the date, the time or a setting changes'}>
                      <input type="checkbox" id="auto-run" checked={ui.auto} onChange={(e) => setUi((u) => ({ ...u, auto: e.target.checked }))} /> Run on every change
                    </label>
                    <button className="btn btn--primary" type="button" disabled={!A.per.some((p) => p.receivers.length) || A.busyBar} aria-busy={A.busyBar} title={n > 1 ? 'Runs every model with a receiver, one after another; each result shows as it lands' : undefined} onClick={() => void A.onRun()}>{views ? 'Run view analysis' : 'Run simulation'}</button>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div className="panel-wrap">
            <aside className="panel stack" data-density="compact" aria-label="Results">
              <ResultsPanel models={A.compared} column={A.column} colourBy={colourBy} hovered={state.hovered} probe={state.probe} bin={state.bin} scale={A.scale} domain={A.domain} viz={s.viz} charts={charts} auto={A.autoOn && !A.slow} analysis={ui.tab} dispatch={views ? dispatchViews : dispatch} reports={views ? null : reports} reportError={reportError} onReportChart={onReportChart} />
            </aside>
            <Splitter side="right" value={ui.widths.right} min={MIN_W} max={MAX_W} defaultValue={UI.widths.right} label="Results panel width" onChange={(right) => setUi((u) => ({ ...u, widths: { ...u.widths, right } }))} />
          </div>
        </div>
      </main>
    </div>
  );
}

type Optics = ReturnType<typeof resolveOptics>;
/** A model's run inputs now: its receivers and shades, their faces or vertices (the rows its run returns), its run
 *  arguments and their words, its mesh ids, and everything the server's response cache keys on (an equal key gives an
 *  equal result). */
interface Per { m: Model; receivers: ObjectRow[]; shades: ObjectRow[]; elements: number; args: string[]; switches: string; mesh: string; key: string }
type TexStats = Readonly<Record<number, ReadonlyMap<string, TextureStats | null>>>;
/** One analysis' inputs: its models (daylight's, or the view analysis' seen as daylight's), its column, whether its tab
 *  shows (Auto runs that one only), and how its runs are made: the run arguments, the checks, the job's tool and weather. */
interface AnalysisCfg {
  models: Model[]; column: number; visible: boolean; auto: boolean; dispatch: Dispatch<Action>; viz: Settings['viz'];
  conv: RefObject<Map<string, Conv>>; reading: RefObject<boolean>; texStats: TexStats; setTexStats: Dispatch<SetStateAction<TexStats>>;
  reflect: boolean; live: boolean; // the diffuse textures count (Reflections); textures count at all (glass, screens)
  on: 'faces' | 'vertices'; epw?: File | { url: string }; weather: unknown; tool?: 'views';
  ladybug?: boolean; // the core takes faces of 3 or 4 corners only: a receiver with a bigger one is sent as drawn
  argsOf: (receivers: ObjectRow[], shades: ObjectRow[], optics: Optics, elements: number) => { args: string[]; switches: string };
  check: (per: Per[], materialsReady: boolean) => Record<string, string>; // validate(): field id -> message
  focus: (field: string) => string; // the control that gets focus for a field's error
}
export type Analysis = ReturnType<typeof useAnalysis>;

/** One analysis' runs (one batch at a time, the models one after another; Auto for the tab that shows) and its
 *  comparison (the column by name, one colour scale over every model). */
function useAnalysis(c: AnalysisCfg) {
  const { models, dispatch, conv } = c;
  const abort = useRef<AbortController | null>(null);
  const jobs = useRef<Record<number, AbortController>>({}); // per slot, its job on its way: removing the model ends it
  const busy = useRef(false), held = useRef(false); // one batch of runs per analysis; a click waiting for the materials
  const lastKey = useRef<Record<number, string | null>>({}); // per slot: the key of the last run started
  const [ended, setEnded] = useState(0); // bumped when a batch ends, so Auto re-checks with the settings of that moment
  const [slow, setSlow] = useState(false); // the batch in flight has taken over 0.3 s
  // Each run mesh's optics per face slot, and the textures its materials still wait for (the diffuse ones only while the
  // reflectance counts), per model. A model's viewer `materials` change only in a flush, and every flush that can change
  // a binding is followed by a re-read of the stage, so its rows key it: kept per slot while its inputs are the same.
  const opticsOf = useRef(new Map<number, { inputs: unknown[]; value: Optics }>());
  const optics = models.map((m) => {
    const inputs = [m.objects, m.optics, c.texStats[m.slot] ?? NO_STATS, c.reflect], had = opticsOf.current.get(m.slot);
    if (had && had.inputs.every((x, i) => x === inputs[i])) return had.value;
    const value = resolveOptics(m.objects, viewer(m.slot).materials, c.texStats[m.slot] ?? NO_STATS, m.optics, c.reflect);
    opticsOf.current.set(m.slot, { inputs, value });
    return value;
  });
  // The textures are read (decoded in a worker) only while their numbers count; a run that does not use them never waits.
  const materialsReady = !c.live || optics.every((o) => !o.unread.length);
  useEffect(() => {
    const k = optics.findIndex((o) => o.unread.length), r = optics[k]?.unread[0];
    if (!c.live || !r || c.reading.current) return; // the read in flight (either analysis') lands first, then the next starts
    c.reading.current = true;
    const slot = models[k].slot;
    void readTexture(viewer(slot).el, r).then((t) => { c.reading.current = false; c.setTexStats((all) => ({ ...all, [slot]: new Map(all[slot] ?? NO_STATS).set(readKey(r), t) })); });
  }); // every render: cheap when nothing is unread or a read is in flight
  const per: Per[] = models.map((m, i) => {
    const receivers = m.objects.filter((o) => o.role === 'receiver'), shades = m.objects.filter((o) => o.role === 'shade');
    const elements = receivers.reduce((n, o) => n + (c.on === 'faces' ? o.tris : o.verts), 0), { args, switches } = c.argsOf(receivers, shades, optics[i], elements);
    const ids = [receivers.map((o) => o.id), shades.map((o) => o.id)];
    return { m, receivers, shades, elements, args, switches, mesh: JSON.stringify(ids), key: JSON.stringify([args, c.weather, ...ids]) };
  });
  const meshKeys = useRef<Record<number, string>>({}); // per slot, its receivers and shades now: a job started for others reports nothing
  meshKeys.current = Object.fromEntries(per.map((p) => [p.m.slot, p.mesh]));
  const autoOn = c.auto && c.visible && per.some((p) => p.receivers.length > 0); // every mode: an annual run is a fraction of a second too

  // One batch per click (every model with a receiver) or per Auto check (those whose inputs changed): the models' jobs
  // one after another under one cancel; each result lands as its job ends.
  const onRun = async (auto = false) => {
    if (busy.current) return; // one batch per analysis: Auto re-checks when it ends, the button is disabled meanwhile
    const todo = per.filter((p) => p.receivers.length && (!auto || p.key !== lastKey.current[p.m.slot])); // no receiver: not run
    for (const p of todo) lastKey.current[p.m.slot] = p.key;
    const errors = c.check(per, materialsReady);
    dispatch({ type: 'ERRORS', errors });
    const first = Object.keys(errors)[0];
    if (first) {
      if (first === 'materials') { for (const p of todo) lastKey.current[p.m.slot] = null; if (!auto) held.current = true; } // nothing else wrong: held, not refused, it runs once the materials are read
      if (!auto) { // Auto shows the errors, never steals focus
        const el = document.getElementById(c.focus(first));
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
    const names = new Map<string, string>(); // a mesh's server id and core name -> its row's name, per job (runBatch runs one at a time)
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
              // C1: content ids (hashed once per row, 8 at a time), core names by them; the args' row ids become those
              // names (the run key keeps the row ids)
              const rows = [...p.receivers, ...p.shades], n = p.receivers.length, cs = rows.map((o) => conv.current.get(o.id));
              if (!cs.every(Boolean)) throw new Error('changed');
              // A receiver goes as the file's own faces and points (its topology, read from the viewer once per geometry):
              // a quad is one row, parts that only share a position keep their own vertices. As drawn when it has none,
              // or in Ladybug mode with a face of more than 4 corners (the core takes triangles and quads there).
              const forms = (await Promise.all(cs.slice(0, n).map((cv) => cv!.topology?.() ?? null))).map((t) => (t && !(c.ladybug && t.corners > 4) ? t : null));
              if (!mine()) throw new Error('changed');
              const sent: Hashed[] = cs.map((cv, k) => (k < n && forms[k] ? cv!.receiver!(forms[k]) : cv!));
              const { meshes, ids, stems, stamps, hashed } = await jobMeshes(sent, n, own.signal);
              if (!mine()) throw new Error('changed'); // its model or roles changed during a long hash: no job
              const core = new Map(rows.map((o, k) => [o.id, stems[k]]));
              names.clear();
              rows.forEach((o, k) => names.set(stems[k], o.name)); // a twin's id is its first row's core name
              rows.forEach((o, k) => { if (!names.has(ids[k])) names.set(ids[k], o.name); });
              let shown = 0; // the upload's progress in the run line, at most 4 times a second
              const onUpload = (d: number, total: number) => {
                if (d && d < total && performance.now() - shown < 250) return;
                shown = performance.now();
                if (mine() && !own.signal.aborted) dispatch({ type: 'RUN', slot, run: { status: 'queued', position: 0, upload: [d, total] } });
              };
              const res = await runRemote('', {
                sensors: meshes.slice(0, n), context: meshes.slice(n), onUpload, ...(c.tool ? { tool: c.tool } : {}),
                epw: c.epw, args: p.args.map((a) => a.replace(UUID, (id) => core.get(id) ?? id)), signal: own.signal, clientId: CLIENT_ID,
                onStatus: (job) => { if (mine()) dispatch({ type: 'RUN', slot, run: job.state === 'queued' ? { status: 'queued', position: job.position ?? 0 } : { status: 'running', progress: job.progress, eta_s: job.eta_s } }); },
              });
              res.manifest.meshes.forEach((g, i) => {
                const o = p.receivers[i], t = forms[i], want = o && (c.on === 'faces' ? t?.faces ?? o.tris : t?.points ?? o.verts);
                if (!o || g.count !== want) throw new Error(`${o?.name ?? g.name}: the server returned ${g.count} rows, expected ${want}. Reload the model and run again.`);
              });
              if (!mine()) throw new Error('changed'); // its model changed during the job: runBatch ends it idle, never a new model's result
              // Every element's area, aligned with the rows: the weight of every statistic, chart, tool and export, written
              // once here instead of per mesh on each use; the last result's when its receivers are these rows, unchanged
              // (row ids change with any re-read).
              const was = p.m.result, keep = was?.on === c.on && was.receivers.length === n && p.receivers.every((o, i) => o.id === was.receivers[i]) && !hashed.some((k) => k < n)
                && forms.every((t, i) => t === (was.forms?.[i] ?? null)); // the same rows: a form's id may be hashed already (Ladybug and back)
              const weights = keep ? was.weights : new Float32Array(res.manifest.meshes.reduce((a, g) => a + g.count, 0));
              if (!keep) res.manifest.meshes.forEach((g, i) => {
                const cv = conv.current.get(p.receivers[i].id), t = forms[i];
                if (!cv || !same(stamps[i], sent[i].stamp())) throw new Error('changed'); // re-read, or changed since sent: ended idle as above
                const { positions, indices } = t ? cv.receiver!(t).mesh() : cv.make(); // one receiver at a time
                weights.set(t ? rowAreas(faceAreas(positions, indices), t, c.on) : (c.on === 'faces' ? faceAreas : vertexAreas)(positions, indices), g.first);
              });
              dispatch({ type: 'RUN', slot, run: { status: 'done', result: { ...res, weights, forms, receivers: p.receivers.map((o) => o.id), on: c.on, key: p.key, elapsed: (performance.now() - t0) / 1000, switches: p.switches } } });
            } finally {
              own.abort(); // the run is over: a PUT still on its way after another failed stops (and reports no progress)
              signal.removeEventListener('abort', off);
              if (jobs.current[slot] === own) delete jobs.current[slot];
            }
          },
        };
      }), ctrl.signal, (slot, end) => {
        if (end === 'idle') lastKey.current[slot] = null; // cancelled or changed: the same inputs may run again (Auto included)
        // The server and the core name a mesh by its content id or core name: say the row's name (a job id stays)
        dispatch({ type: 'RUN', slot, run: end === 'idle' ? { status: 'idle' } : { status: 'error', message: end.message.replace(CORE, (t) => names.get(t) ?? t) } });
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
    for (const m of models) if (!m.result && m.run.status === 'idle') lastKey.current[m.slot] = null;
    if (autoOn && !busy.current && per.some((p) => p.receivers.length && p.key !== lastKey.current[p.m.slot])) void onRun(true);
  }, [autoOn, keys, ended, models]); // eslint-disable-line react-hooks/exhaustive-deps -- onRun is this render's closure: it reads the settings the keys came from
  // Nothing waits for the materials any more (read, or the switches that use them off): Auto re-checks (ended), a click
  // held for them runs.
  useEffect(() => {
    if (!materialsReady) return;
    setEnded((k) => k + 1);
    if (held.current) { held.current = false; void onRun(); }
  }, [materialsReady]); // eslint-disable-line react-hooks/exhaustive-deps -- onRun as above

  // The comparison: the result column by name (the reference: the first model in slot order with a result), and one
  // colour scale for the views and the charts over every model's values: the quantity's gradient, its legend domain
  // (the data's unless overridden), its problem range and the two range colours, from the persisted viz settings.
  const ref = models.find((m) => m.result)?.result ?? null;
  const column = ref ? Math.min(c.column, ref.columns.length - 1) : 0, shown = ref?.columns[column] ?? null;
  const cols = models.map((m) => (m.result && shown ? m.result.columns.indexOf(shown) : -1)); // a result without it counts as none
  const bySlot = [0, 1, 2, 3].map((k) => models.find((m) => m.slot === k)?.result ?? null); // fixed length: memo deps
  const results = useMemo(() => bySlot.filter((r): r is RunResult => !!r), bySlot); // eslint-disable-line react-hooks/exhaustive-deps
  const domain = useMemo<[number, number]>(() => (shown ? unionRange(results, shown) : [NaN, NaN]), [results, shown]); // ponytail: O(rows) per new result; cache per result if it shows
  const scale = useMemo<Scale | null>(() => (shown ? scaleFor(shown, domain, c.viz, results) : null), [shown, domain[0], domain[1], c.viz, results]); // eslint-disable-line react-hooks/exhaustive-deps -- by value: an equal range repaints nothing
  const stale = per.map((p) => !!p.m.result && !inFlight(p.m.run) && p.m.result.key !== p.key && !(autoOn && p.key !== lastKey.current[p.m.slot])); // unless Auto is about to run it
  const staleKey = stale.map(Number).join('');
  const compared = useMemo<Compared[]>(() => models.map((m, i) => ({ ...m, col: cols[i], stale: staleKey[i] === '1' })), [models, shown, staleKey]); // eslint-disable-line react-hooks/exhaustive-deps -- cols follow the models and the column: stable across the cursor's moves
  const busyBar = models.some((m) => inFlight(m.run)) && !autoOn; // a click batch: the button waits and Cancel shows; Auto runs do not flash them
  return { models, optics, materialsReady, per, keys, autoOn, onRun, busy, held, abort, jobs, lastKey, slow, column, shown, cols, results, domain, scale, compared, busyBar };
}
