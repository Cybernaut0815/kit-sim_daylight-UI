// Model: file and folder inputs, the roles of the selected meshes, and the stage's prim tree (PrimTree: the hierarchy as
// in the USD viewer, selected as there; a prim's role goes to every mesh below it). The tree sits in a fixed-height,
// user-resizable box, so loading a model never moves the panels below it.
import { memo, type Dispatch } from 'react';
import type { Action, ObjectRow, Role, Selection } from '../store';
import { Alert, Section } from '../ui';
import { PrimTree } from './PrimTree';

const LABEL: Record<Role, string> = { receiver: 'Receiver', shade: 'Shade', none: 'Ignore' };

interface Props {
  objects: ObjectRow[]; selection: Selection; selected: Set<string>; names: ReadonlyMap<string, string>;
  loading: boolean; error: string | null; errors: Record<string, string>; stage: number;
  onFiles: (files: File[]) => void; onVariant: (path: string, set: string, variant: string) => void; dispatch: Dispatch<Action>;
}

export const ModelPanel = memo(function ModelPanel({ objects, selection, selected, names, loading, error, errors, stage, onFiles, onVariant, dispatch }: Props) {
  const total = objects.length, count = (r: Role) => objects.reduce((n, o) => n + (o.role === r ? 1 : 0), 0);
  return (
    <Section id="model" title="Model">
      <div className="field">
        <label className="field__label" htmlFor="model-files">Model files</label>
        <input
          className="input" id="model-files" type="file" multiple accept=".usd,.usda,.usdc,.usdz,.glb,.gltf,.obj,.bin,.png,.jpg,.jpeg,.webp,.exr,.hdr" disabled={loading}
          aria-invalid={errors.model ? true : undefined}
          onChange={(e) => { const files = Array.from(e.target.files ?? []); if (files.length) onFiles(files); }}
        />
        {errors.model
          ? <span className="field__error">{errors.model}</span>
          : <span className="field__help line">{loading ? <><span className="spinner" aria-hidden="true" /> Loading the model</> : '.usd, .usda, .usdc, .usdz, .glb, .gltf with its .bin and textures, or .obj'}</span>}
      </div>
      <div className="field">
        <label className="field__label" htmlFor="model-folder">Folder…</label>
        <input
          className="input" id="model-folder" type="file" {...{ webkitdirectory: '' }} disabled={loading}
          onChange={(e) => { const files = Array.from(e.target.files ?? []); if (files.length) onFiles(files); }}
        />
        <span className="field__help line">A USD scene with its assets: opens its top-level USD file (the first by name)</span>
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
              <button key={role} className="btn btn--secondary" type="button" disabled={!selected.size} onClick={() => dispatch({ type: 'ROLE', ids: [...selected], role })}>
                {LABEL[role]}
              </button>
            ))}
          </div>
          <PrimTree objects={objects} selection={selection} selected={selected} names={names} stage={stage} loading={loading} onVariant={onVariant} dispatch={dispatch} />
        </div>
      </details>
    </Section>
  );
});
