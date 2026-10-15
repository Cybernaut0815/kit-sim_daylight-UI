// Model: file input and the mesh tree (scene-graph groups, filter, collapse, roles per mesh or per group). The tree
// sits in a fixed-height, user-resizable box, so loading a model never moves the panels below it.
import { memo, useEffect, useMemo, useState, type Dispatch, type KeyboardEvent } from 'react';
import { groupKeys, visibleRows, type TreeNode } from '../lib/tree';
import type { Action, ObjectRow, Role } from '../store';
import { Alert, Icon } from '../ui';

type Shown = Role | 'mixed';
const LABEL: Record<Shown, string> = { receiver: 'Receiver', shade: 'Shade', none: 'Ignored', mixed: 'Mixed' };
const BADGE: Record<Shown, string> = { receiver: 'badge--info', shade: 'badge--neutral', none: 'badge--neutral', mixed: 'badge--neutral' };
const AUTO_OPEN = 40; // models up to this many meshes open fully; larger ones start collapsed

interface Props {
  tree: TreeNode[]; objects: ObjectRow[]; selected: Set<string>; loading: boolean; error: string | null; errors: Record<string, string>;
  onFiles: (files: File[]) => void; dispatch: Dispatch<Action>;
}

export const ModelPanel = memo(function ModelPanel({ tree, objects, selected, loading, error, errors, onFiles, dispatch }: Props) {
  const [filter, setFilter] = useState('');
  const groups = useMemo(() => groupKeys(tree), [tree]);
  const total = objects.length;
  const [open, setOpen] = useState<Set<string>>(new Set());
  useEffect(() => { setOpen(new Set(total <= AUTO_OPEN ? groups : [])); setFilter(''); }, [groups]); // eslint-disable-line react-hooks/exhaustive-deps -- once per model
  const roleOf = useMemo(() => new Map(objects.map((o) => [o.id, o.role])), [objects]);
  const { rows, more } = useMemo(() => visibleRows(tree, open, filter), [tree, open, filter]);
  const count = (r: Role) => objects.reduce((n, o) => n + (o.role === r ? 1 : 0), 0);

  const shown = (ids: string[]): Shown => { const r = roleOf.get(ids[0]) ?? 'none'; return ids.every((id) => roleOf.get(id) === r) ? r : 'mixed'; };
  const toggle = (key: string, to?: boolean) => setOpen((prev) => { const next = new Set(prev); if (to ?? !next.has(key)) next.add(key); else next.delete(key); return next; });
  // a group row selects all its meshes; with shift / ctrl it adds them, or removes them when all were selected already
  const pick = (ids: string[], additive: boolean) => {
    if (!additive) return dispatch({ type: 'SELECT', ids });
    const all = ids.every((id) => selected.has(id));
    dispatch({ type: 'SELECT', ids: all ? ids : ids.filter((id) => !selected.has(id)), additive: true });
  };
  const onKey = (node: TreeNode, isOpen: boolean) => (e: KeyboardEvent) => {
    if (e.key === 'ArrowRight' && node.children.length && !isOpen) { e.preventDefault(); toggle(node.key, true); }
    else if (e.key === 'ArrowLeft' && isOpen) { e.preventDefault(); toggle(node.key, false); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(node.meshIds, e.shiftKey || e.ctrlKey); }
  };

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
        {errors.model ? <span className="field__error">{errors.model}</span> : <span className="field__help line">.glb, .gltf with its .bin and textures, or .obj</span>}
      </div>
      {error && <Alert title="Could not load the model">{error}</Alert>}
      <details className="accordion" open>
        <summary>
          <span>Meshes</span>
          <span className="text-muted">{total ? `${total} total, ${count('receiver')} receiving, ${count('shade')} shading` : 'none loaded'}</span>
        </summary>
        <div className="accordion__body stack stack--tight">
          <div className="toolbar" role="group" aria-label="Role of the selected meshes">
            {(['receiver', 'shade', 'none'] as Role[]).map((role) => (
              <button key={role} className="btn btn--secondary" type="button" disabled={!selected.size} onClick={() => dispatch({ type: 'ROLE', ids: [...selected], role })}>
                {role === 'none' ? 'Ignore' : LABEL[role]}
              </button>
            ))}
          </div>
          <div className="row-fill toolbar">
            <label className="sr-only" htmlFor="mesh-filter">Filter meshes by name</label>
            <input className="input" id="mesh-filter" type="search" placeholder="Filter" value={filter} disabled={!total} onChange={(e) => setFilter(e.target.value)} />
            <div className="cluster">
              <button className="btn btn--ghost" type="button" disabled={!total} onClick={() => dispatch({ type: 'SELECT', ids: objects.map((o) => o.id) })}>All</button>
              <button className="btn btn--ghost" type="button" disabled={!selected.size} onClick={() => dispatch({ type: 'SELECT', ids: [] })}>None</button>
              <button className="btn btn--ghost" type="button" disabled={!groups.length} onClick={() => setOpen(open.size ? new Set() : new Set(groups))}>{open.size ? 'Collapse' : 'Expand'}</button>
            </div>
          </div>
          <div className="tree">
            {total ? (
              <table className="data-table">
                <colgroup><col /><col className="tree__col-num" /><col className="tree__col-role" /></colgroup>
                <thead><tr><th scope="col">Mesh</th><th scope="col" className="num">Triangles</th><th scope="col">Role</th></tr></thead>
                <tbody>
                  {rows.map(({ node, depth, open: isOpen }) => {
                    const kids = node.children.length > 0, role = shown(node.meshIds);
                    return (
                      <tr
                        key={node.key} tabIndex={0} aria-level={depth + 1} aria-expanded={kids ? isOpen : undefined}
                        aria-selected={node.meshIds.every((id) => selected.has(id))}
                        onClick={(e) => pick(node.meshIds, e.shiftKey || e.ctrlKey)} onKeyDown={onKey(node, isOpen)}
                        onPointerEnter={node.meshId ? () => dispatch({ type: 'HOVER', id: node.meshId! }) : undefined}
                        onPointerLeave={node.meshId ? () => dispatch({ type: 'HOVER', id: null }) : undefined}
                        title={node.name}
                      >
                        <td>
                          {Array.from({ length: depth }, (_, i) => <span key={i} className="tree__indent" />)}
                          {kids
                            ? <button className="tree__toggle" type="button" tabIndex={-1} aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${node.name}`} onClick={(e) => { e.stopPropagation(); toggle(node.key); }}><Icon name={isOpen ? 'chevronDown' : 'chevronRight'} /></button>
                            : <span className="tree__indent" />}
                          {node.name}{kids && <span className="text-muted"> ({node.meshIds.length})</span>}
                        </td>
                        <td className="num">{node.tris.toLocaleString('en-GB')}</td>
                        <td><span className={`badge ${BADGE[role]}`}><span className="dot" />{LABEL[role]}</span></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : <p className="text-muted">Open a model to list its meshes.</p>}
          </div>
          <p className="text-muted line">{selected.size} of {total} selected{more ? `, ${more} more rows: narrow the filter` : ''}. Shift-click adds to the selection.</p>
        </div>
      </details>
    </section>
  );
});
