import { describe, expect, it } from 'vitest';
import { idsUnder, meshAt, rowNames, underIndex } from './tree';

// a converted file: everything under /Model; a building group, a lone mesh, and a wrapper around one mesh
const rows = [
  { id: 'a1', path: '/Model/scene/Building_A/a1' },
  { id: 'a2', path: '/Model/scene/Building_A/a2' },
  { id: 'b', path: '/Model/scene/b' },
  { id: 'c', path: '/Model/scene/wrapper/c' },
];
const copies = [{ id: 'chair', path: '/R/Chair_1/Geom/Mesh', paths: ['/R/Chair_1/Geom/Mesh', '/R/Chair_2/Geom/Mesh'] }];

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
    expect(idsUnder(['/R/Chair_2/Geom/Mesh'], copies)).toEqual(['chair']); // a click on any native instance
    expect(idsUnder(['/R/Chair_2'], copies)).toEqual(['chair']); // or on its parent
  });
});

describe('underIndex / meshAt', () => {
  it('lists the rows at or under every prim, copies included', () => {
    const index = underIndex([...rows, ...copies]);
    expect(index.get('/Model')).toEqual(['a1', 'a2', 'b', 'c']);
    expect(index.get('/Model/scene/Building_A')).toEqual(['a1', 'a2']);
    expect(index.get('/Model/scene/b')).toEqual(['b']);
    expect(index.get('/Model/scene/Building')).toBeUndefined(); // not an ancestor
    expect(index.get('/R/Chair_2')).toEqual(['chair']);
    expect(index.get('/R')).toEqual(['chair']); // once, though two copies are under it
    const at = meshAt([...rows, ...copies]);
    expect([at.get('/Model/scene/b'), at.get('/R/Chair_2/Geom/Mesh'), at.get('/Model/scene')]).toEqual(['b', 'chair', undefined]);
  });
});
