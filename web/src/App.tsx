// Shell: app bar, inputs panel, the models' views with the run bar, results panel; owns the models (up to four, each in
// its own USD viewer, its meshes built on demand), the per-mesh builders and content ids, the runs (one batch per click or Auto,
// the models one after another), the comparison (one colour scale over every model), the theme mode, the view
// preferences (sidebar widths, Auto, the views side by side or stacked, linked cameras, the display mode) and the section
// every view shows.
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { Object3D } from 'three';
import type { LocalFile, SectionGizmo, SectionSource, ViewState } from 'usd-viewer';
import { Splitter } from './Splitter';
import { cfgFor, useAnalysis, type Analysis, type Conv, type TexStats } from './analysis';
import type { ChartEdit } from './charts/ChartSettings';
import { derivedTz, weatherLeap } from './lib/args';
import { BUILT_IN } from './lib/charts';
import { zoneAt } from './lib/zone';
import { extract, type RowMesh } from './lib/extract';
import { scaleFor } from './lib/gradients';
import { loadFiles, png } from './lib/loaders';
import { rowNames } from './lib/tree';
import { toUsda } from './lib/usda';
import { fmtNum, roundNum, unionRange, unitFor } from './lib/result';
import { NONE, active, describe, fromStage, toStage, type Section } from './lib/section';
import { link, type SavedView } from './lib/views';
import { exclusive, settled } from './mcp/bridge';
import { appView, connect, inShot, isStaging, putReport, storedReport, type AnalysisCtl, type Ctl } from './mcp/tools';
import { CombinedPanel } from './panels/CombinedPanel';
import { InfoButton } from './panels/InfoPanel';
import { LocationPanel } from './panels/LocationPanel';
import { MaterialsPanel } from './panels/MaterialsPanel';
import { ModelPanel } from './panels/ModelPanel';
import { ResultsPanel } from './panels/ResultsPanel';
import { SetsPanel } from './panels/SetsPanel';
import { SettingsPanel } from './panels/SettingsPanel';
import { columnOf } from './sets/combine';
import { kept } from './sets/kept';
import { SetsMenu } from './sets/SetsMenu';
import { useSetRuns } from './sets/runs';
import { applyReport, captureSet, copySet, copyText, isSet, notOpen, renameSet, type AnalysisSet, type CombinedView, type SetModel } from './sets/model';
import { useCombined } from './sets/useCombined';
import { useSaved } from './sets/useSaved';
import { TimePanel } from './panels/TimePanel';
import { ViewSettingsPanel } from './panels/ViewSettingsPanel';
import { WeatherPanel } from './panels/WeatherPanel';
import { changed, generate, generation } from './report/generate';
import { editChart, parseReports, type AppModel, type Report, type Stored } from './report/spec';
import { TAGGED, initialState, loadRole, parseSettings, reducer, serializeSettings, swapModel, type Action, type Model, type ObjectRow, type Role, type RunResult, type Tab, type Tool } from './store';
import { Icon, LETTERS, Segmented, Tag, knob } from './ui';
import { Viewer } from './viewer/Viewer';
import { download, type ExportMode, type Format, type PickedModel } from './viewer/download';
import { DISPLAYS, DisplayMenu, DownloadMenu, ReportsMenu, SectionMenu, ViewsMenu, type Display } from './viewer/Views';
import type { SunView } from './viewer/sunpath';
import { viewer } from './viewer/usd';

const KEY = 'daylight.settings', THEME_KEY = 'daylight.theme', UI_KEY = 'daylight.ui';
// View preferences, stored apart from the settings: sidebar widths (px; 22rem / 24rem defaults), the sun path, Auto run,
// the subdivision level (the viewer's: 0 = the control cage, -1 = auto, 1..3; every model alike), two or three views
// side by side or stacked, linked cameras, the analysis shown (its tab), the views' display mode and value labels (the
// Display menu).
const UI = { widths: { left: 352, right: 384 }, sunPath: true, auto: false, subdiv: 0, split: 'side' as 'side' | 'stacked', link: true, tab: 'daylight' as Tab, display: 'shaded' as Display, labels: false }, MIN_W = 240, MAX_W = 640;
export type UiPrefs = typeof UI;

type ThemeMode = 'auto' | 'light' | 'dark';
const media = window.matchMedia('(prefers-color-scheme: dark)');
const readTheme = (): ThemeMode => { try { const m = localStorage.getItem(THEME_KEY); return m === 'light' || m === 'dark' ? m : 'auto'; } catch { return 'auto'; } };
const readUi = (): typeof UI => { try { const p = JSON.parse(localStorage.getItem(UI_KEY) ?? 'null') ?? {}; return { ...UI, ...p, widths: { ...UI.widths, ...p.widths }, tab: p.tab === 'views' || p.tab === 'combined' ? p.tab : 'daylight', labels: p.labels === true, display: DISPLAYS.some(([d]) => d === p.display) ? p.display : UI.display }; } catch { return UI; } };

/** A view's model as the app holds it: the viewer's object per row id, the model's own names by prim path (glb / gltf /
 *  obj), a load in progress or its problem, and the open counter (bumped per opened model: the tree resets and the camera
 *  frames; a variant switch keeps both). */
export interface Pane { meshes: ReadonlyMap<string, Object3D>; names: ReadonlyMap<string, string>; loading: boolean; loadError: string | null; stage: number }
const NO_PANE: Pane = { meshes: new Map(), names: new Map(), loading: false, loadError: null, stage: 0 };

export default function App() {
  const [state, toStore] = useReducer(reducer, undefined, () => {
    let raw: string | null = null;
    try { raw = localStorage.getItem(KEY); } catch { /* storage blocked: defaults */ }
    return initialState(parseSettings(raw));
  });
  // every action passes the session's result cache first (sets/kept.ts: finished runs in, a re-opened model's out)
  const dispatch = useCallback((a: Action) => { kept.observe(a); toStore(a); }, []);
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
  const analyses = useRef<Pick<Analysis, 'jobs' | 'lastKey' | 'held' | 'busy'>[]>([]);
  const [sunScale, setSunScale] = useState(1); // the sun path's radius over the one fitted to the model; 1 on every model load
  // Per model (slot), the prim paths of the meshes its sun path is fitted to instead of the whole model: picked in the
  // Time panel from the selection, for this session; gone when the slot opens another model.
  const [sunAround, setSunAround] = useState<Readonly<Record<number, readonly string[]>>>({});
  // the section every view shows (lib/section.ts, model metres): view only, this session; never a setting, a run input or
  // a key, and never cleared by a new model, a variant switch or a re-read
  const [section, setSection] = useState<Section>(NONE);
  const sectionNow = useRef(section); // for the listeners and callbacks
  sectionNow.current = section;
  const [texStats, setTexStats] = useState<TexStats>({}); // per slot (each core numbers its files from /drop/1), by readKey (null: unreadable)
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
  const sets = useSaved(); // the saved sets and combined views (every client's)
  const [openSets, setOpenSets] = useState<Readonly<Record<Tool, string | null>>>({ daylight: null, views: null }); // per tab, the set opened or saved last
  const [setNote, setSetNote] = useState<{ tool: Tool; lines: string[] } | null>(null); // what the last open did per model, or the last save
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
    const lone = loadRole(found);
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

  const s = state.settings, v = s.viewSim, views = ui.tab === 'views', combined = ui.tab === 'combined';
  // The view analysis' own actions (ROLE, SHADE, RUN, COLUMN, COLOUR_BY, ERRORS) tagged for its slice of the store; the
  // others as they are. Stable, so the memoised panels keep their props. The Combined tab's own: its column and colouring.
  const dispatchViews = useCallback((a: Action) => dispatch(TAGGED.has(a.type) ? ({ ...a, tab: 'views' } as Action) : a), []);
  const dispatchCombined = useCallback((a: Action) => dispatch(a.type === 'COLUMN' || a.type === 'COLOUR_BY' ? { ...a, tab: 'combined' } : a), []);
  const vModels = useMemo(() => state.models.map(swapModel), [state.models]); // the view analysis' models, seen as daylight's
  const reflect = s.sim.mode === 'physical' && s.sim.bounces > 0;
  // Daylight per model, and the view analysis: the same models, meshes and materials, its own roles, settings and runs
  // (analysis.ts cfgFor: how each runs).
  // saved sets run in the background (sets/runs.ts), one job at a time and only while neither analysis has a batch on its way
  const runs = useSetRuns({ state, conv, reading, texStats, setTexStats, idle: () => analyses.current.every((x) => !x.busy.current), subdiv: ui.subdiv });
  const shared = { conv, texStats, setTexStats, reading, auto: ui.auto, viz: s.viz, tick: runs.tick };
  const D = useAnalysis({ ...shared, ...cfgFor('daylight', s), models: state.models, column: state.column, visible: ui.tab === 'daylight', dispatch });
  const V = useAnalysis({ ...shared, ...cfgFor('views', s), models: vModels, column: state.viewAnalysis.column, visible: views, dispatch: dispatchViews });
  analyses.current = [D, V];
  // the Combined tab: the combined view shown, from the saved sets' results (sets/useCombined.ts), last
  const C = useCombined({ state, saved: sets.saved, runs, visible: combined, viz: s.viz });
  // T: the tab's analysis that runs (daylight's on the Combined tab, whose inputs panels hide); A: what the screen shows
  const T = views ? V : D, A = combined ? C : T, viz = combined ? C.viz : s.viz;
  const colourBy = combined ? state.combined.colourBy : views ? state.viewAnalysis.colourBy : state.colourBy;

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
  const charts = useMemo(() => (ui.tab !== 'daylight' ? s.charts.filter((c) => BUILT_IN.some((b) => b.id === c.id)) : s.charts), [ui.tab, s.charts]); // the views and Combined tabs: the built-ins, their look shared
  const groups = useMemo(() => [...new Set(vModels.flatMap((m) => m.objects.flatMap((o) => (o.role === 'shade' && o.group ? [o.group] : []))))], [vModels]); // the target groups in use
  // one download at a time; its error is its result's, by run key (holding the result itself would keep a replaced one's
  // values alive)
  const [exporting, setExporting] = useState(false), [exportError, setExportError] = useState<{ key: string; message: string } | null>(null);
  /** The active model's result of analysis X as a file, coloured by `look` (the Download menu: the tab's; the agent
   *  tools: daylight's). */
  const downloadOf = (X: Pick<Analysis, 'models' | 'cols' | 'results'>, look = s.viz) => async (format: Format, mode: ExportMode) => {
    const xm = X.models[ai], picked = model.current[xm.slot]?.picked, col = X.cols[ai], result = xm.result;
    if (!result || col < 0 || !picked) return;
    setExporting(true);
    setExportError(null);
    try {
      await download(format, mode, {
        usd: viewer(xm.slot).el, result, objects: xm.objects, meshes: ap.meshes, column: col, model: picked,
        scales: result.columns.map((c) => scaleFor(c, unionRange(X.results, c), look, X.results)), // the colours on screen: one scale over every model
      });
    } catch (e) {
      setExportError({ key: result.key, message: (e as Error).message });
    } finally {
      setExporting(false);
    }
  };
  const onDownload = useCallback(downloadOf(A, viz), [A.models[ai], ai, ap.meshes, A.cols[ai], A.results, viz]); // eslint-disable-line react-hooks/exhaustive-deps -- the tab's analysis by its active model, cols by its active entry
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
  // picking up a hidden session. The tools act on daylight unless they name the view analysis (Ctl.analysis); shots show
  // the tab they name, else the one shown.
  const ctl = useRef<Ctl>(null!);
  useLayoutEffect(() => {
    const analysisOf = (X: Analysis, tool: Tool): AnalysisCtl => ({
      tool, models: X.models, optics: X.optics, materialsReady: X.materialsReady, per: X.per, shown: X.shown, scale: X.scale, domain: X.domain,
      colourBy: tool === 'views' ? state.viewAnalysis.colourBy : state.colourBy, column: tool === 'views' ? state.viewAnalysis.column : state.column,
      errors: tool === 'views' ? state.viewAnalysis.errors : state.errors, dispatch: tool === 'views' ? dispatchViews : dispatch,
      onRun: X.onRun, onDownload: downloadOf(X), busy: () => X.busy.current, held: () => X.held.current, cancel: () => X.abort.current?.abort(),
    });
    ctl.current = {
      state, dispatch, panes, ui, setUi, theme: mode, setTheme, sunScale, setSunScale, section, setSection: (s) => onSection(s, null), views: savedViews, setViews: setSavedViews,
      optics: D.optics, materialsReady: D.materialsReady, per: D.per, shown: D.shown, scale: D.scale, domain: D.domain,
      exporting, exportError, onFiles, onRemove, onVariant, onSubdiv, onRefine, onRun: D.onRun, onDownload: downloadOf(D), meshOf,
      busy: () => D.busy.current, held: () => D.held.current, cancel: () => D.abort.current?.abort(), viewer,
      variants, reports, refreshReports, generate: (id) => generate(id, () => ctl.current), generation, fileOf: (slot) => model.current[slot]?.picked.root,
      sets, runs, combined: C, openSet: onOpenSet, analysis: (tool) => analysisOf(tool === 'views' ? V : D, tool),
    };
    settled();
  });
  useEffect(() => (agents ? connect(() => ctl.current) : undefined), [agents]);

  // A tab switch shows the other analysis' roles, results and colours: the cursor's and the bin's marks go
  const onTab = (t: Tab) => { dispatch({ type: 'PROBE', probe: null }); dispatch({ type: 'BIN', bin: null }); dispatch({ type: 'BINS', bins: [] }); setUi((u) => ({ ...u, tab: t })); void sets.refresh(); };
  // Analysis sets (sets/model.ts): the tab's, the one open on each tab, what the last open did per model
  const tool: Tool = views ? 'views' : 'daylight';
  const tabSets = useMemo(() => sets.saved.filter((x): x is AnalysisSet => isSet(x) && x.tool === tool), [sets.saved, tool]);
  const openSet = tabSets.find((x) => x.id === openSets[tool]) ?? null;
  // `copied`: a copy's own line, for its model's
  const onOpenSet = (set: AnalysisSet, copied?: { model: string; text: string }) => {
    dispatch({ type: 'APPLY_SET', set });
    if (set.subdiv !== undefined && set.subdiv !== ui.subdiv) onSubdiv(set.subdiv); // re-reads after the roles land: they stay by path
    setOpenSets((o) => ({ ...o, [set.tool]: set.id }));
    setSetNote({ tool: set.tool, lines: [...applyReport(state.models, set).map((r) => (r.model === copied?.model ? copied.text : r.text)), ...notOpen(state.models, set)] });
    if (ui.tab !== set.tool) onTab(set.tool);
  };
  // Copy to model: entry `from` of `set` as a new set for the model in `slot`, saved, then opened to edit
  const openModels = useMemo(() => state.models.filter((m) => m.name).map((m) => ({ slot: m.slot, name: m.name })), [state.models]);
  const onCopySet = (set: AnalysisSet, from: SetModel, slot: number, name: string) => {
    const to = state.models.find((m) => m.slot === slot);
    if (!to?.name) return;
    const { set: copy, counts } = copySet(set, from, to, [...viewer(slot).materials.values()].map((x) => x.path), name);
    void sets.put(copy).then((ok) => { if (ok) onOpenSet(copy, { model: LETTERS[slot], text: copyText(LETTERS[slot], counts) }); });
  };
  // the setup of analysis `of` now as set `name` (`was`: the set it updates), open on its tab from then on: from its own
  // tab's Sets menu, or from the Combined tab
  const onSaveSet = (name: string, of: Tool, was?: AnalysisSet) => {
    const x = captureSet(state, of, name, { shown: (of === 'views' ? V : D).shown, was, subdiv: ui.subdiv });
    void sets.put(x).then((ok) => { if (ok) { setOpenSets((o) => ({ ...o, [of]: x.id })); setSetNote({ tool: of, lines: [was ? `'${x.name}' updated with the current setup` : `'${x.name}' saved; it is open now`] }); } });
  };
  const onRenameSet = (set: AnalysisSet, name: string) => sets.put(renameSet(set, name));
  // the Combined tab: a set's Run for the models that miss its result, a view shown, saved or deleted
  const onRunSet = useCallback((set: AnalysisSet) => void runs.run(set, runs.statusOf(set).filter((x) => x.state === 'missing' || x.state === 'error').map((x) => x.slot)), [runs]);
  const onDeleteSet = useCallback((set: AnalysisSet) => void sets.remove(set.id), [sets.remove]); // eslint-disable-line react-hooks/exhaustive-deps -- remove is stable
  const onShowCombined = useCallback((cv: CombinedView) => dispatchCombined({ type: 'COLUMN', column: columnOf(cv) }), [dispatchCombined]);
  const onSaveCombined = useCallback(async (cv: CombinedView) => { const ok = await sets.put(cv); if (ok) onShowCombined(cv); return ok; }, [sets.put, onShowCombined]); // eslint-disable-line react-hooks/exhaustive-deps -- put is stable
  const onDeleteCombined = useCallback((cv: CombinedView) => void sets.remove(cv.id), [sets.remove]); // eslint-disable-line react-hooks/exhaustive-deps -- remove is stable
  const tabs: [Tab, string][] = [['daylight', 'Daylight'], ['views', 'View analysis'], ['combined', 'Combined']];
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
        <h1 className="sr-only">{combined ? 'Combined views' : views ? 'View analysis' : 'Daylight simulation'}</h1>
        <div className="split fill" style={knob('--split-aside', `${ui.widths.right}px`)}>
          <div className="split split--aside-start fill" style={knob('--split-aside', `${ui.widths.left}px`)}>
            <div className="panel-wrap">
              <aside className="panel stack" style={knob('--stack-gap', 'var(--space-4)')} aria-label="Inputs">
                {combined && <SetsPanel sets={C.sets} statusOf={runs.statusOf} error={sets.error} saving={sets.saving} models={openModels} open={openSets} onOpen={onOpenSet} onRun={onRunSet} onDelete={onDeleteSet} onCopy={onCopySet} onSave={(of, name) => onSaveSet(name, of)} onUpdate={(x) => onSaveSet(x.name, x.tool, x)} onRename={onRenameSet} />}
                {combined && <CombinedPanel views={C.views} sets={C.sets} shown={C.view} notes={C.notes} error={sets.error} saving={sets.saving} statusOf={runs.statusOf} onShow={onShowCombined} onSave={onSaveCombined} onDelete={onDeleteCombined} />}
                {/* the tab's model and materials (daylight's on the Combined tab), mounted there too, hidden */}
                <div className="panel-group" hidden={combined}>
                <ModelPanel models={T.models} active={am.slot} usd={viewer(am.slot).el} names={ap.names} loading={ap.loading} busy={Object.values(panes).some((p) => p.loading)} error={ap.loadError} errors={views ? state.viewAnalysis.errors : state.errors} stage={ap.stage} subdiv={ui.subdiv} selfOcclude={views ? v.selfOcclude : s.sim.selfOcclude} analysis={tool} groups={groups} onFiles={onFiles} onVariant={onVariant} onSubdiv={onSubdiv} onRefine={onRefine} onRemove={onRemove} dispatch={views ? dispatchViews : dispatch} />
                <MaterialsPanel slot={am.slot} title={n > 1 ? `Materials, model ${LETTERS[am.slot]}` : 'Materials'} rows={T.optics[ai].materials} fallback={T.optics[ai].fallback} glass={T.optics[ai].glass} reading={!T.materialsReady} mode={views ? 'physical' : s.sim.mode} transmission={views ? v.transmission : s.sim.transmission} reflections={!views && reflect} edited={Object.keys(am.optics).length > 0} dispatch={dispatch} />
                </div>
                {/* daylight's own inputs stay mounted on the other tabs (the weather header, the map), hidden */}
                <div className="panel-group" hidden={ui.tab !== 'daylight'}>
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
                      scale={A.scale} bin={state.bin} bins={state.bins} probeLabel={probed === m ? probeLabel : null} theme={theme} dispatch={dispatch} sun={ui.tab === 'daylight' ? sunView : null} around={sunAround[m.slot] ?? null} section={sectionWords} analysis={ui.tab} display={ui.display} labels={ui.labels}
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
              {/* left: the Views, Section, Display and Download menus (the active view's; Display: every view's); middle: how the views share the space and the
                  camera; right-aligned, the button's label never changes and Cancel appears on its left: the tickbox stays
                  put; progress shows in the Results run lines */}
              <div className="viewport__bar">
                <div className="cluster cluster--between">
                  <div className="cluster">
                    <ViewsMenu usd={viewer(am.slot).el} model={n > 1 ? LETTERS[am.slot] : undefined} disabled={!ap.meshes.size} views={savedViews} reports={reports} onSave={(sv) => setSavedViews((l) => [...l, sv])} onRemove={(id) => setSavedViews((l) => l.filter((sv) => sv.id !== id))} onReportView={onReportView} onSection={(sc) => onSection(sc, null)} />
                    <SectionMenu usd={viewer(am.slot).el} section={section} selected={am.selection.paths.length > 0} disabled={!ap.meshes.size} onChange={onSection} />
                    <DisplayMenu value={ui.display} onChange={(display) => setUi((u) => ({ ...u, display }))} labels={ui.labels} onLabels={(labels) => setUi((u) => ({ ...u, labels }))} />
                    {!combined && <SetsMenu tool={tool} sets={tabSets} open={openSet} note={setNote?.tool === tool ? setNote.lines : null} error={sets.error} saving={sets.saving} onShow={sets.refresh} onOpen={onOpenSet} onSave={(name) => onSaveSet(name, tool)} onUpdate={(x) => onSaveSet(x.name, tool, x)} models={openModels} onCopy={onCopySet} />}
                    <DownloadMenu model={n > 1 ? LETTERS[am.slot] : undefined} ready={!!am.result && A.cols[ai] >= 0} exporting={exporting} error={exportError && exportError.key === am.result?.key ? exportError.message : null} onDownload={onDownload} />
                    {/* only while there are reports (daylight's); a generation's failure shows as its lastError */}
                    {ui.tab === 'daylight' && reports?.length && reportApp ? <ReportsMenu reports={reports} app={reportApp} error={reportError} onOpen={refreshReports} onDelete={(id) => void onReportDelete(id)} onGenerate={(id) => { setReportError(null); ctl.current.generate(id).catch(() => {}); }} /> : null}
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
                  {combined ? (
                    <div className="cluster cluster--end">
                      {(C.busyBar || n > 1) && <button className={`btn btn--ghost${C.busyBar ? '' : ' viewport__idle'}`} type="button" disabled={!C.busyBar} onClick={runs.cancel}>Cancel</button>}
                      <button className="btn btn--primary" type="button" disabled={!C.runnable || C.busyBar} aria-busy={C.busyBar} title="Runs the sets the combined view shown needs, for the models without their result; a view shown runs them by itself, once" onClick={() => C.runMissing(true)}>Run missing sets</button>
                    </div>
                  ) : (
                  <div className="cluster cluster--end">
                    {/* with several models kept, hidden while idle: the bar under the views never changes its height */}
                    {(T.busyBar || n > 1) && <button className={`btn btn--ghost${T.busyBar ? '' : ' viewport__idle'}`} type="button" disabled={!T.busyBar} onClick={() => T.abort.current?.abort()}>Cancel</button>}
                    <label title={views ? 'Runs the view analysis whenever a view setting or a role changes' : 'Runs the simulation whenever the location, the date, the time or a setting changes'}>
                      <input type="checkbox" id="auto-run" checked={ui.auto} onChange={(e) => setUi((u) => ({ ...u, auto: e.target.checked }))} /> Run on every change
                    </label>
                    <button className="btn btn--primary" type="button" disabled={!T.per.some((p) => p.receivers.length) || T.busyBar} aria-busy={T.busyBar} title={n > 1 ? 'Runs every model with a receiver, one after another; each result shows as it lands' : undefined} onClick={() => void T.onRun()}>{views ? 'Run view analysis' : 'Run simulation'}</button>
                  </div>
                  )}
                </div>
              </div>
            </div>
          </div>
          <div className="panel-wrap">
            <aside className="panel stack" data-density="compact" aria-label="Results">
              <ResultsPanel models={A.compared} column={A.column} colourBy={colourBy} hovered={state.hovered} probe={state.probe} bin={state.bin} bins={state.bins} scale={A.scale} domain={A.domain} viz={viz} charts={charts} auto={!combined && T.autoOn && !T.slow} analysis={ui.tab} dispatch={combined ? dispatchCombined : views ? dispatchViews : dispatch} reports={ui.tab === 'daylight' ? reports : null} reportError={reportError} onReportChart={onReportChart} />
            </aside>
            <Splitter side="right" value={ui.widths.right} min={MIN_W} max={MAX_W} defaultValue={UI.widths.right} label="Results panel width" onChange={(right) => setUi((u) => ({ ...u, widths: { ...u.widths, right } }))} />
          </div>
        </div>
      </main>
    </div>
  );
}
