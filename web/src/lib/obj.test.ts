import { Mesh, type Material } from 'three';
import { describe, expect, it } from 'vitest';
import { parseObj, type ObjFaces } from './obj';
import { toUsda } from './usda';

// A quad and a triangle that share an edge (two materials), then a wall with points of its own on that edge.
const OBJ = `# roof and wall
o roof
v 0 0 0
v 1 0 0
v 1 1 0
v 0 1 0
v 2 0.5 0 1 0 0
vt 0 0
vt 1 0
vt 1 1
vt 0 1
vn 0 0 1
usemtl tiles
f 1/1/1 2/2/1 3/3/1 4/4/1
usemtl metal
f 2/2/1 5/1/1 \\
  3/3/1
g wall
v 1 0 0
v 1 1 0
v 1 1 -3
v 1 0 -3
f -4 -3 -2 -1
`;
const faces = (m: Mesh) => m.geometry.userData.obj as ObjFaces;

describe('parseObj', () => {
  const root = parseObj(OBJ), [roof, wall] = root.children as Mesh[];
  it('an object per o / g, each over the points its faces name: shared where the file shares them', () => {
    expect(root.children.map((c) => c.name)).toEqual(['roof', 'wall']);
    expect([[...faces(roof).counts], [...faces(roof).indices], roof.geometry.attributes.position.count]).toEqual([[4, 3], [0, 1, 2, 3, 1, 4, 2], 5]); // the quad is one face
    expect([[...faces(wall).counts], [...faces(wall).indices], wall.geometry.attributes.position.count]).toEqual([[4], [0, 1, 2, 3], 4]); // negative indices; its own points
    expect([...wall.geometry.attributes.position.array].slice(0, 6)).toEqual([1, 0, 0, 1, 1, 0]);
  });
  it('a fan index for three, vn and vt per corner, a group per material run; the material carries over', () => {
    expect([...roof.geometry.index!.array]).toEqual([0, 1, 2, 0, 2, 3, 1, 4, 2]);
    expect([faces(roof).normals!.length, [...faces(roof).st!]]).toEqual([21, [0, 0, 1, 0, 1, 1, 0, 1, 1, 0, 0, 0, 1, 1]]); // the continued line's corners too
    expect(faces(roof).groups).toEqual([{ start: 0, count: 1, materialIndex: 0 }, { start: 1, count: 1, materialIndex: 1 }]);
    expect(roof.geometry.groups.map((g) => [g.start, g.count, g.materialIndex])).toEqual([[0, 6, 0], [6, 3, 1]]);
    expect((roof.material as Material[]).map((m) => m.name)).toEqual(['tiles', 'metal']);
    expect([(wall.material as Material).name, faces(wall).normals, faces(wall).st, faces(wall).groups]).toEqual(['metal', null, null, []]);
    expect(roof.geometry.attributes.color).toBeUndefined(); // one coloured vertex of five: no colours
  });
  it('materials by name from the creator; vertex colours (sRGB in the file) when every point has one', () => {
    const known = Object.assign(new Mesh().material as Material, { name: 'tiles' });
    const [m] = parseObj(OBJ, (name) => (name === 'tiles' ? known : undefined)).children as Mesh[];
    expect((m.material as Material[])[0]).toBe(known);
    const [c] = parseObj('v 0 0 0 1 0.5 0\nv 1 0 0 1 0.5 0\nv 0 1 0 1 0.5 0\nf 1 2 3\n').children as Mesh[];
    expect(c.geometry.attributes.color.getY(0)).toBeCloseTo(0.214, 3);
    expect((c.material as Material).vertexColors).toBe(true);
  });
  it('a face that names a vertex the file does not have is refused, with its line', () => {
    expect(() => parseObj('v 0 0 0\nv 1 0 0\nf 1 2 3\n')).toThrow(/OBJ line 3: a face names vertex 3 of 2/);
  });
  it('toUsda writes the faces as they are: counts, shared indices, normals per corner, subsets by face', () => {
    const text = toUsda(root).parts.join('');
    expect(text).toContain('int[] faceVertexCounts = [4, 3]\n');
    expect(text).toContain('int[] faceVertexIndices = [0, 1, 2, 3, 1, 4, 2]\n');
    expect(text).toContain('int[] faceVertexCounts = [4]\n');
    expect(text.match(/normal3f\[\] normals = \[[^\]]*\] \(interpolation = "faceVarying"\)/g)?.map((s) => s.split('), (').length)).toEqual([7]);
    expect(text.match(/int\[\] indices = \[[^\]]*\]/g)).toEqual(['int[] indices = [0]', 'int[] indices = [1]']);
  });
});
