// The view analysis' field of view as the core traces it (kit-sim_core docs/views.md, Field of view): each element's
// frame (with the gaze), the ray grid and its cells, for the settings diagrams (charts/FieldDiagram.tsx) and the 3D
// preview's glyphs (viewer/viewfield.ts), and where the preview puts its eyes: a bounded sample of the receivers'
// triangles, however many there are. Pure: no three.js, no DOM.
import type { ViewSim } from '../store';
import { compass, type Vec3 } from './frame';

export type Pt = [number, number];
export type Fov = ViewSim['fov'];
export type Gaze = ViewSim['gaze'];
/** An element's view frame (model space, unit): forward (the gaze), right, up. */
export interface Frame { f: Vec3; r: Vec3; u: Vec3 }

const RAD = Math.PI / 180;
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/**
 * The core's frame for an element with this normal (model space; the reversed normal for a back side). All around
 * (`all`): one world frame, forward = true north, right = east, up = +Z. View mode: forward = the normal, right = the
 * horizontal normal x +Z, up = right x forward; a level gaze turns forward level, so up = +Z. A normal within 1e-3 of
 * vertical has no level direction: forward = the normal, right = east made square to it, either gaze.
 */
export function frameOf(normal: Vec3, north: number, gaze: Gaze, all = false): Frame {
  const { N, E } = compass(north);
  if (all) return { f: N, r: E, u: [0, 0, 1] };
  const len = Math.hypot(...normal), n: Vec3 = len > 0 ? [normal[0] / len, normal[1] / len, normal[2] / len] : [0, 0, 0];
  const l = Math.hypot(n[0], n[1]);
  let f = n, r: Vec3;
  if (l > 1e-3) {
    r = [n[1] / l, -n[0] / l, 0];
    if (gaze === 'level') f = [n[0] / l, n[1] / l, 0];
  } else {
    r = E;
    if (l > 0) { const d = r[0] * n[0] + r[1] * n[1] + r[2] * n[2], q: Vec3 = [r[0] - d * n[0], r[1] - d * n[1], r[2] - d * n[2]], k = Math.hypot(...q); r = [q[0] / k, q[1] / k, q[2] / k]; }
  }
  return { f, r, u: cross(r, f) };
}

/** A field direction in the frame's space: azimuth (deg, clockwise from forward; all around from north), elevation. */
export function dirOf({ f, r, u }: Frame, az: number, el: number): Vec3 {
  const [x, y, z] = local(az, el);
  return [x * r[0] + y * f[0] + z * u[0], x * r[1] + y * f[1] + z * u[1], x * r[2] + y * f[2] + z * u[2]];
}
/** The same in the frame's own axes: right, forward, up. */
const local = (az: number, el: number): Vec3 => { const c = Math.cos(el * RAD); return [c * Math.sin(az * RAD), c * Math.cos(az * RAD), Math.sin(el * RAD)]; };

export interface RayGrid {
  cols: number; rows: number; all: boolean; flat: boolean; // flat: one row along the horizon (LO = HI = 0)
  az: [number, number]; el: [number, number]; // the field's edges (deg): azimuth about the gaze (all around: from north), elevation
  azLines: number[]; elLines: number[]; // the cell edges a drawing shows: every k-th, at most `max` + 1, both ends kept
}

/** Every k-th of the edges 0..n, at most `max` + 1 of them, the last one too. */
function thin(n: number, max: number): number[] {
  const k = Math.max(1, Math.ceil(n / max)), out: number[] = [];
  for (let i = 0; i < n; i += k) out.push(i);
  out.push(n);
  return out;
}

/** The core's grid: round(H / cell) columns by round((HI - LO) / cell) rows, at least one each, equal cells. */
export function rayGrid([h, lo, hi]: Fov, cell: number, max = 8): RayGrid {
  const all = h === 360, flat = lo === 0 && hi === 0;
  const cols = Math.max(1, Math.round(h / cell)), rows = Math.max(1, Math.round((hi - lo) / cell));
  const az0 = all ? 0 : -h / 2;
  return {
    cols, rows, all, flat, az: [az0, az0 + h], el: [lo, hi],
    azLines: thin(cols, max).map((i) => az0 + (i * h) / cols),
    elLines: flat ? [0] : thin(rows, max).map((i) => lo + (i * (hi - lo)) / rows),
  };
}

/** Points along an arc from a to b (deg), about every `per`° (at most 24 pieces), both ends included. */
const steps = (a: number, b: number, per = 7.5) => { const n = Math.min(24, Math.max(2, Math.ceil(Math.abs(b - a) / per))); return Array.from({ length: n + 1 }, (_, i) => a + ((b - a) * i) / n); };
/** A point on the unit circle, `a` degrees clockwise from up (SVG: y down). */
const clock = (a: number): Pt => [Math.sin(a * RAD), -Math.cos(a * RAD)];

/** The field in plan (unit circle, y down): azimuth clockwise from up (the gaze; all around north), a wedge closed at
 *  the centre, or the whole circle. */
export function planOutline(g: RayGrid): Pt[] {
  const arc = steps(g.az[0], g.az[1], 5).map(clock);
  return g.all ? arc : [[0, 0], ...arc, [0, 0]];
}
/** The field from the side (unit circle, y down): the gaze to the right, LO to HI as a wedge closed at the eye; a flat
 *  field is one line along the horizon. */
export function sectionOutline(g: RayGrid): Pt[] {
  return g.flat ? [[0, 0], [1, 0]] : [[0, 0], ...steps(90 - g.el[1], 90 - g.el[0], 5).map(clock), [0, 0]];
}
/** Panorama coordinates, fractions of its width and height: azimuth across -180..180 about the gaze (all around
 *  0..360 from north), elevation from 90 at the top to -90 at the bottom. */
export const panX = (g: RayGrid, az: number): number => (g.all ? az / 360 : (az + 180) / 360);
export const panY = (el: number): number => (90 - el) / 180;

/** A glyph of the field at unit radius in the frame's axes (right, forward, up), the eye at the origin, as flat xyz
 *  arrays: `lines` pairs (the rays to the field's corners, its outline and its thinned cells: a ring or band all around,
 *  the rays of a flat field) and `tris` (the field's surface: a patch, a band, a fan). */
export function glyphOf(g: RayGrid): { lines: Float32Array; tris: Float32Array } {
  const L: number[] = [], T: number[] = [];
  const seg = (a: Vec3, b: Vec3) => L.push(...a, ...b);
  const curve = (pts: Vec3[]) => { for (let i = 1; i < pts.length; i++) seg(pts[i - 1], pts[i]); };
  const [a0, a1] = g.az, [lo, hi] = g.el, eye: Vec3 = [0, 0, 0];
  const azs = g.all ? g.azLines.slice(0, -1) : g.azLines; // all around the last edge is the first
  if (g.flat) {
    curve(steps(a0, a1).map((a) => local(a, 0)));
    for (const a of azs) seg(eye, local(a, 0));
    const s = steps(a0, a1, 15);
    for (let i = 1; i < s.length; i++) T.push(...eye, ...local(s[i - 1], 0), ...local(s[i], 0));
  } else {
    for (const a of azs) curve(steps(lo, hi).map((e) => local(a, e)));
    for (const e of g.elLines) curve(steps(a0, a1).map((a) => local(a, e)));
    if (g.all) { seg(eye, local(0, lo)); seg(eye, local(0, hi)); } // north
    else for (const a of [a0, a1]) for (const e of [lo, hi]) seg(eye, local(a, e));
    const sa = steps(a0, a1, 15), se = steps(lo, hi, 15);
    for (let i = 1; i < sa.length; i++) for (let j = 1; j < se.length; j++) {
      const p = local(sa[i - 1], se[j - 1]), q = local(sa[i], se[j - 1]), r = local(sa[i], se[j]), s = local(sa[i - 1], se[j]);
      T.push(...p, ...q, ...r, ...p, ...r, ...s);
    }
  }
  return { lines: new Float32Array(L), tris: new Float32Array(T) };
}

// ---- where the preview's eyes go -----------------------------------------------------------------------------------

/** A receiver's drawn triangles: local positions, indices (null: unindexed) and its local-to-world matrix (column-major). */
export interface EyeMesh { positions: ArrayLike<number>; indices: ArrayLike<number> | null; matrix: ArrayLike<number> }
/** Triangles the eyes may sit on (world): centroid, first corner and unit normal, xyz each. */
export interface Candidates { centroid: Float32Array; corner: Float32Array; normal: Float32Array; count: number }
/** The most candidate triangles taken from all receivers together. */
export const CANDIDATES = 50_000;

/** At most about `max` triangles of the meshes (at least one each), a global stride through each, as world centroids,
 *  corners and unit normals; degenerate triangles are skipped. A mirroring matrix turns the normal, as the core's input
 *  turns a mirrored mesh's triangles. */
export function candidatesOf(meshes: readonly EyeMesh[], max = CANDIDATES): Candidates {
  const tris = meshes.map((m) => Math.floor((m.indices ? m.indices.length : m.positions.length / 3) / 3));
  const total = tris.reduce((s, t) => s + t, 0), stride = Math.max(1, Math.ceil(total / max));
  const room = tris.reduce((s, t) => s + (t ? Math.max(1, Math.floor(t / stride)) : 0), 0);
  const centroid = new Float32Array(3 * room), corner = new Float32Array(3 * room), normal = new Float32Array(3 * room);
  let count = 0;
  meshes.forEach((m, k) => {
    const t = tris[k], M = m.matrix, P = m.positions, I = m.indices;
    if (!t) return;
    const det = M[0] * (M[5] * M[10] - M[9] * M[6]) - M[4] * (M[1] * M[10] - M[9] * M[2]) + M[8] * (M[1] * M[6] - M[5] * M[2]), s = det < 0 ? -1 : 1;
    const at = (v: number): Vec3 => { const x = P[3 * v], y = P[3 * v + 1], z = P[3 * v + 2]; return [M[0] * x + M[4] * y + M[8] * z + M[12], M[1] * x + M[5] * y + M[9] * z + M[13], M[2] * x + M[6] * y + M[10] * z + M[14]]; };
    const n = Math.max(1, Math.floor(t / stride)), step = t / n;
    for (let j = 0; j < n; j++) {
      const f = Math.min(t - 1, Math.floor((j + 0.5) * step));
      const a = at(I ? I[3 * f] : 3 * f), b = at(I ? I[3 * f + 1] : 3 * f + 1), c = at(I ? I[3 * f + 2] : 3 * f + 2);
      const x = cross([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]), l = Math.hypot(...x);
      if (!(l > 0)) continue;
      for (let i = 0; i < 3; i++) {
        centroid[3 * count + i] = (a[i] + b[i] + c[i]) / 3;
        corner[3 * count + i] = a[i];
        normal[3 * count + i] = (s * x[i]) / l;
      }
      count++;
    }
  });
  return { centroid, corner, normal, count };
}

/** The preview's eyes (world): positions and unit looking directions, xyz each. */
export interface Eyes { p: Float32Array; n: Float32Array; count: number }
export interface EyeOptions {
  spacing: number; max: number; // the first voxel size (world units) and the most glyphs drawn
  on: ViewSim['on']; sides: ViewSim['sides']; offset: number; // offset: along each side's normal, world units
  keep?: (x: number, y: number, z: number) => boolean; // what the section leaves
}

/**
 * Eyes from the candidates: one per voxel of `spacing` and dominant normal axis (so both faces of a thin wall keep
 * theirs), the voxels grown until at most `max` glyphs remain (both sides: two per eye), first candidates first. On
 * vertices an eye sits at a triangle's first corner (near a vertex, not on each). Each side's eye moves `offset` along
 * its own normal, as the core's do; a back side looks along the reversed normal.
 */
export function sampleEyes(c: Candidates, o: EyeOptions): Eyes {
  const per = o.sides === 'both' ? 2 : 1, cap = Math.max(1, Math.floor(o.max / per)), C = c.centroid, N = c.normal;
  const live: number[] = [];
  for (let i = 0; i < c.count; i++) if (!o.keep || o.keep(C[3 * i], C[3 * i + 1], C[3 * i + 2])) live.push(i);
  const axis = (i: number) => {
    const x = Math.abs(N[3 * i]), y = Math.abs(N[3 * i + 1]), z = Math.abs(N[3 * i + 2]), k = x >= y && x >= z ? 0 : y >= z ? 1 : 2;
    return 2 * k + (N[3 * i + k] < 0 ? 1 : 0);
  };
  let s = o.spacing > 0 ? o.spacing : 1, kept = live;
  for (let round = 0; round === 0 || (kept.length > cap && round < 40); round++) {
    const seen = new Set<string>(), next: number[] = [];
    for (const i of live) {
      const key = `${Math.floor(C[3 * i] / s)} ${Math.floor(C[3 * i + 1] / s)} ${Math.floor(C[3 * i + 2] / s)} ${axis(i)}`;
      if (!seen.has(key)) { seen.add(key); next.push(i); }
    }
    kept = next;
    s *= Math.max(1.25, Math.sqrt(kept.length / cap)); // a surface's eyes fall with the square of the spacing
  }
  if (kept.length > cap) { const k = kept.length / cap; kept = Array.from({ length: cap }, (_, j) => kept[Math.floor(j * k)]); }
  const at = o.on === 'vertices' ? c.corner : C, p = new Float32Array(3 * per * kept.length), n = new Float32Array(3 * per * kept.length);
  let j = 0;
  for (const i of kept) {
    for (const side of o.sides === 'front' ? [1] : o.sides === 'back' ? [-1] : [1, -1]) {
      for (let k = 0; k < 3; k++) {
        n[3 * j + k] = side * N[3 * i + k];
        p[3 * j + k] = at[3 * i + k] + side * N[3 * i + k] * o.offset;
      }
      j++;
    }
  }
  return { p, n, count: j };
}
