// Results as USD, on the polygons the run simulated (never on the fan triangles the viewer draws): a receiver drawn
// unrefined keeps its own faces, so only its colours, values and material change; a refined surface or an implicit
// shape is written as its own polygons (the refined quads, the generated cube faces). The viewer core says which
// polygon each drawn triangle came from (meshMap); a polygon's triangles are consecutive and fan from its first corner.
// - per face: one value per polygon, the area-weighted mean of its triangles (uniform);
// - per vertex: one value per polygon corner, the drawn vertex there (faceVarying, exact across seams).
// Every result is a value primvar (primvars:daylight_<result>, as the Python write_results names them) and the shown
// colours a linear displayColor, bound to a material that reads it.
// - overlay(): a root layer over the model files (Replace mode);
// - variantsSpec(): what the core needs to flatten the stage with a variant set per receiver (Variants mode).
import type { ExportAttribute, ExportVariantsSpec, MeshMap } from 'usd-viewer';
import { arrayParts, num } from './usda';

export type Interp = 'uniform' | 'faceVarying';
/** Polygons to author: points, vertex normals, counts and corner indices into the points. */
export interface Polygons { points: Float32Array; normals: Float32Array | null; counts: Int32Array; indices: Int32Array }
/** A receiver with its results on its polygons (`geometry` null: its own faces, kept). */
export interface ResultMesh {
  path: string; interp: Interp;
  values: { name: string; data: ArrayLike<number> }[]; // per polygon or per corner
  colours: ArrayLike<number>[]; // per result column, linear rgb, 3 per element
  geometry: Polygons | null;
}
/** The overlay also blocks what the model authors that no longer fits, and handles the subsets. */
export interface OverlayMesh extends ResultMesh {
  blocks: { name: string; type: string; uniform: boolean }[];
  subsets: string[]; // GeomSubset children: bound to the result (own faces) or deactivated (other polygons)
}

/**
 * The polygons behind drawn triangles: each polygon's corners as drawn vertices, read from its fan run (c0, ci, ci+1;
 * c0, ci+1, ci when flipped). Authored polygons keep the prim's own numbering (-1 corners: a face that drew nothing);
 * others are numbered as they first appear. `polygonOf`: drawn triangle -> polygon in that numbering.
 */
export function polygonCorners(indices: ArrayLike<number>, map: Pick<MeshMap, 'faces' | 'counts' | 'flipped'>): { counts: Int32Array; corners: Int32Array; polygonOf: Int32Array } {
  const { faces, flipped } = map, n = faces.length, polygonOf = new Int32Array(n);
  const runs: { poly: number; start: number; end: number }[] = [];
  for (let t = 0; t < n; t++) {
    if (t && faces[t] === faces[t - 1]) runs[runs.length - 1].end = t + 1;
    else runs.push({ poly: faces[t], start: t, end: t + 1 });
  }
  const write = (run: { start: number; end: number }, out: Int32Array, at: number) => {
    const s = 3 * run.start;
    out[at] = indices[s];
    out[at + 1] = indices[s + (flipped ? 2 : 1)];
    for (let t = run.start, k = at + 2; t < run.end; t++, k++) out[k] = indices[3 * t + (flipped ? 1 : 2)];
  };
  if (map.counts) {
    const counts = Int32Array.from(map.counts), offsets = new Int32Array(counts.length + 1);
    for (let p = 0; p < counts.length; p++) offsets[p + 1] = offsets[p] + counts[p];
    const corners = new Int32Array(offsets[counts.length]).fill(-1);
    for (const run of runs) {
      if (run.end - run.start + 2 !== counts[run.poly]) throw new Error(`face ${run.poly} drew ${run.end - run.start} triangles for ${counts[run.poly]} corners`);
      write(run, corners, offsets[run.poly]);
      polygonOf.fill(run.poly, run.start, run.end);
    }
    return { counts, corners, polygonOf };
  }
  const counts = Int32Array.from(runs, (r) => r.end - r.start + 2), corners = new Int32Array(counts.reduce((a, b) => a + b, 0));
  let at = 0;
  runs.forEach((run, p) => { write(run, corners, at); at += counts[p]; polygonOf.fill(p, run.start, run.end); });
  return { counts, corners, polygonOf };
}

/** Per-triangle values -> per polygon: the area-weighted mean (the plain mean if the areas are all zero; NaN if none). */
export function toPolygons(values: ArrayLike<number>, polygonOf: ArrayLike<number>, count: number, areas: ArrayLike<number>): Float32Array {
  const sum = new Float64Array(count), weight = new Float64Array(count), plain = new Float64Array(count), n = new Float64Array(count);
  for (let t = 0; t < polygonOf.length; t++) {
    const p = polygonOf[t], v = values[t];
    if (!Number.isFinite(v)) continue;
    sum[p] += v * areas[t]; weight[p] += areas[t]; plain[p] += v; n[p]++;
  }
  return Float32Array.from(sum, (s, p) => (weight[p] > 0 ? s / weight[p] : n[p] ? plain[p] / n[p] : NaN));
}

/** Per-vertex values -> per polygon corner (NaN for a corner that was not drawn). */
export const toCorners = (values: ArrayLike<number>, corners: Int32Array): Float32Array => Float32Array.from(corners, (o) => (o >= 0 ? values[o] : NaN));

/** The polygons as a mesh of their own: one point per surface vertex (`weld`: drawn -> surface vertex), corners into them. */
export function polygonGeometry(positions: ArrayLike<number>, normals: ArrayLike<number> | null, p: { counts: Int32Array; corners: Int32Array }, weld: ArrayLike<number> | null): Polygons {
  const id = new Map<number, number>(), from: number[] = [];
  const indices = Int32Array.from(p.corners, (o) => {
    const v = weld ? weld[o] : o;
    let k = id.get(v);
    if (k === undefined) { k = from.length; id.set(v, k); from.push(o); } // a drawn vertex at that surface vertex
    return k;
  });
  const pick = (a: ArrayLike<number>) => { const out = new Float32Array(3 * from.length); from.forEach((o, k) => { out[3 * k] = a[3 * o]; out[3 * k + 1] = a[3 * o + 1]; out[3 * k + 2] = a[3 * o + 2]; }); return out; };
  return { points: pick(positions), normals: normals && pick(normals), counts: p.counts, indices };
}

/** The first free prim name `base`, `base_2`, … among `taken`. */
export const freeName = (base: string, taken: Iterable<string>): string => {
  const t = new Set(taken);
  let name = base;
  for (let k = 2; t.has(name); k++) name = `${base}_${k}`;
  return name;
};

const tuple = (a: ArrayLike<number>) => (i: number) => `(${num(a[3 * i])}, ${num(a[3 * i + 1])}, ${num(a[3 * i + 2])})`;
const scalar = (a: ArrayLike<number>) => (i: number) => (Number.isFinite(a[i]) ? String(num(a[i])) : 'nan'); // a face that drew nothing
function extent(points: ArrayLike<number>): Float32Array {
  const e = new Float32Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
  for (let i = 0; i < points.length; i += 3) for (let c = 0; c < 3; c++) { e[c] = Math.min(e[c], points[i + c]); e[3 + c] = Math.max(e[3 + c], points[i + c]); }
  return e;
}

/**
 * `def Scope "<root>"` with the material every result binds (UsdPreviewSurface, diffuse = displayColor) and, when
 * given, the saved views as cameras (`cameras`: Camera prims at an indent of 8, from lib/views cameraPrims).
 */
export const materialScope = (root: string, cameras = '') => `
def Scope "${root}" (
    doc = "Daylight results: the material of the result meshes (diffuse = primvars:displayColor)${cameras ? ' and the views saved in the app (Cameras)' : ''}"
)
{
    def Material "Result"
    {
        token outputs:surface.connect = </${root}/Result/Surface.outputs:surface>

        def Shader "Surface"
        {
            uniform token info:id = "UsdPreviewSurface"
            color3f inputs:diffuseColor.connect = </${root}/Result/Colour.outputs:result>
            float inputs:roughness = 1
            token outputs:surface
        }

        def Shader "Colour"
        {
            uniform token info:id = "UsdPrimvarReader_float3"
            string inputs:varname = "displayColor"
            float3 outputs:result
        }
    }
${cameras ? `
    def Scope "Cameras"
    {
${cameras}    }
` : ''}}
`;

/**
 * Root layer over the model: `meta` = the stage metadata lines (it is the root layer now), `subLayers` = the model's
 * layers strongest first, `root` = a free top-level name for the material, `shown` = the column whose colours are drawn.
 */
export function overlay(o: { meta: string[]; subLayers: string[]; root: string; meshes: OverlayMesh[]; shown: number; cameras?: string }): string[] {
  const out = ['#usda 1.0\n(\n', ...o.meta.map((l) => `    ${l}\n`), '    subLayers = [\n', o.subLayers.map((l) => `        @${l}@`).join(',\n'), '\n    ]\n)\n'];
  interface Node { kids: Map<string, Node>; mesh?: OverlayMesh }
  const tree: Node = { kids: new Map() };
  for (const m of o.meshes) {
    let n = tree;
    for (const seg of m.path.split('/').slice(1)) { if (!n.kids.has(seg)) n.kids.set(seg, { kids: new Map() }); n = n.kids.get(seg)!; }
    n.mesh = m;
  }
  const emit = (name: string, n: Node, indent: string) => {
    const i1 = `${indent}    `, i2 = `${i1}    `, m = n.mesh, meta = ` (interpolation = "${m?.interp}")\n`;
    out.push(`\n${indent}over ${m?.geometry ? 'Mesh ' : ''}"${name}"${m ? ` (\n${i1}prepend apiSchemas = ["MaterialBindingAPI"]\n${indent})` : ''}\n${indent}{\n`);
    if (m) {
      const g = m.geometry;
      if (g) {
        const e = extent(g.points);
        out.push(`${i1}float3[] extent = [${tuple(e)(0)}, ${tuple(e)(1)}]\n`);
        out.push(...arrayParts(`${i1}int[] faceVertexCounts`, g.counts.length, (i) => String(g.counts[i])));
        out.push(...arrayParts(`${i1}int[] faceVertexIndices`, g.indices.length, (i) => String(g.indices[i])));
        if (g.normals) out.push(...arrayParts(`${i1}normal3f[] normals`, g.normals.length / 3, tuple(g.normals), ' (interpolation = "vertex")\n'));
        out.push(`${i1}uniform token orientation = "rightHanded"\n`);
        out.push(...arrayParts(`${i1}point3f[] points`, g.points.length / 3, tuple(g.points)));
        out.push(`${i1}uniform token subdivisionScheme = "none"\n`);
      }
      out.push(`${i1}rel material:binding = </${o.root}/Result>\n`);
      out.push(...arrayParts(`${i1}color3f[] primvars:displayColor`, m.colours[o.shown].length / 3, tuple(m.colours[o.shown]), meta));
      for (const v of m.values) out.push(...arrayParts(`${i1}float[] primvars:daylight_${v.name}`, v.data.length, scalar(v.data), meta));
      for (const b of m.blocks) out.push(`${i1}${b.uniform ? 'uniform ' : ''}${b.type} ${b.name} = None\n`);
      for (const s of m.subsets) {
        out.push(g
          ? `\n${i1}over "${s}" (\n${i2}active = false\n${i1})\n${i1}{\n${i1}}\n` // its face indices are the cage faces
          : `\n${i1}over "${s}"\n${i1}{\n${i2}rel material:binding = </${o.root}/Result>\n${i1}}\n`);
      }
    }
    for (const [k, c] of n.kids) emit(k, c, i1);
    out.push(`${indent}}\n`);
  };
  for (const [k, c] of tree.kids) emit(k, c, '');
  out.push(materialScope(o.root, o.cameras));
  return out;
}

/**
 * The core's exportVariants input: on every receiver a variant set "daylight" with "original" and one variant per
 * result column (`shown` selected); the value primvars once per receiver; other polygons once, in a class.
 */
export function variantsSpec(meshes: ResultMesh[], o: { columns: string[]; shown: number; root: string; geometryRoot: string; assets: [string, string][]; cameras?: string }): { spec: ExportVariantsSpec; floats: Float32Array; ints: Int32Array } {
  const floats: ArrayLike<number>[] = [], ints: ArrayLike<number>[] = [];
  let nf = 0, ni = 0;
  const f = (a: ArrayLike<number>): [number, number] => { floats.push(a); nf += a.length; return [nf - a.length, a.length]; };
  const i = (a: ArrayLike<number>): [number, number] => { ints.push(a); ni += a.length; return [ni - a.length, a.length]; };
  const prims = meshes.map((m) => {
    const g = m.geometry, geometry: ExportAttribute[] | undefined = g ? [
      { name: 'points', type: 'point3f[]', data: f(g.points) },
      ...(g.normals ? [{ name: 'normals', type: 'normal3f[]', interpolation: 'vertex', data: f(g.normals) }] : []),
      { name: 'faceVertexCounts', type: 'int[]', data: i(g.counts) },
      { name: 'faceVertexIndices', type: 'int[]', data: i(g.indices) },
      { name: 'extent', type: 'float3[]', data: f(extent(g.points)) },
      { name: 'orientation', type: 'token', value: 'rightHanded', uniform: true },
      { name: 'subdivisionScheme', type: 'token', value: 'none', uniform: true },
    ] : undefined;
    return {
      path: m.path, ...(geometry ? { geometry } : {}),
      primvars: m.values.map((v) => ({ name: `primvars:daylight_${v.name}`, type: 'float[]', interpolation: m.interp, data: f(v.data) })),
      variants: o.columns.map((name, c) => ({ name, primvars: [{ name: 'primvars:displayColor', type: 'color3f[]', interpolation: m.interp, data: f(m.colours[c]) }] })),
    };
  });
  const pack = <T extends Float32Array | Int32Array>(out: T, parts: ArrayLike<number>[]) => { let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out; };
  return {
    spec: { set: 'daylight', selection: o.columns[o.shown], material: `/${o.root}/Result`, geometryRoot: `/${o.geometryRoot}`, usda: `#usda 1.0\n${materialScope(o.root, o.cameras)}`, assets: o.assets, prims },
    floats: pack(new Float32Array(nf), floats), ints: pack(new Int32Array(ni), ints),
  };
}
