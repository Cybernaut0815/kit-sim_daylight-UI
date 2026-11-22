// The USD viewer's drawn meshes -> daylight meshes (metres, Z-up), built on demand from the viewer's own geometry and
// world matrix as they are at the call: nothing is kept (a bhs-size model would hold 0.6 GB). Stand-ins carry the world
// matrix, which also keeps the viewer's highlight overlays (children of its objects) out. A run names each mesh by its
// content (jobMeshes, C1).
// Two forms. As drawn (dmesh, make): the viewer's triangles and vertices, what a shade is sent as. A receiver is sent as
// the file's own faces and points instead (receiver, over its topology: lib/topology.ts), so a quad is one result row
// and parts that only share a position keep their own vertices; its rows map back to the drawn triangles there.
import { Matrix4, Mesh, type BufferGeometry, type Object3D } from 'three';
import { dmeshStems, fromThree, meshIds, toDmesh, type ObjMesh } from 'daylight-mesh';
import type { MeshMap } from 'usd-viewer';
import { polygons, receiverTopology, type Topology } from './topology';

/**
 * What the viewer's three.items() lists (only what is used here). `material` (rid, 0 = none) and `subsets` (index ranges
 * with their material, covering every triangle; the geometry's groups in the same order) are fields of the viewer's
 * scene items that its items() type leaves out.
 * ponytail: declared here, not in the viewer; move them into its items() type with its next change
 */
export interface RenderItem {
  rid: number; path: string; kind: string; object: Object3D | null;
  /** Instance matrices in stage space, 16 per copy (one copy draws as a plain mesh); none for a plain mesh. */
  instances?: Float32Array | null;
  material?: number; subsets?: readonly { start: number; count: number; material: number }[] | null;
}
/**
 * A drawn mesh, built on demand: dmesh() its .dmesh bytes, make() the same mesh as an ObjMesh (views of those bytes:
 * weights, meshOf, the agent tools), stamp() what both read (arrays, groups, the world matrix): equal stamps, equal
 * bytes. An instanced one's copies are fixed at extract (its instance matrices and the root's). `materials[k]`: the
 * material rid of optics slot k (one slot without subsets); the bytes hold the slot of each triangle.
 */
export interface Extracted {
  item: RenderItem; instances: number; tris: number; verts: number; materials: number[]; make: () => ObjMesh; dmesh: () => Uint8Array<ArrayBuffer>; stamp: () => unknown[];
  /** The file's own faces and points behind the drawn triangles, read from the viewer once per geometry; null: none
   *  (no meshMap, a mesh without an index, a map that does not fit): its rows are the drawn triangles and vertices.
   *  Absent on an instanced item (never a receiver). */
  topology?: () => Promise<Topology | null>;
  /** The receiver form over that topology: one object per topology, so its content id is hashed once (jobMeshes). */
  receiver?: (t: Topology) => Receiver;
}
/** A mesh whose rows a result names: positions per point row, a triangle's corners as point rows (as an ObjMesh), and
 *  with `faceStart` the triangles of each face row (absent: a row per triangle). Model metres, Z up. */
export type RowMesh = ObjMesh & { faceStart?: Int32Array };
/** A receiver as sent: its .dmesh (polygons over its own points), its stamp (the drawn form's and the topology) and its
 *  mesh in result rows (views of fresh bytes: take it once where it is read, never keep it). */
export interface Receiver extends Hashed { topology: Topology; mesh: () => RowMesh }

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

/** .dmesh bytes as an ObjMesh of views of them: fromThree's doubles and indices, no second copy. */
function viewOf(name: string, b: Uint8Array<ArrayBuffer>): ObjMesh {
  const d = new DataView(b.buffer), N = Number(d.getBigUint64(8, true)), F = Number(d.getBigUint64(16, true)), M = Number(d.getBigUint64(24, true)), at = 32 + 24 * N + 4 * F;
  return { name, positions: new Float64Array(b.buffer, 32, 3 * N), indices: new Int32Array(b.buffer, at, M), ...(d.getUint32(4, true) & 1 ? { slots: new Uint16Array(b.buffer, at + 4 * M, F) } : {}) };
}

/** A receiver's .dmesh bytes as its mesh in result rows: the points as they were sent, the drawn triangles' corners as
 *  point rows (turned as toDmesh turns a mirrored mesh, so a triangle's normal is the face's), the faces' triangles. */
function rowMesh(name: string, b: Uint8Array<ArrayBuffer>, t: Topology, mirrored: boolean): RowMesh {
  let indices = t.cornerRow;
  if (mirrored) { indices = t.cornerRow.slice(); for (let i = 0; i < indices.length; i += 3) { const x = indices[i + 1]; indices[i + 1] = indices[i + 2]; indices[i + 2] = x; } }
  return { name, positions: new Float64Array(b.buffer, 32, 3 * t.points), indices, faceStart: t.faceStart };
}

/**
 * Every shown mesh item of the stage, scaled to metres, plus the hidden ones `keep` names (hidden in the view only). An
 * instanced item becomes one mesh of all its instances (a shade), whose instance matrices are in stage space under the
 * root's up-axis rotation; every copy keeps the prototype's slots. Instanced is the item's `instances`, not how the
 * viewer draws it: a single instance is a plain mesh there, placed by its instance matrix.
 * ponytail: instance matrices come from the core as float32 (0.5 m steps at 5e6 m survey coordinates), unlike the
 * float64 matrices of plain meshes; send them as doubles in the viewer's protocol if georeferenced scatters matter.
 */
export function extract(items: readonly RenderItem[], root: Object3D, scale: number, keep?: (path: string) => boolean, meshMap?: (rid: number) => Promise<MeshMap | null>): Extracted[] {
  root.updateMatrixWorld(true);
  const rootWorld = root.matrixWorld.clone(), out: Extracted[] = [];
  for (const item of items) {
    const o = item.object;
    if (item.kind !== 'mesh' || !o || !(o.visible || keep?.(item.path))) continue;
    const g = (o as Mesh).geometry;
    const materials = item.subsets?.length ? item.subsets.map((s) => s.material) : [item.material ?? 0];
    const arrays = () => [g.attributes.position?.array, g.index?.array, g.groups];
    if (!item.instances) {
      const pos = g.attributes.position;
      if (!pos || pos.itemSize !== 3) throw new Error(`${item.path}: geometry has no xyz position attribute`); // fromThree's check, at load
      const verts = pos.array.length / 3, tris = (g.index ? g.index.count : verts) / 3;
      const dmesh = () => toDmesh({ name: item.path, positions: g.attributes.position.array, indices: g.index?.array ?? null, slots: slotsOf(g, tris) }, { matrix: o.matrixWorld.elements, scale });
      const stamp = () => [...arrays(), ...o.matrixWorld.elements];
      let read: { index: unknown; value: Promise<Topology | null> } | undefined, sent: Receiver | undefined;
      const topology = () => { // per index array: a re-read or another refinement level draws new triangles
        const index = g.index?.array;
        if (!index || !meshMap) return Promise.resolve(null);
        if (read?.index !== index) read = { index, value: meshMap(item.rid).then((map) => (map && g.index?.array === index ? receiverTopology(index, map) : null), () => null) };
        return read.value;
      };
      const receiver = (t: Topology): Receiver => {
        if (sent?.topology === t) return sent;
        const bytes = () => {
          const pos = g.attributes.position.array, positions = new Float64Array(3 * t.points), all = slotsOf(g, tris);
          for (let p = 0; p < t.points; p++) for (let j = 0; j < 3; j++) positions[3 * p + j] = pos[3 * t.pointVertex[p] + j];
          return toDmesh({ name: item.path, positions, ...polygons(t), slots: all && Uint16Array.from({ length: t.faces }, (_, r) => all[t.faceStart[r]]) }, { matrix: o.matrixWorld.elements, scale });
        };
        return (sent = { topology: t, dmesh: bytes, stamp: () => [...stamp(), t], mesh: () => rowMesh(item.path, bytes(), t, o.matrixWorld.determinant() < 0) });
      };
      out.push({ item, instances: 0, tris, verts, materials, dmesh, make: () => viewOf(item.path, dmesh()), stamp, topology, receiver });
      continue;
    }
    const all = item.instances, n = all.length / 16, V = g.attributes.position.count, I = g.index ? g.index.count : V;
    if (!n) continue; // a prototype with no (visible) instances draws nothing
    const make = (): ObjMesh => { // one instance at a time: the peak is the result plus one copy
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
    out.push({ item, instances: n, tris: (I / 3) * n, verts: V * n, materials, make, dmesh: () => toDmesh(make()), stamp: arrays });
  }
  return out;
}

/** Same stamps (Extracted.stamp): the same arrays, groups and matrix, so the same bytes. */
export const same = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
/** A row as a run sends it (as drawn, or its receiver form): its builders and, once hashed, its content id and the stamp
 *  it was hashed at. */
export type Hashed = Pick<Extracted, 'dmesh' | 'stamp'> & { id?: string; at?: readonly unknown[] };

/**
 * C1: a job's meshes for runRemote (the first `sensors` rows receive) and their core names, stems[k] for row k (dmeshStems
 * of the ids: twins become h, h_2). A row is hashed once while its stamp holds (one meshIds call: 8 bodies at a time); a
 * shade with a receiver's bytes is salted by meshIds. Each body is built again at its PUT and refused if its row changed
 * since this job read it (the server cannot check bytes against an id, and its cache is shared). `stamps`: each row as
 * this job read it; `hashed`: the rows hashed now (their bytes are new to this tab).
 */
export async function jobMeshes(rows: readonly Hashed[], sensors: number, signal?: AbortSignal) {
  const stamps = rows.map((c) => c.stamp()), hashed = rows.flatMap((c, k) => (c.id && same(c.at!, stamps[k]) ? [] : [k]));
  (await meshIds({ sensors: hashed.map((k) => ({ dmesh: rows[k].dmesh })), signal })).forEach((id, j) => Object.assign(rows[hashed[j]], { id, at: stamps[hashed[j]] }));
  const own = rows.map((c, k) => ({
    id: c.id!,
    dmesh: () => {
      if (!same(stamps[k], c.stamp())) throw new Error('a mesh changed while it was sent: run again');
      return c.dmesh();
    },
  }));
  const ids = await meshIds({ sensors: own.slice(0, sensors), context: own.slice(sensors) }); // every id given: salts only
  return { meshes: own.map((m, k) => ({ ...m, id: ids[k] })), ids, stems: dmeshStems(ids), stamps, hashed };
}
