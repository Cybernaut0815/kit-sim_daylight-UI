// The view field in the 3D view (the View analysis tab): a camera-like glyph at a sample of the receivers' eyes, the
// field each one traces (lib/viewfield.ts) at a display radius: the rays to its corners, its outline and its thinned
// cells over a faint surface. Exactly one LineSegments and one Mesh, each with one node material made once: a rebuild
// swaps in a new geometry (same attributes, so no shader compiles again), and two draw calls draw any number of
// glyphs. The glyph is built once per field and cell, placed on the CPU per eye in the core's frame for it. Not cut by
// the section (a diagram, not the model): the eyes the section cuts away are left out instead.
import * as THREE from 'three';
import { LineBasicNodeMaterial, MeshBasicNodeMaterial } from 'three/webgpu';
import { cssVar } from '../lib/cssVar';
import { toModel, toWorld, type Vec3 } from '../lib/frame';
import { frameOf, glyphOf, rayGrid, type Eyes, type Fov, type Gaze } from '../lib/viewfield';
import type { ViewSim } from '../store';

/** What the preview draws: the view settings it shows, its size and how many glyphs at most. */
export interface FieldView {
  fov: Fov; cell: number; gaze: Gaze; sides: ViewSim['sides']; on: ViewSim['on']; offset: number; north: number; // offset: metres
  scale: number; max: number; // scale: x the default glyph size (a few % of the model); max: the most glyphs drawn
}
/** The preview's densities: the most glyphs each draws. */
export const DENSITY = { few: 30, some: 120, many: 400 } as const;
export type Density = keyof typeof DENSITY;

export function createViewField() {
  const group = new THREE.Group();
  group.visible = false;
  const edges = new LineBasicNodeMaterial({ toneMapped: false });
  const fill = new MeshBasicNodeMaterial({ transparent: true, opacity: 0.1, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
  const lines = new THREE.LineSegments(new THREE.BufferGeometry(), edges), surface = new THREE.Mesh(new THREE.BufferGeometry(), fill);
  lines.raycast = surface.raycast = () => {}; // diagrams: never picked
  group.add(lines, surface);
  let glyph: { key: string; lines: Float32Array; tris: Float32Array } | null = null;

  /** The unit glyph's points placed at each eye: eye + radius x (x right + y forward + z up). */
  const place = (unit: Float32Array, eyes: Eyes, frames: Float32Array, radius: number) => {
    const n = unit.length / 3, out = new Float32Array(3 * n * eyes.count);
    for (let e = 0, o = 0; e < eyes.count; e++) {
      const F = frames.subarray(9 * e, 9 * e + 9), px = eyes.p[3 * e], py = eyes.p[3 * e + 1], pz = eyes.p[3 * e + 2];
      for (let i = 0; i < n; i++, o += 3) {
        const x = radius * unit[3 * i], y = radius * unit[3 * i + 1], z = radius * unit[3 * i + 2];
        out[o] = px + x * F[0] + y * F[3] + z * F[6];
        out[o + 1] = py + x * F[1] + y * F[4] + z * F[7];
        out[o + 2] = pz + x * F[2] + y * F[5] + z * F[8];
      }
    }
    return out;
  };
  const swap = (o: THREE.LineSegments | THREE.Mesh, xyz: Float32Array) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(xyz, 3));
    o.geometry.dispose();
    o.geometry = g;
  };

  return {
    group,
    /** Glyphs at the eyes (world), `radius` world units across, in each eye's view frame; none: hidden. */
    build(eyes: Eyes, v: FieldView, radius: number) {
      group.visible = eyes.count > 0;
      if (!eyes.count) return;
      const key = `${v.fov.join(',')} ${v.cell}`;
      if (glyph?.key !== key) glyph = { key, ...glyphOf(rayGrid(v.fov, v.cell)) };
      const all = v.fov[0] === 360, frames = new Float32Array(9 * eyes.count); // per eye: right, forward, up (world)
      for (let e = 0; e < eyes.count; e++) {
        const n = toModel([eyes.n[3 * e], eyes.n[3 * e + 1], eyes.n[3 * e + 2]]), { r, f, u } = frameOf(n, v.north, v.gaze, all);
        [r, f, u].forEach((axis: Vec3, k) => frames.set(toWorld(axis), 9 * e + 3 * k));
      }
      swap(lines, place(glyph.lines, eyes, frames, radius));
      swap(surface, place(glyph.tris, eyes, frames, radius));
    },
    /** The accent of the theme now. */
    colour() {
      const c = new THREE.Color(cssVar('--accent', '#ff4d2e', '--bg-surface-2'));
      edges.color.copy(c);
      fill.color.copy(c);
    },
    hide() { group.visible = false; },
    dispose() {
      lines.geometry.dispose();
      surface.geometry.dispose();
      edges.dispose();
      fill.dispose();
    },
  };
}
export type ViewField = ReturnType<typeof createViewField>;
