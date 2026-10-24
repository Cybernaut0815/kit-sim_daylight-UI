// three.js model -> USDA layer for the USD viewer (Y-up, metres). Every node an Xform with its local matrix (doubles:
// survey offsets keep their precision; mirrored nodes stay mirrored, so fromThree flips them as before), every triangle
// mesh a Mesh with its own points, triangles and vertex normals, a GPU-instanced one (EXT_mesh_gpu_instancing) a
// PointInstancer; names made USD identifiers, unique per parent. The look comes along: every material the file defines
// a UsdPreviewSurface under /Model/Materials (base colour, opacity, metal / roughness, normal and emissive maps), UVs as
// primvars:st, a multi-material mesh as GeomSubsets, vertex colours as displayColor; the textures are listed for the
// caller to write as PNG files beside the layer.
// ponytail: text USDA, ~66 MB and ~5 s (generate + core parse) per 1M indexed triangles, non-indexed OBJ ~4x; usdc if that hurts
import { Matrix3, Matrix4, MirroredRepeatWrapping, Quaternion, RepeatWrapping, Vector3, DoubleSide, type BufferAttribute, type Color, type InstancedMesh, type InterleavedBufferAttribute, type Material, type Mesh, type Object3D, type Texture, type Vector2 } from 'three';
import { dmeshStems } from 'daylight-mesh';
import { alphaVaries, listMeshes, materialsOf } from './loaders';

export const num = (x: number) => (Number.isFinite(x) ? +x.toPrecision(9) : 0); // float32 round trip; USDA has no NaN
const vec = (a: BufferAttribute | InterleavedBufferAttribute) => (i: number) => `(${num(a.getX(i))}, ${num(a.getY(i))}, ${num(a.getZ(i))})`;
const tuple = (...xs: number[]) => `(${xs.map(num).join(', ')})`;
const ident = (s: string) => s.replace(/[^A-Za-z0-9_]/g, '_').replace(/^(?=\d)/, '_');
/** `head = [item(0), …]tail` as text parts of at most 65536 items: a layer is never built as one huge string. */
export function arrayParts(head: string, n: number, item: (i: number) => string, tail = '\n'): string[] {
  const out = [`${head} = [`];
  for (let i = 0; i < n; i += 65536) out.push((i ? ', ' : '') + Array.from({ length: Math.min(65536, n - i) }, (_, j) => item(i + j)).join(', '));
  out.push(`]${tail}`);
  return out;
}

/** The material properties toUsda reads: three's standard / physical (glTF) and Phong / Lambert (OBJ + MTL) materials. */
type Look = Material & {
  color?: Color; map?: Texture | null; metalness?: number; metalnessMap?: Texture | null; roughness?: number; roughnessMap?: Texture | null;
  shininess?: number; normalMap?: Texture | null; normalScale?: Vector2; emissive?: Color; emissiveIntensity?: number; emissiveMap?: Texture | null;
  alphaMap?: Texture | null; transmission?: number; isMeshStandardMaterial?: boolean;
};
const SLOTS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'alphaMap'] as const;
const WRAP: Record<number, string> = { [RepeatWrapping]: 'repeat', [MirroredRepeatWrapping]: 'mirror' }; // else clamp

/** A model as a USDA layer: text parts, USD path -> the model's own names, and the textures as [layer-relative path, texture]. */
export interface Usda { parts: string[]; names: Map<string, string>; textures: [string, Texture][] }

/**
 * The layer as text parts for `new File(parts, '<model>.usda')` (never one huge string), and USD path -> the model's own
 * name wherever USD needed another (loadFiles restores glTF's original names on purpose).
 */
export function toUsda(root: Object3D): Usda {
  root.updateMatrixWorld(true); // every o.matrix from its position / quaternion / scale
  const tri = new Set<Object3D>(listMeshes(root)), names = new Map<string, string>();
  // Materials the file defines (loadFiles marks the loaders' own defaults as fallback), then their textures, one PNG per image.
  const mats = [...new Set([...tri].flatMap((o) => materialsOf(o as Mesh)))].filter((m) => !m.userData.fallback) as Look[];
  const matIds = dmeshStems(mats.map((m) => ident(m.name || 'Material')), 'Material');
  const matPath = new Map<Material, string>(mats.map((m, i) => [m, `/Model/Materials/${matIds[i]}`]));
  const images = [...new Map(mats.flatMap((m) => SLOTS.map((k) => m[k])).filter((t): t is Texture => !!t?.image).map((t) => [t.image, t])).values()];
  const files = dmeshStems(images.map((t) => ident(t.name || 'texture')), 'texture').map((n) => `textures/${n}.png`);
  const fileOf = new Map<unknown, string>(images.map((t, i) => [t.image, files[i]]));
  const loaded = (t: Texture | null | undefined): t is Texture => !!t && fileOf.has(t.image); // a failed image: no texture

  const out = ['#usda 1.0\n(\n    defaultPrim = "Model"\n    metersPerUnit = 1\n    upAxis = "Y"\n)\n\n'];
  const arr = (decl: string, n: number, item: (i: number) => string, tail = '') => out.push(...arrayParts(`    ${decl}`, n, item, `${tail}\n`));
  const BIND = ' (\n    prepend apiSchemas = ["MaterialBindingAPI"]\n)';
  /** The mesh's one material path, or null: none, or one per geometry group (an array material with groups: subsets). */
  const own = (o: Mesh) => {
    if (Array.isArray(o.material) && o.geometry.groups.length) return null;
    const m = materialsOf(o)[0];
    return (m && matPath.get(m)) ?? null;
  };
  /** One material per geometry group (three draws an array material by groups): [faces, material path] per bound group. */
  const subsets = (o: Mesh): [number[], string][] => {
    if (!Array.isArray(o.material) || !o.geometry.groups.length) return [];
    const { index, attributes: { position } } = o.geometry, n = (index ? index.count : position.count) / 3;
    return o.geometry.groups.flatMap((g) => {
      const path = matPath.get((o.material as Material[])[g.materialIndex ?? 0]), first = Math.floor(g.start / 3), end = Math.min(Math.floor((g.start + g.count) / 3), n);
      return path && end > first ? [[Array.from({ length: end - first }, (_, i) => first + i), path] as [number[], string]] : [];
    });
  };
  const mesh = (o: Mesh, subIds: string[]) => {
    const { index, attributes: { position, normal, uv, color } } = o.geometry, n = index ? index.count : position.count;
    arr('int[] faceVertexCounts', n / 3, () => '3');
    arr('int[] faceVertexIndices', n, index ? (i) => String(index.getX(i)) : String);
    arr('point3f[] points', position.count, vec(position)); // getX/Y/Z: interleaved and quantized glTF attributes too
    if (normal) arr('normal3f[] normals', normal.count, vec(normal), ' (interpolation = "vertex")');
    if (color) arr('color3f[] primvars:displayColor', color.count, vec(color), ' (interpolation = "vertex")'); // linear in three
    // UVs as USD's st (origin bottom left): the first texture's transform (KHR_texture_transform, MTL -o / -s) baked in,
    // glTF's top-left origin (flipY false) turned over.
    // ponytail: one transform per mesh; UsdTransform2d per texture if materials on one mesh use different ones
    const looks = materialsOf(o).filter((m) => matPath.has(m)) as Look[];
    const t = looks.flatMap((m) => SLOTS.map((k) => m[k])).find(loaded);
    if (uv && t) {
      t.updateMatrix();
      const m = new Matrix3().copy(t.matrix), p = new Vector3();
      arr('texCoord2f[] primvars:st', uv.count, (i) => { p.set(uv.getX(i), uv.getY(i), 1).applyMatrix3(m); return tuple(p.x, t.flipY ? p.y : 1 - p.y); }, ' (interpolation = "vertex")');
    }
    if (looks.some((m) => m.side === DoubleSide)) out.push('    uniform bool doubleSided = 1\n');
    out.push('    uniform token subdivisionScheme = "none"\n'); // else catmullClark: the viewer drops these normals and smooths
    const path = own(o);
    if (path) out.push(`    rel material:binding = <${path}>\n`);
    subsets(o).forEach(([faces, mat], k) => {
      out.push(`def GeomSubset "${subIds[k]}"${BIND}\n{\n    uniform token elementType = "face"\n    uniform token familyName = "materialBind"\n`);
      arr('int[] indices', faces.length, (i) => String(faces[i]));
      out.push(`    rel material:binding = <${mat}>\n}\n`);
    });
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
    out.push(`def Mesh "Mesh"${own(o) || subsets(o).length ? BIND : ''}\n{\n`);
    mesh(o, dmeshStems(subsets(o).map(() => 'Subset'), 'Subset'));
    out.push('}\n}\n');
    const name = o.name || path.slice(path.lastIndexOf('/') + 1);
    names.set(`${path}/Instances`, name).set(`${path}/Instances/Mesh`, name); // instancer and prototype: the node's own name
  };
  const prim = (o: Object3D, name: string, path: string) => {
    if (o.name && o.name !== name) names.set(path, o.name);
    const e = o.matrix.elements, row = (i: number) => `(${e.slice(i, i + 4).join(', ')})`; // three's columns = USD's rows
    const inst = (o as InstancedMesh).isInstancedMesh ? (o as InstancedMesh) : null, isMesh = tri.has(o) && !inst;
    const subs = isMesh ? subsets(o as Mesh) : [], bound = isMesh && (own(o as Mesh) || subs.length);
    out.push(`def ${isMesh ? 'Mesh' : 'Xform'} "${name}"${bound ? BIND : ''}\n{\n    matrix4d xformOp:transform = (${[0, 4, 8, 12].map(row).join(', ')})\n    uniform token[] xformOpOrder = ["xformOp:transform"]\n`);
    // reserved first: the instancer, the subsets, the root's Materials scope; the children get the other names
    const reserved = [...(inst ? ['Instances'] : []), ...subs.map(() => 'Subset'), ...(path === '/Model' && mats.length ? ['Materials'] : [])];
    const ids = dmeshStems([...reserved, ...o.children.map((c) => ident(c.name))], 'Node');
    if (inst) instancer(inst, path); // its own children stay beside the instancer: Hydra draws nothing else under one
    else if (isMesh) mesh(o as Mesh, ids.slice(0, subs.length));
    o.children.forEach((c, i) => prim(c, ids[reserved.length + i], `${path}/${ids[reserved.length + i]}`)); // a Mesh may hold children: the viewer draws them
    if (path === '/Model' && mats.length) out.push('def Scope "Materials"\n{\n', ...mats.map((m, i) => material(m, matIds[i])), '}\n');
    out.push('}\n');
  };

  /** A UsdPreviewSurface from a three material: textures through UsdUVTexture (factors as its scale), st from primvars. */
  const material = (m: Look, id: string): string => {
    const path = `/Model/Materials/${id}`, shaders: string[] = [], inputs: string[] = [];
    const texture = (name: string, t: Texture, srgb: boolean, scale: number[], bias?: number[]) => {
      shaders.push(`def Shader "${name}"\n{\n    uniform token info:id = "UsdUVTexture"\n    asset inputs:file = @./${fileOf.get(t.image)}@\n`
        + `    token inputs:sourceColorSpace = "${srgb ? 'sRGB' : 'raw'}"\n    float4 inputs:scale = ${tuple(...scale)}\n${bias ? `    float4 inputs:bias = ${tuple(...bias)}\n` : ''}`
        + `    token inputs:wrapS = "${WRAP[t.wrapS] ?? 'clamp'}"\n    token inputs:wrapT = "${WRAP[t.wrapT] ?? 'clamp'}"\n    float2 inputs:st.connect = <${path}/St.outputs:result>\n`
        + '    float3 outputs:rgb\n    float outputs:r\n    float outputs:g\n    float outputs:b\n    float outputs:a\n}\n');
      return `<${path}/${name}.outputs:`;
    };
    // The alpha counts only when transparent or cut out: glTF OPAQUE leaves its factor's alpha in opacity, drawn opaque.
    const c = m.color ?? { r: 0.18, g: 0.18, b: 0.18 }, cutout = m.alphaTest > 0, alpha = m.transparent || cutout ? m.opacity ?? 1 : 1;
    const base = loaded(m.map) ? texture('BaseColor', m.map, true, [c.r, c.g, c.b, alpha]) : null;
    if (base) inputs.push(`color3f inputs:diffuseColor.connect = ${base}rgb>`);
    else if (m.vertexColors) { // glTF COLOR_0, OBJ v r g b: the diffuse reads displayColor (the factor only as its fallback)
      shaders.push(`def Shader "Color"\n{\n    uniform token info:id = "UsdPrimvarReader_float3"\n    string inputs:varname = "displayColor"\n    float3 inputs:fallback = ${tuple(c.r, c.g, c.b)}\n    float3 outputs:result\n}\n`);
      inputs.push(`color3f inputs:diffuseColor.connect = <${path}/Color.outputs:result>`);
    } else inputs.push(`color3f inputs:diffuseColor = ${tuple(c.r, c.g, c.b)}`);
    // glTF transmission (three draws it in a pass of its own, transparent stays false) as a constant, never below 0.2 so the
    // glass stays in view; metals pass none. An MTL map_d: its alpha where that varies (a cut-out PNG), else its grey levels.
    // ponytail: the factors only (no transmission / metalness texture); a cut-out with transmission (glTF MASK) stays a
    // cut-out with opaque glass: UsdPreviewSurface has no translucent cut-out, the constant under its threshold draws nothing
    const transmit = (m.transmission ?? 0) * (1 - (m.metalness ?? 0));
    const opacity = transmit && !cutout ? `float inputs:opacity = ${num(Math.max(1 - transmit, 0.2) * alpha)}`
      : loaded(m.alphaMap) ? `float inputs:opacity.connect = ${texture('Opacity', m.alphaMap, false, [alpha, alpha, alpha, alpha])}${alphaVaries(m.alphaMap.image) ? 'a' : 'r'}>`
      : base && (m.transparent || cutout) ? `float inputs:opacity.connect = ${base}a>`
      : alpha < 1 ? `float inputs:opacity = ${num(alpha)}` : null;
    if (opacity) inputs.push(opacity);
    if (cutout) inputs.push(`float inputs:opacityThreshold = ${num(m.alphaTest)}`);
    if (m.isMeshStandardMaterial) { // glTF metal / roughness: roughness in G, metalness in B
      const metal = m.metalness ?? 0, rough = m.roughness ?? 1;
      inputs.push(loaded(m.metalnessMap) ? `float inputs:metallic.connect = ${texture('Metallic', m.metalnessMap, false, [1, 1, metal, 1])}b>` : `float inputs:metallic = ${num(metal)}`);
      inputs.push(loaded(m.roughnessMap) ? `float inputs:roughness.connect = ${texture('Roughness', m.roughnessMap, false, [1, rough, 1, 1])}g>` : `float inputs:roughness = ${num(rough)}`);
    } else { // Phong / Lambert: a dielectric
      // ponytail: roughness from the Phong exponent (Blinn-Phong ~ GGX with alpha^2 = 2 / (n + 2)); MTL Ks is dropped
      inputs.push('float inputs:metallic = 0', `float inputs:roughness = ${num(m.shininess === undefined ? 1 : Math.min(1, Math.sqrt(2 / (m.shininess + 2))))}`);
    }
    const e = m.emissive, k = m.emissiveIntensity ?? 1;
    if (loaded(m.emissiveMap) && e) inputs.push(`color3f inputs:emissiveColor.connect = ${texture('Emissive', m.emissiveMap, true, [e.r * k, e.g * k, e.b * k, 1])}rgb>`);
    else if (e && (e.r || e.g || e.b) && k) inputs.push(`color3f inputs:emissiveColor = ${tuple(e.r * k, e.g * k, e.b * k)}`);
    if (loaded(m.normalMap)) { // tangent-space map in 0..1: scale 2 and bias -1 give -1..1, x / y times the normal scale
      const sx = Math.abs(m.normalScale?.x ?? 1), sy = Math.abs(m.normalScale?.y ?? 1);
      inputs.push(`normal3f inputs:normal.connect = ${texture('Normal', m.normalMap, false, [2 * sx, 2 * sy, 2, 1], [-sx, -sy, -1, 0])}rgb>`);
    }
    const st = shaders.some((x) => x.includes('UsdUVTexture')) ? 'def Shader "St"\n{\n    uniform token info:id = "UsdPrimvarReader_float2"\n    string inputs:varname = "st"\n    float2 outputs:result\n}\n' : '';
    return `def Material "${id}"\n{\n    token outputs:surface.connect = <${path}/Surface.outputs:surface>\n`
      + `def Shader "Surface"\n{\n    uniform token info:id = "UsdPreviewSurface"\n${inputs.map((x) => `    ${x}\n`).join('')}    token outputs:surface\n}\n${st}${shaders.join('')}}\n`;
  };

  prim(root, 'Model', '/Model');
  return { parts: out, names, textures: images.map((t, i) => [files[i], t]) };
}
