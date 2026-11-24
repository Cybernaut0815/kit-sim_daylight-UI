// The saved sets and combined views as the app holds them: fetched on load, on a tab switch, when the Sets menu opens and
// after each own write (a write's failure is kept for the menu that made it).
import { useCallback, useEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import type { Saved } from './model';
import { deleteSet, listSets, putSet } from './server';

export function useSaved() {
  const [saved, setSaved] = useState<Saved[]>([]);
  const [error, setError] = useState<string | null>(null), [saving, setSaving] = useState(false);
  /** The list fetched again; committed when this resolves (a tool reads it right after). Unreachable: kept as it is. */
  const refresh = useCallback(async () => {
    const list = await listSets().catch(() => null);
    if (list) flushSync(() => setSaved(list));
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  const write = useCallback(async (f: () => Promise<void>): Promise<boolean> => {
    setSaving(true);
    setError(null);
    try {
      await f();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setSaving(false);
      await refresh();
    }
  }, [refresh]);
  const put = useCallback((x: Saved) => write(() => putSet(x)), [write]);
  const remove = useCallback((id: string) => write(() => deleteSet(id)), [write]);
  return { saved, error, setError, saving, refresh, put, remove };
}
export type SavedSets = ReturnType<typeof useSaved>;
