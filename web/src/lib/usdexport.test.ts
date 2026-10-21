import { describe, expect, it } from 'vitest';
import { unzipSync } from 'three/addons/libs/fflate.module.js';
import { freeName, overlay, polygonCorners, polygonGeometry, toCorners, toPolygons, variantsSpec, type OverlayMesh } from './usdexport';
import { usdz } from './usdz';

// A quad (corners 0 1 2 3) and a triangle (1 4 2) as the viewer draws them: the quad fanned into two triangles.
const QUAD_TRI = { indices: [0, 1, 2, 0, 2, 3, 1, 4, 2], faces: Int32Array.from([0, 0, 1]) };

describe('polygonCorners', () => {
  it('authored faces: corners in the authored order, -1 for a face that drew nothing', () => {
    const p = polygonCorners(QUAD_TRI.indices, { faces: QUAD_TRI.faces, counts: Int32Array.from([4, 3, 4]), flipped: false });
    expect([...p.counts]).toEqual([4, 3, 4]);
    expect([...p.corners]).toEqual([0, 1, 2, 3, 1, 4, 2, -1, -1, -1, -1]);
    expect([...p.polygonOf]).toEqual([0, 0, 1]);
  });
  it('a subset drawn first and a leftHanded fan (c0, ci+1, ci) give the same corners', () => {
    const p = polygonCorners([1, 2, 4, 0, 2, 1, 0, 3, 2], { faces: Int32Array.from([1, 0, 0]), counts: Int32Array.from([4, 3]), flipped: true });
    expect([...p.corners]).toEqual([0, 1, 2, 3, 1, 4, 2]);
    expect([...p.polygonOf]).toEqual([1, 0, 0]);
  });
  it('other polygons (refined, generated): numbered as they appear; a wrong count is an error', () => {
    const p = polygonCorners(QUAD_TRI.indices, { faces: Int32Array.from([7, 7, 3]), counts: null, flipped: false });
    expect([[...p.counts], [...p.corners], [...p.polygonOf]]).toEqual([[4, 3], [0, 1, 2, 3, 1, 4, 2], [0, 0, 1]]);
    expect(() => polygonCorners(QUAD_TRI.indices, { faces: QUAD_TRI.faces, counts: Int32Array.from([3, 3]), flipped: false })).toThrow('face 0');
  });
});

describe('values onto polygons', () => {
  it('per face: the area-weighted mean of the triangles, NaN where none drew', () => {
    expect([...toPolygons([1, 3, 5], [0, 0, 1], 3, [1, 3, 2])]).toEqual([2.5, 5, NaN]);
    expect([...toPolygons([1, 3], [0, 0], 1, [0, 0])]).toEqual([2]); // degenerate: the plain mean
  });
  it('per vertex: the drawn vertex at each corner', () => {
    expect([...toCorners([10, 11, 12, 13, 14], Int32Array.from([0, 1, 2, 3, -1]))]).toEqual([10, 11, 12, 13, NaN]);
  });
  it('polygonGeometry: one point per surface vertex, seams welded back', () => {
    // Drawn vertex 4 is a seam copy of surface vertex 1.
    const g = polygonGeometry([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0], null, { counts: Int32Array.from([3, 3]), corners: Int32Array.from([0, 1, 2, 0, 2, 4]) }, [0, 1, 2, 3, 1]);
    expect([[...g.indices], g.points.length / 3]).toEqual([[0, 1, 2, 0, 2, 1], 3]);
  });
});

const mesh = (path: string, geometry: OverlayMesh['geometry'] = null): OverlayMesh => ({
  path, interp: 'uniform', geometry, blocks: [], subsets: ['Top'],
  values: [{ name: 'radiation_front', data: [1, NaN] }, { name: 'direct_front', data: [3, 4] }],
  colours: [[1, 0, 0, 0, 1, 0], [0, 0, 1, 1, 1, 1]],
});

describe('overlay', () => {
  const text = overlay({
    meta: ['defaultPrim = "World"'], subLayers: ['./_session.usda', './box.usda'], root: 'Daylight', shown: 1,
    meshes: [mesh('/World/Box'), mesh('/World/Smooth', { points: Float32Array.from([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]), normals: null, counts: Int32Array.from([4]), indices: Int32Array.from([0, 1, 2, 3]) })],
  }).join('');
  const box = text.slice(text.indexOf('over "Box"'), text.indexOf('over Mesh "Smooth"'));
  it('own faces: only the look and the values, the subset bound to the result', () => {
    expect(box).not.toContain('points');
    expect(box).toContain('color3f[] primvars:displayColor = [(0, 0, 1), (1, 1, 1)] (interpolation = "uniform")'); // the shown column
    expect(box).toContain('float[] primvars:daylight_radiation_front = [1, nan] (interpolation = "uniform")');
    expect(box).toContain('rel material:binding = </Daylight/Result>');
    expect(box).toMatch(/over "Top"\n\s+\{\n\s+rel material:binding = <\/Daylight\/Result>/);
  });
  it('other polygons: written as polygons (a quad stays a quad), the subset off', () => {
    const smooth = text.slice(text.indexOf('over Mesh "Smooth"'));
    expect(smooth).toContain('int[] faceVertexCounts = [4]');
    expect(smooth).toContain('uniform token subdivisionScheme = "none"');
    expect(smooth).toMatch(/over "Top" \(\n\s+active = false/);
    expect(text).toContain('subLayers = [\n        @./_session.usda@,\n        @./box.usda@\n    ]');
  });
});

describe('variantsSpec', () => {
  it('packs every array once and names one variant per column', () => {
    const geometry = { points: Float32Array.from([0, 0, 0, 1, 0, 0, 1, 1, 0]), normals: null, counts: Int32Array.from([3]), indices: Int32Array.from([0, 1, 2]) };
    const { spec, floats, ints } = variantsSpec([mesh('/World/Box'), mesh('/World/Cone', geometry)], { columns: ['radiation_front', 'direct_front'], shown: 1, root: 'Daylight', geometryRoot: 'Daylight_Geometry', assets: [['/drop/1/', './']] });
    expect([spec.selection, spec.material, spec.geometryRoot]).toEqual(['direct_front', '/Daylight/Result', '/Daylight_Geometry']);
    expect(spec.prims[0].geometry).toBeUndefined();
    expect(spec.prims[1].geometry!.map((a) => a.name)).toEqual(['points', 'faceVertexCounts', 'faceVertexIndices', 'extent', 'orientation', 'subdivisionScheme']);
    const colour = spec.prims[0].variants[1].primvars[0];
    expect([colour.name, colour.interpolation, [...floats.subarray(colour.data![0], colour.data![0] + colour.data![1])]]).toEqual(['primvars:displayColor', 'uniform', [0, 0, 1, 1, 1, 1]]);
    const counts = spec.prims[1].geometry![1];
    expect([...ints.subarray(counts.data![0], counts.data![0] + counts.data![1])]).toEqual([3]);
    expect(spec.usda).toContain('def Material "Result"');
  });
});

describe('saved views as cameras', () => {
  const cameras = '        def Camera "View_1"\n        {\n        }\n';
  it('the overlay and the variants spec put them in the result scope, under Cameras', () => {
    const text = overlay({ meta: [], subLayers: ['./m.usda'], root: 'Daylight', meshes: [], shown: 0, cameras }).join('');
    expect(text).toMatch(/def Scope "Daylight" \([\s\S]*and the views saved in the app[\s\S]*def Material "Result"[\s\S]*def Scope "Cameras"\n    \{\n        def Camera "View_1"/);
    const { spec } = variantsSpec([], { columns: ['radiation_front'], shown: 0, root: 'Daylight', geometryRoot: 'Daylight_Geometry', assets: [], cameras });
    expect(spec.usda).toContain('def Scope "Cameras"');
    expect(overlay({ meta: [], subLayers: [], root: 'Daylight', meshes: [], shown: 0 }).join('')).not.toContain('Cameras');
  });
});

describe('overlay for one flattened file', () => {
  it('without metadata and sublayers it is a bare layer: the core composes it over the stage', () => {
    const text = overlay({ meta: [], subLayers: [], root: 'Daylight', meshes: [], shown: 0 }).join('');
    expect(text.startsWith('#usda 1.0\n\ndef Scope "Daylight"')).toBe(true);
    expect(overlay({ meta: ['upAxis = "Z"'], subLayers: [], root: 'Daylight', meshes: [], shown: 0 }).join('')).toMatch(/^#usda 1\.0\n\(\n {4}upAxis = "Z"\n\)\n/);
  });
});

describe('helpers', () => {
  it('freeName', () => expect(freeName('Daylight', ['Daylight', 'Daylight_2'])).toBe('Daylight_3'));
  it('usdz: stored files, data 64-byte aligned, the root layer first', () => {
    const files: [string, Uint8Array][] = [['root.usdc', new TextEncoder().encode('PXR-USDC')], ['tex/a.png', new Uint8Array(100).fill(7)], ['b.usda', new Uint8Array(3)]];
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
