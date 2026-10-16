import { BufferGeometry, Float32BufferAttribute, Group, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial } from 'three';
import { describe, expect, it } from 'vitest';
import { extract } from './extract';

const close = (got: ArrayLike<number>, want: number[]) => {
  expect(got.length).toBe(want.length);
  want.forEach((w, i) => expect(got[i]).toBeCloseTo(w, 9));
};

describe('extract', () => {
  it('a Z-up stage in centimetres comes out in its own coordinates, in metres; instances become one mesh', () => {
    const root = new Group(); // the viewer's root turns a Z-up stage Y-up
    root.rotation.x = -Math.PI / 2;
    const geometry = new BufferGeometry().setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3)).setIndex([0, 1, 2]);
    const mesh = new Mesh(geometry); // as the viewer attaches it: the world matrix in stage space, frozen
    mesh.matrixAutoUpdate = false;
    mesh.matrix.makeTranslation(10, 20, 30);
    const inst = new InstancedMesh(geometry, new MeshBasicMaterial(), 2); // instance matrices in stage space, object at identity
    inst.setMatrixAt(0, new Matrix4().makeTranslation(100, 0, 0));
    inst.setMatrixAt(1, new Matrix4().makeTranslation(0, 100, 0));
    const hidden = new Mesh(geometry);
    hidden.visible = false;
    root.add(mesh, inst, hidden);
    const items = [
      { rid: 1, path: '/W/M', kind: 'mesh', object: mesh }, { rid: 2, path: '/W/P', kind: 'mesh', object: inst },
      { rid: 3, path: '/W/H', kind: 'mesh', object: hidden }, { rid: 4, path: '/W/C', kind: 'curves', object: mesh }, { rid: 5, path: '/W/Cam', kind: 'camera', object: null },
    ];
    const out = extract(items, root, 0.01);
    expect(out.map((e) => [e.item.path, e.instances])).toEqual([['/W/M', 0], ['/W/P', 2]]);
    close(out[0].obj.positions, [0.1, 0.2, 0.3, 0.11, 0.2, 0.3, 0.1, 0.21, 0.3]);
    expect(Array.from(out[0].obj.indices)).toEqual([0, 1, 2]);
    close(out[1].obj.positions, [1, 0, 0, 1.01, 0, 0, 1, 0.01, 0, 0, 1, 0, 0.01, 1, 0, 0, 1.01, 0]);
    expect(Array.from(out[1].obj.indices)).toEqual([0, 1, 2, 3, 4, 5]);
  });
});
