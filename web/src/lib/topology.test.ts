import { describe, expect, it } from 'vitest';
import { drawnValues, faceRow, pointRow, polygons, receiverTopology, rowAreas } from './topology';
import { polygonCorners, rowsOnPolygons } from './usdexport';

// Two quads with 8 points of their own, points 4 and 7 at the positions of 1 and 2 (a CAD export: the viewer's smoke
// test '/Split'). The viewer draws 6 vertices: the coincident pairs as one each.
const SPLIT = {
  index: [0, 1, 2, 0, 2, 3, 1, 4, 5, 1, 5, 2],
  map: { faces: Int32Array.of(0, 0, 1, 1), counts: Int32Array.of(4, 4), indices: Int32Array.of(0, 1, 2, 3, 4, 5, 6, 7), weld: Uint32Array.of(0, 1, 2, 3, 5, 6), flipped: false },
};
// A quad, a triangle in a material subset (drawn first) and a hole: the smoke test's '/World/Poly'.
const POLY = {
  index: [1, 4, 2, 0, 1, 2, 0, 2, 3],
  map: { faces: Int32Array.of(1, 0, 0), counts: Int32Array.of(4, 3, 4), indices: Int32Array.of(0, 1, 2, 3, 1, 4, 2, 3, 2, 4, 0), weld: null, flipped: false },
};

describe('receiverTopology', () => {
  it('two parts that only share positions stay two parts: a row per authored point, a face per quad', () => {
    const t = receiverTopology(SPLIT.index, SPLIT.map)!;
    expect([t.faces, t.points, t.corners, t.flipped]).toEqual([2, 8, 4, false]);
    expect([...t.faceStart]).toEqual([0, 2, 4]);
    expect([...t.cornerRow]).toEqual([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
    expect([...t.pointVertex]).toEqual([0, 1, 2, 3, 1, 4, 5, 2]); // rows 4 and 7 sit at the drawn vertices of 1 and 2
    const p = polygons(t);
    expect([[...p.counts], [...p.indices]]).toEqual([[4, 4], [0, 1, 2, 3, 4, 5, 6, 7]]);
  });
  it('without the authored corners the surface vertices stand in: the welded points are one (a core that has none)', () => {
    const t = receiverTopology(SPLIT.index, { ...SPLIT.map, indices: null })!;
    expect([t.faces, t.points]).toEqual([2, 6]);
    expect([...polygons(t).indices]).toEqual([0, 1, 2, 3, 1, 4, 5, 2]);
  });
  it('rows follow the drawn order (a subset first), a hole has none; only points in use get a row', () => {
    const t = receiverTopology(POLY.index, POLY.map)!;
    expect([t.faces, t.points, t.corners]).toEqual([2, 5, 4]);
    expect([...t.faceStart]).toEqual([0, 1, 3]);
    expect([...t.cornerRow]).toEqual([0, 1, 2, 3, 0, 2, 3, 2, 4]); // authored 1, 4, 2 | 0, 1, 2 | 0, 2, 3 by first use
    const p = polygons(t);
    expect([[...p.counts], [...p.indices]]).toEqual([[3, 4], [0, 1, 2, 3, 0, 2, 4]]);
    // back onto the file's polygons: face 0 is row 1, face 1 row 0, the hole nothing; per corner the point rows
    const poly = polygonCorners(POLY.index, POLY.map);
    expect([...rowsOnPolygons(t, poly, true)]).toEqual([1, 0, -1]);
    expect([...rowsOnPolygons(t, poly, false)]).toEqual([3, 0, 2, 4, 0, 1, 2, -1, -1, -1, -1]);
  });
  it('a leftHanded quad: drawn (c0, c2, c1), (c0, c3, c2); its polygon is sent in the drawn turn', () => {
    const index = [0, 2, 1, 0, 3, 2], map = { faces: Int32Array.of(0, 0), counts: Int32Array.of(4), indices: Int32Array.of(0, 1, 2, 3), weld: null, flipped: true };
    const t = receiverTopology(index, map)!;
    expect([...t.cornerRow]).toEqual([0, 1, 2, 0, 3, 1]); // rows by first use: authored 0, 2, 1, 3
    const at = [...polygons(t).indices].map((row) => index[[...t.cornerRow].indexOf(row)]);
    expect(at).toEqual([0, 3, 2, 1]); // drawn vertices: the fan (0, 3, 2), (0, 2, 1) turns as the drawn triangles do
    expect([...rowsOnPolygons(t, polygonCorners(index, map), false)].map((row) => index[[...t.cornerRow].indexOf(row)])).toEqual([0, 1, 2, 3]);
  });
  it('a refined surface (no counts): the runs are its faces, the surface vertices its points', () => {
    const t = receiverTopology([0, 1, 2, 0, 2, 3, 4, 5, 6], { faces: Int32Array.of(7, 7, 9), counts: null, weld: Uint32Array.of(0, 1, 2, 3, 1, 2, 8), flipped: false })!;
    expect([t.faces, t.points, [...t.faceStart]]).toEqual([2, 5, [0, 2, 3]]);
    expect([...t.cornerRow]).toEqual([0, 1, 2, 0, 2, 3, 1, 2, 4]);
  });
  it('null when the map is for other triangles; counts that do not fit the runs fall back to the surface vertices', () => {
    expect(receiverTopology([0, 1, 2], SPLIT.map)).toBeNull();
    expect(receiverTopology([], { faces: new Int32Array(0), counts: null, weld: null, flipped: false })).toBeNull();
    const t = receiverTopology(SPLIT.index, { ...SPLIT.map, counts: Int32Array.of(4, 5) })!;
    expect(t.points).toBe(6);
  });
});

describe('rows on the drawn triangles', () => {
  const t = receiverTopology(SPLIT.index, SPLIT.map)!;
  it('faceRow / pointRow: the row behind a drawn triangle or corner; as drawn without a topology', () => {
    expect([0, 1, 2, 3].map((tri) => faceRow(t, tri))).toEqual([0, 0, 1, 1]);
    expect(faceRow(null, 3)).toBe(3);
    expect([pointRow(t, SPLIT.index, 6), pointRow(null, SPLIT.index, 6)]).toEqual([4, 1]); // the second quad's own point, not the welded vertex
  });
  it('drawnValues: a face on each of its triangles, a point on the corners that name it', () => {
    expect([...drawnValues(Float32Array.of(10, 20), t, 'faces', [])]).toEqual([10, 10, 20, 20]);
    const rows = Float32Array.of(0, 1, 2, 3, 4, 5, 6, 7);
    expect([...drawnValues(rows, t, 'vertices', SPLIT.index)]).toEqual([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]); // the drawn vertex 1 shows 1 and 4
    expect([...drawnValues(rows, t, 'vertices', SPLIT.index, (v) => 2 * v)].slice(6, 9)).toEqual([8, 10, 12]);
    const drawn = Float32Array.of(1, 2, 3, 4);
    expect(drawnValues(drawn, null, 'faces', [])).toBe(drawn); // as drawn: the column's own rows, no copy
    expect([...drawnValues(Float32Array.of(1, 2, 3, 4, 5, 6), null, 'vertices', SPLIT.index)]).toEqual([1, 2, 3, 1, 3, 4, 2, 5, 6, 2, 6, 3]);
  });
  it('rowAreas: a face its triangles, a point a third of each triangle at it; both sum to the triangles', () => {
    const tri = [0.5, 0.5, 1, 1];
    expect([...rowAreas(tri, t, 'faces')]).toEqual([1, 2]);
    const v = rowAreas(tri, t, 'vertices');
    expect(v.length).toBe(8);
    expect(v[0]).toBeCloseTo(1 / 3, 12); // both triangles of the first quad
    expect(v[4]).toBeCloseTo(2 / 3, 12);
    expect(v.reduce((a, b) => a + b, 0)).toBeCloseTo(3, 12);
  });
});
