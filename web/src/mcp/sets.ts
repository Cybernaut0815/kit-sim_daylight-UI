// The agent's tools for analysis sets and combined views (server/mcp.json), as the Sets menu and the Combined tab's
// panels offer them: a set saved from an analysis' setup now (with roles and settings of its own, applied to a copy of
// the app, not to it), opened, copied to another model (a new set, by USD path), run in the background (sets/runs.ts);
// a combined view (sets/combine.ts) saved or previewed; either kind renamed (its id stays) or deleted. results quotes a
// set's kept results and a combined view through setResults and combinedResults, as it quotes an analysis' last runs.
import { flushSync } from 'react-dom';
import { dataOf } from '../lib/charts';
import { roundNum, roundPct, splitColumn, unitFor } from '../lib/result';
import { idsUnder } from '../lib/tree';
import { boundsOf, columnOf, combine, inputRange, type InputRun } from '../sets/combine';
import { applyReport, captureSet, checkView, copyName, copySet, copyText, isSet, levelText, notOpen, renameSet, setSummary, viewHelp, type AnalysisSet, type CombinedView, type Saved } from '../sets/model';
import type { SetModelStatus } from '../sets/runs';
import { inputStatus, missingOf } from '../sets/useCombined';
import { reducer, type Action, type State, type Tool } from '../store';
import { exclusive } from './bridge';
import { TOOLS, check } from './schema';
import { letter, loadedOf, ok, type Args, type Ctl, type Handler } from './tools/common';
import { roleActions } from './tools/model';
import { settingsActions } from './tools/settings';
import { columnFacts, compared, provenance, rowArgs, summaries, viewProvenance } from './tools/stats';

/** save_set's settings blocks take update_settings' schemas (checked in the handler: mcp.json gives them once). */
const SETTINGS = TOOLS.find((t) => t.name === 'update_settings')!.inputSchema.properties!;
const STATE: Record<SetModelStatus['state'], string> = { none: 'no entry', 'no-receiver': 'no receiver', subdiv: 'another subdivision', missing: 'not run', queued: 'queued', running: 'running', done: 'done', error: 'failed' };
/** What a set of another subdivision level needs, for the agent. */
const levelNote = (st: SetModelStatus) => (st.level !== undefined ? { note: `the set runs at subdivision ${levelText(st.level)}, not the app's: open_set it first (it re-reads the models at that level)` } : {});
const savedSets = (x: Ctl) => x.sets.saved.filter(isSet);
const ids = (l: readonly { id: string }[], none: string) => l.map((s) => s.id).join(', ') || none;
/** Saved set `id`; its refusal names `field` and the sets there are. */
function setOf(x: Ctl, id: string, field = 'id'): AnalysisSet {
  const s = savedSets(x).find((k) => k.id === id);
  if (!s) throw new Error(`${field}: no set ${id} (${ids(savedSets(x), 'none saved; save_set first')})`);
  return s;
}
/** Saved combined view `id`. */
function viewOf(x: Ctl, id: string, field = 'id'): CombinedView {
  const v = x.combined.views.find((k) => k.id === id);
  if (!v) throw new Error(`${field}: no combined view ${id} (${ids(x.combined.views, 'none saved; save_combined first')})`);
  return v;
}
/** Saved set or combined view `id` (rename_set, delete_set). */
function savedOf(x: Ctl, id: string): Saved {
  const s = x.sets.saved.find((k) => k.id === id);
  if (!s) throw new Error(`id: no set or combined view ${id} (sets: ${ids(savedSets(x), 'none')}; combined views: ${ids(x.combined.views, 'none')})`);
  return s;
}
const live = (st: SetModelStatus) => st.state === 'queued' || st.state === 'running';
/** The open models `named` (letters; their argument `field`) among a set's or a view's per-model lines, else `fallback`. */
function picked<T extends { model: string }>(lines: readonly T[], named: readonly string[] | undefined, field: string, fallback: () => T[]): T[] {
  return named?.map((l, i) => {
    const k = lines.find((s) => s.model === l);
    if (!k) throw new Error(`${field}[${i}]: no model with a file in slot ${l} (${lines.map((s) => s.model).join(', ') || 'none open'})`);
    return k;
  }) ?? fallback();
}

/** Set `set`'s status per open model with a file: done with its column's mean, P10 and P90 (in the column's unit) and
 *  run time. */
function statusLines(x: Ctl, set: AnalysisSet) {
  return x.runs.statusOf(set).map((st) => {
    const m = x.state.models.find((k) => k.slot === st.slot), r = st.result, col = r ? r.columns.indexOf(set.column) : -1, sum = r && m && col >= 0 ? dataOf(r, col, m.objects).markers : null;
    return {
      model: st.model, status: STATE[st.state], ...(st.progress !== undefined ? { progress: roundPct(st.progress) } : {}), ...(st.message ? { error: st.message } : {}), ...levelNote(st),
      ...(r ? { seconds: roundNum(r.elapsed) } : {}),
      ...(sum ? { column: set.column, unit: unitFor(set.column).value, mean: roundNum(sum.mean), p10: roundNum(sum.p10), p90: roundNum(sum.p90) } : r ? { note: `its result has no ${set.column}` } : {}),
    };
  });
}
/** The saved sets as app_state lists them: each with what it keeps in words and its status per open model (done: the
 *  run time of the result kept this session). */
export const setsOf = (x: Ctl) => savedSets(x).map((s) => ({
  id: s.id, name: s.name, analysis: s.tool, column: s.column, models: s.models.map((m) => m.model), updated: s.updated,
  summary: setSummary(s).map((l) => `${l.label}: ${l.value}`),
  status: x.runs.statusOf(s).map((st) => ({ model: st.model, status: STATE[st.state], ...(st.result ? { seconds: roundNum(st.result.elapsed) } : {}), ...(st.message ? { error: st.message } : {}) })),
}));
/** The combined views as app_state lists them: what each misses per open model (the one shown: the meshes it skipped);
 *  last, a preview the Combined tab shows (save_combined's or the editor's draft: not saved), under its view's id or
 *  'draft'. */
export const combinedOf = (x: Ctl) => {
  const view = x.combined.view, draft = view && !x.combined.views.includes(view) ? view : null;
  return [...x.combined.views, ...(draft ? [draft] : [])].map((v) => {
    const inputs = inputStatus(v, savedSets(x), x.runs), shown = view === v;
    const missing = x.state.models.filter((m) => m.name).flatMap((m) => missingOf(m.slot, inputs));
    const mismatches = shown ? x.combined.models.flatMap((m) => (m.result?.manifest.combined?.mismatches ?? []).map((s) => `${letter(m.slot)}: ${s}`)) : [];
    return {
      id: v.id, name: v.name, unit: v.unit, op: v.op, inputs: v.inputs.length, meaning: viewHelp(v, savedSets(x)), shown, ...(v === draft ? { preview: true } : {}),
      ...(missing.length ? { missing } : {}), ...(mismatches.length ? { mismatches } : {}),
    };
  });
};

/** The app state `s` with save_set's roles and settings (each checked, a problem naming its path) for analysis `tool`. */
function setupOf(x: Ctl, s: State, a: Args, tool: Tool): State {
  for (const [i, r] of ((a.roles ?? []) as Args[]).entries()) {
    const at = `roles[${i}]`, m = loadedOf(x, r.model, `${at}.model`), objects = tool === 'views' ? m.viewAnalysis.objects : m.objects;
    if (!idsUnder(r.paths, objects).length) throw new Error(`${at}.paths: no mesh at or under them in model ${letter(m.slot)}; find prims with model_tree`);
    for (const act of roleActions(m, r, tool, at)) s = reducer(s, act);
  }
  if (a.settings) {
    const wrong = tool === 'views' ? ['sim', 'time'].find((k) => a.settings[k] !== undefined) : a.settings.view !== undefined ? 'view' : undefined;
    if (wrong) throw new Error(`settings.${wrong}: not a setting of a ${tool === 'views' ? "View analysis set (it takes view)" : 'Daylight set (it takes sim and time)'}`);
    for (const k of ['sim', 'time', 'view']) { const why = a.settings[k] === undefined ? '' : check(SETTINGS[k], a.settings[k], `settings.${k}`); if (why) throw new Error(why); }
    let acts: Action[];
    try {
      acts = settingsActions(a.settings, s, null);
    } catch (e) {
      throw new Error(`settings.${(e as Error).message}`); // 'time.date: ...'
    }
    for (const act of acts) s = reducer(s, act);
  }
  return s;
}

/** Each input set of view `v` run for the open models that miss its result (as Run missing sets), the runs' ends. */
function runMissing(x: Ctl, v: CombinedView): Promise<void>[] {
  const out: Promise<void>[] = [];
  flushSync(() => {
    for (const { set, status } of inputStatus(v, savedSets(x), x.runs)) {
      const slots = set ? status.filter((st) => st.state === 'missing').map((st) => st.slot) : [];
      if (set && slots.length) out.push(x.runs.run(set, slots));
    }
  });
  return out;
}
/** The runs ended within the call's budget. */
const settled = (runs: readonly Promise<void>[], end: number) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([Promise.allSettled(runs).then(() => true), new Promise<boolean>((r) => { timer = setTimeout(() => r(false), Math.max(0, end - Date.now())); })]).finally(() => clearTimeout(timer));
};
/** The render after a run's end: its status reads done or failed (the runner's last setState commits). */
const after = async (busy: () => boolean, end: number) => { for (let k = 0; k < 40 && busy() && Date.now() < end; k++) await new Promise((r) => setTimeout(r, 25)); };
/** A wait argument (seconds, default 40) as the budget's end it gives, within the call's own. */
const until = (wait: number | undefined, end: number) => Math.min(end, Date.now() + 1000 * (wait ?? 40));

/** View `v` combined for model `m` against every open model's input results (the normalise bounds span them all), as
 *  the Combined tab combines the view it shows. */
function combinedFor(x: Ctl, v: CombinedView) {
  const inputs = inputStatus(v, savedSets(x), x.runs), models = x.state.models;
  const runsOf = models.map((m) => inputs.map(({ input, set, status }): InputRun | null => {
    const r = status.find((st) => st.slot === m.slot && st.state === 'done')?.result;
    return set && r ? { result: r, col: r.columns.indexOf(input.column), name: set.name } : null;
  }));
  const pathOf = models.map((m) => { const p = new Map(m.objects.map((o) => [o.id, o.path])); return (id: string) => p.get(id); });
  const bounds = v.inputs.map((i, k) => boundsOf(i, inputRange(i, runsOf.map((r) => r[k]), pathOf)));
  return models.map((m, mi) => ({ m, model: letter(m.slot), missing: missingOf(m.slot, inputs), ...combine(v, runsOf[mi], bounds, pathOf[mi]) }));
}

// ---------------------------------------------------------------------------------------------- results' other sources
/** results with set: saved set `set`'s results kept this session, per open model (default those it has one for), quoted
 *  as results quotes an analysis' last runs; its column and problem range the set's own unless given. */
export async function setResults(a: Args, c: () => Ctl) {
  return exclusive(() => {
    const x = c(), set = setOf(x, a.set, 'set');
    if (a.analysis !== undefined && a.analysis !== set.tool) throw new Error(`analysis: set ${set.id} is a ${set.tool} set; leave analysis out`);
    const st = x.runs.statusOf(set), pick = picked(st, a.models, 'models', () => st.filter((s) => s.result));
    if (!pick.some((s) => s.result)) throw new Error(`set: ${set.name} has no result kept this session for ${a.models ? (a.models as string[]).join(', ') : 'an open model'}; run_set it first (${st.map((s) => `${s.model} ${STATE[s.state]}`).join(', ') || 'no model open'})`);
    const column: string = a.column ?? set.column, lacks = pick.find((s) => s.result && !s.result.columns.includes(column));
    if (lacks) throw new Error(`column: model ${lacks.model}'s kept result has no ${column} (${lacks.result!.columns.join(', ')})`);
    const { paths, by, th, limit } = rowArgs(a), look = set.looks?.quantities[splitColumn(column)[0]] ?? set.look ?? {}, lo = look.lo ?? null, hi = look.hi ?? null;
    const each = pick.map((s) => {
      const m = x.state.models.find((k) => k.slot === s.slot)!, r = s.result, run = r && (set.tool === 'views' ? viewProvenance(r, m.objects) : provenance(r, m.objects));
      return { head: { model: s.model, name: m.name, ...(r ? { run } : { status: STATE[s.state], ...levelNote(s) }) }, sums: r ? summaries(x, { objects: m.objects, result: r }, column, by, paths, lo, hi, th) : null };
    });
    return ok({ set: { id: set.id, name: set.name, analysis: set.tool }, ...columnFacts(column), problemRange: { lo, hi }, by, models: compared(each, th, lo !== null || hi !== null, limit) });
  });
}

/** results with analysis 'combined': combined view `id` per open model, quoted as results quotes a column; first, unless
 *  wait is 0, its input sets missing a result run (up to wait seconds), as the Combined tab runs them. */
export async function combinedResults(a: Args, c: () => Ctl, end: number) {
  if (a.id === undefined) throw new Error("id: analysis 'combined' quotes a combined view; give its id (app_state combined)");
  if (a.column !== undefined) throw new Error("column: a combined view has one column of its own; leave column out");
  viewOf(c(), a.id);
  let running = false;
  if (a.wait !== 0) {
    const jobs = await exclusive(() => runMissing(c(), viewOf(c(), a.id))), by = until(a.wait, end);
    if (jobs.length && !(running = !(await settled(jobs, by)))) await after(() => savedSets(c()).some((s) => c().runs.statusOf(s).some(live)), by);
  }
  return exclusive(() => {
    const x = c(), v = viewOf(x, a.id), column = columnOf(v), all = combinedFor(x, v).filter(({ m }) => m.name), pick = picked(all, a.models, 'models', () => all);
    const { paths, by, th, limit } = rowArgs(a), range = x.state.settings.viz.ranges[column], lo = range ? range.lo : v.look?.lo ?? null, hi = range ? range.hi : v.look?.hi ?? null;
    const each = pick.map(({ m, model, missing, info, result }) => ({
      head: { model, name: m.name, ...(missing.length ? { missing } : {}), ...(info.mismatches.length ? { mismatches: info.mismatches } : {}), ...(result ? { inputs: `${info.used} of ${info.of}` } : {}) },
      sums: result ? summaries(x, { objects: m.objects, result }, column, by, paths, lo, hi, th) : null,
    }));
    return ok({
      analysis: 'combined', id: v.id, name: v.name, column, unit: v.unit, meaning: viewHelp(v, savedSets(x)), problemRange: { lo, hi }, by, models: compared(each, th, lo !== null || hi !== null, limit),
      ...(running ? { status: 'running', note: 'input sets are still running in the background; call results again to quote them' } : {}),
    });
  });
}

let previewed: CombinedView | null = null; // save_combined's preview: the agent takes it back on a save, unless the editor replaced it

export const SET_HANDLERS: Record<string, Handler> = {
  async save_set(a, c) {
    return exclusive(async () => {
      const x = c(), name: string = a.name.trim(), was = a.id === undefined ? undefined : setOf(x, a.id);
      if (!name) throw new Error('name: not blank');
      if (a.id !== undefined && x.combined.views.some((v) => v.id === a.id)) throw new Error(`id: ${a.id} is a combined view; give a set's id, or leave id out to save a new set`);
      const tool: Tool = a.analysis ?? was?.tool ?? (x.ui.tab === 'views' ? 'views' : 'daylight');
      if (was && was.tool !== tool) throw new Error(`analysis: set ${was.id} is a ${was.tool} set; leave analysis out, or leave id out to save a new set`);
      if (!x.state.models.some((m) => m.name)) throw new Error('name: no model is open; a set keeps every open model\'s roles: open one with open_model first');
      const s = setupOf(x, x.state, a, tool), sim = s.settings.sim, sides = sim.sides === 'both' ? ['front', 'back'] : [sim.sides];
      if (tool === 'daylight' && a.column !== undefined) {
        const [q, side] = (a.column as string).split('_');
        if (!(sim.quantities as string[]).includes(q) || !sides.includes(side)) throw new Error(`column: not a column the set computes (${sim.quantities.flatMap((k) => sides.map((d) => `${k}_${d}`)).join(', ')})`);
      }
      const set = captureSet(s, tool, name, { shown: a.column ?? x.analysis(tool).shown ?? was?.column, was, subdiv: x.ui.subdiv });
      const saved: AnalysisSet = { ...set, ...(a.colourBy ? { colourBy: a.colourBy } : {}) };
      if (!(await x.sets.put(saved))) throw new Error(`id: not saved (${c().sets.error ?? 'the server refused it'})`);
      return ok({ saved: { id: saved.id, name, analysis: tool, column: saved.column, colourBy: saved.colourBy, models: saved.models.map((m) => ({ model: m.model, file: m.file, roles: m.roles.length })), updated: saved.updated }, status: statusLines(c(), saved) });
    });
  },

  async open_set(a, c) {
    return exclusive(() => {
      const x = c(), set = setOf(x, a.id), lines = applyReport(x.state.models, set), waiting = notOpen(x.state.models, set);
      flushSync(() => x.openSet(set));
      return ok({
        opened: { id: set.id, name: set.name, analysis: set.tool, column: set.column }, tab: c().ui.tab,
        models: lines.map((l) => ({ model: l.model, ...(l.match ? { entry: l.match.entry.model, how: l.match.how, matched: l.match.matched, of: l.match.total } : { entry: null }), text: l.text })),
        ...(waiting.length ? { notOpen: waiting } : {}),
      });
    });
  },

  async copy_set(a, c) {
    return exclusive(async () => {
      const x = c(), set = setOf(x, a.id), to = loadedOf(x, a.to, 'to'), L = letter(to.slot), entries = set.models.map((e) => `${e.model} ${e.file}`).join(', ');
      const from = a.from === undefined ? (set.models.length === 1 ? set.models[0] : undefined) : set.models.find((e) => e.model === a.from);
      if (!from) throw new Error(a.from !== undefined ? `from: set ${set.name} has no entry ${a.from} (${entries || 'none'})` : set.models.length ? `from: set ${set.name} has several entries (${entries}); name the one to copy` : `id: set ${set.name} has no entry to copy`);
      const name = ((a.name as string | undefined) ?? copyName(set, to.name)).trim();
      if (!name) throw new Error('name: not blank');
      const { set: copy, counts } = copySet(set, from, to, [...x.viewer(to.slot).materials.values()].map((m) => m.path), name);
      if (!(await x.sets.put(copy))) throw new Error(`id: not saved (${c().sets.error ?? 'the server refused it'})`);
      const text = copyText(L, counts);
      flushSync(() => c().openSet(copy, { model: L, text }));
      return ok({
        saved: { id: copy.id, name: copy.name, analysis: copy.tool, from: from.model, to: L, file: to.name }, tab: c().ui.tab, text,
        roles: { matched: counts.roles, of: counts.rolesOf }, meshesWithoutRole: counts.bare, materialEdits: { matched: counts.edits, of: counts.editsOf },
      });
    });
  },

  async rename_set(a, c) {
    return exclusive(async () => {
      const item = savedOf(c(), a.id), renamed = renameSet(item, a.name);
      if (!(await c().sets.put(renamed))) throw new Error(`id: not renamed (${c().sets.error ?? 'the server refused it'})`);
      return ok({ renamed: { id: item.id, kind: isSet(item) ? 'set' : 'combined', from: item.name, name: renamed.name } });
    });
  },

  async run_set(a, c, end) {
    const { set, jobs } = await exclusive(() => {
      const x = c(), set = setOf(x, a.id), st = x.runs.statusOf(set);
      const named = (a.models as string[] | undefined)?.map((l, i) => {
        const k = st.find((s) => s.model === l);
        if (!k) throw new Error(`models[${i}]: no model with a file in slot ${l} (${st.map((s) => s.model).join(', ') || 'none open'})`);
        if (k.state === 'none') throw new Error(`models[${i}]: model ${l} has no entry in set ${set.name} (its models: ${set.models.map((m) => `${m.model} ${m.file}`).join(', ')}); copy_set it to ${l} for a set of its own`);
        if (k.state === 'subdiv') throw new Error(`models[${i}]: ${levelNote(k).note}`);
        return k.slot;
      });
      const slots = named ?? st.filter((s) => s.state === 'missing' || s.state === 'error').map((s) => s.slot), jobs: Promise<void>[] = [];
      if (slots.length) flushSync(() => { jobs.push(x.runs.run(set, slots)); });
      return { set, jobs };
    });
    const by = until(a.wait, end), ended = a.wait === 0 || !jobs.length ? !jobs.length : await settled(jobs, by);
    if (ended) await after(() => c().runs.statusOf(set).some(live), by);
    const models = statusLines(c(), set), running = models.some((m) => m.status === 'queued' || m.status === 'running');
    return ok({
      set: { id: set.id, name: set.name, analysis: set.tool }, models,
      ...(running ? { status: 'running', note: 'it goes on in the background; call run_set again (it runs nothing twice) or app_state to see it end' } : {}),
    });
  },

  async delete_set(a, c) {
    return exclusive(async () => {
      const x = c(), item = savedOf(x, a.id), users = isSet(item) ? x.combined.views.filter((v) => v.inputs.some((i) => i.set === item.id)).map((v) => v.name) : [];
      if (!(await x.sets.remove(item.id))) throw new Error(`id: not deleted (${c().sets.error ?? 'the server refused it'})`);
      return ok({
        deleted: item.id, kind: isSet(item) ? 'set' : 'combined', sets: savedSets(c()).map((s) => s.id), combined: c().combined.views.map((v) => v.id),
        ...(users.length ? { note: `combined views that took it as an input now miss it: ${users.join(', ')}` } : {}),
      });
    });
  },

  async save_combined(a, c) {
    return exclusive(async () => {
      const x = c(), sets = savedSets(x), { preview, ...view } = a;
      if (a.id !== undefined && sets.some((s) => s.id === a.id)) throw new Error(`id: ${a.id} is a set; give a combined view's id, or leave id out to save a new view`);
      const was = a.id === undefined ? undefined : x.combined.views.find((v) => v.id === a.id), v = checkView(preview ? { ...view, id: a.id ?? 'draft' } : view, sets, was);
      if (Array.isArray(v)) throw new Error(`${v.length} problem${v.length > 1 ? 's' : ''}: ${v.join('; ')}`);
      if (preview) { // shown on the Combined tab, as the editor shows its draft: nothing stored
        flushSync(() => { if (x.ui.tab !== 'combined') x.setUi((u) => ({ ...u, tab: 'combined' })); x.previewCombined(v); });
        previewed = v;
        const missing = x.state.models.filter((m) => m.name).flatMap((m) => missingOf(m.slot, inputStatus(v, sets, c().runs)));
        return ok({ preview: { id: v.id, name: v.name, unit: v.unit, op: v.op, inputs: v.inputs.length }, tab: 'combined', meaning: viewHelp(v, sets), ...(missing.length ? { missing } : {}), note: 'not saved: save_combined without preview stores it; leaving the Combined tab drops it' });
      }
      if (!(await x.sets.put(v))) throw new Error(`id: not saved (${c().sets.error ?? 'the server refused it'})`);
      if (previewed && c().combined.view === previewed) flushSync(() => c().previewCombined(null)); // the saved view shows instead
      previewed = null;
      const missing = combinedOf(c()).find((k) => k.id === v.id)?.missing;
      return ok({ saved: { id: v.id, name: v.name, unit: v.unit, op: v.op, inputs: v.inputs.length, column: columnOf(v), updated: v.updated }, meaning: viewHelp(v, sets), ...(missing ? { missing } : {}) });
    });
  },
};
