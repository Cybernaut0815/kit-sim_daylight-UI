// How a set applies (the store's APPLY_SET, the set runner, reports): the set's types, which of its model entries an open
// model takes, and its settings and colours over the app's. Pure and types only from the store, so the store can use it
// (sets/model.ts re-exports it with the rest).
import type { ChartSpec } from '../lib/charts';
import type { Scaling } from '../lib/gradients';
import type { OpticsEdit } from '../lib/optics';
import { splitColumn } from '../lib/result';
import type { Model, Settings, Tool, ViewSim } from '../store';

export const LETTERS = 'ABCD';
/** A receiver or shade of a set's model, by prim path: `shade` false, a receiver that casts no shade; `group`, a view
 *  analysis shade's target group. Paths not listed are none. */
export interface SetRole { path: string; role: 'receiver' | 'shade'; shade?: false; group?: string }
/** A model as saved in a set: its letter and file (as a report's ModelRef), its roles, its Materials edits (lib/optics.ts
 *  keys: material paths, the default and glass rows; absent in a set of an older version: the model keeps its own). */
export interface SetModel { model: string; file: string; roles: SetRole[]; optics?: Record<string, OpticsEdit> }
/** A quantity's colours as the Results panel sets them: gradient, its spread, the legend domain, the problem range. */
export interface Look { gradient?: string; scaling?: Scaling; min?: number | null; max?: number | null; lo?: number | null; hi?: number | null }
export type SetSettings = { sim: Omit<Settings['sim'], 'north'>; time: Settings['time'] } | { viewSim: ViewSim };
/** The weather as a set keeps it: an uploaded EPW by its file name (the file stays in the browser that picked it). */
export type SetWeather = Omit<Settings['weather'], 'file'> & { file?: string };
/** The Results panel's colours: each quantity of the set's analysis with its look ({}: the defaults), and the problem
 *  range's two colours. */
export interface SetLooks { quantities: Record<string, Look>; colors: Settings['viz']['colors'] }
/**
 * One analysis' setup: every open model's roles and Materials edits, the tab's run settings, north, the site and weather
 * (Daylight), the result shown, every quantity's colours, the charts and the subdivision level (`subdivOverride`: it
 * also over the meshes' own levels). `look` (the shown quantity's) is a set of an older version's, which also lacks the
 * fields after it: the app keeps its own.
 */
export interface AnalysisSet {
  kind: 'set'; id: string; name: string; created: string; updated: string; tool: Tool;
  models: SetModel[]; settings: SetSettings; column: string; colourBy: 'plain' | 'value'; look?: Look;
  north?: number; site?: Settings['site']; weather?: SetWeather; looks?: SetLooks; charts?: ChartSpec[]; subdiv?: number; subdivOverride?: boolean;
}
/** A subdivision as the app holds it: the level for every model (0 the control cage, -1 auto, 1..3), and whether it
 *  overrides the meshes' own levels (the file's or the Prims row's). */
export interface Subdiv { level: number; override: boolean }
/** How a model found its entry: its own (same letter and file), or its file's entry from a tab that now shows another
 *  file (the file reopened in another tab); `matched` of the entry's `total` paths are in the model. */
export interface Match { entry: SetModel; how: 'same' | 'file'; matched: number; total: number }

/**
 * Model `m`'s entry in a set, among the open models `open`: the one with its letter and file; else, when an entry's own
 * tab shows another file (or none), that entry, for the open models of its file without an entry of their own, in slot
 * order (the file reopened in another tab). Else none (null: the model stays as it is). Never another file's entry: that
 * is copySet's, asked for.
 */
export function entryFor(m: Pick<Model, 'slot' | 'name' | 'objects'>, models: readonly SetModel[], open: readonly Pick<Model, 'slot' | 'name'>[]): Match | null {
  if (!m.name || !models.length) return null;
  const paths = new Set(m.objects.map((o) => o.path)), found = (entry: SetModel, how: Match['how']): Match => ({ entry, how, matched: entry.roles.reduce((n, r) => n + (paths.has(r.path) ? 1 : 0), 0), total: entry.roles.length });
  const owns = (o: Pick<Model, 'slot' | 'name'>) => models.find((e) => e.model === LETTERS[o.slot] && e.file === o.name);
  const own = owns(m);
  if (own) return found(own, 'same');
  const fileIn = (letter: string) => open.find((o) => LETTERS[o.slot] === letter)?.name ?? '';
  const away = models.filter((e) => e.file === m.name && fileIn(e.model) !== e.file); // in letter order, as saved
  const free = open.filter((o) => o.name === m.name && !owns(o)).sort((x, y) => x.slot - y.slot);
  const e = away[free.findIndex((o) => o.slot === m.slot)];
  return e ? found(e, 'file') : null;
}

/** Model `m`'s match in words: 'C: from A, the same file reopened here, 41 of 44 meshes'. */
export function matchText(m: Pick<Model, 'slot'>, match: Match | null): string {
  const L = LETTERS[m.slot];
  if (!match) return `${L}: not in this set, left as it is (Copy to ${L} makes a new set for it)`;
  const from = match.how === 'same' ? 'as saved' : `from ${match.entry.model}, the same file reopened here`;
  return `${L}: ${from}, ${match.matched} of ${match.total} meshes`;
}

/** The subdivision set `set` runs at when it is not the app's `now` (null: it runs here); a set without an override
 *  takes the app's. The set runner cannot refine the meshes of a set it does not open: opening it re-reads them at its
 *  subdivision. */
export function needsLevel(set: Pick<AnalysisSet, 'subdiv' | 'subdivOverride'>, now: Subdiv): Subdiv | null {
  if (set.subdiv === undefined) return null;
  const want = { level: set.subdiv, override: set.subdivOverride ?? now.override };
  return want.level !== now.level || want.override !== now.override ? want : null;
}
/** A subdivision level in words, as the Model panel names it, with its override. */
export const levelText = (level: number, override = false) => `${level === -1 ? 'Auto' : level === 0 ? 'Off' : `Level ${level}`}${override ? ", over each mesh's own" : ''}`;

/** Two models' Materials edits are the same. */
export function sameOptics(a: Readonly<Record<string, OpticsEdit>>, b: Readonly<Record<string, OpticsEdit>>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => b[k] !== undefined && a[k].rho === b[k].rho && a[k].tau === b[k].tau && a[k].kind === b[k].kind);
}

/**
 * `base` with set `set`'s settings: its run settings, then what it keeps of north, the site, the weather, the colours
 * and the charts (what it lacks stays the app's). An uploaded EPW stays loaded only when it is the file the set names;
 * the weather header goes where its reference or (but for an upload) the site changed, as SITE and WEATHER drop it.
 */
export function settingsWith(base: Settings, set: AnalysisSet): Settings {
  const s: Settings = 'viewSim' in set.settings ? { ...base, viewSim: set.settings.viewSim } : { ...base, sim: { ...set.settings.sim, north: base.sim.north }, time: set.settings.time };
  if (set.north !== undefined) s.sim = { ...s.sim, north: set.north };
  if (set.site || set.weather) {
    const site = set.site ? { ...set.site } : base.site, was = base.weather;
    let weather = was;
    if (set.weather) {
      const { file: name, ...rest } = set.weather;
      weather = { ...rest, file: rest.source === 'upload' && name !== undefined && was.file?.name === name ? was.file : null };
    }
    const sameRef = weather.source === was.source && weather.station?.href === was.station?.href && weather.file === was.file;
    const keep = sameRef && (weather.source === 'upload' || (site.lat === base.site.lat && site.lon === base.site.lon));
    Object.assign(s, { site, weather, epwMeta: keep ? base.epwMeta : null });
  }
  const q = splitColumn(set.column)[0];
  if (set.looks) s.viz = { ...Object.entries(set.looks.quantities).reduce((v, [k, look]) => withLook(v, k, look), s.viz), colors: { ...set.looks.colors } };
  else if (set.look && q) s.viz = withLook(s.viz, q, set.look);
  if (set.charts) s.charts = set.charts.map((c) => ({ ...c }));
  return s;
}

/** `viz` with quantity `q` as `look` gives it (what it leaves out: the default). */
export function withLook(viz: Settings['viz'], q: string, look: Look): Settings['viz'] {
  const put = <T,>(r: Record<string, T>, v: T | undefined) => { const { [q]: _was, ...rest } = r; return v === undefined ? rest : { ...rest, [q]: v }; };
  const min = look.min ?? null, max = look.max ?? null, lo = look.lo ?? null, hi = look.hi ?? null;
  return {
    ...viz, gradients: put(viz.gradients, look.gradient), scalings: put(viz.scalings, look.scaling),
    scales: put(viz.scales, min === null && max === null ? undefined : { min, max }), ranges: put(viz.ranges, lo === null && hi === null ? undefined : { lo, hi }),
  };
}
