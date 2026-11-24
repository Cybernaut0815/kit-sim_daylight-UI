// One analysis' runs: the settings it runs with (cfgFor: daylight's, or the view analysis'), each model's run inputs
// (perOf), one model's job (jobOf), and the hook that runs them for a tab (useAnalysis: one batch at a time, the models
// one after another, Auto, the comparison). The background set runner (sets/runs.ts) makes its jobs from the same parts.
import { useEffect, useMemo, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { runRemote } from 'daylight-mesh';
import { buildArgs, epwRef, noOccludeArgs, simFor, targetArgs, validate, validateViews, viewArgs } from './lib/args';
import { jobMeshes, same, type Extracted, type Hashed } from './lib/extract';
import { scaleFor, type Scale } from './lib/gradients';
import { opticsArgs, readKey, resolveOptics, runSwitches, type TextureStats } from './lib/optics';
import { columnIndex, faceAreas, unionRange, vertexAreas } from './lib/result';
import { rowAreas } from './lib/topology';
import { UUID } from './mcp/tools';
import type { Compared } from './panels/ResultsPanel';
import { kept } from './sets/kept';
import { inFlight, runBatch, type Action, type Model, type ObjectRow, type Run, type RunResult, type Settings, type Tool } from './store';
import { readTexture, viewer } from './viewer/usd';

// One id per browser tab for the server's per-client job limit (sessionStorage: a new tab is a new client).
export const CLIENT_ID = (() => { try { return sessionStorage.getItem('daylight.client') ?? (sessionStorage.setItem('daylight.client', crypto.randomUUID()), sessionStorage.getItem('daylight.client')!); } catch { return crypto.randomUUID(); } })();
// validate() field -> the control that gets focus
const FOCUS: Record<string, string> = { model: 'model-files', lat: 'lat', lon: 'lon', quantities: 'q-radiation', skyDensity: 'sky-density', timeTo: 'time-to-date', timeDate: 'time-date', materials: 'materials-status' };
// validateViews() field -> the control that gets focus
const VIEW_FOCUS: Record<string, string> = { model: 'model-files', groups: 'target-group', fov: 'view-fov-lo', cell: 'view-cell', far: 'view-far', reach: 'view-reach', materials: 'materials-status' };

/** A row's mesh, built on demand (lib/extract.ts), with its model's slot; once a run has hashed it, its content id. */
export type Conv = Hashed & Pick<Extracted, 'make' | 'topology' | 'receiver'> & { slot: number };
/** A mesh's server id or core name (C1: content ids, twins id_2, ...) in a server or core message. */
export const CORE = /[0-9a-f]{64}(?:_\d+)?/g;
export const NO_STATS: ReadonlyMap<string, TextureStats | null> = new Map();
export type Optics = ReturnType<typeof resolveOptics>;
/** Per slot (each core numbers its files from /drop/1), the textures read, by readKey (null: unreadable). */
export type TexStats = Readonly<Record<number, ReadonlyMap<string, TextureStats | null>>>;

/** A model's run inputs now: its receivers and shades, their faces or vertices (the rows its run returns), its run
 *  arguments and their words, its mesh ids, and everything the server's response cache keys on (an equal key gives an
 *  equal result). */
export interface Per { m: Model; receivers: ObjectRow[]; shades: ObjectRow[]; elements: number; args: string[]; switches: string; mesh: string; key: string }

/** How an analysis runs with some settings: whether the diffuse textures count (reflect) and textures count at all
 *  (live: glass, screens), the element kind, the weather the server's response cache keys on, the job's tool, the run
 *  arguments, the checks (validate(): field id -> message) and the control that gets focus for a field's error. */
export interface RunCfg {
  reflect: boolean; live: boolean; on: 'faces' | 'vertices'; epw?: File | { url: string }; weather: unknown; tool?: 'views';
  ladybug?: boolean; // the core takes faces of 3 or 4 corners only: a receiver with a bigger one is sent as drawn
  argsOf: (receivers: ObjectRow[], shades: ObjectRow[], optics: Optics, elements: number) => { args: string[]; switches: string };
  check: (per: Per[], materialsReady: boolean) => Record<string, string>;
  focus: (field: string) => string;
}

/** Analysis `tool` with settings `s`: daylight (its sky, sun and weather; a big model's reflection samples: lib/args.ts
 *  simFor; its arguments name the receivers that cast no shade), or the view analysis (the core's views: no weather;
 *  glass counts only while rays pass it). */
export function cfgFor(tool: Tool, s: Settings): RunCfg {
  if (tool === 'views') {
    const v = s.viewSim, base = viewArgs(v, s.sim.north);
    return {
      reflect: false, live: v.transmission, on: v.on, weather: null, tool: 'views',
      argsOf: (receivers, shades, o) => ({
        args: [...base, ...opticsArgs(o.meshes, o.fallback, { mode: 'physical', transmission: v.transmission, fresnel: true }), ...noOccludeArgs(receivers, v), ...targetArgs(shades)],
        switches: v.transmission ? 'Rays pass glass' : '',
      }),
      check: (per, ready) => validateViews(v, per.flatMap((p) => p.shades.flatMap((o) => (o.group ? [o.group] : []))), per.some((p) => p.receivers.length > 0), ready),
      focus: (f) => VIEW_FOCUS[f] ?? f,
    };
  }
  const physical = s.sim.mode === 'physical', reflect = physical && s.sim.bounces > 0, epw = epwRef(s), base = buildArgs(s);
  return {
    reflect, live: physical && (s.sim.transmission || reflect), on: s.sim.on, epw, ladybug: !physical,
    weather: epw instanceof File ? [epw.name, epw.size, epw.lastModified] : epw?.url ?? null,
    argsOf: (receivers, _shades, o, elements) => { const sim = simFor(s.sim, elements); return { args: [...base, ...opticsArgs(o.meshes, o.fallback, sim), ...noOccludeArgs(receivers, s.sim)], switches: runSwitches(sim) }; },
    check: (per, ready) => validate(s, per.some((p) => p.receivers.length > 0), ready, Math.max(0, ...per.map((p) => p.elements))),
    focus: (f) => (f === 'weather' ? `weather-${s.weather.source}` : FOCUS[f] ?? f),
  };
}

/** Model `m`'s optics per run mesh (and the textures they wait for), with the analysis' reflections. */
export const opticsFor = (m: Model, texStats: TexStats, reflect: boolean): Optics => resolveOptics(m.objects, viewer(m.slot).materials, texStats[m.slot] ?? NO_STATS, m.optics, reflect);

/** Each model's run inputs with its optics (`optics[i]` of `models[i]`) under `c`. */
export function perOf(models: readonly Model[], optics: readonly Optics[], c: Pick<RunCfg, 'on' | 'argsOf' | 'weather'>): Per[] {
  return models.map((m, i) => {
    const receivers = m.objects.filter((o) => o.role === 'receiver'), shades = m.objects.filter((o) => o.role === 'shade');
    const elements = receivers.reduce((n, o) => n + (c.on === 'faces' ? o.tris : o.verts), 0), { args, switches } = c.argsOf(receivers, shades, optics[i], elements);
    const ids = [receivers.map((o) => o.id), shades.map((o) => o.id)];
    return { m, receivers, shades, elements, args, switches, mesh: JSON.stringify(ids), key: JSON.stringify([args, c.weather, ...ids]) };
  });
}

/** What one job reports to the one who runs it: whether its model is still the one submitted (no result for another),
 *  each status on its way, the row names of the core's mesh names (filled per job, for its error), and the last result
 *  of these rows (its weights are reused when the rows are the same). */
export interface JobHooks { mine: () => boolean; status: (run: Run) => void; names: Map<string, string>; was: RunResult | null }

/** Model `p`'s job: its meshes hashed and uploaded, the run on the server, its rows checked and weighted. Throws
 *  'changed' when its model or roles change on the way (the caller ends it idle). */
export async function jobOf(p: Per, c: Pick<RunCfg, 'on' | 'ladybug' | 'tool' | 'epw'>, conv: ReadonlyMap<string, Conv>, h: JobHooks, signal: AbortSignal): Promise<RunResult> {
  const t0 = performance.now(); // its own round trip, not the models' before it
  // C1: content ids (hashed once per row, 8 at a time), core names by them; the args' row ids become those names (the
  // run key keeps the row ids)
  const rows = [...p.receivers, ...p.shades], n = p.receivers.length, cs = rows.map((o) => conv.get(o.id));
  if (!cs.every(Boolean)) throw new Error('changed');
  // A receiver goes as the file's own faces and points (its topology, read from the viewer once per geometry): a quad is
  // one row, parts that only share a position keep their own vertices. As drawn when it has none, or in Ladybug mode
  // with a face of more than 4 corners (the core takes triangles and quads there).
  const forms = (await Promise.all(cs.slice(0, n).map((cv) => cv!.topology?.() ?? null))).map((t) => (t && !(c.ladybug && t.corners > 4) ? t : null));
  if (!h.mine()) throw new Error('changed');
  const sent: Hashed[] = cs.map((cv, k) => (k < n && forms[k] ? cv!.receiver!(forms[k]) : cv!));
  const { meshes, ids, stems, stamps, hashed } = await jobMeshes(sent, n, signal);
  if (!h.mine()) throw new Error('changed'); // its model or roles changed during a long hash: no job
  const core = new Map(rows.map((o, k) => [o.id, stems[k]]));
  h.names.clear();
  rows.forEach((o, k) => h.names.set(stems[k], o.name)); // a twin's id is its first row's core name
  rows.forEach((o, k) => { if (!h.names.has(ids[k])) h.names.set(ids[k], o.name); });
  let shown = 0; // the upload's progress in the run line, at most 4 times a second
  const onUpload = (d: number, total: number) => {
    if (d && d < total && performance.now() - shown < 250) return;
    shown = performance.now();
    if (h.mine() && !signal.aborted) h.status({ status: 'queued', position: 0, upload: [d, total] });
  };
  const res = await runRemote('', {
    sensors: meshes.slice(0, n), context: meshes.slice(n), onUpload, ...(c.tool ? { tool: c.tool } : {}),
    epw: c.epw, args: p.args.map((a) => a.replace(UUID, (id) => core.get(id) ?? id)), signal, clientId: CLIENT_ID,
    onStatus: (job) => { if (h.mine()) h.status(job.state === 'queued' ? { status: 'queued', position: job.position ?? 0 } : { status: 'running', progress: job.progress, eta_s: job.eta_s }); },
  });
  res.manifest.meshes.forEach((g, i) => {
    const o = p.receivers[i], t = forms[i], want = o && (c.on === 'faces' ? t?.faces ?? o.tris : t?.points ?? o.verts);
    if (!o || g.count !== want) throw new Error(`${o?.name ?? g.name}: the server returned ${g.count} rows, expected ${want}. Reload the model and run again.`);
  });
  if (!h.mine()) throw new Error('changed'); // its model changed during the job: the caller ends it idle, never a new model's result
  // Every element's area, aligned with the rows: the weight of every statistic, chart, tool and export, written once here
  // instead of per mesh on each use; the last result's when its receivers are these rows, unchanged (row ids change with
  // any re-read).
  const was = h.was, keep = was?.on === c.on && was.receivers.length === n && p.receivers.every((o, i) => o.id === was.receivers[i]) && !hashed.some((k) => k < n)
    && forms.every((t, i) => t === (was.forms?.[i] ?? null)); // the same rows: a form's id may be hashed already (Ladybug and back)
  const weights = keep ? was.weights : new Float32Array(res.manifest.meshes.reduce((a, g) => a + g.count, 0));
  if (!keep) res.manifest.meshes.forEach((g, i) => {
    const cv = conv.get(p.receivers[i].id), t = forms[i];
    if (!cv || !same(stamps[i], sent[i].stamp())) throw new Error('changed'); // re-read, or changed since sent: ended idle as above
    const { positions, indices } = t ? cv.receiver!(t).mesh() : cv.make(); // one receiver at a time
    weights.set(t ? rowAreas(faceAreas(positions, indices), t, c.on) : (c.on === 'faces' ? faceAreas : vertexAreas)(positions, indices), g.first);
  });
  return { ...res, weights, forms, receivers: p.receivers.map((o) => o.id), on: c.on, key: p.key, elapsed: (performance.now() - t0) / 1000, switches: p.switches };
}

/** One analysis' inputs: its models (daylight's, or the view analysis' seen as daylight's), its column, whether its tab
 *  shows (Auto runs that one only), and how its runs are made (cfgFor). */
export interface AnalysisCfg extends RunCfg {
  models: Model[]; column: string; visible: boolean; auto: boolean; dispatch: Dispatch<Action>; viz: Settings['viz']; // column: the shown one's name
  conv: RefObject<Map<string, Conv>>; reading: RefObject<boolean>; texStats: TexStats; setTexStats: Dispatch<SetStateAction<TexStats>>;
  tick?: number; // bumped when the set runner puts a result in the session's cache: a model whose inputs it fits shows it
}
export type Analysis = ReturnType<typeof useAnalysis>;

/** One analysis' runs (one batch at a time, the models one after another; Auto for the tab that shows) and its
 *  comparison (the column by name, one colour scale over every model). */
export function useAnalysis(c: AnalysisCfg) {
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
    const value = opticsFor(m, c.texStats, c.reflect);
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
  const per = perOf(models, optics, c);
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
            const own = (jobs.current[slot] = new AbortController()), off = () => own.abort(); // the batch's cancel, or its model removed
            signal.addEventListener('abort', off);
            try {
              const result = await jobOf(p, c, conv.current, { mine, names, was: p.m.result, status: (run) => dispatch({ type: 'RUN', slot, run }) }, own.signal);
              dispatch({ type: 'RUN', slot, run: { status: 'done', result } });
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
    // A result this session already has for a model's inputs now (a set opened, a setup run before): back at once, with
    // or without Auto, and Auto below finds its key started.
    for (const p of per) {
      if (!p.receivers.length || p.m.result?.key === p.key || inFlight(p.m.run)) continue;
      const result = kept.get(p.m.slot, p.key);
      if (!result) continue;
      lastKey.current[p.m.slot] = p.key;
      dispatch({ type: 'RUN', slot: p.m.slot, run: { status: 'done', result } });
    }
    if (autoOn && !busy.current && per.some((p) => p.receivers.length && p.key !== lastKey.current[p.m.slot])) void onRun(true);
  }, [autoOn, keys, ended, models, c.tick]); // eslint-disable-line react-hooks/exhaustive-deps -- onRun is this render's closure: it reads the settings the keys came from
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
  const column = ref ? columnIndex(ref.columns, c.column) : 0, shown = ref?.columns[column] ?? null;
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
