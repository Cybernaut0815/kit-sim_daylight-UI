// One input of the combined-view editor (CombinedPanel), a fold-out: folded, the input in one line (sets/model.ts
// inputText); unfolded, its set and that set's result, its function with only the bounds the function reads
// (sets/combine.ts BOUNDS; empty: from the values), its weight, the meshes it covers, and Remove.
import { useId } from 'react';
import { columnLabel } from '../lib/result';
import { BOUNDS } from '../sets/combine';
import { FNS, FN_LABEL, inputText, type AnalysisSet, type CombinedInput as Input, type Fn } from '../sets/model';
import { Icon, NumberField, knob } from '../ui';

/** An input as the editor holds it: its meshes as typed, a key of its own, and whether it starts unfolded. */
export type DraftInput = Omit<Input, 'meshes'> & { meshes: string; uid: number; unfolded: boolean };

/** `columns`: the results its set gives (CombinedPanel columnsOf); `removable`: not the view's only input. */
export function CombinedInput({ input: i, k, sets, columns, removable, onChange, onRemove }: {
  input: DraftInput; k: number; sets: readonly AnalysisSet[]; columns: readonly string[]; removable: boolean;
  onChange: (patch: Partial<DraftInput>) => void; onRemove: () => void;
}) {
  const id = useId(), set = sets.find((s) => s.id === i.set), bounds = BOUNDS[i.fn];
  return (
    <details className="accordion" open={i.unfolded}>
      <summary><span className="line sets__summary">{inputText(i, k, sets)}</span></summary>
      <div className="accordion__body stack stack--tight">
        <div className="grid" style={knob('--grid-min', '9rem')}>
          <div className="field">
            <label className="field__label" htmlFor={`${id}-set`}>Set</label>
            <select className="select" id={`${id}-set`} value={i.set} onChange={(e) => { const s = sets.find((x) => x.id === e.target.value); onChange({ set: e.target.value, column: s?.column ?? '' }); }}>
              {!set && <option value={i.set}>{`${i.set || 'Pick a set'} (not saved)`}</option>}
              {sets.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label className="field__label" htmlFor={`${id}-column`}>Result</label>
            <select className="select" id={`${id}-column`} value={i.column} onChange={(e) => onChange({ column: e.target.value })}>
              {[...new Set([i.column, ...columns])].filter(Boolean).map((c) => <option key={c} value={c}>{columnLabel(c)}</option>)}
            </select>
          </div>
        </div>
        <div className="field">
          <label className="field__label" htmlFor={`${id}-fn`}>Function</label>
          <select className="select" id={`${id}-fn`} value={i.fn} onChange={(e) => onChange({ fn: e.target.value as Fn })}>
            {FNS.map((f) => <option key={f} value={f}>{FN_LABEL[f]}</option>)}
          </select>
        </div>
        <div className="grid" style={knob('--grid-min', '6rem')}>
          {bounds.map(([b, label]) => (
            <NumberField key={b} id={`${id}-${b}`} label={label} value={i[b] ?? NaN} placeholder="auto" onCommit={(x) => { const v = Number.isFinite(x) ? x : undefined; onChange(b === 'lo' ? { lo: v } : { hi: v }); }} />
          ))}
          <NumberField id={`${id}-weight`} label="Weight" value={i.weight} min={0} step={0.1} onCommit={(x) => onChange({ weight: Number.isFinite(x) ? x : 1 })} />
        </div>
        {bounds.length > 0 && <span className="field__help">{`Empty: auto, ${i.fn === 'threshold' ? "the middle of the values' range" : "the values' range"} over every model.`}</span>}
        <div className="field">
          <label className="field__label" htmlFor={`${id}-meshes`}>Meshes</label>
          <input className="input" id={`${id}-meshes`} value={i.meshes} placeholder="every receiver" aria-describedby={`${id}-meshes-help`} onChange={(e) => onChange({ meshes: e.target.value })} />
          <span className="field__help" id={`${id}-meshes-help`}>Prim paths, comma separated; empty: every receiver of the set.</span>
        </div>
        <div className="cluster cluster--end">
          <button className="btn btn--ghost" type="button" disabled={!removable} title={removable ? undefined : 'A combined view needs one input at least'} onClick={onRemove}><Icon name="close" />Remove input</button>
        </div>
      </div>
    </details>
  );
}
