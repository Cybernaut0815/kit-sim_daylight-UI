import { BoxGeometry, BufferGeometry, Float32BufferAttribute, Group, Mesh } from 'three';
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
});
