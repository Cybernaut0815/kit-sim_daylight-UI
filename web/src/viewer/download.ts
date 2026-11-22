// The run bar's "Download": the result in the format picked.
// USD, each receiver on the polygons the run simulated (the viewer core maps the drawn triangles back to them: meshMap):
// - usdz, replace: a root layer over the model files (lib/usdexport overlay), packed with them and the session layer
//   (its variant choices and subdivision levels are what the run used);
// - usdz, variants: the core flattens the stage as shown and adds the variant sets (exportVariants, usdc), packed with
//   the files its asset paths name;
// - usda / usdc / usd: one flattened layer, the core composing the overlay over the stage (replace) or adding the variant
//   sets; zipped with the files it uses (textures) when it uses any.
// glTF / GLB / OBJ: the model as drawn, receivers coloured with the shown result (lib/sceneexport).
// values: every result as numbers, values.npy (float32, rows x columns) + weights.npy + values.json, zipped; any size.
// Above about 4M triangles only those and the usdz replace (its overlay a usdc the core writes from binary arrays, nothing
// flattened, the model's files packed as they are) are written (tooBig): the others pass a browser's buffer or string
// limits, or the core's heap (flattening).
import type { BufferAttribute, InterleavedBufferAttribute, Mesh, Object3D } from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import type { StageInfo, UsdViewerElement } from 'usd-viewer';
import { lin, rgbFor, type Scale } from '../lib/gradients';
import { exportMatrices, gltfScene, objText, type Drawn } from '../lib/sceneexport';
import { drawnValues } from '../lib/topology';
import { freeName, overlay, overlayArrays, polygonCorners, polygonGeometry, rowsOnPolygons, toCorners, toPolygons, variantsSpec, type OverlayMesh, type ResultMesh } from '../lib/usdexport';
import { usdz } from '../lib/usdz';
import { stableKey } from '../mcp/tools';
import type { ObjectRow, RunResult } from '../store';

export type ExportMode = 'replace' | 'variants';
export type Format = 'usdz' | 'usda' | 'usdc' | 'usd' | 'glb' | 'gltf' | 'obj' | 'values';
export const FORMATS: readonly Format[] = ['usdz', 'usda', 'usdc', 'usd', 'glb', 'gltf', 'obj', 'values'];
export const isUsd = (f: Format) => f.startsWith('usd');
/** The open model as picked: every file at its path in the package (the root layer among them). */
export interface PickedModel { files: [path: string, file: File][]; root: string; info: StageInfo }
export interface DownloadOptions {
  usd: UsdViewerElement; // the model's viewer
  result: RunResult; objects: ObjectRow[]; meshes: ReadonlyMap<string, Object3D>; column: number; model: PickedModel;
  scales: Scale[]; // per result column, the scale shown (one over every model's values)
}

/** What the overlay blocks on a receiver written with other polygons: authored data that no longer fits them. */
const BLOCK = /^(primvars:.*|normals|crease\w*|corner\w*|holeIndices)$/;
const MIME: Record<string, string> = { usdz: 'model/vnd.usdz+zip', glb: 'model/gltf-binary', gltf: 'model/gltf+json', obj: 'model/obj', zip: 'application/zip' };

const xyz = (a: BufferAttribute | InterleavedBufferAttribute) => {
  const out = new Float32Array(3 * a.count);
  for (let i = 0; i < a.count; i++) { out[3 * i] = a.getX(i); out[3 * i + 1] = a.getY(i); out[3 * i + 2] = a.getZ(i); }
  return out;
};
const save = (data: BlobPart[], name: string) => {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob(data, { type: MIME[name.split('.').pop()!] ?? 'application/octet-stream' })), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
};

/** The most triangles a model gets USD, glTF or OBJ for. ponytail: one bound for all of them (the USD layers and the
 *  overlay are text, glTF a JSON and buffers, OBJ a string); measure per format if a bigger model needs one. */
export const MAX_TRIANGLES = 4_000_000;
/** Why `format` (and `mode`) is refused for a model of `tris` triangles, or null. */
export function tooBig(format: Format, mode: ExportMode, tris: number): string | null {
  if (format === 'values' || (format === 'usdz' && mode === 'replace') || tris <= MAX_TRIANGLES) return null;
  return `A ${format}${isUsd(format) && mode === 'variants' ? ' with variants' : ''} file of this model (${tris.toLocaleString('en-GB')} triangles) is too big for the browser to write: the limit is ${MAX_TRIANGLES.toLocaleString('en-GB')}. Download a .usdz with the results replacing the materials, or Values (.npy + .json, zip) for every result as numbers.`;
}

/** NumPy v1.0 header for `<f4` data of `shape`, Fortran order (column-major: a run's columns one after another). */
export function npyHeader(shape: number[]): Uint8Array {
  let h = `{'descr': '<f4', 'fortran_order': True, 'shape': (${shape.join(', ')}${shape.length === 1 ? ',' : ''}), }`;
  h += `${' '.repeat((64 - ((11 + h.length) % 64)) % 64)}\n`;
  const out = new Uint8Array(10 + h.length);
  out.set([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 1, 0, h.length & 255, h.length >> 8]); // \x93NUMPY, v1.0, header length
  out.set(new TextEncoder().encode(h), 10);
  return out;
}

/** The values download's files: values.npy (rows x columns, float32), weights.npy (each row's area) and values.json
 *  (the columns, each receiver's rows by path and what a row of it is, what ran). The columns go in as they are when
 *  they are one buffer. */
export function valuesFiles(r: RunResult, objects: readonly ObjectRow[]): [string, Uint8Array][] {
  const rows = r.weights.length, c0 = r.data[0], one = r.data.every((c, k) => c.buffer === c0.buffer && c.byteOffset === c0.byteOffset + 4 * rows * k);
  const body = one ? new Uint8Array(c0.buffer, c0.byteOffset, 4 * rows * r.data.length) : new Uint8Array(r.data.reduce((b, c, k) => (b.set(new Uint8Array(c.buffer, c.byteOffset, 4 * rows), 4 * rows * k), b), new Uint8Array(4 * rows * r.data.length)).buffer);
  const cat = (a: Uint8Array, b: Uint8Array) => { const out = new Uint8Array(a.length + b.length); out.set(a); out.set(b, a.length); return out; };
  const path = new Map(objects.map((o) => [o.id, o.path]));
  const meta = {
    columns: r.columns, elements: r.on, rows, order: 'values.npy: rows x columns, float32 (column-major); weights.npy: each row\'s area in m² (vertices: its share of the faces round it). A mesh\'s rows: its own faces (in drawn order: the file\'s, faces of a material subset together) or its own points (those a face uses, in order of first use); "triangles" / "vertices": the mesh as drawn',
    meshes: r.manifest.meshes.map((g, k) => ({ path: path.get(r.receivers[k]) ?? null, first: g.first, count: g.count, rows: r.forms?.[k] ? (r.on === 'faces' ? 'faces' : 'points') : r.on === 'faces' ? 'triangles' : 'vertices' })),
    args: (JSON.parse(stableKey(r.key, objects)) as [string[]])[0], duration_h: r.manifest.duration_h, ...(r.switches ? { switches: r.switches } : {}), // mesh ids as prim paths
  };
  // ponytail: a header and the columns in one copy (a zip writes them in one buffer anyway); Blob parts if 2x hurts
  return [['values.npy', cat(npyHeader([rows, r.data.length]), body)], ['weights.npy', cat(npyHeader([rows]), new Uint8Array(r.weights.buffer, r.weights.byteOffset, 4 * rows))],
    ['values.json', new TextEncoder().encode(`${JSON.stringify(meta, null, 1)}\n`)]];
}

export async function download(format: Format, mode: ExportMode, o: DownloadOptions): Promise<void> {
  const { usd } = o, stem = o.model.root.replace(/^.*\//, '').replace(/\.\w+$/, '');
  const big = tooBig(format, mode, o.objects.reduce((n, x) => n + x.tris, 0));
  if (big) throw new Error(big);
  if (format === 'values') return save([await usdz(valuesFiles(o.result, o.objects))], `${stem}_daylight_values.zip`);
  if (!isUsd(format)) return drawnFile(format, o, stem);
  const r = o.result, perFace = r.on === 'faces';
  const rows = new Map(o.objects.map((x) => [x.id, x])), items = new Map(usd.three.items().map((it) => [it.object, it])); // one lookup per receiver
  const meshes: ResultMesh[] = await Promise.all(r.receivers.map(async (id, k) => {
    const row = rows.get(id), g = r.manifest.meshes[k], object = o.meshes.get(id) as Mesh | undefined;
    if (!row || !object) throw new Error('The model changed since this run: run it again, then download.');
    const item = items.get(object), map = item ? await usd.usd.meshMap(item.rid) : null;
    if (!map) throw new Error(`${row.name}: the viewer has no polygons for this mesh.`);
    const geo = object.geometry, position = geo.getAttribute('position'), normal = geo.getAttribute('normal');
    const index = geo.index ? geo.index.array : Uint32Array.from({ length: position.count }, (_, i) => i);
    const form = r.forms?.[k] ?? null, want = perFace ? form?.faces ?? index.length / 3 : form?.points ?? position.count; // its rows: its own faces and points, or as drawn
    if (want !== g.count || map.faces.length !== index.length / 3 || (form && form.cornerRow.length !== index.length)) throw new Error(`${row.name}: ${g.count} results for another mesh. Run again, then download.`);
    const poly = polygonCorners(index, map), rowsOf = (a: Float32Array) => a.subarray(g.first, g.first + g.count); // views, no copies
    const from = form && rowsOnPolygons(form, poly, perFace);
    const columns = r.columns.map((name, c) => {
      const raw = rowsOf(r.data[c]);
      const data = from ? Float32Array.from(from, (i) => (i >= 0 ? raw[i] : NaN)) : perFace ? toPolygons(raw, poly.polygonOf, poly.counts.length, rowsOf(r.weights)) : toCorners(raw, poly.corners);
      // replace writes the shown column's colours only: no 12 B per element for the others (0.2 GB a column at bhs)
      return { name, data, rgb: mode === 'variants' || c === o.column ? rgbFor(o.scales[c], data, null).map(lin) : new Float32Array(0) };
    });
    return {
      path: row.path, interp: perFace ? 'uniform' : 'faceVarying',
      values: columns.map((c) => ({ name: c.name, data: c.data })), colours: columns.map((c) => c.rgb),
      geometry: map.authored ? null : polygonGeometry(xyz(position), normal ? xyz(normal) : null, poly, map.weld),
    };
  }));
  const taken = (await usd.usd.children('/')).map((s) => s.name), root = freeName('Daylight', taken);
  const mount = /^\/drop\/\d+\//.exec(o.model.info.url)?.[0], assets: [string, string][] = mount ? [[mount, './']] : [];
  const name = `${stem}_daylight${mode === 'variants' ? '_variants' : ''}`;
  /** The picked files the core says the export uses (a .usdz member counts as its package), as the Files they are. */
  const used = (paths: string[]) => { const u = new Set(paths.map((p) => p.replace(/\[.*$/, ''))); return o.model.files.filter(([p]) => u.has(p)); };
  /** The overlay's receivers: blocks for authored data the new polygons do not fit, and their subsets. */
  const overlayMeshes = () => Promise.all(meshes.map(async (m): Promise<OverlayMesh> => {
    const info = await usd.usd.prim(m.path);
    const blocks = info.attributes
      .filter((a) => a.authored && (m.geometry
        ? BLOCK.test(a.name) && a.name !== 'primvars:displayColor' && !(a.name === 'normals' && m.geometry.normals) && !m.values.some((v) => a.name === `primvars:daylight_${v.name}`) // authored again below
        : a.name === 'primvars:displayColor:indices'))
      .map((a) => ({ name: a.name, type: a.typeName, uniform: a.variability === 'uniform' }));
    const subsets = (await usd.usd.children(m.path)).filter((s) => s.typeName === 'GeomSubset').map((s) => s.name);
    return { ...m, blocks, subsets };
  }));

  if (format !== 'usdz') { // one flattened layer: usda text, or usdc (also as .usd)
    const spec = mode === 'variants'
      ? variantsSpec(meshes, { columns: r.columns, shown: o.column, root, geometryRoot: freeName(`${root}_Geometry`, taken), assets })
      : { spec: { set: '', selection: '', material: '', geometryRoot: '', prims: [], assets, overlay: overlay({ meta: [], subLayers: [], root, meshes: await overlayMeshes(), shown: o.column }).join('') }, floats: new Float32Array(), ints: new Int32Array() };
    const out = await usd.usd.exportVariants({ ...spec.spec, format: format === 'usda' ? 'usda' : 'usdc' }, spec.floats, spec.ints);
    if (out.error !== undefined) throw new Error(out.error);
    const files = used(out.assets);
    if (!files.length) return save([out.bytes], `${name}.${format}`);
    return save([await usdz([[`${name}.${format}`, out.bytes], ...files])], `${name}.zip`); // a stored zip, the layer first
  }
  let files: [string, Blob | Uint8Array][];
  if (mode === 'replace') {
    const session = (await usd.usd.layers()).find((l) => l.session);
    const sessionText = session ? await usd.usd.exportLayer(session.identifier, 'usda') : null;
    const i = o.model.info, meta = [
      ...(i.defaultPrim ? [`defaultPrim = "${i.defaultPrim.replace(/^\//, '')}"`] : []), `metersPerUnit = ${i.metersPerUnit}`, `upAxis = "${i.upAxis}"`,
      ...(i.hasTimeRange ? [`startTimeCode = ${i.startTimeCode}`, `endTimeCode = ${i.endTimeCode}`, `timeCodesPerSecond = ${i.timeCodesPerSecond}`] : []),
    ];
    // The overlay as usdc, its arrays written by the core from binary (text would pass a browser's string limit at
    // a few million values): nothing is flattened, and the model's files go in as they are.
    const om = await overlayMeshes(), { prims, floats, ints } = overlayArrays(om, o.column);
    const text = overlay({ meta, subLayers: [...(sessionText ? ['./_session.usda'] : []), `./${o.model.root}`], root, meshes: om, shown: o.column, arrays: false }).join('');
    const out = await usd.usd.exportVariants({ set: '', selection: '', material: '', geometryRoot: '', prims, overlay: text, flatten: false }, floats, ints);
    if (out.error !== undefined) throw new Error(out.error);
    files = [['_daylight.usdc', out.bytes], ...(sessionText ? [['_session.usda', sessionText] as [string, Uint8Array]] : []), ...o.model.files];
  } else {
    const { spec, floats, ints } = variantsSpec(meshes, { columns: r.columns, shown: o.column, root, geometryRoot: freeName(`${root}_Geometry`, taken), assets });
    const out = await usd.usd.exportVariants(spec, floats, ints);
    if (out.error !== undefined) throw new Error(out.error);
    files = [[`${stem}_daylight.usdc`, out.bytes], ...used(out.assets)];
  }
  save([await usdz(files)], `${name}.usdz`);
}

/** glTF / GLB / OBJ: every visible mesh as drawn, in metres; receivers with the shown result and every value. */
async function drawnFile(format: Format, o: DownloadOptions, stem: string): Promise<void> {
  const { usd } = o, r = o.result, perFace = r.on === 'faces', scale = o.model.info.metersPerUnit;
  const shown = o.scales[o.column], receivers = new Map(r.receivers.map((id, k) => [o.meshes.get(id), k]));
  usd.three.root.updateMatrixWorld(true);
  const drawn: Drawn[] = [];
  for (const item of usd.three.items()) {
    const object = item.object as Mesh | null;
    if (item.kind !== 'mesh' || !object?.visible) continue;
    const k = receivers.get(object), matrices = exportMatrices(object, scale);
    if (k === undefined) { drawn.push({ name: item.path, geometry: object.geometry, matrices, material: usd.three.materials(item.rid) }); continue; }
    const g = r.manifest.meshes[k], geo = object.geometry, corners = geo.index ? geo.index.count : geo.attributes.position.count;
    const form = r.forms?.[k] ?? null, n = perFace ? form?.faces ?? corners / 3 : form?.points ?? geo.attributes.position.count; // its rows: its own faces and points, or as drawn
    if (n !== g.count || (form && form.cornerRow.length !== corners)) throw new Error(`${item.path}: ${g.count} results for another mesh. Run again, then download.`);
    // on the drawn triangles: a face's value on each of its triangles, a point's on the corners that name it
    const column = (c: number) => { const rows = r.data[c].subarray(g.first, g.first + g.count); return form ? drawnValues(rows, form, r.on, []) : rows; };
    drawn.push({
      name: item.path, geometry: geo, matrices, material: null,
      result: { per: perFace ? 'face' : form ? 'corner' : 'vertex', rgb: rgbFor(shown, column(o.column), null).map(lin), values: r.columns.map((name, c) => ({ name, data: column(c) })) },
    });
  }
  if (format === 'obj') return save(objText(drawn), `${stem}_daylight.obj`);
  const out = await new GLTFExporter().parseAsync(gltfScene(drawn), { binary: format === 'glb' });
  save([format === 'glb' ? (out as ArrayBuffer) : JSON.stringify(out)], `${stem}_daylight.${format}`);
}
