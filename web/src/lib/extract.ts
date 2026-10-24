// The USD viewer's drawn meshes -> daylight meshes (metres, Z-up). fromThree reads the viewer's own geometry, so result
// rows map 1:1 to the drawn triangles and vertices; stand-ins carry the world matrix, which also keeps the viewer's
// highlight overlays (children of its objects) out.
import { Matrix4, Mesh, type BufferGeometry, type InstancedMesh, type Object3D } from 'three';
import { fromThree, type ObjMesh } from 'daylight-mesh';

/**
 * What the viewer's three.items() lists (only what is used here). `material` (rid, 0 = none) and `subsets` (index ranges
 * with their material, covering every triangle; the geometry's groups in the same order) are fields of the viewer's
 * scene items that its items() type leaves out.
 * ponytail: declared here, not in the viewer; move them into its items() type with its next change
 */
export interface RenderItem {
  rid: number; path: string; kind: string; object: Object3D | null;
  material?: number; subsets?: readonly { start: number; count: number; material: number }[] | null;
}
/** A daylight mesh with its optics slot per triangle (absent: every triangle slot 0).
 *  ponytail: daylight-mesh's own ObjMesh.slots after the submodule bump, which also sends it; this type goes then */
export type SlotMesh = ObjMesh & { slots?: Uint16Array };
/** A drawn mesh: converted now (`obj`), or for an instanced one built on first use (`make`), since a scatter of many
 *  detailed copies would cost gigabytes at load even when it is never given a role. `materials[k]`: the material rid
 *  of optics slot k (one slot without subsets). */
export interface Extracted { item: RenderItem; instances: number; tris: number; verts: number; materials: number[]; obj?: SlotMesh; make?: () => SlotMesh }

const stand = (geometry: BufferGeometry, world: Matrix4) => {
  const s = new Mesh(geometry);
  s.matrixAutoUpdate = false; // fromThree's updateMatrixWorld then copies matrix into matrixWorld
  s.matrix.copy(world);
  return s;
};

/** Slot k for triangle t of geometry group k (start <= 3t < start + count); undefined without groups. */
function slotsOf(g: BufferGeometry, tris: number): Uint16Array | undefined {
  if (!g.groups.length) return undefined;
  const s = new Uint16Array(tris);
  g.groups.forEach((r, k) => s.fill(k, Math.ceil(r.start / 3), Math.ceil((r.start + r.count) / 3)));
  return s;
}

/**
 * Every shown mesh item of the stage, scaled to metres, plus the hidden ones `keep` names (hidden in the view only). An
 * instanced item becomes one mesh of all its instances (a shade), whose instance matrices are in stage space under the
 * root's up-axis rotation; every copy keeps the prototype's slots.
 * ponytail: instance matrices come from the core as float32 (0.5 m steps at 5e6 m survey coordinates), unlike the
 * float64 matrices of plain meshes; send them as doubles in the viewer's protocol if georeferenced scatters matter.
 */
export function extract(items: readonly RenderItem[], root: Object3D, scale: number, keep?: (path: string) => boolean): Extracted[] {
  root.updateMatrixWorld(true);
  const rootWorld = root.matrixWorld.clone(), out: Extracted[] = [];
  for (const item of items) {
    const o = item.object;
    if (item.kind !== 'mesh' || !o || !(o.visible || keep?.(item.path))) continue;
    const g = (o as Mesh).geometry, im = o as InstancedMesh;
    const materials = item.subsets?.length ? item.subsets.map((s) => s.material) : [item.material ?? 0];
    if (!im.isInstancedMesh) {
      const obj: SlotMesh = fromThree([stand(g, o.matrixWorld)], { scale })[0], slots = slotsOf(g, obj.indices.length / 3);
      if (slots) obj.slots = slots;
      out.push({ item, instances: 0, tris: obj.indices.length / 3, verts: obj.positions.length / 3, materials, obj });
      continue;
    }
    const n = im.count, V = g.attributes.position.count, I = g.index ? g.index.count : V, all = im.instanceMatrix.array;
    if (!n) continue; // a prototype with no (visible) instances draws nothing
    const make = (): SlotMesh => { // one instance at a time: the peak is the result plus one copy
      const positions = new Float64Array(3 * V * n), indices = new Uint32Array(I * n), m = new Matrix4(), one = slotsOf(g, I / 3);
      for (let i = 0; i < n; i++) {
        const [p] = fromThree([stand(g, m.fromArray(all, 16 * i).premultiply(rootWorld))], { scale });
        positions.set(p.positions, 3 * V * i);
        for (let k = 0; k < I; k++) indices[I * i + k] = p.indices[k] + V * i;
      }
      if (!one) return { name: item.path, positions, indices };
      const slots = new Uint16Array(one.length * n);
      for (let i = 0; i < n; i++) slots.set(one, one.length * i);
      return { name: item.path, positions, indices, slots };
    };
    out.push({ item, instances: n, tris: (I / 3) * n, verts: V * n, materials, make });
  }
  return out;
}
