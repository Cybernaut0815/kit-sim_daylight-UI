// Framing and critical areas. Two spaces: model (the core's and the result rows' ObjMesh: metres, Z up) and three world
// (the viewer's: stage units, Y up; model = (X, -Z, Y) × metersPerUnit). True north is `north` degrees counter-clockwise
// from model +Y (the core's --north: 90 = west). Views are the viewer's free views (ViewState: eye, target, vertical
// fov, projection, orthographic half-height) in world; what an agent reads is in model metres. Pure: no three.js, no DOM.
import type { ViewState } from 'usd-viewer';
import { fmtNum } from './result';

export type Vec3 = [number, number, number];
export interface Box { min: Vec3; max: Vec3 }
/** A compass side to look from. */
export type Side = 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SW' | 'W' | 'NW';
/** Where a surface faces: up / down within 45° of vertical, else the nearest compass side. */
export type Facing = 'N' | 'E' | 'S' | 'W' | 'up' | 'down';
/** A shot's lens: vertical field of view (degrees), width / height, projection; the box fills 1 / margin of the frame. */
export interface Lens { fov: number; aspect: number; projection: ViewState['projection']; margin?: number }

const RAD = Math.PI / 180, DEG = 180 / Math.PI;
const SIDES: readonly Side[] = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const POINTS = 'N NNE NE ENE E ESE SE SSE S SSW SW WSW W WNW NW NNW'.split(' '), point = (b: number) => POINTS[Math.round(b / 22.5) % 16];
const SCREEN = ['right', 'top-right', 'top', 'top-left', 'left', 'bottom-left', 'bottom', 'bottom-right'];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: Vec3): Vec3 => { const l = Math.hypot(...a); return [a[0] / l, a[1] / l, a[2] / l]; };

/** Model metres -> three world: (x, z, -y) / mpu (mpu = the stage's metersPerUnit; 1 for a direction). */
export const toWorld = ([x, y, z]: Vec3, mpu = 1): Vec3 => [x / mpu, z / mpu, -y / mpu];
/** Three world -> model metres: (X, -Z, Y) × mpu. */
export const toModel = ([x, y, z]: Vec3, mpu = 1): Vec3 => [x * mpu, -z * mpu, y * mpu];
/** A model-space box in world: the mapping permutes axes, so the box stays exact. */
export function boxToWorld(b: Box, mpu: number): Box {
  const p = toWorld(b.min, mpu), q = toWorld(b.max, mpu);
  return { min: [Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.min(p[2], q[2])], max: [Math.max(p[0], q[0]), Math.max(p[1], q[1]), Math.max(p[2], q[2])] };
}

/** True north and east in model space. */
export function compass(north: number): { N: Vec3; E: Vec3 } {
  const n = north * RAD;
  return { N: [-Math.sin(n), Math.cos(n), 0], E: [Math.cos(n), Math.sin(n), 0] };
}
/** The compass bearing of a model-space direction: degrees clockwise from true north, [0, 360). */
export function bearing(v: Vec3, north: number): number {
  const { N, E } = compass(north);
  return (Math.atan2(dot(v, E), dot(v, N)) * DEG + 360) % 360;
}
/** Where a surface with this model-space normal faces. */
export function facingOf(normal: Vec3, north: number): Facing {
  const z = normal[2] / Math.hypot(...normal);
  return z >= Math.SQRT1_2 ? 'up' : z <= -Math.SQRT1_2 ? 'down' : (['N', 'E', 'S', 'W'] as const)[Math.round(bearing(normal, north) / 90) % 4];
}

/** Face f's (b - a) × (c - a): along its normal, twice its area long. */
function faceCross(P: ArrayLike<number>, I: ArrayLike<number>, f: number): Vec3 {
  const a = 3 * I[3 * f], b = 3 * I[3 * f + 1], c = 3 * I[3 * f + 2];
  return cross([P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]], [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]]);
}
/** The area-weighted mean of meshes' unit face normals (model space), Σ cross / Σ |cross|: 1 long for a plane, about 0
 *  for a closed shape. viewDir('auto')'s `normal` for prims. */
export function meanNormal(meshes: readonly { positions: ArrayLike<number>; indices: ArrayLike<number> }[]): Vec3 {
  const s: Vec3 = [0, 0, 0];
  let len = 0;
  for (const { positions, indices } of meshes) {
    for (let f = 0; f < indices.length / 3; f++) {
      const n = faceCross(positions, indices, f);
      s[0] += n[0]; s[1] += n[1]; s[2] += n[2]; len += Math.hypot(...n);
    }
  }
  return len ? [s[0] / len, s[1] / len, s[2] / len] : s;
}

/**
 * From the target towards the eye (world, unit): from a compass side, `elevation` degrees up; 'top' a plan, north up;
 * 'auto' from where `normal` points (model space, as meanNormal), tilted `elevation` up and at most to the zenith: a
 * wall from 20° up, a roof as a plan, a soffit from below. A `normal` shorter than 0.35 (or none) faces every way, a
 * closed shape: from the SW, isometric. Within 0.06° of vertical a view keeps a hair of its bearing (three's lookAt
 * needs a horizontal part): south for a plan ('top', or 'auto' tilted to the zenith or nadir) and for a level surface
 * (horizontal part under 1e-3: float noise), so north is up in a plan.
 */
export function viewDir(from: Side | 'top' | 'auto', north: number, normal?: Vec3, elevation = 20): Vec3 {
  let b = 225, e = 35.26; // the eye's bearing and elevation, degrees
  if (from === 'top') [b, e] = [180, 90];
  else if (from !== 'auto') [b, e] = [SIDES.indexOf(from) * 45, elevation];
  else if (normal && Math.hypot(...normal) >= 0.35) {
    const h = Math.hypot(normal[0], normal[1]);
    e = Math.max(-90, Math.min(90, Math.atan2(normal[2], h) * DEG + elevation));
    b = Math.abs(e) === 90 || h < 1e-3 ? 180 : bearing(normal, north); // a plan's bearing only turns the image
  }
  const { N, E } = compass(north), c = Math.max(Math.cos(e * RAD), 1e-3), cb = Math.cos(b * RAD), sb = Math.sin(b * RAD);
  return toWorld(unit([c * (cb * N[0] + sb * E[0]), c * (cb * N[1] + sb * E[1]), Math.sin(e * RAD)]));
}

/** The camera axes three's lookAt gives a view along `d` (target to eye, world) with +Y up: right, up, back. */
function axes(d: Vec3): [Vec3, Vec3, Vec3] {
  let z = unit(d);
  if (z[0] === 0 && z[2] === 0) z = unit([0, z[1], 1e-4]); // straight up or down: three nudges the same way
  const x = unit([z[2], 0, -z[0]]); // +Y × z
  return [x, cross(z, x), z];
}

/**
 * The view along `dir` (target to eye, world, unit) that fits `box` (world) into a shot of the lens's aspect: every
 * corner inside the frame shrunk by `margin`, the widest on its edge. A box fit: a 60 × 12 m facade fills a 5:1 shot,
 * where the viewer's sphere fit fills 16 % of it. Aimed at the box centre; an orthographic view stands 2 R back (R: half
 * the box diagonal). `cut`: a near plane just in front of the box (5 % of R), a cutaway that clips what stands between.
 */
export function frameView(box: Box, dir: Vec3, { fov, aspect, projection, margin = 1.08 }: Lens): { view: ViewState; cut: number } {
  const [x, y, z] = axes(dir), c: Vec3 = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2];
  const R = Math.hypot(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]) / 2;
  if (!(R > 0)) throw new Error('box: no extent; give min < max on at least one axis');
  const tV = Math.tan((fov * RAD) / 2), tH = tV * aspect, ortho = projection === 'orthographic';
  let D = 0, h = 0, front = -Infinity; // eye distance, half-height, the nearest corner's depth towards the eye
  for (let i = 0; i < 8; i++) {
    const q: Vec3 = [(i & 1 ? box.max[0] : box.min[0]) - c[0], (i & 2 ? box.max[1] : box.min[1]) - c[1], (i & 4 ? box.max[2] : box.min[2]) - c[2]];
    const px = Math.abs(dot(q, x)), py = Math.abs(dot(q, y)), pz = dot(q, z);
    front = Math.max(front, pz);
    if (ortho) h = Math.max(h, margin * py, (margin * px) / aspect);
    else D = Math.max(D, pz + (margin * px) / tH, pz + (margin * py) / tV);
  }
  if (ortho) D = 2 * R;
  else h = D * tV;
  return { view: { eye: [c[0] + D * z[0], c[1] + D * z[1], c[2] + D * z[2]], target: c, fov, projection, height: h }, cut: Math.max(D - front - 0.05 * R, 1e-3 * R) };
}

/**
 * A view in words, for whoever cannot see it: 'seen from the SSW (203°), 19° above the horizon, looking NNE;
 * perspective 45° vertical; aimed at (12.4, -3.0, 6.1) m' (model metres); more than 60° up or down: 'from above, north
 * towards the top-left; ...'.
 */
export function describeView(v: ViewState, north: number, mpu: number): string {
  const d: Vec3 = [v.eye[0] - v.target[0], v.eye[1] - v.target[1], v.eye[2] - v.target[2]], m = toModel(d);
  const up = Math.asin(m[2] / Math.hypot(...m)) * DEG;
  let from: string;
  if (Math.abs(up) > 60) {
    const [x, y] = axes(d), n = toWorld(compass(north).N), a = Math.atan2(dot(n, y), dot(n, x)) * DEG;
    from = `from ${up > 0 ? 'above' : 'below'}, north towards the ${SCREEN[(Math.round(a / 45) + 8) % 8]}`;
  } else {
    const b = bearing(m, north);
    from = `seen from the ${point(b)} (${Math.round(b) % 360}°), ${Math.round(Math.abs(up))}° ${up < 0 ? 'below' : 'above'} the horizon, looking ${point(b + 180)}`;
  }
  const lens = v.projection === 'orthographic' ? `orthographic ${fmtNum(2 * v.height * mpu)} m high` : `perspective ${fmtNum(v.fov)}° vertical`;
  return `${from}; ${lens}; aimed at (${toModel(v.target, mpu).map((t) => t.toFixed(1)).join(', ')}) m`;
}

/** A receiver as findCritical reads it: its rows [first, first + count) of the result, its ObjMesh (model metres) and
 *  its elements' areas `w` (m²: faces, or vertices' shares of them). */
export interface CriticalMesh { id: string; name: string; path: string; first: number; count: number; positions: ArrayLike<number>; indices: ArrayLike<number>; w: ArrayLike<number> }
export interface Cluster {
  mesh: string; name: string; path: string; facing: Facing; side: 'below' | 'above'; // the mesh, the way it faces, the bound missed
  elements: number; area: number; share: number; mean: number; worst: number; // area m²; share of the mesh's area facing that way
  centroid: Vec3; box: Box; normal: Vec3; // model metres, Z up; the area-weighted unit normal
  view: ViewState; near: number; // a 16:10 shot of it from where it faces (world, as the views); near: its cutaway
}
const SHOT: Lens = { fov: 45, aspect: 16 / 10, projection: 'perspective' }; // the viewer's lens, the default 1280 × 800 shot

/**
 * Where a result is out of range: the elements of one column under `below` or over `above`, grouped by mesh × the way
 * they face × the bound they miss, largest area first (at most `limit`; groups under 0.5 % of the problem area dropped).
 * Elements are faces (normal (b - a) × (c - a)) or vertices (the area-weighted normal of their faces, the core's sensor
 * normal); a back-side column (`*_back`) faces the other way. The problem share is of the area with a value.
 * ponytail: one group per mesh × facing even when its elements lie apart (two wings of one mesh frame together); split
 * by connectivity if the shots get too wide.
 */
export function findCritical(o: {
  values: Float64Array[]; col: number; column: string; on: 'faces' | 'vertices'; meshes: readonly CriticalMesh[];
  north: number; mpu: number; below?: number; above?: number; limit?: number;
}): { problemArea: number; problemShare: number; clusters: Cluster[] } {
  const flip = o.column.endsWith('_back') ? -1 : 1, all = new Map<string, number>(); // area per mesh × facing
  const groups = new Map<string, { m: CriticalMesh; key: string; facing: Facing; side: 'below' | 'above'; n: number; a: number; av: number; worst: number; ap: Vec3; an: Vec3; lo: Vec3; hi: Vec3 }>();
  let total = 0, problem = 0;
  o.meshes.forEach((m, k) => {
    const P = m.positions, I = m.indices, at = (v: number): Vec3 => [P[3 * v], P[3 * v + 1], P[3 * v + 2]];
    let vn: Float64Array | null = null; // per vertex: Σ of its faces' crosses
    if (o.on === 'vertices') {
      vn = new Float64Array(P.length);
      for (let f = 0; f < I.length / 3; f++) {
        const n = faceCross(P, I, f);
        for (let c = 0; c < 3; c++) for (let j = 0; j < 3; j++) vn[3 * I[3 * f + c] + j] += n[j];
      }
    }
    for (let i = 0; i < m.count; i++) {
      const v = o.values[m.first + i][o.col], a = m.w[i], raw: Vec3 = vn ? [vn[3 * i], vn[3 * i + 1], vn[3 * i + 2]] : faceCross(P, I, i), l = Math.hypot(...raw);
      if (!Number.isFinite(v) || !(a > 0) || !(l > 0)) continue;
      const n: Vec3 = [(flip * raw[0]) / l, (flip * raw[1]) / l, (flip * raw[2]) / l], facing = facingOf(n, o.north), key = `${k} ${facing}`;
      all.set(key, (all.get(key) ?? 0) + a);
      total += a;
      const side = o.below !== undefined && v < o.below ? 'below' : o.above !== undefined && v > o.above ? 'above' : null;
      if (!side) continue;
      problem += a;
      // a face's corners; a vertex stands for its patch: ± half its side as a square
      const pts = vn ? [at(i)] : [at(I[3 * i]), at(I[3 * i + 1]), at(I[3 * i + 2])], r = vn ? Math.sqrt(a) / 2 : 0;
      let g = groups.get(key + side);
      if (!g) groups.set(key + side, (g = { m, key, facing, side, n: 0, a: 0, av: 0, worst: v, ap: [0, 0, 0], an: [0, 0, 0], lo: [Infinity, Infinity, Infinity], hi: [-Infinity, -Infinity, -Infinity] }));
      g.n++;
      g.a += a;
      g.av += a * v;
      g.worst = side === 'below' ? Math.min(g.worst, v) : Math.max(g.worst, v);
      for (let j = 0; j < 3; j++) {
        g.an[j] += a * n[j];
        for (const p of pts) {
          g.ap[j] += (a * p[j]) / pts.length;
          g.lo[j] = Math.min(g.lo[j], p[j] - r);
          g.hi[j] = Math.max(g.hi[j], p[j] + r);
        }
      }
    }
  });
  const clusters = [...groups.values()].filter((g) => g.a >= 0.005 * problem).sort((p, q) => q.a - p.a).slice(0, o.limit ?? 12).map((g): Cluster => {
    const box: Box = { min: g.lo, max: g.hi }, mean: Vec3 = [g.an[0] / g.a, g.an[1] / g.a, g.an[2] / g.a];
    const { view, cut } = frameView(boxToWorld(box, o.mpu), viewDir('auto', o.north, mean), SHOT);
    return {
      mesh: g.m.id, name: g.m.name, path: g.m.path, facing: g.facing, side: g.side,
      elements: g.n, area: g.a, share: g.a / all.get(g.key)!, mean: g.av / g.a, worst: g.worst,
      centroid: [g.ap[0] / g.a, g.ap[1] / g.a, g.ap[2] / g.a], box, normal: unit(g.an), view, near: cut,
    };
  });
  return { problemArea: problem, problemShare: total ? problem / total : 0, clusters };
}
