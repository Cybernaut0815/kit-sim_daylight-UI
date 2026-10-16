// The Model panel's prim tree: the stage's hierarchy as the USD viewer shows it (every prim, loaded as it is expanded),
// with the triangles and the role of the meshes at or under each prim. Selecting works as in the viewer's own hierarchy
// (its modifySelect): click replaces, Shift adds, Ctrl removes, Shift+Ctrl adds the parent, Shift+Alt the parent with
// its subtree, Alt the rows from the last click; arrows move and expand, a double-click frames. A pick in the view
// opens the tree to the picked prim. The selection is the viewer's; the store mirrors it (SELECTION).
import { memo, useEffect, useMemo, useRef, useState, type Dispatch, type KeyboardEvent, type MouseEvent } from 'react';
import { modifySelect, selectUpWithSubtree, type PrimSummary } from 'usd-viewer';
import { meshAt, underIndex } from '../lib/tree';
import type { Action, ObjectRow, Role, Selection } from '../store';
import { Icon } from '../ui';
import { usd } from '../viewer/usd';

type Shown = Role | 'mixed';
const LABEL: Record<Shown, string> = { receiver: 'Receiver', shade: 'Shade', none: 'Ignored', mixed: 'Mixed' };
const BADGE: Record<Shown, string> = { receiver: 'badge--info', shade: 'badge--neutral', none: 'badge--neutral', mixed: 'badge--neutral' };
const AUTO_OPEN = 40; // models up to this many meshes open down to every mesh; larger ones show their top level
const LIMIT = 400; // rows drawn at most (ponytail: no row windowing; the search reaches the rest)

/** '/A/B/C' -> ['/A', '/A/B']: the prims to open to show C. */
const ancestors = (path: string) => path.split('/').slice(1, -1).map((_, i, segs) => `/${segs.slice(0, i + 1).join('/')}`);

interface Row { path: string; name: string; type: string; depth: number; children: boolean; open: boolean; dim: boolean }
interface Props { objects: ObjectRow[]; selection: Selection; selected: Set<string>; names: ReadonlyMap<string, string>; dispatch: Dispatch<Action> }

export const PrimTree = memo(function PrimTree({ objects, selection, selected, names, dispatch }: Props) {
  const [kids, setKids] = useState<ReadonlyMap<string, PrimSummary[]>>(new Map()); // loaded children per prim ('/' = the roots)
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<string[] | null>(null); // search hits, shown flat instead of the tree
  const [reveal, setReveal] = useState<string | null>(null); // a row to scroll into view once drawn
  const box = useRef<HTMLDivElement>(null);
  const anchor = useRef<string | null>(null); // the last row clicked without Alt: where an Alt-click range starts
  const generation = useRef(0); // answers for an older model are dropped
  const loaded = useRef(kids); // read by the async loads
  loaded.current = kids;
  const under = useMemo(() => underIndex(objects), [objects]), exact = useMemo(() => meshAt(objects), [objects]);
  const byId = useMemo(() => new Map(objects.map((o) => [o.id, o])), [objects]);
  const picked = useMemo(() => new Set(selection.paths), [selection]);
  const total = objects.length, model = objects[0]?.id ?? ''; // ids are new on every load: a new model, not a role change

  /** Loads the children of `paths` (once) and opens them; merged into the state, so loads in flight never undo each other. */
  const openAll = async (paths: string[]) => {
    const gen = generation.current, got: [string, PrimSummary[]][] = [];
    for (const p of paths) if (!loaded.current.has(p) && !got.some(([q]) => q === p)) got.push([p, await usd.usd.children(p)]);
    if (gen !== generation.current) return false;
    if (got.length) setKids((k) => new Map([...k, ...got]));
    setOpen((o) => new Set([...o, ...paths]));
    return true;
  };

  // A new model: its roots, a lone root opened (as the viewer does), and every mesh shown when there are few.
  useEffect(() => {
    const gen = ++generation.current;
    setKids(new Map());
    setOpen(new Set());
    setQuery('');
    if (!model) return;
    (async () => {
      const roots = await usd.usd.children('/');
      if (gen !== generation.current) return;
      setKids(new Map([['/', roots]]));
      const paths = new Set(roots.length === 1 ? [roots[0].path] : []);
      if (total <= AUTO_OPEN) for (const o of objects) for (const a of ancestors(o.path)) paths.add(a);
      await openAll([...paths]);
    })().catch(() => {});
  }, [model]); // eslint-disable-line react-hooks/exhaustive-deps -- once per model

  // A pick in the view: open the tree down to it and bring it into view.
  useEffect(() => {
    const path = selection.active;
    if (selection.source !== 'viewport' || !path || results) return;
    openAll(ancestors(path)).then((ok) => ok && setReveal(path), () => {});
  }, [selection]); // eslint-disable-line react-hooks/exhaustive-deps -- per selection

  // The viewer's search: 'type:Mesh name', answered by the core with paths.
  useEffect(() => {
    if (!query.trim()) return void setResults(null);
    let live = true;
    const t = window.setTimeout(async () => {
      const type = /(?:^|\s)type:(\S+)/.exec(query)?.[1] ?? '', text = query.replace(/(?:^|\s)type:\S+/, '').trim();
      const found = await usd.usd.find(text, type).catch(() => []);
      if (live) setResults(found);
    }, 200);
    return () => { live = false; clearTimeout(t); };
  }, [query]);

  const all = useMemo(() => {
    if (results) return results.map((path): Row => ({ path, name: path, type: '', depth: 0, children: false, open: false, dim: false }));
    const out: Row[] = [];
    const walk = (parent: string, depth: number) => {
      for (const s of kids.get(parent) ?? []) {
        const isOpen = open.has(s.path);
        out.push({ path: s.path, name: names.get(s.path) ?? s.name, type: s.typeName, depth, children: s.hasChildren, open: isOpen, dim: !s.active || !s.visible });
        if (isOpen) walk(s.path, depth + 1);
      }
    };
    walk('/', 0);
    return out;
  }, [kids, open, results, names]);
  const rows = all.slice(0, LIMIT), more = all.length - rows.length;

  useEffect(() => {
    if (!reveal) return;
    box.current?.querySelector(`[data-path="${CSS.escape(reveal)}"]`)?.scrollIntoView({ block: 'nearest' });
    setReveal(null);
  }, [reveal, rows]);

  const toggle = (row: Row) => {
    if (row.open) setOpen((o) => { const n = new Set(o); n.delete(row.path); return n; });
    else openAll([row.path]).catch(() => {});
  };
  /** The visible rows from the anchor to `path`, ending with `path` (just `path` when the anchor is not shown). */
  const range = (path: string) => {
    const paths = rows.map((r) => r.path), from = paths.indexOf(anchor.current ?? selection.active ?? ''), to = paths.indexOf(path);
    if (from < 0 || to < 0) return [path];
    const slice = paths.slice(Math.min(from, to), Math.max(from, to) + 1);
    return from <= to ? slice : slice.reverse();
  };
  const onClick = (e: MouseEvent, path: string) => {
    if (e.altKey && !e.shiftKey) return modifySelect(usd.session, range(path), 'add', 'hierarchy');
    anchor.current = path;
    const ctrl = e.ctrlKey || e.metaKey;
    if (e.shiftKey && e.altKey) selectUpWithSubtree(usd.session, path, 'hierarchy').catch(() => {});
    else modifySelect(usd.session, [path], e.shiftKey && ctrl ? 'up' : e.shiftKey ? 'add' : ctrl ? 'remove' : 'replace', 'hierarchy');
  };
  const onKey = (e: KeyboardEvent) => {
    const current = rows.findIndex((r) => picked.has(r.path)), row = rows[current];
    let next = current;
    if (e.key === 'ArrowDown') next = Math.min(current + 1, rows.length - 1);
    else if (e.key === 'ArrowUp') next = Math.max(current - 1, 0);
    else if (e.key === 'ArrowRight' && row?.children && !row.open) toggle(row);
    else if (e.key === 'ArrowLeft' && row?.open) toggle(row);
    else return;
    e.preventDefault();
    if (next !== current && rows[next]) {
      anchor.current = rows[next].path;
      modifySelect(usd.session, [anchor.current], 'replace', 'hierarchy');
      setReveal(anchor.current);
    }
  };

  return (
    <>
      <label className="sr-only" htmlFor="prim-search">Search prims</label>
      <input className="input" id="prim-search" type="search" placeholder="Search prims (type:Mesh name)" value={query} disabled={!total} onChange={(e) => setQuery(e.target.value)} />
      <div className="cluster">
        <button className="btn btn--ghost" type="button" disabled={!total} onClick={() => usd.select((kids.get('/') ?? []).map((s) => s.path))}>All</button>
        <button className="btn btn--ghost" type="button" disabled={!selection.paths.length} onClick={() => usd.select([])}>None</button>
        <button className="btn btn--ghost" type="button" disabled={!open.size || !!results} onClick={() => setOpen(new Set())}>Collapse</button>
      </div>
      <div className="tree" ref={box} tabIndex={0} role="tree" aria-label="Prims" aria-multiselectable onKeyDown={onKey}>
        {total ? (
          <table className="data-table">
            <colgroup><col /><col className="tree__col-role" /></colgroup>
            <thead><tr><th scope="col">Prim</th><th scope="col">Role</th></tr></thead>
            <tbody>
              {rows.map((r) => {
                const ids = under.get(r.path) ?? [], mesh = byId.get(exact.get(r.path) ?? ''), first = byId.get(ids[0])?.role;
                const role: Shown | null = !ids.length ? null : ids.every((id) => byId.get(id)?.role === first) ? first! : 'mixed';
                const tris = ids.reduce((n, id) => n + (byId.get(id)?.tris ?? 0), 0);
                return (
                  <tr
                    key={r.path} data-path={r.path} aria-level={r.depth + 1} aria-expanded={r.children ? r.open : undefined}
                    aria-selected={picked.has(r.path)} aria-current={selection.active === r.path ? 'true' : undefined}
                    title={ids.length ? `${r.path}\n${ids.length.toLocaleString('en-GB')} ${ids.length === 1 ? 'mesh' : 'meshes'}, ${tris.toLocaleString('en-GB')} triangles` : r.path}
                    onClick={(e) => onClick(e, r.path)} onDoubleClick={() => usd.frame([r.path])}
                    onPointerEnter={mesh ? () => dispatch({ type: 'HOVER', id: mesh.id }) : undefined}
                    onPointerLeave={mesh ? () => dispatch({ type: 'HOVER', id: null }) : undefined}
                  >
                    <td>
                      {Array.from({ length: r.depth }, (_, i) => <span key={i} className="tree__indent" />)}
                      {r.children
                        ? <button className="tree__toggle" type="button" tabIndex={-1} aria-label={`${r.open ? 'Collapse' : 'Expand'} ${r.name}`} onClick={(e) => { e.stopPropagation(); toggle(r); }}><Icon name={r.open ? 'chevronDown' : 'chevronRight'} /></button>
                        : <span className="tree__indent" />}
                      <span className={r.dim ? 'text-muted' : undefined}>{r.name}{mesh?.instances ? ` ×${mesh.instances}` : ''}</span>
                      {r.type && <span className="text-muted"> {r.type}</span>}
                    </td>
                    <td>{role && <span className={`badge ${BADGE[role]}`}><span className="dot" />{LABEL[role]}</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : <p className="text-muted">Open a model to list its prims.</p>}
      </div>
      <p className="text-muted line">{selected.size} of {total} meshes selected{more ? `, ${more} more rows: search to narrow` : ''}.</p>
      <p className="text-muted line" title="Click selects a prim, Shift adds, Ctrl removes, Shift+Ctrl adds its parent, Shift+Alt the parent with everything below it, Alt the rows from the last click. A role applies to every mesh at or below the selected prims; instanced meshes (×n) only shade.">
        Shift adds, Ctrl removes; a role goes to every mesh below.
      </p>
    </>
  );
});
