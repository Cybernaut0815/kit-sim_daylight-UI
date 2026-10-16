import { BoxGeometry, BufferGeometry, Float32BufferAttribute, Group, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { toUsda } from './usda';

describe('toUsda', () => {
  const box = new Mesh(new BoxGeometry()), mirror = new Mesh(new BoxGeometry()), part = new Group();
  box.name = mirror.name = '1st floor';
  box.position.set(512345.678, 0, -6543210.25); // survey coordinates: kept as doubles in the transform
  mirror.scale.set(-1, 1, 1);
  const tri = new Mesh(new BufferGeometry().setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, NaN, 0], 3))); // unnamed, non-indexed
  part.name = 'Block A';
  part.add(tri);
  const root = new Group();
  root.add(box, mirror, part);
  const { parts, names } = toUsda(root), text = parts.join('');

  it('writes a Y-up metre layer with an Xform or Mesh per node, named as USD identifiers unique per parent', () => {
    expect(text).toMatch(/^#usda 1\.0\n\(\n {4}defaultPrim = "Model"\n {4}metersPerUnit = 1\n {4}upAxis = "Y"\n\)/);
    expect(text.match(/def (Mesh|Xform) "\w+"/g)).toEqual(['def Xform "Model"', 'def Mesh "_1st_floor"', 'def Mesh "_1st_floor_2"', 'def Xform "Block_A"', 'def Mesh "Node"']);
    expect([...names]).toEqual([['/Model/_1st_floor', '1st floor'], ['/Model/_1st_floor_2', '1st floor'], ['/Model/Block_A', 'Block A']]);
  });
  it('keeps local matrices exact (translation in the last row, mirrors negative)', () => {
    expect(text).toContain('matrix4d xformOp:transform = ((1, 0, 0, 0), (0, 1, 0, 0), (0, 0, 1, 0), (512345.678, 0, -6543210.25, 1))');
    expect(text).toContain('matrix4d xformOp:transform = ((-1, 0, 0, 0), (0, 1, 0, 0), (0, 0, 1, 0), (0, 0, 0, 1))');
  });
  it('writes triangles, local points and vertex normals; a NaN becomes 0', () => {
    expect(text.match(/int\[\] faceVertexCounts = \[[^\]]*\]/g)?.map((s) => s.split(',').length)).toEqual([12, 12, 1]);
    expect(text).toContain('int[] faceVertexIndices = [0, 1, 2]\n'); // the non-indexed triangle
    expect(text).toContain('point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 0, 0)]\n');
    expect(text.match(/normal3f\[\] normals = \[[^\]]*\] \(interpolation = "vertex"\)/g)).toHaveLength(2);
    expect(text.match(/uniform token subdivisionScheme = "none"/g)).toHaveLength(3);
  });
  it('writes a GPU-instanced mesh (EXT_mesh_gpu_instancing) as a PointInstancer of its geometry, named by the node', () => {
    const trees = new InstancedMesh(new BoxGeometry(), new MeshBasicMaterial(), 2), kid = new Mesh(new BoxGeometry());
    trees.name = 'Oak trees';
    kid.name = 'Instances'; // the instancer's own name: the child gets another
    trees.setMatrixAt(1, new Matrix4().compose(new Vector3(10, 0, -5), new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2), new Vector3(1, 2, 1)));
    trees.add(kid);
    const r = new Group();
    r.add(trees);
    const { parts, names: n } = toUsda(r), t = parts.join('');
    expect(t).toContain('def Xform "Oak_trees"');
    expect(t).toContain('def PointInstancer "Instances"\n{\n    rel prototypes = [</Model/Oak_trees/Instances/Mesh>]\n    int[] protoIndices = [0, 0]\n');
    const nums = (decl: string) => (new RegExp(`${decl} = \\[(.*)\\]\\n`).exec(t)?.[1] ?? '').replace(/[()]/g, '').split(', ').map(Number);
    const near = (got: number[], want: number[]) => { expect(got).toHaveLength(want.length); want.forEach((w, i) => expect(got[i]).toBeCloseTo(w, 6)); };
    near(nums('point3f\\[\\] positions'), [0, 0, 0, 10, 0, -5]);
    near(nums('quath\\[\\] orientations'), [1, 0, 0, 0, Math.SQRT1_2, 0, Math.SQRT1_2, 0]); // (w, x, y, z)
    near(nums('float3\\[\\] scales'), [1, 1, 1, 1, 2, 1]);
    expect(t).toContain('def Mesh "Mesh"');
    expect(t).toContain('def Mesh "Instances_2"'); // the child, beside the instancer
    expect(n.get('/Model/Oak_trees/Instances')).toBe('Oak trees');
    expect(n.get('/Model/Oak_trees/Instances/Mesh')).toBe('Oak trees');
  });
});
