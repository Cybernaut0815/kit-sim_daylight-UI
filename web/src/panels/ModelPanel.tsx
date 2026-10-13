import type { Dispatch } from 'react';
import type { Action, ObjectRow, Role } from '../store';
import { Alert, Swatch, rowKeys } from '../ui';

const LABEL: Record<Role, string> = { receiver: 'Receiver', shade: 'Shade only', none: 'Ignored' };
const BADGE: Record<Role, string> = { receiver: 'badge--info', shade: 'badge--neutral', none: 'badge--neutral' };

interface Props {
  objects: ObjectRow[]; selected: Set<string>; loading: boolean; error: string | null; errors: Record<string, string>;
  onFiles: (files: File[]) => void; dispatch: Dispatch<Action>;
}

export function ModelPanel({ objects, selected, loading, error, errors, onFiles, dispatch }: Props) {
  const select = (id: string, additive: boolean) => dispatch({ type: 'SELECT', ids: [id], additive });
  return (
    <section className="stack" aria-labelledby="h-model">
      <h2 id="h-model">Model</h2>
      <div className="field">
        <label className="field__label" htmlFor="model-files">Model files</label>
        <input
          className="input" id="model-files" type="file" multiple accept=".glb,.gltf,.obj,.bin,.png,.jpg,.jpeg,.webp" disabled={loading}
          aria-invalid={errors.model ? true : undefined}
          onChange={(e) => { const files = Array.from(e.target.files ?? []); if (files.length) onFiles(files); }}
        />
        <span className="field__help">.glb, .gltf with its .bin and textures, or .obj; metres, Y-up as exported.</span>
        {errors.model && <span className="field__error">{errors.model}</span>}
      </div>
      {error && <Alert title="Could not load the model">{error}</Alert>}
      {objects.length > 0 && (
        <>
          <div className="toolbar" role="group" aria-label="Role of the selected meshes">
            {(Object.keys(LABEL) as Role[]).map((role) => (
              <button key={role} className="btn btn--secondary" type="button" disabled={selected.size === 0} onClick={() => dispatch({ type: 'ROLE', ids: [...selected], role })}>
                {role === 'none' ? 'Ignore' : LABEL[role]}
              </button>
            ))}
            <span className="divider divider--vertical" role="separator" aria-orientation="vertical" />
            <button className="btn btn--ghost" type="button" onClick={() => dispatch({ type: 'SELECT', ids: objects.map((o) => o.id) })}>Select all</button>
            <span className="text-muted">{selected.size} of {objects.length} selected</span>
          </div>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr><th scope="col"><span className="sr-only">Colour</span></th><th scope="col">Mesh</th><th scope="col" className="num">Triangles</th><th scope="col">Role</th></tr>
              </thead>
              <tbody>
                {objects.map((o) => (
                  <tr
                    key={o.id} tabIndex={0} aria-selected={selected.has(o.id)}
                    onClick={(e) => select(o.id, e.shiftKey || e.ctrlKey)} onKeyDown={rowKeys(() => select(o.id, true))}
                    onPointerEnter={() => dispatch({ type: 'HOVER', id: o.id })} onPointerLeave={() => dispatch({ type: 'HOVER', id: null })}
                  >
                    <td>{o.role === 'receiver' && <Swatch slot={o.slot} />}</td>
                    <td>{o.name}</td>
                    <td className="num">{o.tris.toLocaleString('en-GB')}</td>
                    <td><span className={`badge ${BADGE[o.role]}`}><span className="dot" />{LABEL[o.role]}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
