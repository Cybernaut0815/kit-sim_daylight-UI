import { BoxGeometry, Group, Mesh } from 'three';
import { describe, expect, it } from 'vitest';
import { buildTree, groupKeys, visibleRows } from './tree';

const mesh = (name: string) => { const m = new Mesh(new BoxGeometry()); m.name = name; m.userData.id = name; return m; };
const group = (name: string, ...kids: (Group | Mesh)[]) => { const g = new Group(); g.name = name; g.add(...kids); return g; };

// loadFiles wraps everything in an unnamed root; a file scene with a building group, a lone mesh, and a wrapper around one mesh
const a1 = mesh('a1'), a2 = mesh('a2'), b = mesh('b'), c = mesh('c');
const root = group('', group('scene', group('Building A', a1, a2), b, group('wrapper', c)));
const tree = buildTree(root, [a1, a2, b, c]);

describe('buildTree', () => {
  it('drops the root and single-child wrappers, keeps groups with their mesh ids and triangle counts', () => {
    expect(tree.map((n) => n.name)).toEqual(['Building A', 'b', 'c']);
    expect(tree[0].meshIds).toEqual(['a1', 'a2']);
    expect(tree[0].tris).toBe(24);
    expect(tree[1].meshId).toBe('b');
    expect(tree[1].children).toEqual([]);
    expect(groupKeys(tree)).toEqual([tree[0].key]);
    expect(buildTree(group(''), [])).toEqual([]);
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
