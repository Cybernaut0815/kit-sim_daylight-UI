// three.js model -> USDA layer for the USD viewer (Y-up, metres). Every node an Xform with its local matrix (doubles:
// survey offsets keep their precision; mirrored nodes stay mirrored, so fromThree flips them as before), every triangle
// mesh a Mesh with its own points, triangles and vertex normals, a GPU-instanced one (EXT_mesh_gpu_instancing) a
// PointInstancer; names made USD identifiers, unique per parent.
// ponytail: text USDA, ~66 MB and ~5 s (generate + core parse) per 1M indexed triangles, non-indexed OBJ ~4x; usdc if that hurts
import { Matrix4, Quaternion, Vector3, type BufferAttribute, type InstancedMesh, type InterleavedBufferAttribute, type Mesh, type Object3D } from 'three';
import { dmeshStems } from 'daylight-mesh';
import { listMeshes } from './loaders';

const num = (x: number) => (Number.isFinite(x) ? +x.toPrecision(9) : 0); // float32 round trip; USDA has no NaN
const vec = (a: BufferAttribute | InterleavedBufferAttribute) => (i: number) => `(${num(a.getX(i))}, ${num(a.getY(i))}, ${num(a.getZ(i))})`;

/**
 * The layer as text parts for `new File(parts, 'model.usda')` (never one huge string), and USD path -> the model's own
 * name wherever USD needed another (loadFiles restores glTF's original names on purpose).
 */
export function toUsda(root: Object3D): { parts: string[]; names: Map<string, string> } {
  root.updateMatrixWorld(true); // every o.matrix from its position / quaternion / scale
  const tri = new Set<Object3D>(listMeshes(root)), names = new Map<string, string>();
  const out = ['#usda 1.0\n(\n    defaultPrim = "Model"\n    metersPerUnit = 1\n    upAxis = "Y"\n)\n\n'];
  const arr = (decl: string, n: number, item: (i: number) => string, tail = '') => {
    out.push(`    ${decl} = [`);
    for (let i = 0; i < n; i += 65536) out.push((i ? ', ' : '') + Array.from({ length: Math.min(65536, n - i) }, (_, j) => item(i + j)).join(', '));
    out.push(`]${tail}\n`);
  };
  const mesh = (o: Mesh) => {
    const { index, attributes: { position, normal } } = o.geometry, n = index ? index.count : position.count;
    arr('int[] faceVertexCounts', n / 3, () => '3');
    arr('int[] faceVertexIndices', n, index ? (i) => String(index.getX(i)) : String);
    arr('point3f[] points', position.count, vec(position)); // getX/Y/Z: interleaved and quantized glTF attributes too
    if (normal) arr('normal3f[] normals', normal.count, vec(normal), ' (interpolation = "vertex")');
    out.push('    uniform token subdivisionScheme = "none"\n'); // else catmullClark: the viewer drops these normals and smooths
  };
  /** The instances of a GPU-instanced mesh: glTF instancing is translation / rotation / scale, so decomposing is exact. */
  const instancer = (o: InstancedMesh, path: string) => {
    const m = new Matrix4(), t = Array.from({ length: o.count }, (_, i) => {
      const p = new Vector3(), q = new Quaternion(), s = new Vector3();
      o.getMatrixAt(i, m).decompose(p, q, s);
      return { p, q, s };
    });
    out.push(`def PointInstancer "Instances"\n{\n    rel prototypes = [<${path}/Instances/Mesh>]\n`);
    arr('int[] protoIndices', t.length, () => '0');
    arr('point3f[] positions', t.length, (i) => `(${num(t[i].p.x)}, ${num(t[i].p.y)}, ${num(t[i].p.z)})`);
    arr('quath[] orientations', t.length, (i) => `(${num(t[i].q.w)}, ${num(t[i].q.x)}, ${num(t[i].q.y)}, ${num(t[i].q.z)})`);
    arr('float3[] scales', t.length, (i) => `(${num(t[i].s.x)}, ${num(t[i].s.y)}, ${num(t[i].s.z)})`);
    out.push('def Mesh "Mesh"\n{\n');
    mesh(o);
    out.push('}\n}\n');
    const own = o.name || path.slice(path.lastIndexOf('/') + 1);
    names.set(`${path}/Instances`, own).set(`${path}/Instances/Mesh`, own); // instancer and prototype: the node's own name
  };
  const prim = (o: Object3D, name: string, path: string) => {
    if (o.name && o.name !== name) names.set(path, o.name);
    const e = o.matrix.elements, row = (i: number) => `(${e.slice(i, i + 4).join(', ')})`; // three's columns = USD's rows
    const inst = (o as InstancedMesh).isInstancedMesh ? (o as InstancedMesh) : null;
    out.push(`def ${tri.has(o) && !inst ? 'Mesh' : 'Xform'} "${name}"\n{\n    matrix4d xformOp:transform = (${[0, 4, 8, 12].map(row).join(', ')})\n    uniform token[] xformOpOrder = ["xformOp:transform"]\n`);
    if (inst) instancer(inst, path); // its own children stay beside the instancer: Hydra draws nothing else under one
    else if (tri.has(o)) mesh(o as Mesh);
    const ids = dmeshStems([...(inst ? ['Instances'] : []), ...o.children.map((c) => c.name.replace(/[^A-Za-z0-9_]/g, '_').replace(/^(?=\d)/, '_'))], 'Node').slice(inst ? 1 : 0);
    o.children.forEach((c, i) => prim(c, ids[i], `${path}/${ids[i]}`)); // a Mesh may hold children: the viewer draws them
    out.push('}\n');
  };
  prim(root, 'Model', '/Model');
  return { parts: out, names };
}
