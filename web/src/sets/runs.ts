// The background set runner: a saved set run without opening it. Per open model that finds an entry in the set, the model
// as it would be with the set's roles (the store's own APPLY_SET on the app now, so its key is the one an opened set
// gets) and the settings it runs with; its optics resolved (missing textures read one at a time, as the live tabs read
// them), checked, and its key looked up in the session's result cache (kept.ts) or run (analysis.ts jobOf): one job at a
// time, and only while neither live analysis has a batch in flight (the server allows 2 jobs per client). Each result
// goes into the cache, where an opened set, the Combined tab and the agent find it.
import { useCallback, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { CORE, NO_STATS, cfgFor, jobOf, opticsFor, perOf, type Conv, type Optics, type Per, type RunCfg, type TexStats } from '../analysis';
import { readKey } from '../lib/optics';
import { inFlight, reducer, runBatch, swapState, type Model, type Run, type RunResult, type Settings, type State } from '../store';
import { readTexture, viewer } from '../viewer/usd';
import { kept } from './kept';
import { LETTERS, entryFor, needsLevel, type AnalysisSet } from './model';

/** Set `set` on the app `state` now: the open models that find an entry, each as it would be with the set's roles (its
 *  tab's slice seen as daylight's), the settings and how they run. */
export function setup(state: State, set: AnalysisSet): { models: Model[]; settings: Settings; cfg: RunCfg } {
  const applied = reducer(state, { type: 'APPLY_SET', set }), view = set.tool === 'views' ? swapState(applied) : applied;
  return { models: view.models.filter((m) => entryFor(m, set.models, view.models)), settings: applied.settings, cfg: cfgFor(set.tool, applied.settings) };
}
/** Set `set`'s run inputs per model (`optics`: a model's, with the analysis' reflections). */
export function setPer(state: State, set: AnalysisSet, optics: (m: Model, reflect: boolean) => Optics): Per[] {
  const { models, cfg } = setup(state, set);
  return perOf(models, models.map((m) => optics(m, cfg.reflect)), cfg);
}

/** A set's result for one open model: none (no entry of its own), no receiver, subdiv (it runs at another subdivision
 *  `level`: open it), missing (not run with these inputs this session), queued or running (the runner's), done
 *  (`result`, `key`) or error (`message`). */
export interface SetModelStatus {
  slot: number; model: string; state: 'none' | 'no-receiver' | 'subdiv' | 'missing' | 'queued' | 'running' | 'done' | 'error';
  progress?: number; message?: string; result?: RunResult; key?: string; level?: number;
}
type Runs = Readonly<Record<string, Readonly<Record<number, Run>>>>;

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((done, fail) => {
  if (signal.aborted) { fail(new Error('cancelled')); return; }
  const t = setTimeout(() => { signal.removeEventListener('abort', stop); done(); }, ms), stop = () => { clearTimeout(t); fail(new Error('cancelled')); };
  signal.addEventListener('abort', stop, { once: true });
});

export interface SetRunsCfg {
  state: State; conv: RefObject<Map<string, Conv>>; reading: RefObject<boolean>; texStats: TexStats; setTexStats: Dispatch<SetStateAction<TexStats>>;
  idle: () => boolean; // neither live analysis has a batch in flight
  subdiv: number; // the app's subdivision level
}

/** The runner: each set's status per model, Run (queued behind the sets before it) and Cancel (every set queued). */
export function useSetRuns(c: SetRunsCfg) {
  const latest = useRef(c);
  latest.current = c;
  const tex = useRef(c.texStats); // the textures read: the render's, advanced at once by the runner's own reads
  tex.current = c.texStats;
  const [runs, setRuns] = useState<Runs>({}); // per set id and slot: queued, running or failed (done: in the cache)
  const [tick, setTick] = useState(0); // bumped per result put in the cache
  const [queued, setQueued] = useState(0); // sets queued or running
  const chain = useRef<Promise<void>>(Promise.resolve()), abort = useRef<AbortController | null>(null), gen = useRef(0);
  const putRun = (id: string, slot: number, run: Run | null) => setRuns((all) => {
    const { [slot]: _was, ...rest } = all[id] ?? {};
    return { ...all, [id]: run ? { ...rest, [slot]: run } : rest };
  });

  // Per set, its status as of the inputs it was worked out from (O(rows) per model: never per hover)
  const memo = useRef(new Map<string, { inputs: unknown[]; value: SetModelStatus[] }>());
  const statusOf = (set: AnalysisSet): SetModelStatus[] => {
    const { state, subdiv } = latest.current, inputs = [set, state.models, state.settings, tex.current, runs[set.id], tick, subdiv], had = memo.current.get(set.id);
    if (had && had.inputs.every((x, i) => x === inputs[i])) return had.value;
    const per = setPer(state, set, (m, reflect) => opticsFor(m, tex.current, reflect)), level = needsLevel(set, subdiv);
    const value = state.models.filter((m) => m.name).map((m): SetModelStatus => {
      const p = per.find((x) => x.m.slot === m.slot), run = runs[set.id]?.[m.slot], base = { slot: m.slot, model: LETTERS[m.slot] };
      if (!p) return { ...base, state: 'none' };
      if (!p.receivers.length) return { ...base, state: 'no-receiver' };
      if (level !== null) return { ...base, state: 'subdiv', level };
      const result = kept.peek(m.slot, p.key) ?? (p.m.result?.key === p.key ? p.m.result : undefined);
      if (run && inFlight(run)) return { ...base, state: run.status === 'queued' ? 'queued' : 'running', ...(run.status === 'running' && run.progress !== undefined ? { progress: run.progress } : {}), key: p.key };
      if (result) return { ...base, state: 'done', result, key: p.key };
      return run?.status === 'error' ? { ...base, state: 'error', message: run.message, key: p.key } : { ...base, state: 'missing', key: p.key };
    });
    memo.current.set(set.id, { inputs, value });
    return value;
  };

  // A model's optics with every texture they need read (one at a time, with the live tabs': `reading`)
  const opticsReady = async (m: Model, cfg: RunCfg, signal: AbortSignal): Promise<Optics> => {
    for (let k = 0; k < 256; k++) {
      const o = opticsFor(m, tex.current, cfg.reflect), r = o.unread[0];
      if (!cfg.live || !r) return o;
      const { reading, setTexStats } = latest.current;
      if (reading.current) { await sleep(100, signal); continue; }
      reading.current = true;
      const t = await readTexture(viewer(m.slot).el, r).finally(() => { reading.current = false; });
      const add = (all: TexStats) => ({ ...all, [m.slot]: new Map(all[m.slot] ?? NO_STATS).set(readKey(r), t) });
      tex.current = add(tex.current);
      setTexStats(add);
    }
    throw new Error('the materials could not be read; open the set to see which');
  };

  const runSet = async (set: AnalysisSet, slots?: readonly number[]) => {
    const ctrl = new AbortController(), names = new Map<string, string>(); // a mesh's core name -> its row's name, per job
    abort.current = ctrl;
    const todo = setup(latest.current.state, set).models.filter((m) => !slots || slots.includes(m.slot)).map((m) => m.slot);
    await runBatch(todo.map((slot) => ({
      slot, ready: () => true,
      run: async (signal: AbortSignal) => {
        while (!latest.current.idle()) await sleep(250, signal); // a live batch first: one job of ours at a time beside it
        const { models, cfg } = setup(latest.current.state, set), m = models.find((x) => x.slot === slot); // the model now
        if (!m) throw new Error('changed');
        const [p] = perOf([m], [await opticsReady(m, cfg, signal)], cfg);
        if (!p.receivers.length) { putRun(set.id, slot, null); return; }
        const problem = Object.values(cfg.check([p], true))[0];
        if (problem) throw new Error(problem);
        const hit = kept.get(slot, p.key) ?? (m.result?.key === p.key ? m.result : undefined);
        if (!hit) {
          const mine = () => [...p.receivers, ...p.shades].every((o) => latest.current.conv.current.has(o.id)); // not re-read or removed
          kept.put(slot, await jobOf(p, cfg, latest.current.conv.current, { mine, names, was: m.result, status: (run) => putRun(set.id, slot, run) }, signal));
        } else kept.put(slot, hit);
        putRun(set.id, slot, null);
        setTick((k) => k + 1);
      },
    })), ctrl.signal, (slot, end) => {
      const idle = end === 'idle' || end.message === 'changed' || end.message === 'cancelled';
      putRun(set.id, slot, idle ? null : { status: 'error', message: end.message.replace(CORE, (t) => names.get(t) ?? t) });
    });
  };

  /** Set `set` run for its models (`slots`: these only) after the sets queued before it; resolves when it has run (at
   *  once for a set of another subdivision level: nothing runs). */
  const run = useCallback((set: AnalysisSet, slots?: readonly number[]): Promise<void> => {
    if (needsLevel(set, latest.current.subdiv) !== null) return Promise.resolve();
    const g = gen.current;
    for (const m of setup(latest.current.state, set).models) if (!slots || slots.includes(m.slot)) putRun(set.id, m.slot, { status: 'queued', position: 0 });
    setQueued((n) => n + 1);
    const next = chain.current.then(() => (g === gen.current ? runSet(set, slots) : undefined)).finally(() => {
      if (g !== gen.current) setRuns(({ [set.id]: _gone, ...rest }) => rest); // cancelled before its turn
      setQueued((n) => n - 1);
    });
    chain.current = next.catch(() => {});
    return next;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- runSet reads refs only
  const cancel = useCallback(() => { gen.current++; abort.current?.abort(); }, []);
  return { statusOf, run, cancel, busy: queued > 0, tick };
}
export type SetRuns = ReturnType<typeof useSetRuns>;
