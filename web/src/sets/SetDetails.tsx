// A set's fold-out (the Sets menu, the Combined tab's list): what it keeps, a line each (setSummary), and Copy to model,
// which makes a new set of one of its entries for an open model, the roles and Materials edits by USD path, then opens it.
import { useId, useState } from 'react';
import { LETTERS, MAX_NAME, copyName, setSummary, type AnalysisSet, type SetModel } from './model';

/** An open model with a file: what Copy to model offers. */
export interface OpenModel { slot: number; name: string }
export type OnCopy = (set: AnalysisSet, from: SetModel, slot: number, name: string) => void;

/** `open` and `onToggle`: the fold-out held by the caller (the menu places itself again), else its own. `flat`: no
 *  fold-out, its two parts under headings (inside the Combined tab's own fold-out of the set). */
export function SetDetails({ set, models, saving, open, onToggle, onCopy, flat }: {
  set: AnalysisSet; models: readonly OpenModel[]; saving: boolean; open?: boolean; onToggle?: (open: boolean) => void; onCopy: OnCopy; flat?: boolean;
}) {
  const id = useId(), own = (m: OpenModel) => set.models.some((e) => e.model === LETTERS[m.slot] && e.file === m.name);
  const [from, setFrom] = useState(0), [to, setTo] = useState<number | null>(null), [name, setName] = useState('');
  const target = models.find((m) => m.slot === to) ?? models.find((m) => !own(m)) ?? models[0], entry = set.models[Math.min(from, set.models.length - 1)];
  const placeholder = target ? copyName(set, target.name) : '';
  const body = (
    <>
      {flat && <h4>What it keeps</h4>}
      <div className="table-wrap">
        <table className="data-table data-table--wrap" aria-label={`What ${set.name} keeps`}>
          <tbody>{setSummary(set).map((l) => <tr key={l.label}><th scope="row" className="text-muted">{l.label}</th><td>{l.value}</td></tr>)}</tbody>
        </table>
      </div>
      {flat && <h4>Copy to model</h4>}
      {!entry ? <p className="field__help">No model in this set to copy from.</p> : !target ? <p className="field__help">Open a model to copy this set to.</p> : (
        <form className="stack stack--tight" onSubmit={(e) => { e.preventDefault(); onCopy(set, entry, target.slot, name.trim() || placeholder); setName(''); }}>
          {set.models.length > 1 && (
            <div className="field">
              <label className="field__label" htmlFor={`${id}-from`}>From</label>
              <select className="select" id={`${id}-from`} value={Math.min(from, set.models.length - 1)} onChange={(e) => setFrom(Number(e.target.value))}>
                {set.models.map((e, i) => <option key={`${e.model} ${e.file}`} value={i}>{e.model}: {e.file}</option>)}
              </select>
            </div>
          )}
          <div className="field">
            <label className="field__label" htmlFor={`${id}-to`}>To</label>
            <select className="select" id={`${id}-to`} value={target.slot} onChange={(e) => setTo(Number(e.target.value))}>
              {models.map((m) => <option key={m.slot} value={m.slot}>{LETTERS[m.slot]}: {m.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label className="field__label" htmlFor={`${id}-name`}>Name of the new set</label>
            <input className="input" id={`${id}-name`} value={name} maxLength={MAX_NAME} placeholder={placeholder} onChange={(e) => setName(e.target.value)} />
            <span className="field__help">A new set for that model alone: the roles and Materials edits whose USD paths it has, every other mesh without a role. It opens at once, to edit and update.</span>
          </div>
          <div className="cluster cluster--end">
            <button className="btn btn--secondary" type="submit" disabled={saving}>Copy as new set</button>
          </div>
        </form>
      )}
    </>
  );
  if (flat) return <div className="stack stack--tight">{body}</div>;
  return (
    <details className="accordion" open={open} onToggle={(e) => onToggle?.(e.currentTarget.open)}>
      <summary>Settings, Copy to model</summary>
      <div className="accordion__body stack stack--tight">{body}</div>
    </details>
  );
}
