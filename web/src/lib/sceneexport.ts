// glTF / OBJ downloads: the model as drawn (every visible mesh, instances as copies) in metres and Y-up, receivers
// coloured with the shown result. glTF also carries every result as a value attribute (_DAYLIGHT_<RESULT>, on the drawn
// triangles' corners); OBJ only the colours (v x y z r g b).
// The viewer draws stage materials as node materials (TSL): standard() turns them back into what GLTFExporter reads.
import { BufferAttribute, BufferGeometry, Color, DoubleSide, Matrix3, Matrix4, Mesh, MeshBasicMaterial, MeshStandardMaterial, Scene, Vector3, type InstancedMesh, type Material, type Object3D, type Texture } from 'three';

/** One drawn mesh: its geometry as the viewer has it, its copies in export space, its look or its result. */
export interface Drawn {
  name: string;
  geometry: BufferGeometry;
  matrices: Matrix4[];
  material: Material | Material[] | null; // the shaded view's; null: a plain grey
  /** Receivers: per element (triangle or vertex) of the geometry, the shown result's linear colour and every value. */
  result?: { perFace: boolean; rgb: Float32Array; values: { name: string; data: ArrayLike<number> }[] };
}

/** World matrices of an object's copies, scaled to metres (`scale` = the stage's metersPerUnit). */
export function exportMatrices(o: Object3D, scale: number): Matrix4[] {
  const s = new Matrix4().makeScale(scale, scale, scale).multiply(o.matrixWorld), im = o as InstancedMesh;
  if (!im.isInstancedMesh) return [s];
  return Array.from({ length: im.count }, (_, i) => s.clone().multiply(im.getMatrixAt(i, new Matrix4())));
}

/**
 * A receiver's geometry for export: position and normal, the result colour as `color` and every value as
 * `_daylight_<name>` (GLTFExporter writes `_DAYLIGHT_<NAME>`). Per face the triangles are split so each corner carries
 * its triangle's value.
 */
export function resultGeometry(g: BufferGeometry, r: NonNullable<Drawn['result']>): BufferGeometry {
  let out = new BufferGeometry().setAttribute('position', g.attributes.position);
  if (g.attributes.normal) out.setAttribute('normal', g.attributes.normal);
  if (g.index) out.setIndex(g.index);
  if (r.perFace && out.index) out = out.toNonIndexed();
  const n = out.attributes.position.count, per = r.perFace ? 3 : 1; // corners per element
  const rgb = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) rgb.set(r.rgb.subarray(3 * Math.floor(i / per), 3 * Math.floor(i / per) + 3), 3 * i);
  out.setAttribute('color', new BufferAttribute(rgb, 3));
  for (const v of r.values) {
    const data = new Float32Array(n);
    // ponytail: a NaN result (no value) is written as 0; glTF has no "missing"
    for (let i = 0; i < n; i++) { const x = v.data[Math.floor(i / per)]; data[i] = Number.isFinite(x) ? x : 0; }
    out.setAttribute(`_daylight_${v.name}`, new BufferAttribute(data, 1));
  }
  return out;
}

/**
 * The base-colour texture of a viewer material: its colorNode is texture(...), maybe times a scale and plus a bias
 * (operators: the left operand), behind a channel split and variables (wrappers: their node).
 */
export function textureOf(node: unknown): Texture | null {
  let n = node as { isTextureNode?: boolean; isOperatorNode?: boolean; node?: unknown; aNode?: unknown; value?: Texture } | null | undefined;
  for (let depth = 0; n && !n.isTextureNode && depth < 16; depth++) n = (n.isOperatorNode ? n.aNode : n.node) as typeof n;
  const t = n?.value;
  return t?.isTexture && !(t as { isDataTexture?: boolean }).isDataTexture ? t : null;
}

/**
 * A viewer material as GLTFExporter reads it: colour, metal / roughness, opacity, vertex colours, the base-colour texture
 * (stored upright again: the viewer keeps its bitmaps flipped, flipY false).
 * ponytail: texture scale / bias, UsdTransform2d and the other maps are dropped; add them when an export needs them
 */
export function standard(m: Material): MeshStandardMaterial {
  const s = m as Material & { color?: Color; metalness?: number; roughness?: number; vertexColors?: boolean; colorNode?: unknown };
  const map = textureOf(s.colorNode);
  const out = new MeshStandardMaterial({
    // BLEND only with an alpha the export carries (a constant below 1, the base texture's): transparent through another
    // texture (an MTL map_d alone) would be BLEND at alpha 1, without depth writes
    name: m.name, color: s.color ?? new Color(1, 1, 1), metalness: s.metalness ?? 0, roughness: s.roughness ?? 1,
    opacity: m.opacity, transparent: m.transparent && (m.opacity < 1 || !!map), alphaTest: m.alphaTest, side: m.side,
    vertexColors: !!(s.vertexColors || m.userData.readsDisplayColor),
  });
  if (map) {
    out.map = map.clone();
    out.map.flipY = true; // GLTFExporter flips the canvas back
    out.map.needsUpdate = true;
  }
  return out;
}

/** Geometry for a mesh with its stage look: the drawn attributes glTF knows, uv turned to glTF's top-left origin. */
function lookGeometry(g: BufferGeometry): BufferGeometry {
  const out = new BufferGeometry().setAttribute('position', g.attributes.position);
  for (const k of ['normal', 'color'] as const) if (g.attributes[k]) out.setAttribute(k, g.attributes[k]);
  const uv = g.attributes.uv;
  if (uv) {
    const flipped = new Float32Array(2 * uv.count);
    for (let i = 0; i < uv.count; i++) { flipped[2 * i] = uv.getX(i); flipped[2 * i + 1] = 1 - uv.getY(i); }
    out.setAttribute('uv', new BufferAttribute(flipped, 2));
  }
  if (g.index) out.setIndex(g.index);
  for (const gr of g.groups) out.addGroup(gr.start, gr.count, gr.materialIndex);
  return out;
}

const GREY = new MeshStandardMaterial({ name: 'Grey', color: 0xb4b4b4, roughness: 1, side: DoubleSide });

/** The scene GLTFExporter writes: one node per copy (named by prim path, matrix in metres). */
export function gltfScene(drawn: Drawn[]): Scene {
  const scene = new Scene(), looks = new Map<Material, Material>(), result = new MeshBasicMaterial({ name: 'Daylight result', vertexColors: true, side: DoubleSide });
  const look = (m: Material) => { let x = looks.get(m); if (!x) looks.set(m, (x = standard(m))); return x; };
  for (const d of drawn) {
    const geometry = d.result ? resultGeometry(d.geometry, d.result) : lookGeometry(d.geometry);
    const material = d.result ? result : d.material === null ? GREY : Array.isArray(d.material) ? d.material.map(look) : look(d.material);
    d.matrices.forEach((m, i) => {
      const mesh = new Mesh(geometry, material);
      mesh.name = d.matrices.length > 1 ? `${d.name} ${i + 1}` : d.name;
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(m);
      scene.add(mesh);
    });
  }
  return scene;
}

const SRGB = (x: number) => +new Color(x, x, x).convertLinearToSRGB().r.toFixed(4);

/**
 * OBJ text parts (never one huge string): per copy an `o`, its vertices in metres with colours (receivers: the result,
 * others: their material's base colour), normals, triangles.
 * ponytail: one colour per mesh for the others (a multi-material mesh takes its first); per-group colours if it matters
 */
export function objText(drawn: Drawn[]): string[] {
  const out = ['# Daylight result: metres, Y up; vertex colours (sRGB) after the coordinates\n'];
  const p = new Vector3(), nm = new Matrix3();
  let vbase = 1, nbase = 1; // OBJ numbers v and vn apart, from 1
  for (const d of drawn) {
    const g = d.result ? resultGeometry(d.geometry, d.result) : d.geometry, pos = g.attributes.position, normal = g.attributes.normal, col = d.result ? g.attributes.color : null;
    const first = Array.isArray(d.material) ? d.material[0] : d.material, c = (first as { color?: Color } | null)?.color;
    const flat = c ? ` ${SRGB(c.r)} ${SRGB(c.g)} ${SRGB(c.b)}` : '';
    const index = g.index, n = index ? index.count : pos.count;
    d.matrices.forEach((m, k) => {
      const lines: string[] = [`o ${(d.matrices.length > 1 ? `${d.name} ${k + 1}` : d.name).replace(/\s+/g, '_')}`];
      for (let i = 0; i < pos.count; i++) {
        p.fromBufferAttribute(pos, i).applyMatrix4(m);
        lines.push(`v ${p.x} ${p.y} ${p.z}${col ? ` ${SRGB(col.getX(i))} ${SRGB(col.getY(i))} ${SRGB(col.getZ(i))}` : flat}`);
      }
      if (normal) {
        nm.getNormalMatrix(m);
        for (let i = 0; i < normal.count; i++) { p.fromBufferAttribute(normal, i).applyMatrix3(nm).normalize(); lines.push(`vn ${+p.x.toFixed(6)} ${+p.y.toFixed(6)} ${+p.z.toFixed(6)}`); }
      }
      const at = (i: number) => { const v = index ? index.getX(i) : i; return normal ? `${vbase + v}//${nbase + v}` : String(vbase + v); };
      for (let t = 0; t < n; t += 3) lines.push(`f ${at(t)} ${at(t + 1)} ${at(t + 2)}`);
      vbase += pos.count;
      if (normal) nbase += normal.count;
      for (let i = 0; i < lines.length; i += 65536) out.push(`${lines.slice(i, i + 65536).join('\n')}\n`);
    });
  }
  return out;
}
