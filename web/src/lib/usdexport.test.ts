import { describe, expect, it } from 'vitest';
import { unzipSync } from 'three/addons/libs/fflate.module.js';
import { freeName, overlay, relativeAssets, variants, type OverlayMesh } from './usdexport';
import { items } from './usdaedit';
import { usdz } from './usdz';

// Two triangles of a unit quad, results per face: radiation 1 and 2, direct 3 and 4.
const quad = (path: string): OverlayMesh => ({
  path, positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], indices: [0, 1, 2, 0, 2, 3], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
  columns: [{ name: 'radiation_front', values: [1, 2], rgb: [1, 0, 0, 0, 1, 0] }, { name: 'direct_front', values: [3, 4], rgb: [0, 0, 1, 1, 1, 1] }],
  blocks: [{ name: 'primvars:st', type: 'texCoord2f[]', uniform: false }], subsets: ['Top'],
});

describe('overlay', () => {
  it('writes the receivers over the sublayered model with geometry, colours, values and the material', () => {
    const text = overlay({ meta: ['defaultPrim = "World"', 'upAxis = "Y"'], subLayers: ['./session.usda', './box.usda'], root: 'Daylight', meshes: [quad('/World/Box')], interp: 'uniform', shown: 1 }).join('');
    expect(text).toContain('    subLayers = [\n        @./session.usda@,\n        @./box.usda@\n    ]');
    expect(text).toMatch(/over "World"\n\{\n\n    over Mesh "Box" \(\n        prepend apiSchemas = \["MaterialBindingAPI"\]\n    \)\n    \{\n/);
    for (const line of [
      'float3[] extent = [(0, 0, 0), (1, 1, 0)]', 'int[] faceVertexCounts = [3, 3]', 'int[] faceVertexIndices = [0, 1, 2, 0, 2, 3]',
      'float[] primvars:daylight_radiation_front = [1, 2] (interpolation = "uniform")', 'float[] primvars:daylight_direct_front = [3, 4] (interpolation = "uniform")',
      'color3f[] primvars:displayColor = [(0, 0, 1), (1, 1, 1)] (interpolation = "uniform")', // the shown column
      'rel material:binding = </Daylight/Result>', 'uniform token subdivisionScheme = "none"', 'texCoord2f[] primvars:st = None',
    ]) expect(text).toContain(`        ${line}\n`);
    expect(text).toContain('        over "Top" (\n            active = false\n        )');
    expect(text).toContain('def Material "Result"');
  });
});

const FLAT = `#usda 1.0
(
    defaultPrim = "World"
)

def Xform "World"
{
    def Mesh "Box" (
        apiSchemas = ["MaterialBindingAPI"]
    )
    {
        int[] faceVertexCounts = [4]
        int[] faceVertexIndices = [0, 1, 2, 3]
        rel material:binding = </World/M>
        point3f[] points = [(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0)]
        texCoord2f[] primvars:st = [(0, 0), (1, 0), (1, 1), (0, 1)] (
            interpolation = "vertex"
        )
        double3 xformOp:translate = (5, 0, 0)
        uniform token[] xformOpOrder = ["xformOp:translate"]

        def GeomSubset "Top"
        {
            int[] indices = [0]
        }
    }

    def Cube "Block"
    {
        double size = 2
        asset tex = @/drop/1/tex/a.png@
    }
}
`;

describe('variants', () => {
  const text = variants(FLAT, { meshes: [quad('/World/Box'), quad('/World/Block')], interp: 'uniform', shown: 0 }).join('');
  const box = text.slice(text.indexOf('def Mesh "Box"'), text.indexOf('def Mesh "Block"'));
  it('moves the shape into "original" and keeps the transform on the prim', () => {
    expect(box).toContain('        prepend variantSets = "daylight"\n        variants = {\n            string daylight = "radiation_front"\n        }');
    const original = box.slice(box.indexOf('"original"'), box.indexOf('"radiation_front" ('));
    for (const s of ['points', 'faceVertexIndices', 'material:binding = </World/M>', 'primvars:st', 'def GeomSubset "Top"']) expect(original).toContain(s);
    const outside = box.slice(0, box.indexOf('variantSet "daylight"'));
    expect(outside).toContain('double3 xformOp:translate = (5, 0, 0)');
    expect(outside).not.toContain('points');
  });
  it('one variant per column, referencing the geometry stored once', () => {
    expect(box).toContain('"radiation_front" (\n                prepend apiSchemas = ["MaterialBindingAPI"]\n                prepend references = </Daylight_Geometry/Mesh0>\n            ) {\n                rel material:binding = </Daylight/Result>\n                color3f[] primvars:displayColor = [(1, 0, 0), (0, 1, 0)]');
    expect(box).toContain('"direct_front" (');
    expect(text).toContain('class "Daylight_Geometry"');
    expect(text.match(/point3f\[\] points/g)!.length).toBe(1 + 2); // the box's original + one per receiver in the class
  });
  it('an implicit shape becomes a Mesh whose "original" is its tessellation', () => {
    const block = text.slice(text.indexOf('def Mesh "Block"'));
    expect(block).toContain('"original" (\n                prepend references = </Daylight_Geometry/Mesh1>\n            ) {\n                double size = 2');
  });
  it('is still one valid layer for the scanner, and says which receivers it could not find', () => {
    expect(items(text, 0, text.length).filter((it) => it.kind === 'prim').map((it) => it.name)).toEqual(['World', 'Daylight_Geometry', 'Daylight']);
    expect(() => variants(FLAT, { meshes: [quad('/World/Nope')], interp: 'uniform', shown: 0 })).toThrow('/World/Nope');
  });
});

describe('helpers', () => {
  it('freeName and relativeAssets', () => {
    expect(freeName('Daylight', ['Daylight', 'Daylight_2'])).toBe('Daylight_3');
    const { text, paths } = relativeAssets(FLAT);
    expect(text).toContain('asset tex = @./tex/a.png@');
    expect([...paths]).toEqual(['tex/a.png']);
  });
  it('usdz: stored files, data 64-byte aligned, the root layer first', () => {
    const files: [string, Uint8Array][] = [['root.usda', new TextEncoder().encode('#usda 1.0\n')], ['tex/a.png', new Uint8Array(100).fill(7)], ['b.usda', new Uint8Array(3)]];
    const zip = usdz(files), view = new DataView(zip.buffer, zip.byteOffset);
    const offsets: number[] = [], names: string[] = [];
    for (let o = 0; view.getUint32(o, true) === 0x04034b50;) {
      const method = view.getUint16(o + 8, true), size = view.getUint32(o + 18, true), n = view.getUint16(o + 26, true), e = view.getUint16(o + 28, true);
      expect(method).toBe(0);
      names.push(new TextDecoder().decode(zip.subarray(o + 30, o + 30 + n)));
      offsets.push(o + 30 + n + e);
      o += 30 + n + e + size;
    }
    expect(names).toEqual(files.map(([f]) => f));
    expect(offsets.map((o) => o % 64)).toEqual([0, 0, 0]);
    expect(unzipSync(zip)['tex/a.png']).toEqual(files[1][1]);
  });
});
