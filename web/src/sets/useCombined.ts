// The Combined tab's analysis: the combined view shown, per open model (combine.ts) from its input sets' results as the
// set runner finds them, with the display fields of useAnalysis (models, compared, column, shown, cols, results, domain,
// scale), so the views, the Results and Download work as on the other tabs. A model's objects show the combined meshes
// as receivers and every other mesh as none. Whenever a saved view shows, it runs each input set that has no result for
// the inputs now (once per set, model and inputs). `preview`: the editor's draft (CombinedPanel), shown instead of the
// saved view until Save or Cancel; it never starts a run by itself (Run missing sets does).
import { useEffect, useMemo, useRef } from 'react';
import { scaleFor, type Scale } from '../lib/gradients';
import { columnLabel, registerCombined, splitColumn, unionRange } from '../lib/result';
import type { Compared } from '../panels/ResultsPanel';
import type { Model, ObjectRow, Run, RunResult, Settings, State } from '../store';
import { boundsOf, columnOf, combine, inputRange, type InputRun } from './combine';
import { LETTERS, isCombined, isSet, levelText, viewHelp, withLook, type AnalysisSet, type CombinedView, type Saved } from './model';
import type { SetRuns } from './runs';

/** Per input of view `v`: its set (null: deleted) and that set's status per model. */
export const inputStatus = (v: CombinedView, sets: readonly AnalysisSet[], runs: Pick<SetRuns, 'statusOf'>) =>
  v.inputs.map((i) => { const set = sets.find((x) => x.id === i.set) ?? null; return { input: i, set, status: set ? runs.statusOf(set) : [] }; });

/** What model `slot` misses of view `v`'s inputs, in words ('C: no result of View south'). */
export function missingOf(slot: number, inputs: ReturnType<typeof inputStatus>): string[] {
  const L = LETTERS[slot];
  return inputs.flatMap(({ input, set, status }) => {
    if (!set) return [`${L}: the set ${input.set} is deleted`];
    const st = status.find((x) => x.slot === slot);
    if (!st || st.state === 'none') return [`${L}: no entry in ${set.name}`];
    if (st.state === 'no-receiver') return [`${L}: no receiver in ${set.name}`];
    if (st.state === 'error') return [`${L}: ${set.name} failed (${st.message})`];
    if (st.state === 'subdiv') return [`${L}: ${set.name} runs at subdivision ${levelText(st.level!)}; open it to run`];
    if (st.state !== 'done') return [`${L}: no result of ${set.name}${st.state === 'missing' ? '' : ' yet'}`];
    return st.result!.columns.includes(input.column) ? [] : [`${L}: ${set.name} has no ${columnLabel(input.column)}`];
  });
}

/** The view the Combined tab shows: the editor's preview, else the saved view of `column`, else the first. */
export const shownView = (views: readonly CombinedView[], column: string, preview: CombinedView | null): CombinedView | null =>
  preview ?? views.find((v) => columnOf(v) === column) ?? views[0] ?? null;

export function useCombined(c: { state: State; saved: readonly Saved[]; runs: SetRuns; visible: boolean; viz: Settings['viz']; preview: CombinedView | null }) {
  const { state, saved, runs, preview } = c, models = state.models;
  const views = useMemo(() => saved.filter(isCombined), [saved]), sets = useMemo(() => saved.filter(isSet), [saved]);
  useMemo(() => registerCombined([...views.filter((v) => v.id !== preview?.id), ...(preview ? [preview] : [])].map((v) => ({ id: v.id, name: v.name, unit: v.unit, help: viewHelp(v, sets) }))), [views, sets, preview]);
  const view = shownView(views, state.combined.column, preview), shown = view ? columnOf(view) : null;
  const inputs = view ? inputStatus(view, sets, runs) : [];
  // per model and input, the result to combine (a done status with the column)
  const runsOf = models.map((m) => inputs.map(({ input, set, status }): InputRun | null => {
    const r = status.find((x) => x.slot === m.slot && x.state === 'done')?.result;
    return set && r ? { result: r, col: r.columns.indexOf(input.column), name: set.name } : null;
  }));
  const paths = useRef(new WeakMap<ObjectRow[], Map<string, string>>()); // per model's rows, a row id's prim path
  const pathOf = models.map((m) => {
    let p = paths.current.get(m.objects);
    if (!p) paths.current.set(m.objects, (p = new Map(m.objects.map((o) => [o.id, o.path]))));
    return (id: string) => p.get(id);
  });
  // one combination per model, kept while its view and input results are the same (and its rows: a re-read is new)
  const memo = useRef(new Map<number, { inputs: unknown[]; value: { result: RunResult | null; objects: ObjectRow[] } }>());
  const bounds = view ? view.inputs.map((i, k) => boundsOf(i, inputRange(i, runsOf.map((r) => r[k]), pathOf))) : [];
  const boundsKey = JSON.stringify(bounds);
  const combined = models.map((m, mi) => {
    if (!view) return { result: null, objects: m.objects };
    const missing = missingOf(m.slot, inputs), key = [view, m.objects, boundsKey, missing.join('\n'), ...runsOf[mi].map((r) => r?.result)], had = memo.current.get(m.slot);
    if (had && had.inputs.length === key.length && had.inputs.every((x, i) => x === key[i])) return had.value;
    const { result, info } = combine(view, runsOf[mi], bounds, pathOf[mi]);
    const on = new Set(result?.receivers ?? []), objects = m.objects.map((o) => (on.has(o.id) ? (o.role === 'receiver' ? o : { ...o, role: 'receiver' as const }) : o.role === 'none' ? o : { ...o, role: 'none' as const }));
    const value = { result: result && { ...result, manifest: { ...result.manifest, combined: { op: view.op, ...info, missing } } }, objects };
    memo.current.set(m.slot, { inputs: key, value });
    return value;
  });
  // the Combined tab's models, busy while an input set of theirs runs: each kept while its parts are the same, and the
  // list while every model is (the memoised panels keep their props)
  const own = useRef(new Map<number, { inputs: unknown[]; value: Model }>()), last = useRef<Model[]>([]);
  const now = models.map((m, mi) => {
    const busy = inputs.some(({ status }) => status.some((x) => x.slot === m.slot && (x.state === 'queued' || x.state === 'running')));
    const key = [m, combined[mi].objects, combined[mi].result, busy], had = own.current.get(m.slot);
    if (had && had.inputs.every((x, i) => x === key[i])) return had.value;
    const run: Run = busy ? { status: 'running' } : { status: 'idle' }, value = { ...m, objects: combined[mi].objects, result: combined[mi].result, run, error: null };
    own.current.set(m.slot, { inputs: key, value });
    return value;
  });
  const cmodels = now.length === last.current.length && now.every((x, i) => x === last.current[i]) ? last.current : (last.current = now);

  // a saved view shown runs each input set without a result for the inputs now (an error, or a preview's input, waits for
  // Run missing sets)
  const asked = useRef(new Set<string>());
  const missingKey = inputs.map(({ set, status }) => (set ? status.filter((x) => x.state === 'missing').map((x) => `${set.id}:${x.slot}:${x.key}`).join() : '')).join('|');
  const runMissing = (all = false) => {
    for (const { set, status } of inputs) {
      if (!set) continue;
      const slots = status.filter((x) => x.state === 'missing' || (all && x.state === 'error')).filter((x) => all || !asked.current.has(`${set.id}:${x.slot}:${x.key}`)).map((x) => x.slot);
      for (const x of status) if (slots.includes(x.slot)) asked.current.add(`${set.id}:${x.slot}:${x.key}`);
      if (slots.length) void runs.run(set, slots);
    }
  };
  useEffect(() => { if (c.visible && view && !preview) runMissing(); }, [c.visible, view?.id, missingKey, !preview]); // eslint-disable-line react-hooks/exhaustive-deps -- this render's inputs

  // the display fields, as useAnalysis gives them
  const q = shown ? splitColumn(shown)[0] : '';
  const viz = useMemo(() => (view?.look && q && !(q in c.viz.gradients || q in c.viz.scales || q in c.viz.ranges || q in c.viz.scalings) ? withLook(c.viz, q, view.look) : c.viz), [c.viz, view?.look, q]);
  const cols = cmodels.map((m) => (m.result ? 0 : -1));
  const bySlot = [0, 1, 2, 3].map((k) => cmodels.find((m) => m.slot === k)?.result ?? null);
  const results = useMemo(() => bySlot.filter((r): r is RunResult => !!r), bySlot); // eslint-disable-line react-hooks/exhaustive-deps
  const domain = useMemo<[number, number]>(() => (shown ? unionRange(results, shown) : [NaN, NaN]), [results, shown]);
  const scale = useMemo<Scale | null>(() => (shown ? scaleFor(shown, domain, viz, results) : null), [shown, domain[0], domain[1], viz, results]); // eslint-disable-line react-hooks/exhaustive-deps -- by value
  const compared = useMemo<Compared[]>(() => cmodels.map((m) => ({ ...m, col: m.result ? 0 : -1, stale: false })), [cmodels]);
  const busyBar = runs.busy;
  // per model with a file: what it misses of the view, then the meshes it skipped
  const notes = view ? cmodels.filter((m) => m.name).flatMap((m) => [...missingOf(m.slot, inputs), ...(m.result?.manifest.combined?.mismatches ?? []).map((x) => `${LETTERS[m.slot]}: ${x}`)]) : [];
  const runnable = inputs.some(({ set, status }) => set && status.some((x) => x.state === 'missing' || x.state === 'error'));
  return { views, sets, view, inputs, notes, runnable, models: cmodels, compared, column: 0, shown, cols, results, domain, scale, viz, busyBar, runMissing };
}
export type Combined = ReturnType<typeof useCombined>;
