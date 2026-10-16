import { describe, expect, it } from 'vitest';
import { groupKeys, idsUnder, rowNames, treeFromPaths, visibleRows } from './tree';

// a converted file: everything under /Model; a building group, a lone mesh, and a wrapper around one mesh
const rows = [
  { id: 'a1', path: '/Model/scene/Building_A/a1', tris: 12 },
  { id: 'a2', path: '/Model/scene/Building_A/a2', tris: 12 },
  { id: 'b', path: '/Model/scene/b', tris: 12 },
  { id: 'c', path: '/Model/scene/wrapper/c', tris: 12 },
];
const tree = treeFromPaths(rows, new Map([['/Model/scene/Building_A', 'Building A']]));

describe('treeFromPaths', () => {
  it('drops the root and single-child wrappers, keeps groups with their mesh ids, triangle counts and own names', () => {
    expect(tree.map((n) => n.name)).toEqual(['Building A', 'b', 'c']);
    expect(tree[0].key).toBe('/Model/scene/Building_A');
    expect(tree[0].meshIds).toEqual(['a1', 'a2']);
    expect(tree[0].tris).toBe(24);
    expect(tree[1].meshId).toBe('b');
    expect(tree[1].children).toEqual([]);
    expect(groupKeys(tree)).toEqual([tree[0].key]);
    expect(treeFromPaths([])).toEqual([]);
  });
  it('a mesh holding meshes keeps both; a single mesh is its own row', () => {
    const t = treeFromPaths([{ id: 'p', path: '/W/P', tris: 2 }, { id: 'k', path: '/W/P/K', tris: 3 }]);
    expect(t.map((n) => [n.name, n.meshId, n.tris, n.meshIds])).toEqual([['P', 'p', 5, ['p', 'k']]]);
    expect(treeFromPaths([{ id: 'x', path: '/X', tris: 1 }]).map((n) => n.name)).toEqual(['X']);
    expect(treeFromPaths([{ id: 'x', path: '/X', tris: 1, instances: 3 }])[0].name).toBe('X ×3');
  });
});

describe('rowNames', () => {
  it('names rows by their own name, with parents in front only while names repeat', () => {
    expect(rowNames(['/A/Geom/Mesh', '/B/Geom/Mesh', '/C/x', '/Model/Block_A'], new Map([['/Model/Block_A', 'Block A']]))).toEqual(['A/Geom/Mesh', 'B/Geom/Mesh', 'x', 'Block A']);
    expect(rowNames(['/A/m', '/B/m', '/B/n'])).toEqual(['A/m', 'B/m', 'n']);
  });
});

describe('idsUnder', () => {
  it('maps a viewer selection of prims, ancestors or subtrees to the rows at or under them', () => {
    expect(idsUnder(['/Model/scene/Building_A'], rows)).toEqual(['a1', 'a2']);
    expect(idsUnder(['/Model/scene/b', '/Model/scene/wrapper/c'], rows)).toEqual(['b', 'c']);
    expect(idsUnder(['/Model/scene/Building'], rows)).toEqual([]); // a path prefix is not an ancestor
    expect(idsUnder(['/'], rows)).toHaveLength(4);
    expect(idsUnder([], rows)).toEqual([]);
    const copies = [{ id: 'chair', path: '/R/Chair_1/Geom/Mesh', paths: ['/R/Chair_1/Geom/Mesh', '/R/Chair_2/Geom/Mesh'] }];
    expect(idsUnder(['/R/Chair_2/Geom/Mesh'], copies)).toEqual(['chair']); // a click on any native instance
  });
});

describe('visibleRows', () => {
  it('shows children of open groups only, with depth', () => {
    expect(visibleRows(tree, new Set(), '').rows.map((r) => r.node.name)).toEqual(['Building A', 'b', 'c']);
    const open = visibleRows(tree, new Set([tree[0].key]), '').rows;
    expect(open.map((r) => `${r.depth}:${r.node.name}`)).toEqual(['0:Building A', '1:a1', '1:a2', '0:b', '0:c']);
  });
  it('filters by name and forces the ancestors of matches open', () => {
    expect(visibleRows(tree, new Set(), 'A2').rows.map((r) => r.node.name)).toEqual(['Building A', 'a2']);
    expect(visibleRows(tree, new Set(), 'building').rows.map((r) => r.node.name)).toEqual(['Building A']); // matched group stays as the user left it
    expect(visibleRows(tree, new Set([tree[0].key]), 'building').rows).toHaveLength(3);
  });
  it('caps the rows and counts the rest', () => {
    const r = visibleRows(tree, new Set([tree[0].key]), '', 2);
    expect(r.rows).toHaveLength(2);
    expect(r.more).toBe(3);
  });
});
