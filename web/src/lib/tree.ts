// The mesh tree: the scene graph reduced to the nodes that hold meshes, and the rows a collapsed / filtered view shows.
import type { BufferGeometry, Mesh, Object3D } from 'three';

export interface TreeNode { key: string; name: string; meshId?: string; tris: number; meshIds: string[]; children: TreeNode[] }
export interface Row { node: TreeNode; depth: number; open: boolean }

const trisOf = (g: BufferGeometry) => (g.index ? g.index.count : g.attributes.position.count) / 3;

/** Scene graph -> tree of the nodes that hold meshes (ids from `userData.id`); wrappers with one child and no mesh are lifted. */
export function buildTree(root: Object3D, meshes: Mesh[]): TreeNode[] {
  const ids = new Map<Object3D, string>(meshes.map((m) => [m, m.userData.id as string]));
  const walk = (o: Object3D): TreeNode | null => {
    const kids = o.children.map(walk).filter((n): n is TreeNode => n !== null);
    const meshId = ids.get(o);
    if (!meshId && kids.length === 0) return null;
    if (!meshId && kids.length === 1) return kids[0];
    const own = meshId ? trisOf((o as Mesh).geometry) : 0;
    return {
      key: o.uuid, name: o.name || (meshId ? 'Mesh' : 'Group'), meshId, children: kids,
      tris: own + kids.reduce((s, k) => s + k.tris, 0), meshIds: [...(meshId ? [meshId] : []), ...kids.flatMap((k) => k.meshIds)],
    };
  };
  const top = walk(root);
  return !top ? [] : top.meshId ? [top] : top.children; // the root group itself is never a row
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
