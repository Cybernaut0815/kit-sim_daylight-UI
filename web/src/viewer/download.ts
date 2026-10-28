// The run bar's "Download": the result in the format picked.
// USD, each receiver on the polygons the run simulated (the viewer core maps the drawn triangles back to them: meshMap):
// - usdz, replace: a root layer over the model files (lib/usdexport overlay), packed with them and the session layer
//   (its variant choices and subdivision levels are what the run used);
// - usdz, variants: the core flattens the stage as shown and adds the variant sets (exportVariants, usdc), packed with
//   the files its asset paths name;
// - usda / usdc / usd: one flattened layer, the core composing the overlay over the stage (replace) or adding the variant
//   sets; zipped with the files it uses (textures) when it uses any.
// glTF / GLB / OBJ: the model as drawn, receivers coloured with the shown result (lib/sceneexport).
import type { BufferAttribute, InterleavedBufferAttribute, Mesh, Object3D } from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import type { StageInfo, UsdViewerElement } from 'usd-viewer';
import { lin, rgbFor, scaleFor } from '../lib/gradients';
import { exportMatrices, gltfScene, objText, type Drawn } from '../lib/sceneexport';
import { freeName, overlay, polygonCorners, polygonGeometry, toCorners, toPolygons, variantsSpec, type OverlayMesh, type ResultMesh } from '../lib/usdexport';
import { usdz } from '../lib/usdz';
import type { ObjectRow, RunResult, Settings } from '../store';

export type ExportMode = 'replace' | 'variants';
export type Format = 'usdz' | 'usda' | 'usdc' | 'usd' | 'glb' | 'gltf' | 'obj';
export const FORMATS: readonly Format[] = ['usdz', 'usda', 'usdc', 'usd', 'glb', 'gltf', 'obj'];
export const isUsd = (f: Format) => f.startsWith('usd');
/** The open model as picked: every file at its path in the package (the root layer among them). */
export interface PickedModel { files: [path: string, file: File][]; root: string; info: StageInfo }
export interface DownloadOptions {
  usd: UsdViewerElement; // the model's viewer
  result: RunResult; objects: ObjectRow[]; meshes: ReadonlyMap<string, Object3D>; viz: Settings['viz']; column: number; model: PickedModel;
  weightsFor: (id: string, on: 'faces' | 'vertices') => ArrayLike<number> | undefined;
}

/** What the overlay blocks on a receiver written with other polygons: authored data that no longer fits them. */
const BLOCK = /^(primvars:.*|normals|crease\w*|corner\w*|holeIndices)$/;
const MIME: Record<string, string> = { usdz: 'model/vnd.usdz+zip', glb: 'model/gltf-binary', gltf: 'model/gltf+json', obj: 'model/obj', zip: 'application/zip' };

const xyz = (a: BufferAttribute | InterleavedBufferAttribute) => {
  const out = new Float32Array(3 * a.count);
  for (let i = 0; i < a.count; i++) { out[3 * i] = a.getX(i); out[3 * i + 1] = a.getY(i); out[3 * i + 2] = a.getZ(i); }
  return out;
};
const bytes = async (parts: BlobPart[]) => new Uint8Array(await new Blob(parts).arrayBuffer());
const read = async ([path, file]: [string, File]): Promise<[string, Uint8Array]> => [path, new Uint8Array(await file.arrayBuffer())];
const save = (data: BlobPart[], name: string) => {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob(data, { type: MIME[name.split('.').pop()!] ?? 'application/octet-stream' })), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
};

export async function download(format: Format, mode: ExportMode, o: DownloadOptions): Promise<void> {
  const { usd } = o, stem = o.model.root.replace(/^.*\//, '').replace(/\.\w+$/, '');
  if (!isUsd(format)) return drawnFile(format, o, stem);
  const r = o.result, perFace = r.on === 'faces', items = usd.three.items();
  const scales = r.columns.map((_, c) => scaleFor(r.values, r.columns, c, o.viz));
  const meshes: ResultMesh[] = await Promise.all(r.receivers.map(async (id, k) => {
    const row = o.objects.find((x) => x.id === id), g = r.manifest.meshes[k], object = o.meshes.get(id) as Mesh | undefined;
    if (!row || !object) throw new Error('The model changed since this run: run it again, then download.');
    const item = items.find((it) => it.object === object), map = item ? await usd.usd.meshMap(item.rid) : null;
    if (!map) throw new Error(`${row.name}: the viewer has no polygons for this mesh.`);
    const geo = object.geometry, position = geo.getAttribute('position'), normal = geo.getAttribute('normal');
    const index = geo.index ? geo.index.array : Uint32Array.from({ length: position.count }, (_, i) => i);
    if ((perFace ? index.length / 3 : position.count) !== g.count || map.faces.length !== index.length / 3) throw new Error(`${row.name}: ${g.count} results for another mesh. Run again, then download.`);
    const poly = polygonCorners(index, map), areas = perFace ? o.weightsFor(id, 'faces') : undefined;
    const columns = r.columns.map((name, c) => {
      const raw = new Float64Array(g.count);
      for (let i = 0; i < g.count; i++) raw[i] = r.values[g.first + i][c];
      const data = perFace ? toPolygons(raw, poly.polygonOf, poly.counts.length, areas ?? new Float64Array(g.count).fill(1)) : toCorners(raw, poly.corners);
      return { name, data, rgb: rgbFor(scales[c], data, null).map(lin) };
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
  /** The picked files the core says the export uses (a .usdz member counts as its package). */
  const used = async (paths: string[]) => { const u = new Set(paths.map((p) => p.replace(/\[.*$/, ''))); return Promise.all(o.model.files.filter(([p]) => u.has(p)).map(read)); };
  /** The overlay's receivers: blocks for authored data the new polygons do not fit, and their subsets. */
  const overlayMeshes = () => Promise.all(meshes.map(async (m): Promise<OverlayMesh> => {
    const info = await usd.usd.prim(m.path);
    const blocks = info.attributes
      .filter((a) => a.authored && (m.geometry
        ? BLOCK.test(a.name) && a.name !== 'primvars:displayColor' && !(a.name === 'normals' && m.geometry.normals)
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
    const files = await used(out.assets);
    if (!files.length) return save([out.bytes], `${name}.${format}`);
    return save([usdz([[`${name}.${format}`, out.bytes], ...files]) as Uint8Array<ArrayBuffer>], `${name}.zip`); // a stored zip, the layer first
  }
  let files: [string, Uint8Array][];
  if (mode === 'replace') {
    const session = (await usd.usd.layers()).find((l) => l.session);
    const sessionText = session ? await usd.usd.exportLayer(session.identifier, 'usda') : null;
    const i = o.model.info, meta = [
      ...(i.defaultPrim ? [`defaultPrim = "${i.defaultPrim.replace(/^\//, '')}"`] : []), `metersPerUnit = ${i.metersPerUnit}`, `upAxis = "${i.upAxis}"`,
      ...(i.hasTimeRange ? [`startTimeCode = ${i.startTimeCode}`, `endTimeCode = ${i.endTimeCode}`, `timeCodesPerSecond = ${i.timeCodesPerSecond}`] : []),
    ];
    const layer = overlay({ meta, subLayers: [...(sessionText ? ['./_session.usda'] : []), `./${o.model.root}`], root, meshes: await overlayMeshes(), shown: o.column });
    files = [['_daylight.usda', await bytes(layer)], ...(sessionText ? [['_session.usda', sessionText] as [string, Uint8Array]] : []), ...(await Promise.all(o.model.files.map(read)))];
  } else {
    const { spec, floats, ints } = variantsSpec(meshes, { columns: r.columns, shown: o.column, root, geometryRoot: freeName(`${root}_Geometry`, taken), assets });
    const out = await usd.usd.exportVariants(spec, floats, ints);
    if (out.error !== undefined) throw new Error(out.error);
    files = [[`${stem}_daylight.usdc`, out.bytes], ...(await used(out.assets))];
  }
  save([usdz(files) as Uint8Array<ArrayBuffer>], `${name}.usdz`);
}

/** glTF / GLB / OBJ: every visible mesh as drawn, in metres; receivers with the shown result and every value. */
async function drawnFile(format: Format, o: DownloadOptions, stem: string): Promise<void> {
  const { usd } = o, r = o.result, perFace = r.on === 'faces', scale = o.model.info.metersPerUnit;
  const shown = scaleFor(r.values, r.columns, o.column, o.viz), receivers = new Map(r.receivers.map((id, k) => [o.meshes.get(id), k]));
  usd.three.root.updateMatrixWorld(true);
  const drawn: Drawn[] = [];
  for (const item of usd.three.items()) {
    const object = item.object as Mesh | null;
    if (item.kind !== 'mesh' || !object?.visible) continue;
    const k = receivers.get(object), matrices = exportMatrices(object, scale);
    if (k === undefined) { drawn.push({ name: item.path, geometry: object.geometry, matrices, material: usd.three.materials(item.rid) }); continue; }
    const g = r.manifest.meshes[k], geo = object.geometry, n = perFace ? (geo.index ? geo.index.count : geo.attributes.position.count) / 3 : geo.attributes.position.count;
    if (n !== g.count) throw new Error(`${item.path}: ${g.count} results for another mesh. Run again, then download.`);
    const column = (c: number) => Float64Array.from({ length: g.count }, (_, i) => r.values[g.first + i][c]);
    drawn.push({
      name: item.path, geometry: geo, matrices, material: null,
      result: { perFace, rgb: rgbFor(shown, column(o.column), null).map(lin), values: r.columns.map((name, c) => ({ name, data: column(c) })) },
    });
  }
  if (format === 'obj') return save(objText(drawn), `${stem}_daylight.obj`);
  const out = await new GLTFExporter().parseAsync(gltfScene(drawn), { binary: format === 'glb' });
  save([format === 'glb' ? (out as ArrayBuffer) : JSON.stringify(out)], `${stem}_daylight.${format}`);
}
