// The run bar's Sets menu on the Daylight and View analysis tabs, in two parts. Open a saved set: the tab's sets (one
// click opens one: each entry's roles and Materials edits on its own model, the settings, the result shown and its
// colours), the open one badged, each with its fold-out (what it keeps, Copy to model); what the last open or save did
// shows under the list. Save the current setup: Update the open set with it, or save it as a new set by name.
import { useEffect, useState } from 'react';
import type { Tool } from '../store';
import { Alert, MenuButton } from '../ui';
import { MAX_NAME, SETUP_WORDS, nextName, type AnalysisSet } from './model';
import { SetDetails, type OnCopy, type OpenModel } from './SetDetails';

const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

/** `sets`: the tab's; `open`: the one open on it; `note`: the last open's or save's lines; `models`: the open models with
 *  a file (Copy to model); `onShow`: on every open of the menu (the list is fetched again). */
export function SetsMenu({ tool, sets, open, note, error, saving, models, onShow, onOpen, onSave, onUpdate, onCopy }: {
  tool: Tool; sets: readonly AnalysisSet[]; open: AnalysisSet | null; note: readonly string[] | null; error: string | null; saving: boolean; models: readonly OpenModel[];
  onShow: () => void; onOpen: (set: AnalysisSet) => void; onSave: (name: string) => void; onUpdate: (set: AnalysisSet) => void; onCopy: OnCopy;
}) {
  const [name, setName] = useState(''), [unfolded, setUnfolded] = useState<string | null>(null); // one fold-out at a time, held here: the menu places itself again
  useEffect(() => { // the popover's own toggle: MenuButton keeps its element
    const m = document.getElementById('sets-menu'), on = (e: Event) => { if ((e as ToggleEvent).newState === 'open') onShow(); };
    m?.addEventListener('toggle', on);
    return () => m?.removeEventListener('toggle', on);
  }, [onShow]);
  const list = [...sets].sort((a, b) => b.updated.localeCompare(a.updated)), placeholder = nextName(sets), what = tool === 'views' ? 'view analysis' : 'daylight';
  return (
    <MenuButton id="sets-menu" label="Sets" busy={saving} title={`Analysis sets: the ${what} setup (each open model's roles and Materials edits, the ${what} settings, the result shown and its colours) saved under a name, for every browser and the agent; open one to apply it, copy one to another model, or save the current setup`}>
      {() => (
        <>
          <div className="menu__section">Open a saved set</div>
          {list.length
            ? list.map((x) => (
              <div key={x.id}>
                <button className="menu__item" type="button" title={`Open: each entry's roles and Materials edits on its own model (${x.models.map((m) => `${m.model} ${m.file}`).join(', ')}), its settings and its result shown. Saved ${when(x.updated)}`} onClick={() => onOpen(x)}>
                  <span>{x.name}</span>
                  {open?.id === x.id && <span className="badge badge--info"><span className="dot" aria-hidden="true" />open</span>}
                </button>
                <SetDetails set={x} models={models} saving={saving} open={unfolded === x.id} onToggle={(o) => setUnfolded((u) => (o ? x.id : u === x.id ? null : u))} onCopy={onCopy} />
              </div>
            ))
            : <p className="views__note text-muted">{`No ${what} set yet: save the current setup below`}</p>}
          {note && <div className="views__note text-muted" role="status">{note.map((l) => <p key={l}>{l}</p>)}</div>}
          {error && <Alert title="Sets">{error}</Alert>}
          <div className="menu__separator" />
          <div className="menu__section">Save the current setup</div>
          {open && (
            <>
              <button className="menu__item" type="button" disabled={saving} title={`'${open.name}' takes the current ${what} setup`} onClick={() => onUpdate(open)}><span>Update '{open.name}' with the current setup</span></button>
              <p className="views__note text-muted">Replaces what it keeps; its name and id stay.</p>
            </>
          )}
          <p className="views__note text-muted">{`A set keeps ${SETUP_WORDS[tool]}.`}</p>
          <form className="menu__footer views__save sets__save" onSubmit={(e) => { e.preventDefault(); onSave(name.trim() || placeholder); setName(''); }}>
            <label className="field__label" htmlFor="set-name">New set</label>
            <input className="input" id="set-name" value={name} maxLength={MAX_NAME} placeholder={placeholder} onChange={(e) => setName(e.target.value)} />
            <button className="btn btn--primary" type="submit" disabled={saving}>Save as new set</button>
          </form>
        </>
      )}
    </MenuButton>
  );
}
