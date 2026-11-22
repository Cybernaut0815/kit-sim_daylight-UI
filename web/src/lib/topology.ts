// A receiver as a run sees it: the file's own faces and points behind the triangles the viewer draws.
// The viewer fans every polygon into triangles and draws points that share a position (and per-point values) as one
// vertex, which three.js needs and which is right for looking at a model. A run must not take that as the mesh: a quad
// is one face, and two parts that only meet at a position are two parts (a vertex of each, each with its own normal).
// The viewer core says which polygon each drawn triangle came from and which authored point each corner names
// (meshMap); from that a receiver is sent as its polygons over its own points, and its result rows (one per face, or one
// per point) are mapped back onto the drawn triangles here.
// A receiver without a topology (the mock core, a mesh drawn without an index) is sent as drawn: a row per triangle or
// per drawn vertex. Everything below takes `null` for that form.
import type { MeshMap } from 'usd-viewer';

export interface Topology {
  faces: number; points: number;
  /** The most corners a face has (Ladybug mode takes faces of 3 or 4). */
  corners: number;
  /** Face row r draws the triangles faceStart[r] .. faceStart[r + 1] - 1: the rows are the polygons in drawn order. */
  faceStart: Int32Array;
  /** The point row at drawn corner c (position 3t + j in geometry.index).
   *  ponytail: 12 B per triangle while the receiver's geometry lives; rebuild per use from meshMap if that hurts */
  cornerRow: Int32Array;
  /** A drawn vertex at each point row: where the point is. */
  pointVertex: Int32Array;
  /** leftHanded in the file: a fan's triangles are drawn (c0, ci+1, ci). */
  flipped: boolean;
}

/**
 * The topology behind drawn triangles `index` (3 per triangle), or null when the map does not fit them. A polygon's
 * triangles are consecutive and fan from its first corner (protocol.ts MeshMap). Points: the authored ones (`indices`,
 * a mesh drawn with its own faces), else the surface's vertices (`weld`: a refined surface, an implicit shape, a core
 * without `indices`); only those a drawn face uses get a row, in order of first use.
 * Null too when it would say nothing the drawn mesh does not: every face a triangle, every point drawn as exactly one
 * vertex and every vertex one point (a triangulated export without repeated points, most large models). Such a mesh is
 * sent as drawn: the same faces and the same shared points, with the bytes, the content id and no map to keep.
 */
export function receiverTopology(index: ArrayLike<number>, map: Pick<MeshMap, 'faces' | 'counts' | 'weld' | 'flipped'> & { indices?: ArrayLike<number> | null }): Topology | null {
  const { faces, flipped, weld } = map, T = faces.length;
  if (!T || 3 * T !== index.length) return null;
  const starts = new Int32Array(T + 1);
  let F = 0;
  for (let t = 0; t < T; t++) if (!t || faces[t] !== faces[t - 1]) starts[F++] = t;
  starts[F] = T;
  // the authored corners, when every run is one whole face of `counts`
  let off: Int32Array | null = null;
  const { counts, indices } = map;
  if (counts && indices) {
    off = new Int32Array(counts.length + 1);
    for (let p = 0; p < counts.length; p++) off[p + 1] = off[p] + counts[p];
    if (off[counts.length] !== indices.length) off = null;
    for (let r = 0; r < F && off; r++) { const p = faces[starts[r]]; if (!(p >= 0 && p < counts.length) || starts[r + 1] - starts[r] + 2 !== counts[p]) off = null; }
  }
  const ids = off ? indices! : null;
  let top = -1;
  if (ids) { for (let i = 0; i < ids.length; i++) if (ids[i] > top) top = ids[i]; } else for (let c = 0; c < index.length; c++) { const v = weld ? weld[index[c]] : index[c]; if (v > top) top = v; }
  const rowOf = new Int32Array(top + 1).fill(-1), cornerRow = new Int32Array(3 * T), pointVertex = new Int32Array(top + 1);
  let drawn = 0;
  for (let c = 0; c < index.length; c++) if (index[c] >= drawn) drawn = index[c] + 1;
  const rowAt = new Int32Array(drawn).fill(-1); // the point row at each drawn vertex, while there is one for each
  let P = 0, most = 3, same = F === T;
  for (let r = 0; r < F; r++) {
    const t0 = starts[r], at = off ? off[faces[t0]] : 0;
    most = Math.max(most, starts[r + 1] - t0 + 2);
    for (let t = t0; t < starts[r + 1]; t++) {
      for (let j = 0; j < 3; j++) {
        const c = 3 * t + j, v = index[c];
        // corner j of the fan's triangle i is the polygon's corner 0, i + 1 or i + 2 (the last two swapped when flipped)
        const id = ids ? ids[at + (j === 0 ? 0 : (j === 1) !== flipped ? t - t0 + 1 : t - t0 + 2)] : weld ? weld[v] : v;
        if (!(id >= 0 && id <= top)) return null;
        let row = rowOf[id];
        if (row < 0) { row = rowOf[id] = P; pointVertex[P++] = v; }
        cornerRow[c] = row;
        if (same) { if (rowAt[v] < 0) rowAt[v] = row; same = rowAt[v] === row && pointVertex[row] === v; } // two points at a vertex, or a point at two
      }
    }
  }
  if (same) return null;
  return { faces: F, points: P, corners: most, faceStart: starts.slice(0, F + 1), cornerRow, pointVertex: pointVertex.slice(0, P), flipped };
}

/**
 * The topology as polygons for a .dmesh: each face's corners (point rows) in the winding the viewer draws (right-handed;
 * a mirrored world matrix is toDmesh's to turn), and their counts.
 */
export function polygons(t: Topology): { counts: Int32Array; indices: Int32Array } {
  const { faceStart: s, cornerRow: c } = t, counts = new Int32Array(t.faces), indices = new Int32Array(c.length / 3 + 2 * t.faces);
  let k = 0;
  for (let r = 0; r < t.faces; r++) {
    const t0 = s[r], t1 = s[r + 1];
    counts[r] = t1 - t0 + 2;
    indices[k++] = c[3 * t0];
    // drawn (c0, ci+1, ci+2): the fan in order; drawn (c0, ci+2, ci+1) when flipped: the same turn is the fan backwards
    if (!t.flipped) { indices[k++] = c[3 * t0 + 1]; for (let i = t0; i < t1; i++) indices[k++] = c[3 * i + 2]; }
    else { indices[k++] = c[3 * (t1 - 1) + 1]; for (let i = t1 - 1; i >= t0; i--) indices[k++] = c[3 * i + 2]; }
  }
  return { counts, indices };
}

/** The face row that drew triangle `tri` (null: a row per triangle). */
export function faceRow(t: Topology | null, tri: number): number {
  if (!t) return tri;
  let lo = 0, hi = t.faces; // the last row starting at or before tri
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (t.faceStart[mid] <= tri) lo = mid; else hi = mid; }
  return lo;
}
/** The point row at drawn corner `c` of geometry index `index` (null: a row per drawn vertex). */
export const pointRow = (t: Topology | null, index: ArrayLike<number>, c: number): number => (t ? t.cornerRow[c] : index[c]);

/**
 * A receiver's rows as the viewer paints them and a drawn-mesh export writes them: one value per drawn triangle
 * ('faces') or per drawn corner ('vertices'), each through `f` when given. Without a topology and without `f` the face
 * rows are the triangles: returned as they are, no copy.
 */
export function drawnValues(rows: Float32Array, t: Topology | null, on: 'faces' | 'vertices', index: ArrayLike<number>, f?: (v: number) => number): Float32Array {
  if (on === 'faces') {
    if (!t) return f ? rows.map(f) : rows;
    const out = new Float32Array(t.cornerRow.length / 3);
    for (let r = 0; r < t.faces; r++) out.fill(f ? f(rows[r]) : rows[r], t.faceStart[r], t.faceStart[r + 1]);
    return out;
  }
  const at = t ? t.cornerRow : index, out = new Float32Array(at.length);
  for (let c = 0; c < at.length; c++) out[c] = f ? f(rows[at[c]]) : rows[at[c]];
  return out;
}

/**
 * Each row's area from the drawn triangles' (`tri`): a face row's triangles summed, a point row a third of every
 * triangle with a corner there (Σ rows = Σ triangles either way).
 */
export function rowAreas(tri: ArrayLike<number>, t: Topology, on: 'faces' | 'vertices'): Float64Array {
  const out = new Float64Array(on === 'faces' ? t.faces : t.points);
  if (on === 'faces') { for (let r = 0; r < t.faces; r++) for (let i = t.faceStart[r]; i < t.faceStart[r + 1]; i++) out[r] += tri[i]; }
  else for (let i = 0; i < tri.length; i++) for (let j = 0; j < 3; j++) out[t.cornerRow[3 * i + j]] += tri[i] / 3;
  return out;
}
