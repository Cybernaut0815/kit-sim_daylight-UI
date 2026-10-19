// Results as USD. Each receiver is written as the triangles the run used (the drawn, possibly refined surface, in its
// prim's own space), with one value primvar per result column (`primvars:daylight_<column>`, as the Python
// write_results names them) and the result colours as a linear `displayColor`, bound to a material that reads it.
// - overlay(): a root layer over the model's own files (sublayered): the receivers' geometry, colours and material
//   replace what the model authors. Everything else stays as it is.
// - variants(): a flattened stage edited in place: each receiver gets a variant set `daylight` with its own geometry
//   under "original" and one variant per result column. A variant is weaker than a local opinion, so the geometry has
//   to move out of the prim, which is only possible in one flattened layer.
import { arrayParts, num } from './usda';
import { items, rewrite, type Prim } from './usdaedit';

export type Interp = 'uniform' | 'vertex'; // one value per triangle, or per vertex
export interface ExportColumn { name: string; values: ArrayLike<number>; rgb: ArrayLike<number> } // rgb: linear, 3 per element
export interface ExportMesh {
  path: string; // the receiver's prim
  positions: ArrayLike<number>; indices: ArrayLike<number>; normals: ArrayLike<number> | null; // drawn triangles, prim space
  columns: ExportColumn[];
}
/** The overlay also blocks what the model authors on the prim that no longer fits the new triangles. */
export interface OverlayMesh extends ExportMesh {
  blocks: { name: string; type: string; uniform: boolean }[]; // other primvars, creases, corners, holes, normals
  subsets: string[]; // GeomSubset children: deactivated (their face indices are the old faces)
}

const tuple = (a: ArrayLike<number>) => (i: number) => `(${num(a[3 * i])}, ${num(a[3 * i + 1])}, ${num(a[3 * i + 2])})`;

/** The first free prim name `base`, `base_2`, … among `taken`. */
export const freeName = (base: string, taken: Iterable<string>): string => {
  const t = new Set(taken);
  let name = base;
  for (let k = 2; t.has(name); k++) name = `${base}_${k}`;
  return name;
};

/** The result mesh's attributes, one statement per line at `indent`: geometry and the value primvars. */
function geometry(m: ExportMesh, interp: Interp, indent: string): string[] {
  const out: string[] = [], n = m.indices.length / 3, np = m.positions.length / 3, lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < np; i++) for (let c = 0; c < 3; c++) { const v = m.positions[3 * i + c]; if (v < lo[c]) lo[c] = v; if (v > hi[c]) hi[c] = v; }
  const meta = ` (interpolation = "${interp}")\n`;
  out.push(`${indent}float3[] extent = [${tuple(lo)(0)}, ${tuple(hi)(0)}]\n`);
  out.push(...arrayParts(`${indent}int[] faceVertexCounts`, n, () => '3'));
  out.push(...arrayParts(`${indent}int[] faceVertexIndices`, m.indices.length, (i) => String(m.indices[i])));
  if (m.normals) out.push(...arrayParts(`${indent}normal3f[] normals`, m.normals.length / 3, tuple(m.normals), ' (interpolation = "vertex")\n'));
  out.push(`${indent}uniform token orientation = "rightHanded"\n`); // the drawn winding: the core already flipped leftHanded faces
  out.push(...arrayParts(`${indent}point3f[] points`, np, tuple(m.positions)));
  for (const c of m.columns) out.push(...arrayParts(`${indent}float[] primvars:daylight_${c.name}`, c.values.length, (i) => String(num(c.values[i])), meta));
  out.push(`${indent}uniform token subdivisionScheme = "none"\n`);
  return out;
}

const colours = (c: ExportColumn, interp: Interp, indent: string) =>
  arrayParts(`${indent}color3f[] primvars:displayColor`, c.rgb.length / 3, tuple(c.rgb), ` (interpolation = "${interp}")\n`);

/** `def Scope "<root>"` with the material every result mesh binds: UsdPreviewSurface, diffuse = displayColor. */
export const materialScope = (root: string) => `
def Scope "${root}" (
    doc = "Daylight results: the material of the result meshes (diffuse = primvars:displayColor)"
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
}
`;

/**
 * Root layer over the model: `meta` = the stage metadata lines (it is the root layer now), `subLayers` = the model's
 * layers strongest first, `root` = a free top-level name for the material, `shown` = the column whose colours are drawn.
 */
export function overlay(o: { meta: string[]; subLayers: string[]; root: string; meshes: OverlayMesh[]; interp: Interp; shown: number }): string[] {
  const out = ['#usda 1.0\n(\n', ...o.meta.map((l) => `    ${l}\n`), '    subLayers = [\n', o.subLayers.map((l) => `        @${l}@`).join(',\n'), '\n    ]\n)\n'];
  interface Node { kids: Map<string, Node>; mesh?: OverlayMesh }
  const tree: Node = { kids: new Map() };
  for (const m of o.meshes) {
    let n = tree;
    for (const seg of m.path.split('/').slice(1)) { if (!n.kids.has(seg)) n.kids.set(seg, { kids: new Map() }); n = n.kids.get(seg)!; }
    n.mesh = m;
  }
  const emit = (name: string, n: Node, indent: string) => {
    const i1 = `${indent}    `, m = n.mesh;
    out.push(`\n${indent}over ${m ? 'Mesh ' : ''}"${name}"${m ? ` (\n${i1}prepend apiSchemas = ["MaterialBindingAPI"]\n${indent})` : ''}\n${indent}{\n`);
    if (m) {
      out.push(...geometry(m, o.interp, i1), `${i1}rel material:binding = </${o.root}/Result>\n`, ...colours(m.columns[o.shown], o.interp, i1));
      for (const b of m.blocks) out.push(`${i1}${b.uniform ? 'uniform ' : ''}${b.type} ${b.name} = None\n`);
      for (const s of m.subsets) out.push(`\n${i1}over "${s}" (\n${i1}    active = false\n${i1})\n${i1}{\n${i1}}\n`);
    }
    for (const [k, c] of n.kids) emit(k, c, i1);
    out.push(`${indent}}\n`);
  };
  for (const [k, c] of tree.kids) emit(k, c, '');
  out.push(materialScope(o.root));
  return out;
}

/** What moves into the variant "original": the shape (geometry, primvars, binding, implicit-shape sizes) and its subsets. */
const SHAPE = /^(points|normals|faceVertexCounts|faceVertexIndices|holeIndices|crease\w*|corner\w*|subdivisionScheme|interpolateBoundary|faceVaryingLinearInterpolation|triangleSubdivisionRule|orientation|extent|velocities|accelerations|primvars:.*|material:binding.*|size|radius|radiusTop|radiusBottom|height|axis|width|length)$/;

/**
 * The flattened stage with a variant set `daylight` on every receiver ("original" + one variant per column, `shown`
 * selected) and the result geometry once per mesh (a class each variant references). Throws if a receiver is missing.
 */
export function variants(flat: string, o: { meshes: ExportMesh[]; interp: Interp; shown: number }): string[] {
  const top = items(flat, 0, flat.length).filter((it) => it.kind === 'prim').map((it) => it.name);
  const root = freeName('Daylight', top), geomRoot = freeName(`${root}_Geometry`, top), names = o.meshes[0]?.columns.map((c) => c.name) ?? [];
  const done = new Set<string>(), edits = new Map<string, (p: Prim) => string>();
  o.meshes.forEach((m, k) => edits.set(m.path, (p) => {
    done.add(m.path);
    const ind = p.indent, i1 = `${ind}    `, i2 = `${i1}    `, i3 = `${i2}    `, ref = `</${geomRoot}/Mesh${k}>`;
    const moves = (x: Prim['items'][number]) => (x.item.kind === 'property' && SHAPE.test(x.item.name)) || (x.item.kind === 'prim' && x.item.type === 'GeomSubset');
    const moved = p.items.filter(moves), kept = p.items.filter((x) => !moves(x));
    const meta = [p.meta, `${i1}prepend variantSets = "daylight"`, `${i1}variants = {\n${i2}string daylight = "${names[o.shown]}"\n${i1}}`].filter(Boolean).join('\n');
    // A Cube / Sphere / … becomes a Mesh (a variant cannot change the type): its "original" is the drawn tessellation.
    const original = p.type === 'Mesh' ? '' : `(\n${i3}prepend references = ${ref}\n${i2}) `;
    return [
      `${p.spec} Mesh "${p.name}" (\n${meta}\n${ind})\n${ind}{\n`,
      ...kept.map((x) => `${i1}${x.text}\n`), kept.length ? '\n' : '',
      `${i1}variantSet "daylight" = {\n${i2}"original" ${original}{\n`, ...moved.map((x) => `${i3}${x.text}\n`), `${i2}}\n`,
      ...m.columns.flatMap((c) => [
        `${i2}"${c.name}" (\n${i3}prepend apiSchemas = ["MaterialBindingAPI"]\n${i3}prepend references = ${ref}\n${i2}) {\n`,
        `${i3}rel material:binding = </${root}/Result>\n`, ...colours(c, o.interp, i3), `${i2}}\n`,
      ]),
      `${i1}}\n${ind}}`,
    ].join('');
  }));
  const edited = rewrite(flat, edits), missing = o.meshes.filter((m) => !done.has(m.path)).map((m) => m.path);
  if (missing.length) throw new Error(`Not found in the flattened stage: ${missing.slice(0, 3).join(', ')}`);
  return [
    edited, `\nclass "${geomRoot}" (\n    doc = "Daylight results: the simulated triangles of each receiver, with one value primvar per result"\n)\n{\n`,
    ...o.meshes.flatMap((m, k) => [`    class Mesh "Mesh${k}"\n    {\n`, ...geometry(m, o.interp, '        '), '    }\n']),
    '}\n', materialScope(root),
  ];
}

/**
 * Asset paths of a flattened stage are the core's mount paths (@/drop/<n>/<path>@): make them relative to a package
 * root that holds the picked files at their own paths. Returns the text and the paths it now needs.
 */
export function relativeAssets(flat: string): { text: string; paths: Set<string> } {
  const paths = new Set<string>();
  const text = flat.replace(/@\/drop\/\d+\/([^@]+)@/g, (_, p: string) => (paths.add(p), `@./${p}@`));
  return { text, paths };
}
