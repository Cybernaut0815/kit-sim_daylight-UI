import { createHash } from 'node:crypto';
import { BufferGeometry, Float32BufferAttribute, Group, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial } from 'three';
import { describe, expect, it, vi } from 'vitest';
import { fromThree, toDmesh } from 'daylight-mesh';
import { extract, jobMeshes } from './extract';

const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');

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
      { rid: 1, path: '/W/M', kind: 'mesh', object: mesh }, { rid: 2, path: '/W/P', kind: 'mesh', object: inst, instances: inst.instanceMatrix.array as Float32Array }, { rid: 6, path: '/W/U', kind: 'mesh', object: unused, instances: new Float32Array(0) },
      { rid: 3, path: '/W/H', kind: 'mesh', object: hidden }, { rid: 4, path: '/W/C', kind: 'curves', object: mesh }, { rid: 5, path: '/W/Cam', kind: 'camera', object: null },
    ];
    const out = extract(items, root, 0.01);
    expect(out.map((e) => [e.item.path, e.instances, e.tris, e.verts])).toEqual([['/W/M', 0, 1, 3], ['/W/P', 2, 2, 6]]);
    close(out[0].make().positions, [0.1, 0.2, 0.3, 0.11, 0.2, 0.3, 0.1, 0.21, 0.3]);
    expect(Array.from(out[0].make().indices)).toEqual([0, 1, 2]);
    const all = out[1].make();
    close(all.positions, [1, 0, 0, 1.01, 0, 0, 1, 0.01, 0, 0, 1, 0, 0.01, 1, 0, 0, 1.01, 0]);
    expect(Array.from(all.indices)).toEqual([0, 1, 2, 3, 4, 5]);
    expect([out[0].materials, out[1].materials, out[0].make().slots, all.slots]).toEqual([[0], [0], undefined, undefined]); // no material, no subsets: one slot
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
      { rid: 3, path: '/W/Scatter', kind: 'mesh', object: inst, material: 5, subsets, instances: inst.instanceMatrix.array as Float32Array },
    ], root, 1);
    expect(out.map((e) => e.materials)).toEqual([[7, 9], [5], [7, 9]]);
    expect(Array.from(out[0].make().slots!)).toEqual([0, 0, 1]);
    expect(out[1].make().slots).toBeUndefined(); // every triangle slot 0
    const all = out[2].make();
    expect(Array.from(all.slots!)).toEqual([0, 0, 1, 0, 0, 1]);
    expect(all.slots!.length).toBe(all.indices.length / 3);
    // what the server gets: flags 1 and the slots after the indices; a mesh without subsets: flags 0, no block
    const bytes = out[0].dmesh();
    expect([new DataView(bytes.buffer).getUint32(4, true), Array.from(new Uint16Array(bytes.buffer, bytes.length - 6, 3))]).toEqual([1, [0, 0, 1]]);
    expect(new DataView(out[1].dmesh().buffer).getUint32(4, true)).toBe(0);
  });
  it('a single instance, which the viewer draws as a plain mesh placed by its matrix, is still an instanced shade', () => {
    const geometry = new BufferGeometry().setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3)).setIndex([0, 1, 2]);
    const at = new Matrix4().makeTranslation(10, 0, 0), one = new Mesh(geometry);
    one.matrixAutoUpdate = false;
    one.matrix.copy(at);
    const root = new Group();
    root.add(one);
    const [e] = extract([{ rid: 4, path: '/__Prototype_1/Cup', kind: 'mesh', object: one, material: 0, instances: new Float32Array(at.elements) }], root, 1);
    expect(e.instances).toBe(1);
    expect(Array.from(e.make().positions, (v) => v + 0)).toEqual([10, 0, 0, 11, 0, 0, 10, 0, 1]); // placed once, not twice (Y up to Z up)
  });
  it('a group range not on a triangle boundary takes the triangles it starts (start <= 3t < start + count)', () => {
    const geometry = new BufferGeometry().setAttribute('position', new Float32BufferAttribute(new Array(27).fill(0), 3)).setIndex([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    geometry.addGroup(0, 4, 0); // indices 0..3: triangles 0 and 1 start in it
    geometry.addGroup(4, 5, 1); // indices 4..8: triangle 2
    const mesh = new Mesh(geometry), root = new Group();
    root.add(mesh);
    expect(Array.from(extract([{ rid: 1, path: '/M', kind: 'mesh', object: mesh }], root, 1)[0].make().slots!)).toEqual([0, 0, 1]);
  });
  // a rotated root (Z-up stage), centimetres; meshes as the viewer attaches them: frozen world matrices
  const scene = () => {
    const root = new Group();
    root.rotation.x = -Math.PI / 2;
    const tri = () => new BufferGeometry().setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0], 3)).setIndex([0, 1, 2, 1, 3, 2]);
    const at = (g: BufferGeometry, m: Matrix4) => { const o = new Mesh(g); o.matrixAutoUpdate = false; o.matrix.copy(m); root.add(o); return o; };
    const facade = tri();
    facade.addGroup(0, 3, 0);
    facade.addGroup(3, 3, 1);
    const objects = [
      at(tri(), new Matrix4().makeTranslation(10, 20, 30)), // A
      at(tri(), new Matrix4().makeTranslation(10, 20, 30)), // A's twin: the same bytes
      at(tri(), new Matrix4().makeScale(-1, 1, 1).setPosition(3, 0, 0)), // mirrored
      at(facade, new Matrix4().makeTranslation(0, 5, 0)), // slotted
      at(tri().toNonIndexed(), new Matrix4().makeTranslation(0, 0, 7)), // a triangle soup
    ];
    const items = objects.map((object, k) => ({ rid: k + 1, path: `/W/M${k}`, kind: 'mesh', object }));
    return { root, objects, items };
  };
  it("dmesh() is the old eager conversion's bytes, make() its views (plain, twin, mirrored, slotted, non-indexed, instanced)", () => {
    const { root, objects, items } = scene();
    const inst = new InstancedMesh(objects[0].geometry, new MeshBasicMaterial(), 2);
    inst.setMatrixAt(0, new Matrix4().makeTranslation(1, 0, 0));
    inst.setMatrixAt(1, new Matrix4().makeTranslation(0, 1, 0));
    root.add(inst);
    const out = extract([...items, { rid: 9, path: '/W/S', kind: 'mesh', object: inst, instances: inst.instanceMatrix.array as Float32Array }], root, 0.01);
    out.slice(0, 5).forEach((e, k) => { // the old path: fromThree over a stand-in at the world matrix, with the slots
      const stand = new Mesh(objects[k].geometry);
      stand.matrixAutoUpdate = false;
      stand.matrix.copy(objects[k].matrixWorld);
      const old = fromThree([stand], { scale: 0.01 })[0], slots = k === 3 ? Uint16Array.of(0, 1) : undefined;
      expect(Buffer.from(e.dmesh()).equals(Buffer.from(toDmesh({ ...old, slots })))).toBe(true);
      expect([Array.from(e.make().positions), Array.from(e.make().indices)]).toEqual([Array.from(old.positions), Array.from(old.indices)]);
    });
    expect(Buffer.from(out[5].dmesh()).equals(Buffer.from(toDmesh(out[5].make())))).toBe(true);
  });
  it('jobMeshes: content ids, twins as h and h_2, a shade equal to a receiver salted, hashed once, a moved mesh refused', async () => {
    const { root, objects, items } = scene();
    const rows = extract(items, root, 0.01).map((e) => ({ ...e, dmesh: vi.fn(e.dmesh) }));
    const h = sha(rows[0].dmesh()), hm = sha(rows[2].dmesh()), hs = sha(rows[3].dmesh()), hn = sha(rows[4].dmesh());
    rows.forEach((r) => r.dmesh.mockClear());
    // receivers A, A's twin, the mirrored one; shades: the slotted one and a shade with A's bytes (its twin again)
    const job = [rows[0], rows[1], rows[2], rows[3], { ...rows[1], id: undefined, at: undefined }];
    const one = await jobMeshes(job, 3);
    const S = sha(`${h}\0ctx`);
    expect(one.ids).toEqual([h, h, hm, hs, S]);
    expect(one.stems).toEqual([h, `${h}_2`, hm, hs, S]);
    expect(one.hashed).toEqual([0, 1, 2, 3, 4]);
    expect(hn).not.toBe(h);
    const calls = () => job.map((r) => r.dmesh.mock.calls.length);
    const before = calls(), two = await jobMeshes(job, 3);
    expect([two.ids, two.hashed, calls()]).toEqual([one.ids, [], before]); // hashed once: no body built again
    objects[0].matrix.makeTranslation(1, 0, 0); // A moves
    objects[0].updateMatrixWorld(true);
    expect(() => two.meshes[0].dmesh()).toThrow(/changed while it was sent/); // the earlier job's body refuses the new bytes
    const three = await jobMeshes(job, 3);
    expect(three.hashed).toEqual([0]);
    expect(three.ids[0]).not.toBe(h);
    expect(Buffer.from(three.meshes[0].dmesh()).equals(Buffer.from(job[0].dmesh()))).toBe(true);
  });
});
