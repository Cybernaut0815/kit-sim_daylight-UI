// The Combined tab's saved sets: the Daylight or View analysis setup now saved as a new set, then every set under its
// tab, each a fold-out: its name, whether it is open on its tab and, per open model, whether a result of it is at hand
// (the session's cache, sets/runs.ts statusOf). Open shows it on its own tab; Run runs it for the models that miss it;
// Update replaces what it keeps with that tab's setup now; Rename keeps its id (combined views follow); Delete removes
// it from the server, after asking; below, what it keeps and Copy to model.
import { memo, useId, useState } from 'react';
import { MAX_NAME, SETUP_WORDS, levelText, nextName, renameSet, type AnalysisSet } from '../sets/model';
import type { SetModelStatus } from '../sets/runs';
import { SetDetails, type OnCopy, type OpenModel } from '../sets/SetDetails';
import type { Tool } from '../store';
import { Alert, LETTERS, Section, Segmented } from '../ui';

interface Props {
  sets: readonly AnalysisSet[]; statusOf: (set: AnalysisSet) => SetModelStatus[]; error: string | null; saving: boolean; models: readonly OpenModel[];
  open: Partial<Record<Tool, string | null>>; onOpen: (set: AnalysisSet) => void; onRun: (set: AnalysisSet) => void; onDelete: (set: AnalysisSet) => void; onCopy: OnCopy;
  onSave: (tool: Tool, name: string) => void; onUpdate: (set: AnalysisSet) => void; onRename: (set: AnalysisSet, name: string) => Promise<boolean>;
}
type RowProps = Omit<Props, 'sets' | 'statusOf' | 'error' | 'open' | 'onSave'> & { set: AnalysisSet; status: SetModelStatus[]; isOpen: boolean };

const TAB: Record<Tool, string> = { daylight: 'Daylight', views: 'View analysis' };
const TOOLS = [['daylight', 'Daylight'], ['views', 'View analysis']] as const;
// a model's state as a badge: its letter and the state in words beside the dot
const BADGE: Record<SetModelStatus['state'], [string, string]> = {
  done: ['badge--success', 'result'], running: ['badge--info', 'running'], queued: ['badge--neutral', 'queued'], missing: ['badge--neutral', 'not run'],
  error: ['badge--error', 'failed'], none: ['badge--neutral', 'no entry'], 'no-receiver': ['badge--warning', 'no receiver'], subdiv: ['badge--warning', 'open to run'],
};
const badgeTitle = (x: SetModelStatus) => (x.level !== undefined ? `It runs at subdivision ${levelText(x.level)}: Open re-reads the models at that level, then it runs` : x.message);
const badgeText = (x: SetModelStatus) => `${LETTERS[x.slot]} ${x.state === 'running' && x.progress !== undefined ? `${Math.round(100 * x.progress)} %` : BADGE[x.state][1]}`;

/** One set: its name and badges folded; its actions (or the rename field), what it keeps and Copy to model unfolded. */
function SetRow({ set, status, isOpen, saving, models, onOpen, onRun, onDelete, onCopy, onUpdate, onRename }: RowProps) {
  const id = useId(), [renaming, setRenaming] = useState<string | null>(null), [problem, setProblem] = useState<string | null>(null);
  const runnable = status.some((x) => x.state === 'missing' || x.state === 'error');
  const cancel = () => { setRenaming(null); setProblem(null); };
  const rename = async (name: string) => {
    try { renameSet(set, name); } catch { setProblem(`A name of 1 to ${MAX_NAME} characters: type one, or Cancel`); return; }
    if (await onRename(set, name)) cancel();
  };
  return (
    <details className="accordion">
      <summary>
        <span className="cluster sets__summary">
          <strong className="line">{set.name}</strong>
          {isOpen && <span className="badge badge--info" title={`Open on the ${TAB[set.tool]} tab`}><span className="dot" aria-hidden="true" />open</span>}
          {status.map((x) => <span key={x.slot} className={`badge ${BADGE[x.state][0]}`} title={badgeTitle(x)}><span className="dot" aria-hidden="true" />{badgeText(x)}</span>)}
        </span>
      </summary>
      <div className="accordion__body stack stack--tight">
        {renaming === null ? (
          <div className="cluster" data-density="compact">
            <button className="btn btn--secondary" type="button" onClick={() => onOpen(set)}>Open</button>
            <button className="btn btn--ghost" type="button" disabled={!runnable} title={runnable ? 'Run it for the models without a result' : 'Every model has its result, or no entry'} onClick={() => onRun(set)}>Run</button>
            <button className="btn btn--ghost" type="button" disabled={saving || !models.length} title={models.length ? `Replace what it keeps with the ${TAB[set.tool]} setup now` : "Open a model first: a set keeps each open model's roles"} onClick={() => { if (confirm(`Replace what "${set.name}" keeps with the current ${TAB[set.tool]} setup? Its name and id stay, so combined views that use it follow.`)) onUpdate(set); }}>Update from the current setup</button>
            <button className="btn btn--ghost" type="button" disabled={saving} onClick={() => setRenaming(set.name)}>Rename</button>
            <button className="btn btn--danger" type="button" disabled={saving} onClick={() => { if (confirm(`Delete the set "${set.name}"? Combined views that use it miss it until a set of that id is saved again. This cannot be undone.`)) onDelete(set); }}>Delete</button>
          </div>
        ) : (
          <form className="stack stack--tight" aria-label={`Rename ${set.name}`} onSubmit={(e) => { e.preventDefault(); void rename(renaming); }}>
            <div className="field">
              <label className="field__label" htmlFor={`${id}-rename`}>New name</label>
              <input
                className="input" id={`${id}-rename`} value={renaming} maxLength={MAX_NAME} autoFocus aria-invalid={problem ? true : undefined} aria-describedby={problem ? `${id}-problem` : `${id}-keeps`}
                onChange={(e) => { setRenaming(e.target.value); setProblem(null); }} onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); cancel(); } }}
              />
              {problem ? <span className="field__error" id={`${id}-problem`}>{problem}</span> : <span className="field__help" id={`${id}-keeps`}>Its id stays: combined views that use it keep it.</span>}
            </div>
            <div className="cluster cluster--end">
              <button className="btn btn--ghost" type="button" onClick={cancel}>Cancel</button>
              <button className="btn btn--secondary" type="submit" disabled={saving}>Save name</button>
            </div>
          </form>
        )}
        <SetDetails set={set} models={models} saving={saving} onCopy={onCopy} flat />
      </div>
    </details>
  );
}

export const SetsPanel = memo(function SetsPanel({ sets, statusOf, error, saving, models, open, onSave, ...row }: Props) {
  const [tool, setTool] = useState<Tool>('daylight'), [name, setName] = useState('');
  const placeholder = nextName(sets.filter((s) => s.tool === tool));
  return (
    <Section id="sets" title="Analysis sets" busy={saving}>
      {error && <Alert title="Sets">{error}</Alert>}
      <form className="stack stack--tight" aria-labelledby="sets-save" onSubmit={(e) => { e.preventDefault(); onSave(tool, name.trim() || placeholder); setName(''); }}>
        <h3 id="sets-save">Save the current setup</h3>
        <Segmented name="sets-save-tool" label="The setup of" value={tool} options={TOOLS} onChange={setTool} />
        <div className="field">
          <label className="field__label" htmlFor="sets-save-name">Name of the new set</label>
          <input className="input" id="sets-save-name" value={name} maxLength={MAX_NAME} placeholder={placeholder} aria-describedby="sets-save-help" onChange={(e) => setName(e.target.value)} />
          <span className="field__help" id="sets-save-help">{`The ${TAB[tool]} tab's setup as it is now: ${SETUP_WORDS[tool]}.`}</span>
        </div>
        <div className="cluster cluster--end">
          <button className="btn btn--secondary" type="submit" disabled={saving || !models.length} title={models.length ? undefined : "Open a model first: a set keeps each open model's roles"}>Save as new set</button>
        </div>
      </form>
      <hr className="divider" />
      {TOOLS.map(([t, label]) => {
        const list = sets.filter((s) => s.tool === t).sort((a, b) => b.updated.localeCompare(a.updated));
        return (
          <div key={t} className="stack stack--tight">
            <h3>{`${label} sets (${list.length})`}</h3>
            {list.length
              ? list.map((set) => <SetRow key={set.id} set={set} status={statusOf(set)} isOpen={open[t] === set.id} saving={saving} models={models} {...row} />)
              : <p className="field__help">{`None yet: save the ${label} setup above, or on the ${label} tab with Sets → Save as new set.`}</p>}
          </div>
        );
      })}
    </Section>
  );
});
