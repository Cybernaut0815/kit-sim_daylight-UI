import { BufferGeometry, Float32BufferAttribute, Group, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial } from 'three';
import { describe, expect, it } from 'vitest';
import { extract } from './extract';

const close = (got: ArrayLike<number>, want: number[]) => {
  expect(got.length).toBe(want.length);
  want.forEach((w, i) => expect(got[i]).toBeCloseTo(w, 9));
};

describe('extract', () => {
  it('a Z-up stage in centimetres comes out in its own coordinates, in metres; instances become one mesh, on demand', () => {
    const root = new Group(); // the viewer's root turns a Z-up stage Y-up
    root.rotation.x = -Math.PI / 2;
    const geometry = new BufferGeometry().setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3)).setIndex([0, 1, 2]);
    const mesh = new Mesh(geometry); // as the viewer attaches it: the world matrix in stage space, frozen
    mesh.matrixAutoUpdate = false;
    mesh.matrix.makeTranslation(10, 20, 30);
    const inst = new InstancedMesh(geometry, new MeshBasicMaterial(), 2); // instance matrices in stage space, object at identity
    inst.setMatrixAt(0, new Matrix4().makeTranslation(100, 0, 0));
    inst.setMatrixAt(1, new Matrix4().makeTranslation(0, 100, 0));
    const unused = new InstancedMesh(geometry, new MeshBasicMaterial(), 1); // a prototype no instance uses
    unused.count = 0;
    const hidden = new Mesh(geometry);
    hidden.visible = false;
    root.add(mesh, inst, unused, hidden);
    const items = [
      { rid: 1, path: '/W/M', kind: 'mesh', object: mesh }, { rid: 2, path: '/W/P', kind: 'mesh', object: inst }, { rid: 6, path: '/W/U', kind: 'mesh', object: unused },
      { rid: 3, path: '/W/H', kind: 'mesh', object: hidden }, { rid: 4, path: '/W/C', kind: 'curves', object: mesh }, { rid: 5, path: '/W/Cam', kind: 'camera', object: null },
    ];
    const out = extract(items, root, 0.01);
    expect(out.map((e) => [e.item.path, e.instances, e.tris, e.verts])).toEqual([['/W/M', 0, 1, 3], ['/W/P', 2, 2, 6]]);
    close(out[0].obj!.positions, [0.1, 0.2, 0.3, 0.11, 0.2, 0.3, 0.1, 0.21, 0.3]);
    expect(Array.from(out[0].obj!.indices)).toEqual([0, 1, 2]);
    expect(out[1].obj).toBeUndefined(); // built on first use
    const all = out[1].make!();
    close(all.positions, [1, 0, 0, 1.01, 0, 0, 1, 0.01, 0, 0, 1, 0, 0.01, 1, 0, 0, 1.01, 0]);
    expect(Array.from(all.indices)).toEqual([0, 1, 2, 3, 4, 5]);
    expect([out[0].materials, out[1].materials, out[0].obj!.slots, all.slots]).toEqual([[0], [0], undefined, undefined]); // no material, no subsets: one slot
  });
  it("a mesh's subsets (its geometry groups) become optics slots per triangle, every instanced copy keeping them", () => {
    // three triangles: 0 and 1 in the first subset, 2 in the second (the viewer orders a mesh's triangles by subset)
    const geometry = new BufferGeometry().setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 2, 0, 0, 3, 0, 0, 2, 1, 0], 3)).setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6]);
    geometry.addGroup(0, 6, 0);
    geometry.addGroup(6, 3, 1);
    const subsets = [{ start: 0, count: 6, material: 7 }, { start: 6, count: 3, material: 9 }];
    const facade = new Mesh(geometry), plain = new Mesh(new BufferGeometry().setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3)).setIndex([0, 1, 2]));
    const inst = new InstancedMesh(geometry, new MeshBasicMaterial(), 2);
    inst.setMatrixAt(0, new Matrix4());
    inst.setMatrixAt(1, new Matrix4().makeTranslation(10, 0, 0));
    const root = new Group();
    root.add(facade, plain, inst);
    const out = extract([
      { rid: 1, path: '/W/Facade', kind: 'mesh', object: facade, material: 5, subsets }, // the mesh's own material lives on in a subset
      { rid: 2, path: '/W/Wall', kind: 'mesh', object: plain, material: 5, subsets: null },
      { rid: 3, path: '/W/Scatter', kind: 'mesh', object: inst, material: 5, subsets },
    ], root, 1);
    expect(out.map((e) => e.materials)).toEqual([[7, 9], [5], [7, 9]]);
    expect(Array.from(out[0].obj!.slots!)).toEqual([0, 0, 1]);
    expect(out[1].obj!.slots).toBeUndefined(); // every triangle slot 0
    const all = out[2].make!();
    expect(Array.from(all.slots!)).toEqual([0, 0, 1, 0, 0, 1]);
    expect(all.slots!.length).toBe(all.indices.length / 3);
  });
  it('a group range not on a triangle boundary takes the triangles it starts (start <= 3t < start + count)', () => {
    const geometry = new BufferGeometry().setAttribute('position', new Float32BufferAttribute(new Array(27).fill(0), 3)).setIndex([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    geometry.addGroup(0, 4, 0); // indices 0..3: triangles 0 and 1 start in it
    geometry.addGroup(4, 5, 1); // indices 4..8: triangle 2
    const mesh = new Mesh(geometry), root = new Group();
    root.add(mesh);
    expect(Array.from(extract([{ rid: 1, path: '/M', kind: 'mesh', object: mesh }], root, 1)[0].obj!.slots!)).toEqual([0, 0, 1]);
  });
});
