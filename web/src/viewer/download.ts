// The Results panel "Download USD": the receivers as the run saw them (the drawn triangles, from the viewer), the
// result from the store, the layer from lib/usdexport, one usdz from lib/usdz.
// - replace: a root layer over the model files, packed with them (and the session layer: its variant choices and
//   subdivision levels are what the run used).
// - variants: the stage flattened as shown, each receiver with a variant set "daylight", packed with its textures.
// ponytail: the variants edit runs on the main thread (~4 s for Kitchen_set, after ~10-20 s of core flatten in its
// worker); a Worker for the edit, or an Sdf edit in the core, if large stages make that a real wait
import type { BufferAttribute, InterleavedBufferAttribute, Mesh, Object3D } from 'three';
import type { StageInfo } from 'usd-viewer';
import { lin, rgbFor, scaleFor } from '../lib/gradients';
import { freeName, overlay, relativeAssets, variants, type ExportMesh, type Interp, type OverlayMesh } from '../lib/usdexport';
import { usdz } from '../lib/usdz';
import type { ObjectRow, RunResult, Settings } from '../store';
import { usd } from './usd';

export type ExportMode = 'replace' | 'variants';
/** The open model as picked: every file at its path in the package (the root layer among them). */
export interface PickedModel { files: [path: string, file: File][]; root: string; info: StageInfo }

/** What the overlay blocks on a receiver: authored data that no longer fits the new triangles (displayColor is rewritten). */
const BLOCK = /^(primvars:.*|normals|crease\w*|corner\w*|holeIndices)$/;

const xyz = (a: BufferAttribute | InterleavedBufferAttribute) => {
  const out = new Float32Array(3 * a.count);
  for (let i = 0; i < a.count; i++) { out[3 * i] = a.getX(i); out[3 * i + 1] = a.getY(i); out[3 * i + 2] = a.getZ(i); }
  return out;
};
const bytes = async (parts: BlobPart[]) => new Uint8Array(await new Blob(parts).arrayBuffer());

export async function downloadUsd(mode: ExportMode, o: { result: RunResult; objects: ObjectRow[]; meshes: ReadonlyMap<string, Object3D>; viz: Settings['viz']; column: number; model: PickedModel }): Promise<void> {
  const r = o.result, interp: Interp = r.on === 'faces' ? 'uniform' : 'vertex';
  const scales = r.columns.map((_, c) => scaleFor(r.values, r.columns, c, o.viz));
  const meshes: ExportMesh[] = r.receivers.map((id, k) => {
    const row = o.objects.find((x) => x.id === id), g = r.manifest.meshes[k], geo = (o.meshes.get(id) as Mesh | undefined)?.geometry;
    if (!row || !geo) throw new Error('The model changed since this run: run it again, then download.');
    const position = geo.getAttribute('position'), normal = geo.getAttribute('normal');
    const indices = geo.index ? Uint32Array.from(geo.index.array) : Uint32Array.from({ length: position.count }, (_, i) => i);
    if ((r.on === 'faces' ? indices.length / 3 : position.count) !== g.count) throw new Error(`${row.name}: ${g.count} results for another mesh. Run again, then download.`);
    const columns = r.columns.map((name, c) => {
      const values = new Float32Array(g.count);
      for (let i = 0; i < g.count; i++) values[i] = r.values[g.first + i][c];
      return { name, values, rgb: rgbFor(scales[c], values, null).map(lin) };
    });
    return { path: row.path, positions: xyz(position), indices, normals: normal ? xyz(normal) : null, columns };
  });
  const stem = o.model.root.replace(/^.*\//, '').replace(/\.\w+$/, '');
  const read = async ([path, file]: [string, File]): Promise<[string, Uint8Array]> => [path, new Uint8Array(await file.arrayBuffer())];
  let files: [string, Uint8Array][];
  if (mode === 'replace') {
    const session = (await usd.usd.layers()).find((l) => l.session);
    const sessionText = session ? await usd.usd.exportLayer(session.identifier, 'usda') : null;
    const root = freeName('Daylight', (await usd.usd.children('/')).map((s) => s.name));
    const over: OverlayMesh[] = await Promise.all(meshes.map(async (m) => {
      const info = await usd.usd.prim(m.path);
      const blocks = info.attributes
        .filter((a) => a.authored && BLOCK.test(a.name) && a.name !== 'primvars:displayColor' && !(a.name === 'normals' && m.normals))
        .map((a) => ({ name: a.name, type: a.typeName, uniform: a.variability === 'uniform' }));
      const subsets = (await usd.usd.children(m.path)).filter((s) => s.typeName === 'GeomSubset').map((s) => s.name);
      return { ...m, blocks, subsets };
    }));
    const i = o.model.info, meta = [
      ...(i.defaultPrim ? [`defaultPrim = "${i.defaultPrim.replace(/^\//, '')}"`] : []), `metersPerUnit = ${i.metersPerUnit}`, `upAxis = "${i.upAxis}"`,
      ...(i.hasTimeRange ? [`startTimeCode = ${i.startTimeCode}`, `endTimeCode = ${i.endTimeCode}`, `timeCodesPerSecond = ${i.timeCodesPerSecond}`] : []),
    ];
    const layer = overlay({ meta, subLayers: [...(sessionText ? ['./_session.usda'] : []), `./${o.model.root}`], root, meshes: over, interp, shown: o.column });
    files = [['_daylight.usda', await bytes(layer)], ...(sessionText ? [['_session.usda', sessionText] as [string, Uint8Array]] : []), ...(await Promise.all(o.model.files.map(read)))];
  } else {
    const flat = await usd.usd.exportLayer('', 'flat');
    if (!flat) throw new Error('The stage could not be flattened.');
    const { text, paths } = relativeAssets(new TextDecoder().decode(flat));
    const layer = variants(text, { meshes, interp, shown: o.column });
    files = [[`${stem}_daylight.usda`, await bytes(layer)], ...(await Promise.all(o.model.files.filter(([p]) => paths.has(p)).map(read)))];
  }
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([usdz(files) as Uint8Array<ArrayBuffer>], { type: 'model/vnd.usdz+zip' })), download: `${stem}_daylight${mode === 'variants' ? '_variants' : ''}.usdz` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
