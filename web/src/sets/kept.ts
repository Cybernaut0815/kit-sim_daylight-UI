// The session's finished results by model slot and run key: a set opened again, or any setup run earlier in this session,
// shows its result at once (analysis.ts restores it). Every finished run is put here, live (App's dispatch passes each
// action to observe: RUN done) or background (sets/runs.ts); a model's entries go when it is opened, re-read or removed
// (its row ids, part of every key, are new then); above the byte budget the least recently used go first. A page reload
// empties it: the setup runs again and the server's response cache answers.
import type { Action, RunResult } from '../store';

export const KEPT_BYTES = 512 * 2 ** 20;
/** A result's values in bytes: its columns and its weights (shared weights count once per result: an upper bound). */
export const bytesOf = (r: RunResult): number => r.data.reduce((n, d) => n + d.byteLength, r.weights.byteLength);

export interface Kept {
  get: (slot: number, key: string) => RunResult | undefined;
  /** As get, without counting as a use (a status shown is not a use). */
  peek: (slot: number, key: string) => RunResult | undefined;
  put: (slot: number, result: RunResult) => void;
  purge: (slot: number) => void;
  /** An action on its way to the store: RUN done puts its result, LOAD, RELOAD and REMOVE purge their slot. */
  observe: (action: Action) => void;
  bytes: () => number;
  size: () => number;
}

export function keptCache(limit = KEPT_BYTES): Kept {
  console.assert(limit > 0, 'kept: the byte budget must be positive');
  const entries = new Map<string, { slot: number; result: RunResult; bytes: number }>(); // insertion order = last use
  let total = 0;
  const idOf = (slot: number, key: string) => `${slot}\n${key}`;
  const drop = (id: string) => {
    const e = entries.get(id);
    if (e) { total -= e.bytes; entries.delete(id); }
  };
  const get = (slot: number, key: string) => {
    const id = idOf(slot, key), e = entries.get(id);
    if (!e) return undefined;
    entries.delete(id); // a hit is the newest again
    entries.set(id, e);
    return e.result;
  };
  const put = (slot: number, result: RunResult) => {
    const id = idOf(slot, result.key), bytes = bytesOf(result);
    drop(id);
    if (bytes > limit) return; // bigger than the whole budget: never kept
    entries.set(id, { slot, result, bytes });
    total += bytes;
    for (const old of entries.keys()) { if (total <= limit) break; drop(old); }
  };
  const purge = (slot: number) => { for (const [id, e] of entries) if (e.slot === slot) drop(id); };
  const observe = (a: Action) => {
    if (a.type === 'LOAD' || a.type === 'RELOAD' || a.type === 'REMOVE') purge(a.slot);
    else if (a.type === 'RUN' && a.run.status === 'done') put(a.slot, a.run.result);
  };
  return { get, peek: (slot, key) => entries.get(idOf(slot, key))?.result, put, purge, observe, bytes: () => total, size: () => entries.size };
}

/** The app's one cache. */
export const kept = keptCache();
