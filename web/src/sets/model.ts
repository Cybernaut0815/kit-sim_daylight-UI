// Analysis sets and combined views as the app keeps them (the server's PUT /sets/{id}, one JSON object each). A set is
// one analysis' setup: every open model's roles by prim path and Materials edits, the tab's run settings, north, the
// site and weather (Daylight), the result shown, the colours, the charts and the subdivision; opened (the store's
// APPLY_SET) each entry applies to its own model only (apply.ts entryFor), and the session's result cache (kept.ts)
// shows a result run before at once. Another model takes a set only as a copy (copySet). A combined view weighs sets'
// results into one column (combine.ts). Pure.
import { GRADIENTS, SCALINGS } from '../lib/gradients';
import { DEFAULT_KEY, GLASS_KEY, type OpticsEdit } from '../lib/optics';
import { columnLabel, fmtNum, splitColumn, unitFor } from '../lib/result';
import { fmtClock, fmtDay } from '../lib/time';
import { GROUP, QUANTITIES, parseSettings, type Model, type Settings, type State, type Tool } from '../store';
import { LETTERS, entryFor, levelText, matchText, type AnalysisSet, type Look, type Match, type SetLooks, type SetModel, type SetRole, type SetWeather } from './apply';
import { BOUNDS } from './combine';

export * from './apply';

export const FNS = ['raw', 'normalise', 'invert', 'log', 'threshold', 'band'] as const;
export type Fn = (typeof FNS)[number];
export const OPS = ['mean', 'sum', 'min', 'max', 'product'] as const;
export type Op = (typeof OPS)[number];
/** One input of a combined view: set `set`'s column `column` through `fn` (lo, hi: its bounds), weighed `weight`, on the
 *  receivers at or under `meshes` (absent: all of them). */
export interface CombinedInput { set: string; column: string; weight: number; fn: Fn; lo?: number; hi?: number; meshes?: string[] }
export interface CombinedView { kind: 'combined'; id: string; name: string; created: string; updated: string; unit: string; op: Op; inputs: CombinedInput[]; look?: Look }
export type Saved = AnalysisSet | CombinedView;

export const MAX_NAME = 80, MAX_INPUTS = 8, MAX_UNIT = 16;
const ID = /^[a-z0-9-]{1,64}$/, DEVICE = /^(con|prn|aux|nul|com\d|lpt\d)$/;
const SUFFIX = '0123456789abcdefghijklmnopqrstuvwxyz';
/** A new id: the name's slug and a random suffix of 4 ('South facade' -> 'south-facade-x7k2'). */
export function newId(name: string): string {
  const slug = name.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 56).replace(/-+$/, '') || 'set';
  return `${slug}-${Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => SUFFIX[b % SUFFIX.length]).join('')}`;
}
/** A quantity's look in `viz` now (its defaults: absent). */
export function lookOf(viz: Settings['viz'], q: string): Look {
  const g = viz.gradients[q], sc = viz.scalings[q], d = viz.scales[q], r = viz.ranges[q];
  return {
    ...(g !== undefined ? { gradient: g } : {}), ...(sc !== undefined ? { scaling: sc } : {}),
    ...(d && (d.min !== null || d.max !== null) ? { min: d.min, max: d.max } : {}), ...(r && (r.lo !== null || r.hi !== null) ? { lo: r.lo, hi: r.hi } : {}),
  };
}
/** A model's roles as a set keeps them: receivers and shades by path, the no-shade flag, a shade's target group. */
export const rolesOf = (m: Pick<Model, 'objects'>): SetRole[] => m.objects.flatMap((o) => (o.role === 'none' ? [] : [{
  path: o.path, role: o.role, ...(o.role === 'receiver' && o.shade === false ? { shade: false as const } : {}), ...(o.role === 'shade' && o.group ? { group: o.group } : {}),
}]));

/**
 * The colours of analysis `tool` in `viz` now, as a set keeps them: each quantity of it with its look ({}: the
 * defaults), Daylight's six; the View analysis' those with a look now and `shown`'s (its quantities are its columns'
 * and target groups'), never a combined view's; and the problem range's two colours.
 */
export function looksOf(viz: Settings['viz'], tool: Tool, shown: string): SetLooks {
  const daylight = new Set<string>(QUANTITIES), styled = new Set([...Object.keys(viz.gradients), ...Object.keys(viz.scales), ...Object.keys(viz.ranges), ...Object.keys(viz.scalings), shown]);
  const qs = tool === 'daylight' ? QUANTITIES : [...styled].filter((q) => q && q !== 'combined' && !daylight.has(q));
  return { quantities: Object.fromEntries(qs.map((q) => [q, lookOf(viz, q)])), colors: { ...viz.colors } };
}

/**
 * The setup of analysis `tool` in `s` now as set `name`: every model with a file open (its letter, file, roles and
 * Materials edits), the tab's run settings, north, the site and weather (Daylight; an uploaded EPW by its name), the
 * column shown (`shown`: its full name, else the tab's), the tab's colours, the charts and `subdiv` (the App's level,
 * when given). `was`: the set it updates (its id and created stay).
 */
export function captureSet(s: State, tool: Tool, name: string, o: { shown?: string | null; was?: AnalysisSet; now?: string; subdiv?: number } = {}): AnalysisSet {
  const views = tool === 'views', now = o.now ?? new Date().toISOString(), { north, ...sim } = s.settings.sim, { file, ...weather } = s.settings.weather;
  const column = o.shown ?? (views ? s.viewAnalysis.column : s.column);
  return {
    kind: 'set', id: o.was?.id ?? newId(name), name, created: o.was?.created ?? now, updated: now, tool,
    models: s.models.filter((m) => m.name).map((m) => ({ model: LETTERS[m.slot], file: m.name, roles: rolesOf(views ? { objects: m.viewAnalysis.objects } : m), optics: { ...m.optics } })),
    settings: views ? { viewSim: s.settings.viewSim } : { sim, time: s.settings.time },
    column, colourBy: views ? s.viewAnalysis.colourBy : s.colourBy, north,
    ...(views ? {} : { site: { ...s.settings.site }, weather: { ...weather, ...(weather.source === 'upload' && file ? { file: file.name } : {}) } }),
    looks: looksOf(s.settings.viz, tool, splitColumn(column)[0]), charts: s.settings.charts.map((c) => ({ ...c })),
    ...(o.subdiv !== undefined ? { subdiv: o.subdiv } : {}),
  };
}

/** What APPLY_SET does to each open model (`models`: the tab's): its entry and how many of its paths matched, in words. */
export const applyReport = (models: readonly Pick<Model, 'slot' | 'name' | 'objects'>[], set: Pick<AnalysisSet, 'models'>): { model: string; match: Match | null; text: string }[] =>
  models.filter((m) => m.name).map((m) => { const match = entryFor(m, set.models, models); return { model: LETTERS[m.slot], match, text: matchText(m, match) }; });
/** The set's entries no open model takes, in words ('tower (A in the set): not open, its roles wait for it'). */
export function notOpen(models: readonly Pick<Model, 'slot' | 'name' | 'objects'>[], set: Pick<AnalysisSet, 'models'>): string[] {
  const taken = new Set(applyReport(models, set).flatMap((r) => (r.match ? [r.match.entry] : [])));
  return set.models.filter((e) => !taken.has(e)).map((e) => `${e.file} (${e.model} in the set): not open, its roles wait for it`);
}

/** What copySet carried over: of the entry's roles, those whose path the target has; the target's meshes left without a
 *  role; of its Materials edits of materials, those the target has (the default and glass rows go along always). */
export interface CopyCounts { roles: number; rolesOf: number; bare: number; edits: number; editsOf: number }
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
/** The note of a copy ('C: 5 of 6 roles by path, 1 mesh without a role; 2 of 3 material edits'). */
export const copyText = (model: string, c: CopyCounts) =>
  `${model}: ${c.roles} of ${c.rolesOf} roles by path, ${plural(c.bare, 'mesh', 'meshes')} without a role; ${c.editsOf ? `${c.edits} of ${c.editsOf} material edits` : 'no material edits'}`;
/** The name a copy of `set` for file `file` gets unless one is given. */
export const copyName = (set: Pick<AnalysisSet, 'name'>, file: string) => `${set.name} for ${file}`.slice(0, MAX_NAME);
/** The next free "Set N" name among `sets`. */
export const nextName = (sets: readonly Pick<AnalysisSet, 'name'>[]) => `Set ${Math.max(0, ...sets.map((x) => Number(/^Set (\d+)$/.exec(x.name)?.[1] ?? 0))) + 1}`;
/** What a set of each tab keeps, in words (the save forms' help). */
export const SETUP_WORDS: Record<Tool, string> = {
  daylight: "every open model's roles and Materials edits, the location, north, weather, time and simulation settings, the result shown and its colours, the charts and the subdivision",
  views: "every open model's view roles and Materials edits, north, the view settings, the result shown and its colours, the charts and the subdivision",
};
/** Set or combined view `set` under the name `name` (trimmed), its id and all it keeps as they are: combined views that
 *  use a set follow. */
export function renameSet<T extends Saved>(set: T, name: string, now = new Date().toISOString()): T {
  if (!text(name, MAX_NAME)) throw new Error(`name: 1 to ${MAX_NAME} characters`);
  return { ...set, name: name.trim(), updated: now };
}

/**
 * Set `set`'s entry `from` as a new set `name` (a new id) for model `to` alone, its letter and file: the roles of the
 * paths `to` has (every other mesh of it gets none), the Materials edits of the material paths `to` has (`materials`)
 * and the default and glass rows; everything else as it is. With the counts for the note.
 */
export function copySet(set: AnalysisSet, from: SetModel, to: Pick<Model, 'slot' | 'name' | 'objects'>, materials: readonly string[], name: string, now = new Date().toISOString()): { set: AnalysisSet; counts: CopyCounts } {
  if (!to.name) throw new Error(`model ${LETTERS[to.slot]} has no file open`);
  if (!text(name, MAX_NAME)) throw new Error(`name: 1 to ${MAX_NAME} characters`);
  const paths = new Set(to.objects.map((o) => o.path)), mats = new Set(materials), always = (k: string) => k === DEFAULT_KEY || k === GLASS_KEY;
  const roles = from.roles.filter((r) => paths.has(r.path)), edits = Object.entries(from.optics ?? {});
  const kept = edits.filter(([k]) => always(k) || mats.has(k));
  const entry: SetModel = { model: LETTERS[to.slot], file: to.name, roles, ...(from.optics ? { optics: Object.fromEntries(kept) } : {}) };
  return {
    set: { ...structuredClone(set), id: newId(name), name: name.trim(), created: now, updated: now, models: [structuredClone(entry)] },
    counts: { roles: roles.length, rolesOf: from.roles.length, bare: paths.size - new Set(roles.map((r) => r.path)).size, edits: kept.length, editsOf: edits.length },
  };
}

const WEATHER_WORDS: Record<SetWeather['source'], string> = { upload: 'an uploaded EPW', station: 'the nearest weather station', pvgis: 'PVGIS, a typical year', 'clear-sky': 'clear sky' };
const SIDE_WORDS = { front: 'front sides', back: 'back sides', both: 'both sides' } as const;
const NOT_KEPT = "not kept (an older set): the app's own stays";
const timeWords = (t: Settings['time']) => (t.mode === 'annual' ? 'Annual: every hour of the weather year' : t.mode === 'instant' ? `${fmtDay(t.date)}, ${fmtClock(t.hour)}`
  : `${fmtDay(t.from.date)} ${fmtClock(t.from.hour)} to ${fmtDay(t.to.date)} ${fmtClock(t.to.hour)}, every ${t.stepMin} min`);
const has = (v: number | null | undefined): v is number => v !== null && v !== undefined;
const problemWords = (lo: number | null | undefined, hi: number | null | undefined, unit: string) => {
  const u = (v: number) => `${fmtNum(v)}${unit ? ` ${unit}` : ''}`;
  return has(lo) && has(hi) ? `outside ${u(lo)} to ${u(hi)}` : has(lo) ? `below ${u(lo)}` : has(hi) ? `above ${u(hi)}` : 'none';
};
/**
 * Set `set` in words, a line each (the Sets fold-out, the agent's app_state): per model its file, roles and Materials
 * edits; the location and north, the time, the run or view settings, the weather and the subdivision; the result shown,
 * its colours and its problem range.
 */
export function setSummary(set: AnalysisSet): { label: string; value: string }[] {
  const lines: { label: string; value: string }[] = [], line = (label: string, value: string) => { lines.push({ label, value }); };
  for (const e of set.models) {
    const n = (role: SetRole['role']) => e.roles.filter((r) => r.role === role).length, edits = Object.keys(e.optics ?? {}).length;
    line(`Model ${e.model}`, `${e.file}: ${plural(n('receiver'), 'receiver', 'receivers')}, ${plural(n('shade'), 'shade', 'shades')}${e.optics ? `, ${edits ? plural(edits, 'material edit', 'material edits') : 'no material edits'}` : ''}`);
  }
  const north = set.north !== undefined ? `${fmtNum(set.north)}°` : null;
  if ('sim' in set.settings) {
    const { sim, time } = set.settings, site = set.site;
    line('Location', site ? `${site.place || 'unnamed'} (${fmtNum(site.lat)}, ${fmtNum(site.lon)})${north ? `, north ${north}` : ''}` : NOT_KEPT);
    line('Time', timeWords(time));
    line('Simulation', `${sim.mode === 'ladybug' ? 'Ladybug' : 'Physical'}: ${sim.quantities.map(columnLabel).join(', ')}; ${SIDE_WORDS[sim.sides]} on ${sim.on}; sky density ${sim.skyDensity}; ${sim.bounces ? plural(sim.bounces, 'reflection', 'reflections') : 'no reflections'}${sim.transmission ? '; light through glass' : ''}`);
    const w = set.weather;
    line('Weather', w ? `${WEATHER_WORDS[w.source]}${w.source === 'upload' && w.file ? `, ${w.file}` : ''}${w.source === 'station' && w.station ? `, ${w.station.title}` : ''}${w.source === 'clear-sky' ? `, turbidity ${fmtNum(w.turbidity)}` : ''}` : NOT_KEPT);
  } else {
    const v = set.settings.viewSim;
    if (north) line('North', north);
    line('View settings', `field ${v.fov[0]}°, ${v.fov[1]}° to ${v.fov[2]}°${v.fov[0] < 360 ? (v.gaze === 'level' ? ', level gaze' : ' about the normal') : ''}; a ray every ${fmtNum(v.cell)}°; far ${fmtNum(v.far)} m; ${SIDE_WORDS[v.sides]} on ${v.on}${v.reach ? `; reach ${v.reach}` : ''}${v.transmission ? '; through glass' : ''}`);
  }
  line('Subdivision', set.subdiv !== undefined ? levelText(set.subdiv) : NOT_KEPT);
  const q = splitColumn(set.column)[0], look = set.looks?.quantities[q] ?? set.look ?? {}, unit = unitFor(set.column).value;
  line('Result', `${set.column ? columnLabel(set.column) : 'none chosen'}; ${set.colourBy === 'value' ? 'the meshes coloured by value' : 'the meshes plain'}`);
  const legend = has(look.min) || has(look.max) ? `, legend ${has(look.min) ? fmtNum(look.min) : 'lowest'} to ${has(look.max) ? fmtNum(look.max) : 'highest'}` : '';
  line('Colours', `${look.gradient ? (GRADIENTS.find((g) => g.key === look.gradient)?.label ?? look.gradient) : 'default gradient'}, ${(SCALINGS.find(([k]) => k === look.scaling) ?? ['', 'default scaling'])[1].toLowerCase()}${legend}`);
  line('Problem range', problemWords(look.lo, look.hi, unit));
  return lines;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const strs = (v: unknown): v is string[] => Array.isArray(v) && v.every((p) => typeof p === 'string');
const bound = (v: unknown) => v === undefined || v === null || finite(v);
/** A look as stored, its fields of their types. */
const readableLook = (v: unknown): v is Look => isObj(v) && (v.gradient === undefined || typeof v.gradient === 'string')
  && (v.scaling === undefined || SCALINGS.some(([k]) => k === v.scaling)) && [v.min, v.max, v.lo, v.hi].every(bound);
const readableRole = (r: unknown): r is SetRole => isObj(r) && typeof r.path === 'string' && r.path.startsWith('/') && (r.role === 'receiver' || r.role === 'shade')
  && (r.shade === undefined || r.shade === false) && (r.group === undefined || (typeof r.group === 'string' && GROUP.test(r.group)));
const unit = (v: unknown) => finite(v) && v >= 0 && v <= 1;
const readableOptics = (v: unknown): v is Record<string, OpticsEdit> => isObj(v) && Object.values(v).every((e) => isObj(e) && unit(e.rho) && unit(e.tau) && (e.kind === 'opaque' || e.kind === 'glass' || e.kind === 'porous'));
const readableModel = (m: unknown): m is SetModel => isObj(m) && typeof m.model === 'string' && m.model.length === 1 && LETTERS.includes(m.model)
  && typeof m.file === 'string' && m.file.length > 0 && Array.isArray(m.roles) && m.roles.every(readableRole) && (m.optics === undefined || readableOptics(m.optics));
const stamps = (s: Obj, id: string) => s.id === id && ID.test(id) && !DEVICE.test(id) && text(s.name, MAX_NAME) && typeof s.created === 'string' && typeof s.updated === 'string';
const readableSite = (v: unknown): v is Settings['site'] => isObj(v) && finite(v.lat) && Math.abs(v.lat) <= 90 && finite(v.lon) && Math.abs(v.lon) <= 180 && typeof v.place === 'string';
const readableStation = (v: unknown) => v === null || (isObj(v) && typeof v.title === 'string' && typeof v.href === 'string' && finite(v.lat) && finite(v.lon));
const readableWeather = (v: unknown): v is SetWeather => isObj(v) && ['upload', 'station', 'pvgis', 'clear-sky'].includes(v.source as string) && readableStation(v.station)
  && finite(v.turbidity) && finite(v.altitude) && (v.file === undefined || text(v.file, 255));
const HEX = /^#[0-9a-f]{6}$/i;
const readableLooks = (v: unknown): v is SetLooks => isObj(v) && isObj(v.quantities) && Object.values(v.quantities).every(readableLook)
  && isObj(v.colors) && HEX.test(String(v.colors.below)) && HEX.test(String(v.colors.above));
/** The fields a set of an older version lacks, each absent or readable. */
const readableExtras = (s: Obj) => (s.north === undefined || finite(s.north)) && (s.site === undefined || readableSite(s.site)) && (s.weather === undefined || readableWeather(s.weather))
  && (s.looks === undefined || readableLooks(s.looks)) && (s.charts === undefined || Array.isArray(s.charts)) && (s.subdiv === undefined || (Number.isInteger(s.subdiv) && (s.subdiv as number) >= -1 && (s.subdiv as number) <= 3));

/** A stored set the app can read, its settings spread over the defaults (a set of an older version opens with today's
 *  fields, but a view analysis saved before the gaze with the one it ran with: about the normal) and its charts as the
 *  app keeps them (junk dropped); null when it cannot. */
function readSet(id: string, s: Obj): AnalysisSet | null {
  if (!stamps(s, id) || (s.tool !== 'daylight' && s.tool !== 'views') || !Array.isArray(s.models) || s.models.length > 4 || !s.models.every(readableModel)) return null;
  if (typeof s.column !== 'string' || (s.colourBy !== 'plain' && s.colourBy !== 'value') || (s.look !== undefined && !readableLook(s.look)) || !isObj(s.settings) || !readableExtras(s)) return null;
  const st = s.settings, viewSim = isObj(st.viewSim) ? { gaze: 'normal', ...st.viewSim } : st.viewSim;
  const parsed = parseSettings(JSON.stringify({ ...st, viewSim, charts: s.charts })), { north: _north, ...sim } = parsed.sim;
  if (s.tool === 'views' ? !isObj(st.viewSim) : !isObj(st.sim) || !isObj(st.time)) return null;
  return { ...(s as unknown as AnalysisSet), settings: s.tool === 'views' ? { viewSim: parsed.viewSim } : { sim, time: parsed.time }, ...(s.charts ? { charts: parsed.charts } : {}) };
}
/** A set embedded elsewhere (a report's setup) as readSet takes it; null when the app cannot read it. */
export const readSetup = (v: unknown): AnalysisSet | null => (isObj(v) && v.kind === 'set' && typeof v.id === 'string' ? readSet(v.id, v) : null);
const readableInput = (i: unknown): i is CombinedInput => isObj(i) && typeof i.set === 'string' && ID.test(i.set) && typeof i.column === 'string' && i.column.length > 0
  && finite(i.weight) && i.weight >= 0 && FNS.includes(i.fn as Fn) && (i.lo === undefined || finite(i.lo)) && (i.hi === undefined || finite(i.hi))
  && (i.meshes === undefined || (strs(i.meshes) && i.meshes.every((p) => p.startsWith('/'))));
const readCombined = (id: string, c: Obj): CombinedView | null => (stamps(c, id) && typeof c.unit === 'string' && c.unit.length <= MAX_UNIT && OPS.includes(c.op as Op)
  && Array.isArray(c.inputs) && c.inputs.length >= 1 && c.inputs.length <= MAX_INPUTS && c.inputs.every(readableInput) && (c.look === undefined || readableLook(c.look))
  ? (c as unknown as CombinedView) : null);

/** GET /sets' answer, each spec parsed; one the app cannot read (damaged, hand-edited, of another version) is left out,
 *  so it never breaks the app (DELETE still removes it by id). */
export const parseSets = (list: readonly { id: string; spec: string }[]): Saved[] => list.flatMap((e) => {
  try {
    const spec: unknown = JSON.parse(e.spec);
    if (!isObj(spec)) return [];
    const x = spec.kind === 'set' ? readSet(e.id, spec) : spec.kind === 'combined' ? readCombined(e.id, spec) : null;
    return x ? [x] : [];
  } catch {
    return [];
  }
});
const COLUMN = /^[a-z0-9-]+(?:_[a-z0-9-]+)*$/i; // a target group's name may hold '-' (store GROUP)
/**
 * A combined view from the editor or the agent ({id?, name, unit?, op, inputs, look?}), checked against the saved sets:
 * the view to store (`was`: the one it replaces, its created kept), or every problem, each naming its path
 * ('inputs[1].weight: ...'). An input's weight defaults to 1, its fn to raw.
 */
export function checkView(raw: unknown, sets: readonly AnalysisSet[], was?: CombinedView, now = new Date().toISOString()): CombinedView | string[] {
  const no: string[] = [], bad = (at: string, what: string) => { no.push(`${at}: ${what}`); };
  if (!isObj(raw)) return ['view: an object {name, unit?, op, inputs, look?}'];
  if (raw.id !== undefined && (typeof raw.id !== 'string' || !ID.test(raw.id) || DEVICE.test(raw.id))) bad('id', '1 to 64 lowercase letters, digits or -');
  if (!text(raw.name, MAX_NAME)) bad('name', `1 to ${MAX_NAME} characters`);
  if (raw.unit !== undefined && (typeof raw.unit !== 'string' || raw.unit.length > MAX_UNIT)) bad('unit', `at most ${MAX_UNIT} characters ('' or none: a score)`);
  if (!OPS.includes(raw.op as Op)) bad('op', `one of ${OPS.join(', ')}`);
  if (raw.look !== undefined && !readableLook(raw.look)) bad('look', '{gradient?, scaling?, min?, max?, lo?, hi?}');
  const inputs: CombinedInput[] = [];
  if (!Array.isArray(raw.inputs) || raw.inputs.length < 1 || raw.inputs.length > MAX_INPUTS) bad('inputs', `1 to ${MAX_INPUTS} inputs {set, column, weight?, fn?, lo?, hi?, meshes?}`);
  else raw.inputs.forEach((i, k) => {
    const at = `inputs[${k}]`;
    if (!isObj(i)) { bad(at, 'an object {set, column, weight?, fn?, lo?, hi?, meshes?}'); return; }
    const set = sets.find((s) => s.id === i.set), fn = (i.fn ?? 'raw') as Fn, weight = i.weight ?? 1;
    if (!set) bad(`${at}.set`, `the id of a saved set${sets.length ? ` (${sets.map((s) => s.id).join(', ')})` : '; save one first'}`);
    if (typeof i.column !== 'string' || !COLUMN.test(i.column)) bad(`${at}.column`, "a result column of the set, such as 'radiation_front' or 'sky_front'");
    if (!finite(weight) || weight < 0) bad(`${at}.weight`, 'a number, 0 or more (0: left out)');
    if (!FNS.includes(fn)) bad(`${at}.fn`, `one of ${FNS.join(', ')}`);
    if (i.lo !== undefined && !finite(i.lo)) bad(`${at}.lo`, 'a number');
    if (i.hi !== undefined && !finite(i.hi)) bad(`${at}.hi`, 'a number');
    if (finite(i.lo) && finite(i.hi) && i.lo > i.hi) bad(`${at}.hi`, `not below lo (${i.lo})`);
    if (i.meshes !== undefined && (!strs(i.meshes) || !i.meshes.length || i.meshes.length > 50 || !i.meshes.every((p) => p.startsWith('/')))) bad(`${at}.meshes`, '1 to 50 prim paths, each starting with / (none: every receiver)');
    inputs.push({ set: i.set as string, column: i.column as string, weight: weight as number, fn, ...(finite(i.lo) ? { lo: i.lo } : {}), ...(finite(i.hi) ? { hi: i.hi } : {}), ...(strs(i.meshes) ? { meshes: i.meshes } : {}) });
  });
  if (no.length) return no;
  const name = (raw.name as string).trim();
  return {
    kind: 'combined', id: was?.id ?? (raw.id as string | undefined) ?? newId(name), name, created: was?.created ?? now, updated: now,
    unit: ((raw.unit as string | undefined) ?? '').trim(), op: raw.op as Op, inputs, ...(raw.look ? { look: raw.look as Look } : {}),
  };
}

const OP_WORDS: Record<Op, string> = { mean: 'The weighted mean', sum: 'The weighted sum', min: 'The lowest', max: 'The highest', product: 'The product, each to the power of its weight,' };
export const OP_LABEL: Record<Op, string> = { mean: 'Weighted mean', sum: 'Weighted sum', min: 'Lowest', max: 'Highest', product: 'Product' };
export const FN_LABEL: Record<Fn, string> = { raw: 'As it is', normalise: 'Normalise 0 to 1', invert: 'Invert (1 - normalised)', log: 'Log10', threshold: 'At or above lo', band: 'Within lo to hi' };
const FN_WORDS: Record<Fn, string> = { raw: 'as it is', normalise: 'normalised 0 to 1', invert: 'inverted (1 - normalised)', log: 'log10', threshold: '1 at or above a threshold', band: '1 within a band' };
/** Input `i` (the `k`th from 0) in one line, the editor's fold-out summary ('1. South: Radiation, front; normalised 0 to
 *  1 (0 at 10); weight 1'): only the bounds its function reads and has, none for the values' range. */
export function inputText(i: Pick<CombinedInput, 'set' | 'column' | 'fn' | 'weight' | 'lo' | 'hi'>, k: number, sets: readonly Pick<AnalysisSet, 'id' | 'name'>[]): string {
  const set = sets.find((s) => s.id === i.set)?.name ?? `${i.set || 'no set'} (not saved)`;
  const bounds = BOUNDS[i.fn].flatMap(([b, label]) => (finite(i[b]) ? [`${label.toLowerCase()} ${fmtNum(i[b])}`] : []));
  return `${k + 1}. ${set}: ${i.column ? columnLabel(i.column) : 'no result'}; ${FN_WORDS[i.fn]}${bounds.length ? ` (${bounds.join(', ')})` : ''}; weight ${fmtNum(i.weight)}`;
}
/** What combined view `v` shows, in words (the Results' help under the selector, the agent's app_state). */
export function viewHelp(v: CombinedView, sets: readonly AnalysisSet[]): string {
  const name = (id: string) => sets.find((s) => s.id === id)?.name ?? `${id} (deleted)`, n = (x: number | undefined, d: string) => (x === undefined ? d : fmtNum(x));
  const parts = v.inputs.map((i) => {
    const what = `${name(i.set)}, ${columnLabel(i.column)}`;
    const f = i.fn === 'raw' ? what : i.fn === 'normalise' ? `${what} normalised (${n(i.lo, 'its lowest')} to ${n(i.hi, 'its highest')} over every model)`
      : i.fn === 'invert' ? `1 minus ${what} normalised` : i.fn === 'log' ? `log10 of ${what}` : i.fn === 'threshold' ? `${what} at or above ${n(i.lo, 'the middle of its range')} (1, else 0)`
        : `${what} within ${n(i.lo, 'its lowest')} to ${n(i.hi, 'its highest')} (1, else 0)`;
    return `${f}${v.op !== 'min' && v.op !== 'max' && i.weight !== 1 ? `, weight ${fmtNum(i.weight)}` : ''}${i.meshes ? `, on ${i.meshes.join(', ')}` : ''}`;
  });
  return `${OP_WORDS[v.op]} of ${parts.join('; ')}. ${v.unit ? `In ${v.unit}.` : 'A score: its total over the area in m².'} Meshes no input covers stay unpainted.`;
}

export const isSet = (x: Saved): x is AnalysisSet => x.kind === 'set';
export const isCombined = (x: Saved): x is CombinedView => x.kind === 'combined';
