// The Combined tab's views: the saved combined views (Show one on the models, Edit, Delete) and the editor of one: its
// name, unit and op, and its inputs, each a fold-out (CombinedInput): a set's result column through a function (lo, hi:
// its bounds, only those the function reads; empty: from the results), weighed, on some meshes (empty: every receiver of
// that set). Under the list, what each model misses of the view shown and the meshes it skipped. Saved through
// sets/model.ts checkView, the agent's save_combined check. The draft shows in the views as it is edited (`onPreview`,
// checked the same way); Cancel, or leaving the tab, goes back to the view shown before.
import { Fragment, memo, useEffect, useRef, useState } from 'react';
import { BOUNDS } from '../sets/combine';
import { MAX_INPUTS, OPS, OP_LABEL, checkView, type AnalysisSet, type CombinedView, type Op } from '../sets/model';
import type { SetModelStatus } from '../sets/runs';
import { Alert, Icon, Section, knob } from '../ui';
import { CombinedInput, type DraftInput } from './CombinedInput';

interface Props {
  views: readonly CombinedView[]; sets: readonly AnalysisSet[]; shown: CombinedView | null; notes: readonly string[]; error: string | null; saving: boolean;
  statusOf: (set: AnalysisSet) => SetModelStatus[]; onShow: (view: CombinedView) => void; onSave: (view: CombinedView) => Promise<boolean>; onDelete: (view: CombinedView) => void;
  onPreview: (view: CombinedView | null) => void;
}
export interface Draft { was?: CombinedView; name: string; unit: string; op: Op; inputs: DraftInput[] }

/** The columns a set gives: daylight's quantities on its sides before a run, then every column a result of it has. */
const columnsOf = (set: AnalysisSet, status: readonly SetModelStatus[]) => {
  const st = set.settings, sides = 'sim' in st ? (st.sim.sides === 'both' ? ['front', 'back'] : [st.sim.sides]) : [];
  const own = 'sim' in st ? st.sim.quantities.flatMap((q) => sides.map((side) => `${q}_${side}`)) : [];
  return [...new Set([set.column, ...own, ...status.flatMap((x) => x.result?.columns ?? [])])].filter(Boolean);
};
let uids = 0; // each draft input's key: a removal never hands one input's fold-out to the next
// a saved view's inputs start folded (their lines show the view at a glance); a new view's and an added one unfolded
export const draftOf = (v: CombinedView): Draft => ({ was: v, name: v.name, unit: v.unit, op: v.op, inputs: v.inputs.map((i) => ({ ...i, meshes: i.meshes?.join(', ') ?? '', uid: ++uids, unfolded: false })) });
const inputOf = (set: AnalysisSet | undefined): DraftInput => ({ set: set?.id ?? '', column: set?.column ?? '', weight: 1, fn: 'raw', meshes: '', uid: ++uids, unfolded: true });
/** The draft as checkView takes it: the meshes as paths, only the bounds its function reads. */
const viewOf = (d: Draft) => ({
  name: d.name, unit: d.unit, op: d.op, ...(d.was?.look ? { look: d.was.look } : {}),
  inputs: d.inputs.map(({ meshes, lo, hi, uid: _uid, unfolded: _unfolded, ...i }) => {
    const reads = BOUNDS[i.fn].map(([b]) => b);
    return {
      ...i, ...(reads.includes('lo') && Number.isFinite(lo) ? { lo } : {}), ...(reads.includes('hi') && Number.isFinite(hi) ? { hi } : {}),
      ...(meshes.trim() ? { meshes: meshes.split(',').map((p) => p.trim()).filter(Boolean) } : {}),
    };
  }),
});
/** Draft `d` as the views show it while it is edited: the view it would save, under the id of the view it edits ('draft'
 *  for a new one, the same through every edit), or what is wrong with it. */
export const previewOf = (d: Draft, sets: readonly AnalysisSet[]): CombinedView | string[] => checkView({ ...viewOf(d), id: d.was?.id ?? 'draft' }, sets, d.was);

export const CombinedPanel = memo(function CombinedPanel({ views, sets, shown, notes, error, saving, statusOf, onShow, onSave, onDelete, onPreview }: Props) {
  const [draft, setDraft] = useState<Draft | null>(null), [problems, setProblems] = useState<string[]>([]);
  // why the draft is not in the views (null: it is); whether a version of this edit is; the draft and sets checked last
  const [why, setWhy] = useState<string | null>(null), previewed = useRef(false), sent = useRef<[Draft, readonly AnalysisSet[]] | null>(null);
  const show = (d: Draft) => {
    const p = previewOf(d, sets);
    sent.current = [d, sets];
    if (Array.isArray(p)) { setWhy(`${previewed.current ? 'The views keep the last valid version' : 'Not in the views yet'}: ${p[0]}`); return; }
    setWhy(null); previewed.current = true; onPreview(p);
  };
  // an edit shows at once; typing shows once it rests (each keystroke would recombine); no draft: the view before
  useEffect(() => {
    if (!draft) { sent.current = null; setWhy(null); onPreview(null); return; }
    if (sent.current?.[0] === draft && sent.current[1] === sets) return;
    const t = setTimeout(() => show(draft), 250);
    return () => clearTimeout(t);
  }, [draft, sets]); // eslint-disable-line react-hooks/exhaustive-deps -- onPreview is stable
  useEffect(() => () => onPreview(null), []); // eslint-disable-line react-hooks/exhaustive-deps -- leaving the tab cancels
  const edit = (d: Draft | null) => { setDraft(d); setProblems([]); previewed.current = false; if (d) show(d); };
  const setInput = (k: number, patch: Partial<DraftInput>) => setDraft((d) => d && { ...d, inputs: d.inputs.map((i, j) => (j === k ? { ...i, ...patch } : i)) });
  const save = async () => {
    if (!draft) return;
    const v = checkView(viewOf(draft), sets, draft.was);
    if (Array.isArray(v)) { setProblems(v); return; }
    if (await onSave(v)) edit(null);
  };
  return (
    <Section id="combined" title="Combined views" busy={saving}>
      {error && <Alert title="Combined views">{error}</Alert>}
      {!views.length && !draft && <p className="field__help">A combined view weighs saved sets' results into one value per element: such as sun on the facade with the view out, each normalised.</p>}
      {views.map((v, k) => (
        <Fragment key={v.id}>
          {k > 0 && <hr className="divider" />}
          <div className="stack stack--tight">
            <div className="cluster">
              <strong className="line">{v.name}</strong>
              {shown?.id === v.id && <span className="badge badge--info"><span className="dot" aria-hidden="true" />shown</span>}
            </div>
            <span className="field__help line">{`${OP_LABEL[v.op]} of ${v.inputs.length} input${v.inputs.length === 1 ? '' : 's'}${v.unit ? `, in ${v.unit}` : ', a score'}`}</span>
            <div className="cluster" data-density="compact">
              <button className="btn btn--secondary" type="button" disabled={shown?.id === v.id} onClick={() => onShow(v)}>Show</button>
              <button className="btn btn--ghost" type="button" onClick={() => edit(draftOf(v))}>Edit</button>
              <button className="btn btn--danger" type="button" disabled={saving} onClick={() => { if (confirm(`Delete the combined view "${v.name}"? This cannot be undone.`)) { onDelete(v); if (draft?.was?.id === v.id) edit(null); } }}>Delete</button>
            </div>
          </div>
        </Fragment>
      ))}
      {notes.length > 0 && (
        <div className="alert alert--warning" role="status">
          <span className="alert__icon"><Icon name="alert" /></span>
          <div><span className="alert__title">{`${shown?.name ?? 'The view'} on the models`}</span>{notes.map((n) => <div key={n}>{n}</div>)}</div>
        </div>
      )}
      {!draft && (
        <div className="cluster">
          <button className="btn btn--secondary" type="button" disabled={!sets.length} title={sets.length ? undefined : 'Save a set on the Daylight or View analysis tab first'} onClick={() => edit({ name: `Combined ${views.length + 1}`, unit: '', op: 'mean', inputs: [inputOf(sets[0])] })}>
            <Icon name="plus" />New combined view
          </button>
        </div>
      )}
      {draft && (
        <form className="stack" aria-labelledby="cv-title" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <hr className="divider" />
          <h3 id="cv-title">{draft.was ? `Edit '${draft.was.name}'` : 'New combined view'}</h3>
          <span className="field__help line" role="status" title={why ?? undefined}>{why ?? 'Shown in the views as you edit, until Save or Cancel.'}</span>
          <div className="field">
            <label className="field__label" htmlFor="cv-name">Name</label>
            <input className="input" id="cv-name" value={draft.name} maxLength={80} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </div>
          <div className="grid" style={knob('--grid-min', '8rem')}>
            <div className="field">
              <label className="field__label" htmlFor="cv-unit">Unit</label>
              <input className="input" id="cv-unit" value={draft.unit} maxLength={16} placeholder="none: a score" onChange={(e) => setDraft({ ...draft, unit: e.target.value })} />
            </div>
            <div className="field">
              <label className="field__label" htmlFor="cv-op">Combine by</label>
              <select className="select" id="cv-op" value={draft.op} onChange={(e) => setDraft({ ...draft, op: e.target.value as Op })}>
                {OPS.map((op) => <option key={op} value={op}>{OP_LABEL[op]}</option>)}
              </select>
            </div>
          </div>
          <div className="stack stack--tight">
            <h4>{`Inputs (${draft.inputs.length} of ${MAX_INPUTS})`}</h4>
            {draft.inputs.map((i, k) => {
              const set = sets.find((s) => s.id === i.set);
              return (
                <CombinedInput
                  key={i.uid} input={i} k={k} sets={sets} columns={set ? columnsOf(set, statusOf(set)) : []} removable={draft.inputs.length > 1}
                  onChange={(patch) => setInput(k, patch)} onRemove={() => setDraft({ ...draft, inputs: draft.inputs.filter((_, j) => j !== k) })}
                />
              );
            })}
          </div>
          {problems.length > 0 && <div role="alert">{problems.map((p) => <span key={p} className="field__error">{p}</span>)}</div>}
          <div className="cluster">
            <button className="btn btn--secondary" type="button" disabled={draft.inputs.length >= MAX_INPUTS} onClick={() => setDraft({ ...draft, inputs: [...draft.inputs, inputOf(sets[0])] })}><Icon name="plus" />Add input</button>
          </div>
          <div className="cluster cluster--end">
            <button className="btn btn--ghost" type="button" onClick={() => edit(null)}>Cancel</button>
            <button className="btn btn--secondary" type="submit" disabled={saving}>Save combined view</button>
          </div>
        </form>
      )}
    </Section>
  );
});
