// A report as the app keeps it (the server's PUT /reports/{id}): the spec the agent saves (save_report), checked here and
// completed with each report model's run at save time, so that a later generation can tell whether the results are still
// the ones its text was written on (readiness); and the edits the app makes to its charts. Pure: the app comes in as a
// plain view (tools.ts appView).
import type { ViewState } from 'usd-viewer';
import type { ChartEdit } from '../charts/ChartSettings';
import { FIELDS as LOOK, cleanSpec, isShare, type ChartSpec, type Metric as ChartMetric } from '../lib/charts';
import { fmtNum, unitFor } from '../lib/result';
import type { Settings } from '../store';

const LETTERS = 'ABCD';
/** What a stat or a table column shows: summarize()'s statistics, named as the results tool names them. */
export const METRICS = ['mean', 'median', 'p10', 'p90', 'min', 'max', 'below', 'within', 'above', 'area', 'total', 'elements'] as const;
export type Metric = (typeof METRICS)[number];
export interface Stat { label: string; metric: Metric; column: string; model: string; path?: string }
/** A ChartSpec with its models as letters, as update_settings takes them (unset: the report's models). */
export type ReportChart = Omit<ChartSpec, 'models'> & { models?: string[] };
export type Block =
  | { type: 'text'; title?: string; text: string }
  | { type: 'chart'; chart: ReportChart; caption: string; saved?: ReportChart } // saved: the chart as save_report stored it (Reset in the app)
  | { type: 'view'; name: string; view: ViewState; near?: number; column: string | null; aspect?: number; caption: string }
  | { type: 'table'; column: string; by?: 'parts' | 'mesh' | 'facing'; parts?: string[]; metrics: Metric[]; caption: string };
/** Prim path -> variant set -> the variant chosen in the app (a set at the file's own variant is not listed). */
export type Variants = Record<string, Record<string, string>>;
/** A quantity's problem range as the Results panel sets it (null: no bound). */
export interface Range { lo: number | null; hi: number | null }
/** A report model and its run at save time: the file (and the paths open_model opened it from), the variant choices,
 *  the receivers' and shades' prim paths, and its run's settings (AppModel.key).
 *  ponytail: every receiver and shade path, stored once; counts and a hash if models of many thousand meshes must fit
 *  the server's 1 MB */
export interface ModelRef { model: string; file: string; open?: string[]; variants: Variants; receivers: string[]; shades: string[]; runKey: string }
/** ranges: per quantity the report shows, its problem range at save (its shares and range colours are drawn on it). */
export interface Report { id: string; title: string; created: string; updated: string; models: ModelRef[]; ranges?: Record<string, Range>; stats?: Stat[]; summary: string; blocks: Block[]; notes?: string }
/** A checked spec before the save stamps it (created, updated). */
export type Draft = Omit<Report, 'created' | 'updated'>;
/** A stored report as GET /reports lists it, its spec parsed. */
export interface Stored { id: string; pdf: boolean; spec: Report }

/** An open model as a report sees it: its file's name ('' = none) and the paths open_model opened it from, the variant
 *  choices made in the app ([the file's own, the chosen one]), its receivers' and shades' prim paths, and its result:
 *  freshness, the settings it ran with (`key`: its run key's arguments and weather, prim paths for the mesh ids, as
 *  tools.ts stableKey gives them; `inputs`: the same of the inputs now), columns. */
export interface AppModel {
  model: string; file: string; open?: string[]; loading: boolean; choices: Record<string, Record<string, readonly [string, string]>>;
  receivers: string[]; shades: string[]; result: 'running' | 'fresh' | 'stale' | null; key: string | null; inputs: string; columns: string[];
}
/** The app as a report sees it (tools.ts appView): the open models, the column shown, the problem ranges. */
export interface AppView { models: AppModel[]; shown: string | null; ranges: Settings['viz']['ranges'] }

/** The choices that differ from the file's own variants. */
export const chosenOf = (choices: AppModel['choices']): Variants =>
  Object.fromEntries(Object.entries(choices).flatMap(([p, sets]) => { const s = Object.entries(sets).filter(([, [own, now]]) => own !== now); return s.length ? [[p, Object.fromEntries(s.map(([k, [, now]]) => [k, now]))]] : []; }));

const strs = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string');
/** A stored spec of report `id` the app can read: every field the menus, the Results panel, readiness and the page read,
 *  of its type. */
function readable(id: string, s: unknown): s is Report {
  if (!isObj(s) || s.id !== id || ![s.title, s.created, s.updated, s.summary].every((v) => typeof v === 'string')) return false;
  const model = (m: unknown) => isObj(m) && typeof m.model === 'string' && m.model.length === 1 && LETTERS.includes(m.model) && typeof m.file === 'string' && typeof m.runKey === 'string'
    && isObj(m.variants) && Object.values(m.variants).every(isObj) && strs(m.receivers) && strs(m.shades) && (m.open === undefined || strs(m.open));
  const metric = (v: unknown) => METRICS.includes(v as Metric);
  const block = (b: unknown) => isObj(b) && (b.type === 'text' ? typeof b.text === 'string'
    : b.type === 'chart' ? typeof b.caption === 'string' && isObj(b.chart) && typeof b.chart.column === 'string' && (b.chart.models === undefined || strs(b.chart.models)) && typeof cleanSpec({ ...b.chart, models: undefined }) !== 'string'
      : b.type === 'view' ? typeof b.caption === 'string' && typeof b.name === 'string' && isObj(b.view) && vec(b.view.eye) && vec(b.view.target)
        : b.type === 'table' && typeof b.caption === 'string' && typeof b.column === 'string' && Array.isArray(b.metrics) && b.metrics.every(metric));
  return Array.isArray(s.models) && s.models.length > 0 && s.models.every(model) && (s.ranges === undefined || isObj(s.ranges))
    && (s.stats === undefined || (Array.isArray(s.stats) && s.stats.every((x) => isObj(x) && metric(x.metric) && [x.label, x.column, x.model].every((v) => typeof v === 'string'))))
    && Array.isArray(s.blocks) && s.blocks.every(block);
}
/** GET /reports' answer, each spec parsed; one the app cannot read (damaged, hand-edited, of another version) is left
 *  out, so it never breaks the app (delete_report still removes it by id). */
export const parseReports = (list: { id: string; pdf: boolean; spec: string }[]): Stored[] =>
  list.flatMap((e) => { try { const spec: unknown = JSON.parse(e.spec); return readable(e.id, spec) ? [{ id: e.id, pdf: e.pdf, spec }] : []; } catch { return []; } });

/** A chart block's spec as the charts draw it: models as slots, the report's models when unset. */
export const chartSpec = (c: ReportChart, r: Pick<Report, 'models'>): ChartSpec => ({ ...c, models: (c.models ?? r.models.map((m) => m.model)).map((l) => LETTERS.indexOf(l)) });

/** Report `r` with a chart edited in its Results panel group (ChartEdit, its spec as chartSpec gives it): its look put
 *  (checked as every chart's; the models stay the block's), the chart back as save_report stored it, or its block
 *  removed. null: no such chart, or a look the check refuses. */
export function editChart(r: Report, e: ChartEdit): Report | null {
  const id = 'spec' in e ? e.spec.id : e.id, i = r.blocks.findIndex((b) => b.type === 'chart' && b.chart.id === id), b = r.blocks[i];
  if (b?.type !== 'chart') return null;
  if ('remove' in e) return { ...r, blocks: r.blocks.filter((_, k) => k !== i) };
  if ('reset' in e) return b.saved ? { ...r, blocks: r.blocks.with(i, { ...b, chart: b.saved }) } : null;
  const { models, kind } = b.chart, next = cleanSpec({ ...e.spec, kind, models: undefined });
  if (typeof next === 'string') return null;
  return { ...r, blocks: r.blocks.with(i, { ...b, chart: { ...(next as Omit<ReportChart, 'models'>), ...(models ? { models } : {}) } }) };
}

/** A view block's image per model as printed, CSS px: the figure card's inner width (A4 less the 16 mm margins, the card's
 *  20 px padding and border), half of it less the gap with two or more models (two to a row), at most 640 px high in all
 *  (300 per row of two rows) so the figure keeps to one page. */
export function imageSize(models: number, aspect: number): { width: number; height: number } {
  const card = (178 / 25.4) * 96 - 42, col = models > 1 ? (card - 16) / 2 : card, width = Math.min(col, (models > 2 ? 300 : 640) * aspect);
  return { width, height: width / aspect };
}

const ID = /^[a-z0-9-]{1,64}$/, COLUMN = /^(radiation|direct|diffuse|irradiance|illuminance|sunhours)_(front|back)$/;
const DEVICE = /^(con|prn|aux|nul|com\d|lpt\d)$/; // Windows names no folder can take
const MAX_BYTES = 1 << 20; // the server keeps a spec of at most 1 MB
// what agents write outside the report fonts, and the spelling to use
const SPELL: Record<string, string> = {
  '≥': '>=', '≤': '<=', '→': '->', '←': '<-', '↔': '<->', '⇒': '=>', '≠': 'not equal to', '≈': 'about', '∼': 'about', '✓': 'yes', '✔': 'yes', '✗': 'no', '✘': 'no',
  '◂': '<', '▸': '>', '▲': 'up', '▼': 'down', '™': '(TM)', '√': 'sqrt', '∞': 'infinity', 'Σ': 'sum', '∑': 'sum', 'Δ': 'difference', 'τ': 'tau', 'ρ': 'rho',
  'α': 'alpha', 'β': 'beta', 'γ': 'gamma', 'η': 'eta', 'θ': 'theta', 'λ': 'lambda', 'μ': 'micro', 'π': 'pi', 'σ': 'sigma', 'φ': 'phi', 'Ω': 'ohm',
  '‐': '-', '‑': '-', '‒': '-', '―': '-', '‰': 'per mille', '‡': '††', '‼': '!!', '‽': '?!',
};
// the code points both faces of the report's text draw (Geist: body, captions, labels; Space Mono: headings): their
// cmaps within kit-ui 0.2.0's unicode-ranges
const DRAWN = ('0020-007E 00A0-00AC 00AE-0113 0116-012B 012E-0137 0139-013E 0141-0148 014A-014D 0150-017E 018F 0192 01A0-01A1 01AF-01B0 01CD-01CE 01E6-01E7 '
  + '0218-021B 0237 0259 02C6-02C7 02DA 02DC-02DD 0304 0308 1E20-1E21 1E80-1E85 1E9E 1EF2-1EF9 2013-2014 2018-201A 201C-201E 2020 2022 2026 2032-2033 2039-203A 2044 '
  + '20AC 20B1 20B9 2122 2191 2193 2212').split(' ').map((r) => r.split('-').map((h) => parseInt(h, 16)));
const INVISIBLE = /[­​-‏‪-‮⁠-⁯﻿]/;
/** The first character of `s` the report fonts do not draw, named with what to write instead; '' when there is none.
 *  Line breaks and tabs pass. */
export function glyphs(s: string): string {
  for (const ch of s) {
    const u = ch.codePointAt(0)!, hex = `U+${u.toString(16).toUpperCase().padStart(4, '0')}`;
    if (ch === '\n' || ch === '\r' || ch === '\t' || DRAWN.some(([a, b = a]) => u >= a && u <= b)) continue;
    if (u < 0x20 || (u >= 0x7f && u <= 0x9f)) return `${hex} is a control character; remove it`;
    if (INVISIBLE.test(ch)) return `${hex} is an invisible character; remove it`;
    if (/\s/.test(ch)) return `${hex} is a special space; write a plain space`;
    return `'${ch}' (${hex}) is not in the report fonts; write ${SPELL[ch] ? `'${SPELL[ch]}'` : 'it in Latin letters'}`;
  }
  return '';
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const vec = (v: unknown) => Array.isArray(v) && v.length === 3 && v.every(finite);
const quantityOf = (column: string) => column.split('_')[0];
const FIELDS: Record<string, string[]> = {
  spec: ['id', 'title', 'created', 'updated', 'models', 'stats', 'summary', 'blocks', 'notes'], stat: ['label', 'metric', 'column', 'model', 'path'],
  text: ['type', 'title', 'text'], chart: ['type', 'chart', 'caption'], view: ['type', 'name', 'view', 'near', 'column', 'aspect', 'caption'], table: ['type', 'column', 'by', 'parts', 'metrics', 'caption'],
};

/** The share metrics (below, within, above) of a spec whose quantity has no problem range now: they would read 0 or 100 %
 *  (`skip`: quantities already said to have another range than at save). */
function rangeless(r: Pick<Draft, 'stats' | 'blocks'>, ranges: AppView['ranges'], skip = new Set<string>()): string[] {
  const open = (column: string) => { const q = quantityOf(column), g = ranges[q]; return !skip.has(q) && (g?.lo ?? null) === null && (g?.hi ?? null) === null; };
  const say = (at: string, metric: string, column: string) => `${at}: ${metric} is a share of the problem range, and ${quantityOf(column)} has none; set it (update_settings viz {quantity: '${quantityOf(column)}', below / above}) or use another metric`;
  return [
    ...(r.stats ?? []).flatMap((s, i) => (isShare(s.metric as ChartMetric) && open(s.column) ? [say(`stats[${i}].metric`, s.metric, s.column)] : [])),
    ...r.blocks.flatMap((b, i) => {
      const shares = b.type === 'table' ? b.metrics.filter((m) => isShare(m as ChartMetric)) : b.type === 'chart' && b.chart.kind === 'parts' && b.chart.metric && isShare(b.chart.metric) ? [b.chart.metric] : [];
      const column = b.type === 'table' ? b.column : b.type === 'chart' ? b.chart.column! : '';
      return shares.length && open(column) ? [say(`blocks[${i}]`, shares.join(', '), column)] : [];
    }),
  ];
}

/**
 * A spec from the agent (save_report) checked against the app, or every problem, each naming its path ('blocks[3].caption:
 * empty'). Its models are letters (or get_report's model objects, whose letters alone count): each open with a fresh
 * result now, and stored with its run (ModelRef). A chart's column defaults to the one shown; created and updated are
 * the save's.
 */
export function validateSpec(raw: unknown, app: AppView): Draft | string[] {
  const no: string[] = [];
  const bad = (at: string, what: string): undefined => { no.push(`${at}: ${what}`); return undefined; };
  const keys = (at: string, o: Obj, kind: string) => { for (const k of Object.keys(o)) if (!FIELDS[kind].includes(k)) bad(`${at}${at ? '.' : ''}${k}`, `not a field of ${kind === 'spec' ? 'a ReportSpec' : kind === 'stat' ? 'a stat' : `a ${kind} block`} (${FIELDS[kind].join(', ')})`); };
  const text = (at: string, v: unknown, max: number, optional = false): string | undefined => {
    if (v === undefined && optional) return undefined;
    if (typeof v !== 'string') return bad(at, `text, 1 to ${max} characters`);
    if (!v.trim()) return bad(at, 'empty');
    if (v.length > max) return bad(at, `${v.length} characters, at most ${max}`);
    const g = glyphs(v);
    return g ? bad(at, g) : v;
  };
  if (!isObj(raw)) return ['spec: an object, the ReportSpec (guide report)'];
  keys('', raw, 'spec');
  const id = typeof raw.id !== 'string' || !ID.test(raw.id) ? bad('id', '1 to 64 lowercase letters, digits or -') : DEVICE.test(raw.id) ? bad('id', 'a name Windows keeps for a device; choose another id') : raw.id;
  const title = text('title', raw.title, 120), summary = text('summary', raw.summary, 4000), notes = raw.notes === '' ? undefined : text('notes', raw.notes, 4000, true);

  const refs: AppModel[] = [], listed: string[] = []; // the models that can be reported on; every letter given
  if (!Array.isArray(raw.models) || raw.models.length < 1 || raw.models.length > 4) bad('models', "1 to 4 model letters, e.g. ['A'] (a report on A) or ['A', 'B'] (a comparison, A the reference)");
  else raw.models.forEach((v, i) => {
    const L = typeof v === 'string' ? v : isObj(v) ? v.model : undefined, at = `models[${i}]`;
    if (typeof L !== 'string' || L.length !== 1 || !LETTERS.includes(L)) return bad(at, "a model letter, 'A' to 'D'");
    if (listed.includes(L)) return bad(at, `model ${L} is listed twice`);
    listed.push(L);
    const m = app.models.find((k) => k.model === L);
    if (!m || (!m.file && !m.loading)) return bad(at, `no model in slot ${L}; open one with open_model`);
    if (m.loading) return bad(at, `model ${L} is loading; call app_state until it has loaded`);
    if (m.result === 'running') return bad(at, `model ${L}'s result is being replaced by a run on its way; call run to wait for it`);
    if (!m.result) return bad(at, `model ${L} has no result; run first`);
    if (m.result === 'stale') return bad(at, `model ${L}'s result is stale (inputs changed since it ran); run first`);
    refs.push(m);
  });
  const letters = listed.join(', ');
  // checks against the models given (none where a model's own problem is named already)
  const column = (at: string, v: unknown, ms = refs): string | undefined => {
    if (typeof v !== 'string' || !COLUMN.test(v)) return bad(at, "a result column such as 'sunhours_front'");
    const lacks = ms.find((m) => !m.columns.includes(v));
    return lacks ? bad(at, `not in model ${lacks.model}'s result (${lacks.columns.join(', ')})`) : v;
  };
  // a prim path with receivers at or under it in one of `ms`
  const part = (at: string, v: unknown, ms = refs): string | undefined => {
    if (typeof v !== 'string' || !v.startsWith('/')) return bad(at, 'a prim path, starting with /');
    return v === '/' || !ms.length || ms.some((m) => m.receivers.some((r) => r === v || r.startsWith(`${v}/`))) ? v : bad(at, `no receiver at or under ${v} in model ${ms.map((m) => m.model).join(' or ')} (model_tree)`);
  };
  const metric = (at: string, v: unknown) => (METRICS.includes(v as Metric) ? (v as Metric) : bad(at, `one of ${METRICS.join(', ')}`));

  let stats: Stat[] | undefined;
  if (raw.stats !== undefined) {
    if (!Array.isArray(raw.stats) || raw.stats.length > 4) bad('stats', 'at most 4 stats, each {label, metric, column, model, path?}');
    else stats = raw.stats.map((s, i) => {
      const at = `stats[${i}]`;
      if (!isObj(s)) return bad(at, 'an object {label, metric, column, model, path?}')!;
      keys(at, s, 'stat');
      const m = refs.filter((k) => k.model === s.model);
      if (!listed.includes(s.model as string)) bad(`${at}.model`, `one of the report's models (${letters})`);
      const st: Stat = { label: text(`${at}.label`, s.label, 60)!, metric: metric(`${at}.metric`, s.metric)!, column: column(`${at}.column`, s.column, m)!, model: s.model as string };
      if (s.path !== undefined) st.path = part(`${at}.path`, s.path, m);
      return st;
    });
  }

  const blocks: Block[] = [], charts = new Map<string, number>();
  if (!Array.isArray(raw.blocks) || raw.blocks.length < 1 || raw.blocks.length > 40) bad('blocks', '1 to 40 blocks: text, chart, view and table');
  else raw.blocks.forEach((b, i) => {
    const at = `blocks[${i}]`;
    if (!isObj(b) || typeof b.type !== 'string' || !['text', 'chart', 'view', 'table'].includes(b.type)) return bad(`${at}.type`, 'one of text, chart, view, table');
    keys(at, b, b.type);
    const caption = b.type === 'text' ? '' : text(`${at}.caption`, b.caption, 400)!;
    if (b.type === 'text') {
      const title = text(`${at}.title`, b.title, 120, true);
      blocks.push({ type: 'text', ...(title !== undefined ? { title } : {}), text: text(`${at}.text`, b.text, 8000)! });
    } else if (b.type === 'chart') {
      const c = b.chart;
      if (!isObj(c)) return bad(`${at}.chart`, 'a ChartSpec {id, kind, ...}');
      if (Object.hasOwn(LOOK, c.kind as string)) { // cleanSpec drops a field it does not know: name it here instead
        const own = ['id', 'kind', 'title', 'column', 'models', 'parts', ...LOOK[c.kind as keyof typeof LOOK]];
        for (const k of Object.keys(c)) if (!own.includes(k)) bad(`${at}.chart.${k}`, `not a field of a ${c.kind} chart (${own.join(', ')})`);
      }
      const ls = c.models === undefined ? undefined : Array.isArray(c.models) && c.models.length && c.models.every((l) => listed.includes(l)) ? (c.models as string[]) : bad(`${at}.chart.models`, `letters of the report's models (${letters})`);
      const spec = cleanSpec({ ...c, models: ls?.map((l) => LETTERS.indexOf(l)), column: c.column ?? app.shown ?? undefined });
      if (typeof spec === 'string') return bad(`${at}.chart.${spec.slice(0, spec.indexOf(':'))}`, spec.slice(spec.indexOf(':') + 2));
      if (spec.id === 'hist' || spec.id === 'curve') bad(`${at}.chart.id`, `'${spec.id}' is a Results panel chart of its own; give the report's chart another id`);
      else if (charts.has(spec.id)) bad(`${at}.chart.id`, `'${spec.id}' is taken by blocks[${charts.get(spec.id)}]`);
      charts.set(spec.id, i);
      column(`${at}.chart.column`, spec.column, ls ? refs.filter((m) => ls.includes(m.model)) : refs);
      if (spec.title !== undefined && glyphs(spec.title)) bad(`${at}.chart.title`, glyphs(spec.title));
      spec.parts?.forEach((p, k) => part(`${at}.chart.parts[${k}]`, p));
      const { models: slots, ...rest } = spec, chart = { ...rest, ...(slots ? { models: slots.map((k) => LETTERS[k]) } : {}) };
      blocks.push({ type: 'chart', chart, caption, saved: chart });
    } else if (b.type === 'view') {
      const v = (isObj(b.view) ? b.view : {}) as Obj;
      if (!(vec(v.eye) && vec(v.target) && finite(v.fov) && v.fov > 0 && v.fov < 180 && (v.projection === 'perspective' || v.projection === 'orthographic') && finite(v.height) && v.height > 0)) {
        bad(`${at}.view`, 'a camera {eye, target, fov, projection, height} as find_critical, set_camera or app_state give it');
      }
      if (b.near !== undefined && !(finite(b.near) && b.near > 0)) bad(`${at}.near`, "the cutaway in m, more than 0 (find_critical's near)");
      if (b.aspect !== undefined && !(finite(b.aspect) && b.aspect >= 0.25 && b.aspect <= 4)) bad(`${at}.aspect`, 'width / height, 0.25 to 4');
      const col = b.column === null ? null : b.column === undefined ? bad(`${at}.column`, "a result column, or null for the models' own colours") : column(`${at}.column`, b.column);
      blocks.push({
        type: 'view', name: text(`${at}.name`, b.name, 60)!, view: { eye: v.eye, target: v.target, fov: v.fov, projection: v.projection, height: v.height } as ViewState,
        ...(b.near !== undefined ? { near: b.near as number } : {}), column: col ?? null, ...(b.aspect !== undefined ? { aspect: b.aspect as number } : {}), caption,
      });
    } else {
      const by = b.by === undefined ? 'parts' : ['parts', 'mesh', 'facing'].includes(b.by as string) ? (b.by as 'parts') : bad(`${at}.by`, 'one of parts, mesh, facing');
      let parts: string[] | undefined;
      if (b.parts !== undefined) {
        if (!Array.isArray(b.parts) || b.parts.length < 1 || b.parts.length > 50) bad(`${at}.parts`, '1 to 50 prim paths');
        else parts = b.parts.map((p, k) => part(`${at}.parts[${k}]`, p)!);
      } else if (by === 'parts') bad(`${at}.parts`, "by 'parts' takes the prim paths, one row each (model_tree); or by 'mesh' or 'facing'");
      const metrics = Array.isArray(b.metrics) && b.metrics.length >= 1 && b.metrics.length <= 6 && new Set(b.metrics).size === b.metrics.length
        ? b.metrics.map((m, k) => metric(`${at}.metrics[${k}]`, m)!) : bad(`${at}.metrics`, `1 to 6 different statistics of ${METRICS.join(', ')}`);
      blocks.push({ type: 'table', column: column(`${at}.column`, b.column)!, ...(b.by !== undefined ? { by } : {}), ...(parts ? { parts } : {}), metrics: metrics ?? [], caption } as Block);
    }
  });
  if (no.length) return no;
  const used = [...(stats ?? []).map((s) => s.column), ...blocks.flatMap((b) => (b.type === 'chart' ? [b.chart.column!] : b.type === 'view' ? (b.column ? [b.column] : []) : b.type === 'table' ? [b.column] : []))];
  const draft: Draft = {
    id: id!, title: title!,
    models: refs.map((m) => ({ model: m.model, file: m.file, ...(m.open ? { open: m.open } : {}), variants: chosenOf(m.choices), receivers: m.receivers, shades: m.shades, runKey: m.key! })),
    ranges: Object.fromEntries([...new Set(used.map(quantityOf))].map((q) => [q, { lo: app.ranges[q]?.lo ?? null, hi: app.ranges[q]?.hi ?? null }])),
    ...(stats ? { stats } : {}), summary: summary!, blocks, ...(notes !== undefined ? { notes } : {}),
  };
  const ranges = rangeless(draft, app.ranges);
  if (ranges.length) return ranges;
  const bytes = new TextEncoder().encode(JSON.stringify(draft)).length + 100; // + created and updated
  return bytes > MAX_BYTES ? [`spec: ${Math.round(bytes / 1024)} KB as stored, over the 1 MB the server keeps; shorten the texts, or report on models with fewer meshes`] : draft;
}

const few = (ps: readonly string[]) => `${ps.slice(0, 4).join(', ')}${ps.length > 4 ? ` and ${ps.length - 4} more` : ''}`;
/** A problem range in words: 'below 2 h', 'below 2 h and above 6 h', 'none'. */
const rangeText = (q: string, g?: Partial<Range>) => {
  const u = unitFor(q).value, lo = g?.lo ?? null, hi = g?.hi ?? null;
  return lo === null && hi === null ? 'none' : [lo !== null ? `below ${fmtNum(lo)} ${u}` : '', hi !== null ? `above ${fmtNum(hi)} ${u}` : ''].filter(Boolean).join(' and ');
};
/** The run settings that differ between two AppModel keys (at save, now), each '--from X at save, Y now'; '' when none
 *  or unreadable. */
function differ(was: string, now: string): string {
  try {
    const parse = (k: string) => {
      const [args, w] = JSON.parse(k) as [string[], unknown], m = new Map([['weather', Array.isArray(w) ? String(w[0]) : typeof w === 'string' ? w : 'clear sky']]);
      args.forEach((t, i) => { if (t.startsWith('--')) m.set(t, args[i + 1] === undefined || args[i + 1].startsWith('--') ? 'on' : args[i + 1]); });
      return m;
    };
    const a = parse(was), b = parse(now), say = (v?: string) => (v === undefined ? 'off' : v.length > 40 ? `${v.slice(0, 37)}...` : v);
    const d = [...new Set([...a.keys(), ...b.keys()])].filter((k) => a.get(k) !== b.get(k)).map((k) => `${k} ${say(a.get(k))} at save, ${say(b.get(k))} now`);
    return d.length ? ` (${d.join('; ')})` : '';
  } catch {
    return '';
  }
}

/**
 * What stops report `r` from being generated now, in words the agent can act on ([]: ready). Per report model: not open
 * in its slot with its file (open_model); the variants or roles not as at save (set_geometry, set_roles, then run); a run
 * on its way (wait), no result or a stale one (run); a result run with settings other than at save, which it names. Then
 * a problem range other than at save, share metrics without one, and a generation of it on its way.
 */
export function readiness(r: Report, app: AppView, generating = false): string[] {
  const out: string[] = [];
  for (const ref of r.models) {
    const L = ref.model, m = app.models.find((k) => k.model === L), say = (what: string) => out.push(`model ${L}: ${what}`), open = `open_model ${ref.open?.join(', ') ?? ref.file} into ${L}`;
    if (!m || (!m.file && !m.loading)) { say(`not open; ${open}`); continue; }
    if (m.loading) { say('loading; call app_state until it has loaded'); continue; }
    if (m.file !== ref.file) { say(`${m.file} is open, the report is on ${ref.file}; ${open}`); continue; }
    const now = chosenOf(m.choices), fix: string[] = [];
    for (const [p, sets] of Object.entries(ref.variants)) for (const [set, v] of Object.entries(sets)) if (now[p]?.[set] !== v) fix.push(`set_geometry variant ${set} of ${p} to ${v} (now ${now[p]?.[set] ?? "the file's own"})`);
    for (const [p, sets] of Object.entries(now)) for (const [set, v] of Object.entries(sets)) if (ref.variants[p]?.[set] === undefined) fix.push(`set_geometry variant ${set} of ${p} back to ${m.choices[p][set][0]}, the file's own (now ${v})`);
    const roleOf = (receivers: string[], shades: string[]) => { const rs = new Set(receivers), ss = new Set(shades); return (p: string) => (rs.has(p) ? 'receiver' : ss.has(p) ? 'shade' : 'none'); };
    const was = roleOf(ref.receivers, ref.shades), is = roleOf(m.receivers, m.shades), to = new Map<string, string[]>();
    for (const p of new Set([...ref.receivers, ...ref.shades, ...m.receivers, ...m.shades])) if (was(p) !== is(p)) to.set(was(p), [...(to.get(was(p)) ?? []), p]);
    for (const [role, ps] of to) fix.push(`set_roles ${role} for ${few(ps)}`);
    if (fix.length) say(`not as at save: ${fix.join('; ')}; then run`);
    else if (m.result === 'running') say('a run is on its way; wait for it (run waits)');
    else if (m.result === 'stale' && m.key === ref.runKey) say(`the inputs changed since the run this report is on${differ(ref.runKey, m.inputs)}; set them back`);
    else if (m.result !== 'fresh' || m.key !== ref.runKey) { // the run there is, or the next one, would not be the report's
      const d = differ(ref.runKey, m.result === 'fresh' ? m.key! : m.inputs);
      say(d ? `the settings differ from save time${d}; set them back and run, or ${m.result === 'fresh' ? '' : 'run and '}save the report again`
        : m.result === 'stale' ? 'its result is stale (inputs changed since it ran); run' : m.result ? 'its result was run with other settings than at save; set them back and run, or save the report again' : 'no result; run');
    }
  }
  const moved = new Set<string>();
  for (const [q, was] of Object.entries(r.ranges ?? {})) {
    const now = app.ranges[q], lo = was?.lo ?? null, hi = was?.hi ?? null;
    if ((now?.lo ?? null) === lo && (now?.hi ?? null) === hi) continue;
    moved.add(q);
    out.push(`the problem range of ${q} is ${rangeText(q, now)} now, ${rangeText(q, was)} at save; set it back (update_settings viz {quantity: '${q}', below: ${lo}, above: ${hi}}) or save the report again`);
  }
  out.push(...rangeless(r, app.ranges, moved));
  if (generating) out.push('generating: a PDF of this report is being made; call generate_report for it');
  return out;
}

/** A readiness problem (or a refusal quoting them) as the app says it: what to restore in the app's words, not the
 *  tools' that readiness names for the agent. */
export const inApp = (s: string) => s
  .replace(/open_model (.+?) into ([A-D])\b/g, 'open $1 as model $2')
  .replace(/set_geometry variant (\S+) of (\S+) (?:back )?to /g, 'variant $1 of $2 back to ')
  .replace(/set_roles (\w+) for ([^;]+)/g, (_, role: string, ps: string) => `${ps} back to ${role === 'none' ? 'ignored' : role}`)
  .replace(/; call app_state until it has loaded| \(run waits\)|,? or (?:run and )?save the report again|; call generate_report for it/g, '')
  .replace(/ \(update_settings viz \{[^}]*\}\)/g, ' in Results')
  .replace(/(?:stats|blocks)\[\d+\](?:\.metric)?: [\w, ]+ is a share of the problem range, and (\w+) has none; set it in Results or use another metric/g, 'the report shows shares of the problem range of $1, which has none now; set one in Results')
  .replace(/--([a-z][\w-]*) /g, '$1 ') // run settings by name: 'step 15 at save, 30 now'
  .replace(/\bsunhours\b/g, 'sun hours');
