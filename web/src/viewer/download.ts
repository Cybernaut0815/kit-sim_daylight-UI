// The Results panel "Download USD": each receiver on the polygons the run simulated (the viewer core maps the drawn
// triangles back to them: meshMap), the result from the store, one usdz.
// - replace: a root layer over the model files (lib/usdexport overlay), packed with them and the session layer (its
//   variant choices and subdivision levels are what the run used);
// - variants: the core flattens the stage as shown and adds the variant sets (exportVariants, usdc), packed with the
//   files its asset paths name.
import type { BufferAttribute, InterleavedBufferAttribute, Mesh, Object3D } from 'three';
import type { StageInfo } from 'usd-viewer';
import { lin, rgbFor, scaleFor } from '../lib/gradients';
import { freeName, overlay, polygonCorners, polygonGeometry, toCorners, toPolygons, variantsSpec, type OverlayMesh, type ResultMesh } from '../lib/usdexport';
import { usdz } from '../lib/usdz';
import { cameraPrims, type SavedView } from '../lib/views';
import type { ObjectRow, RunResult, Settings } from '../store';
import { usd } from './usd';

export type ExportMode = 'replace' | 'variants';
/** The open model as picked: every file at its path in the package (the root layer among them). */
export interface PickedModel { files: [path: string, file: File][]; root: string; info: StageInfo }

/** What the overlay blocks on a receiver written with other polygons: authored data that no longer fits them. */
const BLOCK = /^(primvars:.*|normals|crease\w*|corner\w*|holeIndices)$/;

const xyz = (a: BufferAttribute | InterleavedBufferAttribute) => {
  const out = new Float32Array(3 * a.count);
  for (let i = 0; i < a.count; i++) { out[3 * i] = a.getX(i); out[3 * i + 1] = a.getY(i); out[3 * i + 2] = a.getZ(i); }
  return out;
};
const bytes = async (parts: BlobPart[]) => new Uint8Array(await new Blob(parts).arrayBuffer());

export async function downloadUsd(mode: ExportMode, o: {
  result: RunResult; objects: ObjectRow[]; meshes: ReadonlyMap<string, Object3D>; viz: Settings['viz']; column: number; model: PickedModel;
  weightsFor: (id: string, on: 'faces' | 'vertices') => ArrayLike<number> | undefined;
  cameras?: SavedView[]; // views saved in the app, written as cameras under <root>/Cameras
}): Promise<void> {
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
  const stem = o.model.root.replace(/^.*\//, '').replace(/\.\w+$/, '');
  const read = async ([path, file]: [string, File]): Promise<[string, Uint8Array]> => [path, new Uint8Array(await file.arrayBuffer())];
  const taken = (await usd.usd.children('/')).map((s) => s.name), root = freeName('Daylight', taken);
  usd.three.root.updateMatrixWorld();
  const cameras = o.cameras?.length ? cameraPrims(o.cameras, usd.three.root.matrixWorld, '        ') : '';
  let files: [string, Uint8Array][];
  if (mode === 'replace') {
    const session = (await usd.usd.layers()).find((l) => l.session);
    const sessionText = session ? await usd.usd.exportLayer(session.identifier, 'usda') : null;
    const over: OverlayMesh[] = await Promise.all(meshes.map(async (m) => {
      const info = await usd.usd.prim(m.path);
      const blocks = info.attributes
        .filter((a) => a.authored && (m.geometry
          ? BLOCK.test(a.name) && a.name !== 'primvars:displayColor' && !(a.name === 'normals' && m.geometry.normals)
          : a.name === 'primvars:displayColor:indices'))
        .map((a) => ({ name: a.name, type: a.typeName, uniform: a.variability === 'uniform' }));
      const subsets = (await usd.usd.children(m.path)).filter((s) => s.typeName === 'GeomSubset').map((s) => s.name);
      return { ...m, blocks, subsets };
    }));
    const i = o.model.info, meta = [
      ...(i.defaultPrim ? [`defaultPrim = "${i.defaultPrim.replace(/^\//, '')}"`] : []), `metersPerUnit = ${i.metersPerUnit}`, `upAxis = "${i.upAxis}"`,
      ...(i.hasTimeRange ? [`startTimeCode = ${i.startTimeCode}`, `endTimeCode = ${i.endTimeCode}`, `timeCodesPerSecond = ${i.timeCodesPerSecond}`] : []),
    ];
    const layer = overlay({ meta, subLayers: [...(sessionText ? ['./_session.usda'] : []), `./${o.model.root}`], root, meshes: over, shown: o.column, cameras });
    files = [['_daylight.usda', await bytes(layer)], ...(sessionText ? [['_session.usda', sessionText] as [string, Uint8Array]] : []), ...(await Promise.all(o.model.files.map(read)))];
  } else {
    const mount = /^\/drop\/\d+\//.exec(o.model.info.url)?.[0];
    const { spec, floats, ints } = variantsSpec(meshes, { columns: r.columns, shown: o.column, root, geometryRoot: freeName(`${root}_Geometry`, taken), assets: mount ? [[mount, './']] : [], cameras });
    const out = await usd.usd.exportVariants(spec, floats, ints);
    if (out.error !== undefined) throw new Error(out.error);
    const used = new Set(out.assets);
    files = [[`${stem}_daylight.usdc`, out.bytes], ...(await Promise.all(o.model.files.filter(([p]) => used.has(p)).map(read)))];
  }
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([usdz(files) as Uint8Array<ArrayBuffer>], { type: 'model/vnd.usdz+zip' })), download: `${stem}_daylight${mode === 'variants' ? '_variants' : ''}.usdz` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
