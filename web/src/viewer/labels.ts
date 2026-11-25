// Value labels on the painted receivers (the Display menu's "Values on the surfaces"): a screen grid of cells (the
// scene's cell size: one label and a gap), a ray through each cell's centre; a label where the first hit among the
// visible meshes is kept by the section and is a painted receiver (nothing covers it there), one per element (the face
// or corner the probe reads), at most 150, written "value unit". Fast at any model size: a ray tests only the meshes
// whose projected box covers its cell, nearest box first, and stops once the next box starts behind its hit; a mesh is
// tested through a BVH of its triangles (three-mesh-bvh), made once per geometry. Takes any camera and size: the views
// (sampled in idle slices once the camera rests, Viewer.tsx) and the agent's screenshots (capture.ts, all at once). One
// scheduler serves every view: a slice of at most 12 ms each, the views in turn. No import of ./usd.ts: the node tests
// import this module.
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { fmtNum } from '../lib/result';
import { faceRow } from '../lib/topology';
import type { RunResult } from '../store';

export const MAX_LABELS = 150, SLICE_MS = 12;
/** A label: its centre in px from the top left, its text. */
export interface Label { x: number; y: number; text: string }

/** The element of receiver `k` (its index in `result.receivers`) that `hit` lands on: the face the hit triangle belongs
 *  to, or the corner of that triangle nearest the hit point (the receiver's own faces and points: lib/topology.ts);
 *  null where it has none. */
export function elementOf(result: RunResult, k: number, hit: THREE.Intersection, p = new THREE.Vector3()): number | null {
  if (hit.faceIndex == null) return null;
  const form = result.forms?.[k] ?? null;
  let element: number | null = null;
  if (result.on === 'faces') element = faceRow(form, hit.faceIndex);
  else if (hit.face) { // the geometry stays indexed: the hit face's corners are index[3 faceIndex + j]
    const mesh = hit.object as THREE.Mesh, pos = mesh.geometry.attributes.position;
    let best = Infinity;
    [hit.face.a, hit.face.b, hit.face.c].forEach((vi, j) => {
      const d = p.fromBufferAttribute(pos, vi).applyMatrix4(mesh.matrixWorld).distanceToSquared(hit.point);
      if (d < best) { best = d; element = form ? form.cornerRow[3 * hit.faceIndex! + j] : vi; }
    });
  }
  return element !== null && element < result.manifest.meshes[k].count ? element : null;
}

/** What a sampler reads: the camera and its size in px, the visible meshes, a mesh's receiver index when it is painted
 *  (else -1), the result and its column, the section's test, the column's unit ('' for none) and the cell size in px. */
export interface LabelScene {
  camera: THREE.Camera; width: number; height: number; meshes: readonly THREE.Object3D[]; receiverOf: (o: THREE.Object3D) => number;
  result: RunResult; column: number; keeps: (p: THREE.Vector3) => boolean; unit: string; cell: readonly [number, number];
}

/** A label's text: the value as the hover readout writes it, then the unit. */
const textOf = (v: number, unit: string) => (unit ? `${fmtNum(v)} ${unit}` : fmtNum(v));

/** The cell grid of `s`: whole cells across and down, the view's width and height shared out among them. */
function gridOf(s: LabelScene) {
  const cols = Math.floor(s.width / s.cell[0]), rows = Math.floor(s.height / s.cell[1]);
  return { cols, rows, dx: s.width / Math.max(cols, 1), dy: s.height / Math.max(rows, 1) };
}

const corner = new THREE.Vector3(), eyeSpace = new THREE.Vector3();
/** World box `box` on the screen of `cam`, in px from the top left: [left, top, right, bottom]; the whole view when part
 *  of it lies behind a perspective eye. */
function rectOf(box: THREE.Box3, cam: THREE.Camera, width: number, height: number): [number, number, number, number] {
  const persp = (cam as THREE.PerspectiveCamera).isPerspectiveCamera;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let c = 0; c < 8; c++) {
    corner.set(c & 1 ? box.max.x : box.min.x, c & 2 ? box.max.y : box.min.y, c & 4 ? box.max.z : box.min.z);
    if (persp && eyeSpace.copy(corner).applyMatrix4(cam.matrixWorldInverse).z >= 0) return [0, 0, width, height];
    corner.project(cam);
    x0 = Math.min(x0, corner.x); x1 = Math.max(x1, corner.x); y0 = Math.min(y0, corner.y); y1 = Math.max(y1, corner.y);
  }
  return [((x0 + 1) / 2) * width, ((1 - y1) / 2) * height, ((x1 + 1) / 2) * width, ((1 - y0) / 2) * height];
}

/** A mesh, or one instance of an instanced mesh, as the rays test it: its world matrix and inverse, its world box, the
 *  side its material draws (and is hit from). */
interface Target { o: THREE.Mesh; instance: number | undefined; matrix: THREE.Matrix4; inverse: THREE.Matrix4; box: THREE.Box3; side: THREE.Side }

/** The meshes of `objects` with triangles as targets, an instanced mesh as one per instance (curves and points cover
 *  nothing). */
function targetsOf(objects: readonly THREE.Object3D[]): Target[] {
  const out: Target[] = [];
  for (const o of objects) {
    const m = o as THREE.Mesh, g = m.geometry;
    if (!m.isMesh || !g?.attributes.position || (g.index ? g.index.count : g.attributes.position.count) < 3) continue;
    if (!g.boundingBox) g.computeBoundingBox();
    const side = Array.isArray(m.material) ? THREE.DoubleSide : m.material.side;
    const add = (matrix: THREE.Matrix4, instance: number | undefined) =>
      out.push({ o: m, instance, matrix, inverse: matrix.clone().invert(), box: g.boundingBox!.clone().applyMatrix4(matrix), side });
    const inst = m as THREE.InstancedMesh;
    if (inst.isInstancedMesh) {
      for (let i = 0; i < inst.count; i++) { const at = new THREE.Matrix4(); inst.getMatrixAt(i, at); add(at.premultiply(inst.matrixWorld), i); }
    } else add(m.matrixWorld.clone(), undefined);
  }
  return out;
}

/** A geometry's BVH, made on first use and again once its points or index change. Indirect: the geometry's index stays
 *  in its own order, which faceIndex, the result's rows and the viewer's paint follow. */
const trees = new WeakMap<THREE.BufferGeometry, { tree: MeshBVH; position: unknown; version: number; index: THREE.BufferAttribute | null; indexVersion: number }>();
function treeOf(g: THREE.BufferGeometry): MeshBVH {
  const position = g.attributes.position as THREE.BufferAttribute, index = g.index, was = trees.get(g);
  if (was && was.position === position && was.version === position.version && was.index === index && was.indexVersion === (index?.version ?? 0)) return was.tree;
  const tree = new MeshBVH(g, { indirect: true });
  trees.set(g, { tree, position, version: position.version, index, indexVersion: index?.version ?? 0 });
  return tree;
}

/** The cells' centres inside the painted receivers' projected bounds (all of them when one lies partly behind the eye). */
export function cellsOf(s: LabelScene): [number, number][] {
  return cellsIn(s, targetsOf(s.meshes.filter((o) => s.receiverOf(o) >= 0)));
}
function cellsIn(s: LabelScene, receivers: readonly Target[]): [number, number][] {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const t of receivers) {
    const [l, tp, r, b] = rectOf(t.box, s.camera, s.width, s.height);
    left = Math.min(left, l); top = Math.min(top, tp); right = Math.max(right, r); bottom = Math.max(bottom, b);
  }
  if (!(right >= left)) return [];
  left = Math.max(left, 0); top = Math.max(top, 0); right = Math.min(right, s.width); bottom = Math.min(bottom, s.height);
  const { cols, rows, dx, dy } = gridOf(s), out: [number, number][] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const x = (c + 0.5) * dx, y = (r + 0.5) * dy;
    if (x >= left - dx / 2 && x <= right + dx / 2 && y >= top - dy / 2 && y <= bottom + dy / 2) out.push([x, y]);
  }
  return out;
}

/** A sampler over scene `s`: step(until) casts the next rays until `until()` says stop and returns whether it is done;
 *  `labels` holds every label found so far, in the order found. Its first step lays out the targets and cells. */
export function sampler(s: LabelScene): { step: (until: () => boolean) => boolean; labels: Label[] } {
  const caster = new THREE.Raycaster(), ndc = new THREE.Vector2(), p = new THREE.Vector3(), entry = new THREE.Vector3(), local = new THREE.Ray();
  const seen = new Set<string>(), labels: Label[] = [];
  const near = (s.camera as THREE.PerspectiveCamera).isPerspectiveCamera ? (s.camera as THREE.PerspectiveCamera).near : 0; // what the camera clips (a shot's cutaway) covers nothing
  const { cols, rows, dx, dy } = gridOf(s);
  let cells: [number, number][] | null = null, targets: Target[] = [], buckets: number[][] = [], i = 0;

  /** Each target in the cells its projected box covers (a cell more round it: the box's edge may fall on a centre). */
  const layout = () => {
    targets = targetsOf(s.meshes);
    cells = cellsIn(s, targets.filter((t) => s.receiverOf(t.o) >= 0));
    buckets = Array.from({ length: cols * rows }, () => []);
    targets.forEach((t, k) => {
      const [l, tp, r, b] = rectOf(t.box, s.camera, s.width, s.height);
      if (r < 0 || b < 0 || l > s.width || tp > s.height) return; // off the view
      const c0 = Math.max(Math.floor(l / dx - 0.5), 0), c1 = Math.min(Math.ceil(r / dx - 0.5), cols - 1);
      const r0 = Math.max(Math.floor(tp / dy - 0.5), 0), r1 = Math.min(Math.ceil(b / dy - 0.5), rows - 1);
      for (let row = r0; row <= r1; row++) for (let col = c0; col <= c1; col++) buckets[row * cols + col].push(k);
    });
  };
  /** Target `t`'s first hit along world ray `ray` that is past `near` and kept by the section, in world space. */
  const firstOn = (t: Target, ray: THREE.Ray): THREE.Intersection | null => {
    const tree = treeOf(t.o.geometry);
    local.copy(ray).applyMatrix4(t.inverse);
    const toWorld = (h: THREE.Intersection) => {
      h.point.applyMatrix4(t.matrix);
      h.distance = h.point.distanceTo(ray.origin);
      h.object = t.o;
      if (t.instance !== undefined) h.instanceId = t.instance;
      return h;
    };
    const kept = (h: THREE.Intersection) => h.distance >= near && s.keeps(h.point);
    const first = tree.raycastFirst(local, t.side);
    if (!first || kept(toWorld(first))) return first;
    return tree.raycast(local, t.side).map(toWorld).filter(kept).sort((a, b) => a.distance - b.distance)[0] ?? null; // cut away or clipped: the next one
  };
  /** The first hit at px (x, y): its cell's targets by where the ray enters their boxes, until a box starts behind it. */
  const hitAt = (x: number, y: number): THREE.Intersection | null => {
    ndc.set((x / s.width) * 2 - 1, -(y / s.height) * 2 + 1);
    caster.setFromCamera(ndc, s.camera);
    const ray = caster.ray, order: [number, number][] = [];
    for (const k of buckets[Math.min(Math.floor(y / dy), rows - 1) * cols + Math.min(Math.floor(x / dx), cols - 1)] ?? []) {
      if (ray.intersectBox(targets[k].box, entry)) order.push([entry.distanceTo(ray.origin), k]);
    }
    order.sort((a, b) => a[0] - b[0]);
    let best: THREE.Intersection | null = null;
    for (const [from, k] of order) {
      if (best && from > best.distance) break;
      const h = firstOn(targets[k], ray);
      if (h && (!best || h.distance < best.distance)) best = h;
    }
    return best;
  };
  const step = (until: () => boolean) => {
    if (!cells) layout();
    while (i < cells!.length && labels.length < MAX_LABELS) {
      const [x, y] = cells![i++], hit = hitAt(x, y);
      const k = hit ? s.receiverOf(hit.object) : -1, e = hit && k >= 0 ? elementOf(s.result, k, hit, p) : null;
      if (e !== null && !seen.has(`${k}:${e}`)) {
        seen.add(`${k}:${e}`);
        const v = s.result.data[s.column][s.result.manifest.meshes[k].first + e];
        if (Number.isFinite(v)) labels.push({ x, y, text: textOf(v, s.unit) });
      }
      if (until()) break;
    }
    return i >= cells!.length || labels.length >= MAX_LABELS;
  };
  return { step, labels };
}
/** Every label of scene `s` at once (the agent's screenshots). */
export const labelsOf = (s: LabelScene): Label[] => { const sm = sampler(s); sm.step(() => false); return sm.labels; };

// The one scheduler: per idle callback, one slice of at most SLICE_MS on the view first in line, which then goes to the
// back of the line unless it is done; a view queued again replaces its job.
type Job = (until: () => boolean) => boolean;
const line: { owner: object; job: Job }[] = [];
let pending = false;
const idle = (f: () => void) => (typeof requestIdleCallback === 'function' ? requestIdleCallback(f, { timeout: 500 }) : setTimeout(f, 16));
function pump() {
  pending = false;
  const first = line.shift();
  if (!first) return;
  const end = performance.now() + SLICE_MS;
  if (!first.job(() => performance.now() >= end)) line.push(first);
  if (line.length) { pending = true; idle(pump); }
}
/** `job` (a sampler's step, with whatever it draws) run for `owner` in idle slices, replacing the job it had. */
export function enqueue(owner: object, job: Job): void {
  cancelLabels(owner);
  line.push({ owner, job });
  if (!pending) { pending = true; idle(pump); }
}
/** `owner`'s job dropped, wherever it is in line. */
export function cancelLabels(owner: object): void {
  const k = line.findIndex((x) => x.owner === owner);
  if (k >= 0) line.splice(k, 1);
}
