// The mesh tree: the stage's prim paths reduced to the prims that hold meshes, and the rows a collapsed / filtered view shows.

export interface TreeNode { key: string; name: string; meshId?: string; tris: number; meshIds: string[]; children: TreeNode[] }
export interface Row { node: TreeNode; depth: number; open: boolean }

/**
 * Mesh rows by prim path -> tree of the prims that hold meshes (key = path, name = the model's own from `names`, else
 * the path's last segment, '×n' after an instanced mesh); wrappers with one child and no mesh are lifted, the
 * pseudo-root is never a row.
 */
export function treeFromPaths(rows: readonly { id: string; path: string; tris: number; instances?: number }[], names: ReadonlyMap<string, string> = new Map()): TreeNode[] {
  interface Prim { key: string; name: string; meshId?: string; tris: number; kids: Map<string, Prim> }
  const root: Prim = { key: '', name: '', tris: 0, kids: new Map() };
  for (const r of rows) {
    let p = root;
    for (const seg of r.path.split('/').filter(Boolean)) {
      const key = `${p.key}/${seg}`;
      let k = p.kids.get(seg);
      if (!k) p.kids.set(seg, (k = { key, name: names.get(key) ?? seg, tris: 0, kids: new Map() }));
      p = k;
    }
    p.meshId = r.id;
    p.tris = r.tris;
    if (r.instances) p.name += ` ×${r.instances}`;
  }
  const walk = (p: Prim): TreeNode | null => {
    const kids = [...p.kids.values()].map(walk).filter((n): n is TreeNode => n !== null);
    if (!p.meshId && kids.length === 0) return null;
    if (!p.meshId && kids.length === 1) return kids[0];
    return {
      key: p.key, name: p.name, meshId: p.meshId, children: kids,
      tris: p.tris + kids.reduce((s, k) => s + k.tris, 0), meshIds: [...(p.meshId ? [p.meshId] : []), ...kids.flatMap((k) => k.meshIds)],
    };
  };
  const top = walk(root);
  return !top ? [] : top.meshId ? [top] : top.children;
}

/**
 * Row labels: the model's own name (`names`) or the prim name, with parent names put in front while two rows share one
 * (USD files name many meshes alike: 'Block_A/Mesh').
 */
export function rowNames(paths: readonly string[], names: ReadonlyMap<string, string> = new Map()): string[] {
  const segs = paths.map((p) => { const s = p.split('/').filter(Boolean); return s.map((seg, i) => names.get(`/${s.slice(0, i + 1).join('/')}`) ?? seg); });
  const out = segs.map((s) => s[s.length - 1] ?? '');
  for (let k = 2; ; k++) {
    const count = new Map<string, number>();
    for (const n of out) count.set(n, (count.get(n) ?? 0) + 1);
    let grew = false;
    out.forEach((n, i) => { if (count.get(n)! > 1 && segs[i].length >= k) { out[i] = segs[i].slice(-k).join('/'); grew = true; } });
    if (!grew) return out;
  }
}

/**
 * Ids of the rows at or under any of `paths`: a viewer selection may name an Xform, a subtree or a prim with no row. A
 * row with `paths` (a natively instanced mesh: every copy is a prim) is hit through any of them.
 */
export function idsUnder(paths: readonly string[], rows: readonly { id: string; path: string; paths?: readonly string[] }[]): string[] {
  const sel = new Set(paths);
  const hit = (p: string) => {
    for (let q = p; q; q = q.slice(0, q.lastIndexOf('/'))) if (sel.has(q)) return true;
    return sel.has('/');
  };
  return rows.filter((r) => (r.paths ?? [r.path]).some(hit)).map((r) => r.id);
}

/**
 * Rows of the open nodes. With a filter: nodes whose name matches show with their subtree (open as the user left it),
 * ancestors of matches are forced open, everything else hides. At most `limit` rows; `more` counts the rest.
 */
export function visibleRows(nodes: TreeNode[], open: Set<string>, filter: string, limit = 400): { rows: Row[]; more: number } {
  const f = filter.trim().toLowerCase(), rows: Row[] = [];
  let more = 0;
  // ponytail: hit() re-walks subtrees per level (quadratic on deep trees); memoise per filter if huge scenes lag
  const hit = (n: TreeNode): boolean => n.name.toLowerCase().includes(f) || n.children.some(hit);
  const add = (ns: TreeNode[], depth: number, inMatch: boolean) => {
    for (const n of ns) {
      const self = !f || inMatch || n.name.toLowerCase().includes(f);
      if (!self && !n.children.some(hit)) continue;
      const isOpen = n.children.length > 0 && (open.has(n.key) || (!self && !!f));
      if (rows.length < limit) rows.push({ node: n, depth, open: isOpen });
      else more++;
      if (isOpen) add(n.children, depth + 1, !!f && self);
    }
  };
  add(nodes, 0, false);
  return { rows, more };
}

/** Keys of every node with children (for expand all). */
export function groupKeys(nodes: TreeNode[]): string[] {
  const out: string[] = [];
  const walk = (ns: TreeNode[]) => { for (const n of ns) if (n.children.length) { out.push(n.key); walk(n.children); } };
  walk(nodes);
  return out;
}
