// Value labels on the painted receivers (the Display menu's "Values on the surfaces"): a screen grid of 96 × 32 px
// cells, a ray through each cell's centre; a label where the first hit among the visible meshes is kept by the section
// and is a painted receiver (nothing covers it there), one per element (the face or corner the probe reads), at most
// 150. Takes any camera and size: the views (sampled in idle slices once the camera rests, Viewer.tsx) and the agent's
// screenshots (capture.ts, all at once). One scheduler serves every view: a slice of at most 6 ms each, the views in
// turn. No import of ./usd.ts: the node tests import this module.
import * as THREE from 'three';
import { fmtNum } from '../lib/result';
import { faceRow } from '../lib/topology';
import type { RunResult } from '../store';

export const CELL_W = 96, CELL_H = 32, MAX_LABELS = 150, SLICE_MS = 6;
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
 *  (else -1), the result and its column, and the section's test. */
export interface LabelScene {
  camera: THREE.Camera; width: number; height: number; meshes: readonly THREE.Object3D[]; receiverOf: (o: THREE.Object3D) => number;
  result: RunResult; column: number; keeps: (p: THREE.Vector3) => boolean;
}

/** The cells' centres inside the painted receivers' projected bounds (all of them when one lies partly behind the eye). */
export function cellsOf(s: LabelScene): [number, number][] {
  const box = new THREE.Box3(), v = new THREE.Vector3(), cam = s.camera;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, whole = false;
  for (const o of s.meshes) {
    if (s.receiverOf(o) < 0) continue;
    box.setFromObject(o);
    if (box.isEmpty()) continue;
    for (let c = 0; c < 8 && !whole; c++) {
      v.set(c & 1 ? box.max.x : box.min.x, c & 2 ? box.max.y : box.min.y, c & 4 ? box.max.z : box.min.z);
      if ((cam as THREE.PerspectiveCamera).isPerspectiveCamera && v.clone().applyMatrix4(cam.matrixWorldInverse).z >= 0) whole = true;
      v.project(cam);
      x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x); y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y);
    }
  }
  if (!whole && !(x1 >= x0)) return [];
  // NDC -> px (y down), clamped to the view
  const left = whole ? 0 : ((x0 + 1) / 2) * s.width, right = whole ? s.width : ((x1 + 1) / 2) * s.width;
  const top = whole ? 0 : ((1 - y1) / 2) * s.height, bottom = whole ? s.height : ((1 - y0) / 2) * s.height;
  const cols = Math.floor(s.width / CELL_W), rows = Math.floor(s.height / CELL_H), out: [number, number][] = [];
  const dx = s.width / Math.max(cols, 1), dy = s.height / Math.max(rows, 1);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const x = (c + 0.5) * dx, y = (r + 0.5) * dy;
    if (x >= left - dx / 2 && x <= right + dx / 2 && y >= top - dy / 2 && y <= bottom + dy / 2) out.push([x, y]);
  }
  return out;
}

/** A sampler over scene `s`: step(until) casts the next rays until `until()` says stop and returns whether it is done;
 *  `labels` holds every label found so far, in the order found. */
export function sampler(s: LabelScene): { step: (until: () => boolean) => boolean; labels: Label[] } {
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), p = new THREE.Vector3(), seen = new Set<string>(), labels: Label[] = [];
  const persp = (s.camera as THREE.PerspectiveCamera).isPerspectiveCamera;
  if (persp) ray.near = (s.camera as THREE.PerspectiveCamera).near; // what the camera clips (a shot's cutaway) covers nothing
  let cells: [number, number][] | null = null, i = 0;
  const step = (until: () => boolean) => {
    cells ??= cellsOf(s);
    // ponytail: linear raycast over every visible mesh per cell; three-mesh-bvh if receivers of ~1M triangles lag
    while (i < cells.length && labels.length < MAX_LABELS) {
      const [x, y] = cells[i++];
      ndc.set((x / s.width) * 2 - 1, -(y / s.height) * 2 + 1);
      ray.setFromCamera(ndc, s.camera);
      const hit = ray.intersectObjects(s.meshes as THREE.Object3D[], false).find((h) => s.keeps(h.point));
      const k = hit ? s.receiverOf(hit.object) : -1, e = hit && k >= 0 ? elementOf(s.result, k, hit, p) : null;
      if (e !== null && !seen.has(`${k}:${e}`)) {
        seen.add(`${k}:${e}`);
        const v = s.result.data[s.column][s.result.manifest.meshes[k].first + e];
        if (Number.isFinite(v)) labels.push({ x, y, text: fmtNum(v) });
      }
      if (until()) break;
    }
    return i >= cells.length || labels.length >= MAX_LABELS;
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
