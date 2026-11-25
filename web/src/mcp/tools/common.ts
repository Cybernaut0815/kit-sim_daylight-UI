// What every tool module shares: the controller App hands the tools (Ctl), the reply and wait helpers, model and
// analysis lookups, a result's freshness and stable run key, the app as a report sees it, and the local files route.
import type { Dispatch, SetStateAction } from 'react';
import type { Pane, UiPrefs } from '../../App';
import { validate, validateViews } from '../../lib/args';
import type { RowMesh } from '../../lib/extract';
import type { Scale } from '../../lib/gradients';
import type { resolveOptics } from '../../lib/optics';
import type { Section } from '../../lib/section';
import type { SavedView } from '../../lib/views';
import type { Pdf } from '../../report/generate';
import type { AppModel, AppView, Stored } from '../../report/spec';
import type { AnalysisSet, CombinedView } from '../../sets/model';
import type { SetRuns } from '../../sets/runs';
import type { Combined } from '../../sets/useCombined';
import type { SavedSets } from '../../sets/useSaved';
import { inFlight, type Action, type Model, type ObjectRow, type RunResult, type State, type Tab, type Tool } from '../../store';
import type { ExportMode, Format } from '../../viewer/download';
import type { Slot } from '../../viewer/usd';
import type { Density } from '../../viewer/viewfield';
import { until, type CallToolResult } from '../bridge';

type Theme = 'auto' | 'light' | 'dark';
/** Prim paths per model slot (the Time panel's sun path round a selection, the field preview's receivers). */
export type PerSlot = Readonly<Record<number, readonly string[]>>;
/** The View settings panel's preview of the field each eye traces: shown, its size, how many glyphs, on which receivers. */
export interface FieldPreview { shown: boolean; scale: number; density: Density; around: PerSlot }
/** App as the tools drive it: App rewrites it on every commit. */
export interface Ctl {
  state: State; dispatch: Dispatch<Action>;
  panes: Readonly<Record<number, Pane>>; // by slot
  ui: UiPrefs; setUi: Dispatch<SetStateAction<UiPrefs>>;
  theme: Theme; setTheme: (mode: Theme) => void; // the mode (auto: the system's)
  sunScale: number; setSunScale: (scale: number) => void;
  sunAround: PerSlot; setSunAround: (around: PerSlot) => void; // the sun path fitted to these meshes per model (none: the whole model)
  field: FieldPreview; setField: (patch: Partial<FieldPreview>) => void;
  section: Section; setSection: (s: Section) => void; // every view's section (model metres; lib/section.ts), view only; setting it lets the user's gizmo go
  views: SavedView[]; setViews: Dispatch<SetStateAction<SavedView[]>>;
  optics: ReturnType<typeof resolveOptics>[]; materialsReady: boolean; // optics per model, in state.models order
  per: { m: Model; receivers: ObjectRow[]; shades: ObjectRow[]; elements: number; key: string }[]; // per model, in order: its receivers' faces or vertices (the rows a run returns), its run key now
  shown: string | null; scale: Scale | null; domain: [number, number]; // the column every view shows, its colour scale, every model's data range
  exporting: boolean; exportError: { key: string; message: string } | null; // the last download's failure, by its result's run key
  onFiles: (slot: number, files: File[]) => Promise<void>; onRemove: (slot: number) => void;
  onVariant: (slot: number, path: string, set: string, variant: string) => void; onSubdiv: (level: number) => void;
  onRefine: (slot: number, paths: string[], level: number | null) => void;
  onRun: () => Promise<void>; onDownload: (format: Format, mode: ExportMode) => Promise<void>;
  // a row's mesh (model metres, Z up), built per call: take it once per mesh where it is read, never keep it. As drawn,
  // or with a result the mesh its rows name (a receiver sent as the file's own faces and points: lib/extract RowMesh)
  meshOf: (id: string, r?: RunResult | null) => RowMesh | undefined;
  busy: () => boolean; held: () => boolean; cancel: () => void; // a batch on its way; a click waiting for the materials; Cancel
  viewer: (slot: number) => Slot;
  variants: (slot: number) => AppModel['choices']; // the variant choices made in the app since the slot's file opened
  fileOf: (slot: number) => string | undefined; // the file the slot opened (within a picked folder: its path there)
  reports: Stored[] | null; refreshReports: () => Promise<void>; // GET /reports (null: no report routes here); fetch it again
  generate: (id: string) => Promise<Pdf>; generation: (id: string) => { generating: boolean; lastError: string | null }; // report/generate.ts
  sets: Pick<SavedSets, 'saved' | 'put' | 'remove' | 'refresh' | 'error'>; // the saved sets and combined views (GET /sets), written through
  runs: Pick<SetRuns, 'statusOf' | 'run' | 'cancel' | 'busy'>; // the sets run in the background (sets/runs.ts)
  combined: Pick<Combined, 'views' | 'sets' | 'view' | 'inputs' | 'notes' | 'models' | 'shown' | 'scale' | 'domain'>; // the Combined tab (sets/useCombined.ts)
  previewCombined: (view: CombinedView | null) => void; // a draft the Combined tab shows instead of the saved view (null: none)
  openSet: (set: AnalysisSet, copied?: { model: string; text: string }) => void; // a set opened as the Sets menu opens it (APPLY_SET, its tab shown); copied: a copy's own note line
  analysis: (tool: Tool) => AnalysisCtl; // daylight's (the fields above) or the view analysis'
}
/** One analysis as the tools drive it (analysis.ts useAnalysis): its models (the view analysis' seen as daylight's: its
 *  own roles and results), optics, run inputs, the column it shows with its colouring and scale, its problems and its
 *  own dispatch (the view analysis' actions tagged for its slice). */
export interface AnalysisCtl {
  tool: Tool; models: Model[]; optics: Ctl['optics']; materialsReady: boolean; per: Ctl['per']; shown: string | null; scale: Scale | null; domain: [number, number];
  colourBy: 'plain' | 'value'; column: string; errors: Record<string, string>; dispatch: Dispatch<Action>;
  onRun: () => Promise<void>; onDownload: Ctl['onDownload']; busy: () => boolean; held: () => boolean; cancel: () => void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- checked against the tool's inputSchema before a handler runs
export type Args = Record<string, any>;
/** A tool: its checked arguments, the controller now, and when its budget ends (Date.now() ms). */
export type Handler = (a: Args, c: () => Ctl, end: number) => Promise<CallToolResult>;

export const LETTERS = 'ABCD', letter = (slot: number) => LETTERS[slot];
/** A reply: `o` as compact JSON text. */
export const ok = (o: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(o) }] });
/** A path's last part: a file or folder name. */
export const base = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;
/** App's async work ended within the call's budget (else it goes on, and the reply says running). */
export const done = (pred: () => boolean, end: number, what: string) => until(pred, end - Date.now(), what).then(() => true, () => false);

// ---------------------------------------------------------------------------------------------- models and analyses
/** The model in slot `l` (default the active one); a refusal names `field`, the argument that gave the letter. */
export function modelOf(x: Ctl, l?: string, field = 'model'): Model {
  const slot = l === undefined ? x.state.active : LETTERS.indexOf(l), m = x.state.models.find((k) => k.slot === slot);
  if (!m) throw new Error(`${field}: no model in slot ${l}; open one with open_model, or use ${x.state.models.map((k) => letter(k.slot)).join(', ')}`);
  return m;
}
/** The model in slot `l` with meshes, not loading. */
export function loadedOf(x: Ctl, l?: string, field = 'model'): Model {
  const m = modelOf(x, l, field), L = letter(m.slot);
  if (x.panes[m.slot]?.loading) throw new Error(`${field}: model ${L} is loading; call app_state until it has loaded`);
  if (!m.objects.length) throw new Error(`${field}: model ${L} has no model open; open one with open_model`);
  return m;
}
/** A model's meshes by Daylight role; noShade: the receivers among them that cast no shade, when there are. */
export const roles = (m: Model) => {
  const free = m.objects.filter((o) => o.shade === false).length;
  return { ...Object.fromEntries((['receiver', 'shade', 'none'] as const).map((r) => [r, m.objects.filter((o) => o.role === r).length])), ...(free ? { noShade: free } : {}) };
};
/** A model's meshes by its View analysis role: receivers, obstructions, targets by group (noShade: the receivers that
 *  block no rays). */
export const viewRoles = (m: Pick<Model, 'objects'>) => {
  const n = (f: (o: ObjectRow) => boolean) => m.objects.filter(f).length, groups: Record<string, number> = {}, free = n((o) => o.role === 'receiver' && o.shade === false);
  for (const o of m.objects) if (o.role === 'shade' && o.group) groups[o.group] = (groups[o.group] ?? 0) + 1;
  return { receiver: n((o) => o.role === 'receiver'), obstruction: n((o) => o.role === 'shade' && !o.group), targets: groups, none: n((o) => o.role === 'none'), ...(free ? { noShade: free } : {}) };
};
/** What would stop a Daylight run (lib/args validate), by field. */
export const problems = (x: Ctl) => validate(x.state.settings, x.per.some((p) => p.receivers.length > 0), x.materialsReady, Math.max(0, ...x.per.map((p) => p.elements)));
/** What would stop a View analysis run (lib/args validateViews), by field. */
export const viewProblems = (x: Ctl) => {
  const y = x.analysis('views'), groups = y.models.flatMap((m) => m.objects.flatMap((o) => (o.role === 'shade' && o.group ? [o.group] : [])));
  return validateViews(x.state.settings.viewSim, groups, y.per.some((p) => p.receivers.length > 0), y.materialsReady);
};
/** The slots whose views have meshes drawn. */
export const loadedSlots = (x: Ctl) => x.state.models.filter((m) => (x.panes[m.slot]?.meshes.size ?? 0) > 0).map((m) => m.slot);
/** What tab `tab` shows: its models (their results), the column it keeps and shows with its colouring and scale, and
 *  the dispatch that sets them (tagged for its slice). */
export function tabOf(x: Ctl, tab: Tab) {
  if (tab === 'combined') {
    const { column, colourBy } = x.state.combined;
    return { models: x.combined.models, column, colourBy, shown: x.combined.shown, scale: x.combined.scale, dispatch: (a: Action) => x.dispatch(a.type === 'COLUMN' || a.type === 'COLOUR_BY' ? { ...a, tab: 'combined' } : a) };
  }
  const y = x.analysis(tab);
  return { models: y.models, column: y.column, colourBy: y.colourBy, shown: y.shown, scale: y.scale, dispatch: y.dispatch };
}
/** The analysis a tool acts on: its `analysis` argument's, else daylight's. */
export const analysisOf = (x: Ctl, a: Args) => x.analysis(a.analysis ?? 'daylight');
/** Model `m` as analysis `y` sees it (its roles and result there). */
export const inAnalysis = (y: Pick<AnalysisCtl, 'models'>, m: Model) => y.models.find((k) => k.slot === m.slot) ?? m;
/** An analysis' name as the app's tabs show it. */
export const nameOf = (tool: Tool) => (tool === 'views' ? 'View analysis' : 'Daylight');
/** What runs analysis `tool`, for a refusal's hint. */
export const runCall = (tool: Tool) => (tool === 'views' ? "run with analysis 'views'" : 'run');

// ---------------------------------------------------------------------------------------------- results and run keys
export const UUID = /[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/g;
/** A run key with its mesh ids (new per page load and per re-read) as the rows' prim paths: equal inputs, equal key. */
export const stableKey = (key: string, rows: readonly ObjectRow[]) => { const path = new Map(rows.map((o) => [o.id, o.path])); return key.replace(UUID, (id) => path.get(id) ?? id); };
/** Model i's result against the inputs now: running (a job on its way), fresh or stale; null without one. */
export function freshness(x: Pick<Ctl, 'per'>, i: number): 'running' | 'fresh' | 'stale' | null {
  const { m, key } = x.per[i];
  return inFlight(m.run) ? 'running' : !m.result ? null : stableKey(m.result.key, m.objects) === stableKey(key, m.objects) ? 'fresh' : 'stale';
}
/** A stable run key's settings: its arguments and weather (the receivers and shades apart). */
const runOf = (key: string) => JSON.stringify((JSON.parse(key) as unknown[]).slice(0, 2));
/** A result's element areas per receiver, m²: views of its weights. */
export const weightsOf = (r: RunResult) => r.manifest.meshes.map((g) => r.weights.subarray(g.first, g.first + g.count));
// per slot, open_model's paths, the open counter that open gave its pane and the model's name once loaded
export const opened = new Map<number, { paths: string[]; stage: number; name?: string }>();
/** The app as a report sees it (report/spec.ts): the models' files (and paths, opened by open_model), variant choices,
 *  roles (the receivers that cast no shade among them) and results; the column shown, the problem ranges. From the
 *  controller, or from App's render (its Reports menu). */
export const appView = (x: Pick<Ctl, 'shown' | 'state' | 'panes' | 'variants' | 'per'>): AppView => ({
  shown: x.shown, ranges: x.state.settings.viz.ranges,
  models: x.state.models.map((m, i) => {
    const o = opened.get(m.slot), mine = o && o.stage === x.panes[m.slot]?.stage && (o.name ?? m.name) === m.name; // not a file opened in the app since
    return {
      model: letter(m.slot), file: m.objects.length ? m.name : '', ...(mine ? { open: o.paths } : {}), loading: !!x.panes[m.slot]?.loading, choices: x.variants(m.slot),
      receivers: x.per[i].receivers.map((r) => r.path), shades: x.per[i].shades.map((r) => r.path), noShade: x.per[i].receivers.filter((r) => r.shade === false).map((r) => r.path),
      result: freshness(x, i), key: m.result && runOf(stableKey(m.result.key, m.objects)), inputs: runOf(stableKey(x.per[i].key, m.objects)), columns: m.result?.columns ?? [],
    };
  }),
});

// ---------------------------------------------------------------------------------------------- local files
/** GET /files: a file's bytes, or a folder's listing (JSON); the server's refusal names the argument. */
export async function local(path: string, field: string): Promise<Response> {
  const r = await fetch(`/files?path=${encodeURIComponent(path)}`).catch(() => null);
  if (!r?.ok) throw new Error(`${field}: ${r ? (await r.text()).replace(/^error: /, '').trim() : 'the server cannot be reached'}`);
  return r;
}
/** The response is JSON (a folder listing, a list), not a file's bytes. */
export const isJson = (r: Response) => !!r.headers.get('Content-Type')?.startsWith('application/json');
/** A server refusal's text without its 'error: ' prefix. */
export const said = async (r: Response) => (await r.text()).replace(/^error: /, '').trim();
/** A blob as base64 (an image reply), in chunks the call stack takes. */
export async function b64(blob: Blob): Promise<string> {
  const u = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}
