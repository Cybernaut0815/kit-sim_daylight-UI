// The USD viewer's drawn meshes -> daylight meshes (metres, Z-up). fromThree reads the viewer's own geometry, so result
// rows map 1:1 to the drawn triangles and vertices; stand-ins carry the world matrix, which also keeps the viewer's
// highlight overlays (children of its objects) out.
import { Matrix4, Mesh, type InstancedMesh, type Object3D } from 'three';
import { fromThree, type ObjMesh } from 'daylight-mesh';

/** What the viewer's three.items() lists (only what is used here). */
export interface RenderItem { rid: number; path: string; kind: string; object: Object3D | null }
export interface Extracted { item: RenderItem; obj: ObjMesh; instances: number }

/** Concatenates meshes into one (indices offset per part). */
function merge(parts: ObjMesh[]): ObjMesh {
  let np = 0, ni = 0;
  for (const p of parts) { np += p.positions.length; ni += p.indices.length; }
  const positions = new Float64Array(np), indices = new Uint32Array(ni);
  let op = 0, oi = 0;
  for (const p of parts) {
    positions.set(p.positions, op);
    for (let i = 0; i < p.indices.length; i++) indices[oi + i] = p.indices[i] + op / 3;
    op += p.positions.length;
    oi += p.indices.length;
  }
  return { name: parts[0].name, positions, indices };
}

/**
 * Every shown mesh item of the stage as one ObjMesh, scaled to metres. An instanced item becomes one mesh of all its
 * instances (a shade); its instance matrices are in stage space, under the root's up-axis rotation.
 */
export function extract(items: readonly RenderItem[], root: Object3D, scale: number): Extracted[] {
  root.updateMatrixWorld(true);
  const out: Extracted[] = [];
  for (const item of items) {
    const o = item.object;
    if (item.kind !== 'mesh' || !o?.visible) continue;
    const im = o as InstancedMesh, n = im.isInstancedMesh ? im.count : 0;
    const worlds = n ? Array.from({ length: n }, (_, i) => new Matrix4().fromArray(im.instanceMatrix.array, 16 * i).premultiply(root.matrixWorld)) : [o.matrixWorld];
    // ponytail: one stand-in per instance; batch the matrices if stages with 100k instances show up
    const stands = worlds.map((m) => {
      const s = new Mesh((o as Mesh).geometry);
      s.matrixAutoUpdate = false; // fromThree's updateMatrixWorld then copies matrix into matrixWorld
      s.matrix.copy(m);
      return s;
    });
    const parts = fromThree(stands, { scale });
    out.push({ item, obj: n ? merge(parts) : parts[0], instances: n });
  }
  return out;
}
