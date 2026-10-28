// Model: a tab per model to compare (up to four, A to D: "+" adds one, x removes one), and for the active model: file
// and folder inputs, the roles of the selected meshes, and the stage's prim tree (PrimTree: the hierarchy as in the USD
// viewer, selected as there; a prim's role goes to every mesh below it). The tree sits in a fixed-height,
// user-resizable box, so loading a model never moves the panels below it.
import { memo, useCallback, type Dispatch } from 'react';
import type { UsdViewerElement } from 'usd-viewer';
import type { Action, Model, Role } from '../store';
import { Alert, Icon, LETTERS, Section, Tag } from '../ui';
import { PrimTree } from './PrimTree';

const LABEL: Record<Role, string> = { receiver: 'Receiver', shade: 'Shade', none: 'Ignore' };
const SUBDIV_HELP = 'As the USD viewer draws them: catmullClark and loop meshes refined with OpenSubdiv (creases, corners, holes and boundary rules included); bilinear and "none" stay as authored; a mesh without a scheme counts as catmullClark, except under Auto. A mesh whose refined surface would be very large for the view is refined less: its row shows the triangles it really has. Not saved to the model.';

interface Props {
  models: Model[]; active: number; usd: UsdViewerElement; // the active model's viewer
  names: ReadonlyMap<string, string>; loading: boolean; busy: boolean; // busy: any model loading
  error: string | null; errors: Record<string, string>; stage: number; subdiv: number;
  onFiles: (slot: number, files: File[]) => void; onVariant: (slot: number, path: string, set: string, variant: string) => void;
  onSubdiv: (level: number) => void; onRefine: (slot: number, paths: string[], level: number | null) => void;
  onRemove: (slot: number) => void; dispatch: Dispatch<Action>;
}

/** After a tab is added or removed, the pressed tab takes the focus (the button pressed may be gone). */
const focusTab = () => requestAnimationFrame(() => document.querySelector<HTMLElement>('.model-tabs [aria-current="page"]')?.focus());

export const ModelPanel = memo(function ModelPanel({ models, active, usd, names, loading, busy, error, errors, stage, subdiv, onFiles, onVariant, onSubdiv, onRefine, onRemove, dispatch }: Props) {
  const { objects, selection, selected } = models.find((m) => m.slot === active)!;
  const total = objects.length, count = (r: Role) => objects.reduce((n, o) => n + (o.role === r ? 1 : 0), 0);
  const variant = useCallback((path: string, set: string, v: string) => onVariant(active, path, set, v), [onVariant, active]); // stable for the memoised tree
  const about = (m: Model) => `Model ${LETTERS[m.slot]}: ${m.name || 'no model open yet'}`;
  return (
    <Section id="model" title="Model">
      <div className="tabs model-tabs" role="group" aria-label="Models to compare">
        {models.map((m) => (
          <span key={m.slot} className="model-tabs__item">
            <button className="tabs__tab" type="button" aria-current={m.slot === active ? 'page' : undefined} aria-label={about(m)} title={about(m)} onClick={() => dispatch({ type: 'ACTIVE', slot: m.slot })}>
              <Tag slot={m.slot} />
            </button>
            {models.length > 1 && (
              <button
                className="icon-btn icon-btn--ghost" type="button" disabled={busy} aria-label={`Remove model ${LETTERS[m.slot]}`}
                title={`Remove model ${LETTERS[m.slot]}: its view, its results and its run go; the other models keep their letters and colours`}
                onClick={() => { onRemove(m.slot); focusTab(); }}
              >
                <Icon name="close" />
              </button>
            )}
          </span>
        ))}
        {/* kept at four, disabled: the row never changes its height */}
        <button
          className="tabs__tab" type="button" disabled={models.length >= 4} aria-label="Add a model to compare"
          title={models.length < 4 ? 'Add a model to compare (up to four): its own 3D view and its own results, run with the same site, weather, time and settings' : 'Four models at most: remove one to add another'}
          onClick={() => { dispatch({ type: 'ADD' }); focusTab(); }}
        >
          <Icon name="plus" />
        </button>
      </div>
      <div className="field">
        <label className="field__label" htmlFor="model-files">Model files</label>
        <input
          key={active} className="input" id="model-files" type="file" multiple accept=".usd,.usda,.usdc,.usdz,.glb,.gltf,.obj,.mtl,.bin,.png,.jpg,.jpeg,.webp,.exr,.hdr" disabled={loading}
          aria-invalid={errors.model ? true : undefined}
          onChange={(e) => { const files = Array.from(e.target.files ?? []); if (files.length) onFiles(active, files); }}
        />
        {errors.model
          ? <span className="field__error">{errors.model}</span>
          : <span className="field__help line">{loading ? <><span className="spinner" aria-hidden="true" /> Loading the model</> : '.usd, .usda, .usdc, .usdz, .glb, .gltf (Draco, meshopt) with its .bin and textures, or .obj with its .mtl and textures'}</span>}
      </div>
      <div className="field">
        <label className="field__label" htmlFor="model-folder">Folder…</label>
        <input
          key={active} className="input" id="model-folder" type="file" {...{ webkitdirectory: '' }} disabled={loading}
          onChange={(e) => { const files = Array.from(e.target.files ?? []); if (files.length) onFiles(active, files); }}
        />
        <span className="field__help line">A USD scene with its assets: opens its top-level USD file (the first by name)</span>
      </div>
      <div className="field">
        <label className="field__label" htmlFor="subdiv">Subdivision</label>
        <select className="select" id="subdiv" value={subdiv} disabled={busy} onChange={(e) => onSubdiv(Number(e.target.value))}>
          <option value={0}>Off: the control cage</option>
          <option value={-1}>Auto: authored schemes, up to level 2</option>
          {[1, 2, 3].map((l) => <option key={l} value={l}>Level {l}</option>)}
        </select>
        <span className="field__help line" title={models.length > 1 ? `${SUBDIV_HELP} One level for every model.` : SUBDIV_HELP}>catmullClark / loop meshes as smooth surfaces with their creases; the run uses these triangles</span>
      </div>
      {error && <Alert title="Problems loading the model">{error}</Alert>}
      <details className="accordion" open>
        <summary>
          <span>Prims</span>
          <span className="text-muted">{total ? `${total} meshes, ${count('receiver')} receiving, ${count('shade')} shading` : 'none loaded'}</span>
        </summary>
        <div className="accordion__body stack stack--tight">
          <div className="toolbar" role="group" aria-label="Role of the meshes at or below the selected prims">
            {(['receiver', 'shade', 'none'] as Role[]).map((role) => (
              <button key={role} className="btn btn--secondary" type="button" disabled={!selected.size} onClick={() => dispatch({ type: 'ROLE', slot: active, ids: [...selected], role })}>
                {LABEL[role]}
              </button>
            ))}
            <select
              className="select" value="" aria-label="Subdivision of the selected meshes" title={`Subdivision of the selected meshes, over the model's level. ${SUBDIV_HELP}`}
              disabled={!selected.size || loading}
              onChange={(e) => onRefine(active, objects.filter((o) => selected.has(o.id) && !o.instances).map((o) => o.path), e.target.value === 'model' ? null : Number(e.target.value))}
            >
              <option value="" disabled>Subdivision…</option>
              <option value="model">As the model</option>
              <option value={0}>Off</option>
              {[1, 2, 3].map((l) => <option key={l} value={l}>Level {l}</option>)}
            </select>
          </div>
          <PrimTree usd={usd} objects={objects} selection={selection} selected={selected} names={names} stage={stage} loading={loading} onVariant={variant} dispatch={dispatch} />
        </div>
      </details>
    </Section>
  );
});
