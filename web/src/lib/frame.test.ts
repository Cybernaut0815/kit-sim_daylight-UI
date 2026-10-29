import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { camera } from '../viewer/capture';
import { boxToWorld, compass, describeView, findCritical, frameView, meanNormal, toModel, toWorld, viewDir, type Box, type CriticalMesh, type Lens, type Vec3 } from './frame';
import { faceAreas, vertexAreas } from './result';

const close = (a: ArrayLike<number>, b: ArrayLike<number>, eps = 1e-9) => Array.from(a).every((x, i) => Math.abs(x - b[i]) < eps);
const corners = (b: Box) => Array.from({ length: 8 }, (_, i) => new Vector3(i & 1 ? b.max[0] : b.min[0], i & 2 ? b.max[1] : b.min[1], i & 4 ? b.max[2] : b.min[2]));
const LENS: Lens = { fov: 45, aspect: 1.6, projection: 'perspective' };

/** A quad a b c d, counter-clockwise seen from where it faces, as two triangles under /Site/Block. */
const quad = (name: string, ...q: Vec3[]) => ({ id: name, name, path: `/Site/Block/${name}`, positions: q.flat(), indices: [0, 1, 2, 0, 2, 3] });
// A 10 × 20 × 6 m block (model metres), its walls named by where they face at north 90 (model -X is north)
const BLOCK = [
  quad('Facade_N', [0, 0, 0], [0, 0, 6], [0, 20, 6], [0, 20, 0]),
  quad('Facade_S', [10, 0, 0], [10, 20, 0], [10, 20, 6], [10, 0, 6]),
  quad('Facade_W', [0, 0, 0], [10, 0, 0], [10, 0, 6], [0, 0, 6]),
  quad('Facade_E', [0, 20, 0], [0, 20, 6], [10, 20, 6], [10, 20, 0]),
  quad('Roof', [0, 0, 6], [10, 0, 6], [10, 20, 6], [0, 20, 6]),
];
const FLOOR = quad('Floor', [0, 0, 0], [0, 20, 0], [10, 20, 0], [10, 0, 0]);

describe('frameView', () => {
  const facade: Box = { min: [-30, 0, -2], max: [30, 12, 2] }; // 60 × 12 m, 4 m deep (world)
  for (const projection of ['perspective', 'orthographic'] as const) {
    for (const aspect of [5, 0.5]) {
      it(`${projection} at aspect ${aspect}: every corner in the frame, the widest on its edge (1 / margin); the cut clips none`, () => {
        const { view, cut } = frameView(facade, viewDir('SW', 0), { fov: 45, aspect, projection }), cam = camera(view, aspect);
        const ndc = corners(facade).map((q) => q.clone().project(cam));
        expect(Math.max(...ndc.map((p) => Math.max(Math.abs(p.x), Math.abs(p.y))))).toBeCloseTo(1 / 1.08, 9);
        expect(Math.min(...corners(facade).map((q) => -q.applyMatrix4(cam.matrixWorldInverse).z))).toBeGreaterThan(cut);
      });
    }
  }
  it('a top view at north 30°: north up the image, east to the right', () => {
    const { view } = frameView(facade, viewDir('top', 30), LENS), cam = camera(view, LENS.aspect), { N, E } = compass(30);
    const at = (d: Vec3) => new Vector3(...view.target).add(new Vector3(...toWorld(d))).project(cam);
    expect([at(N).x, at(E).y].map((v) => Math.abs(v) < 1e-9)).toEqual([true, true]);
    expect(at(N).y).toBeGreaterThan(0.01);
    expect(at(E).x).toBeGreaterThan(0.01);
    expect(describeView(view, 30, 1)).toMatch(/^from above, north towards the top; perspective 45° vertical;/);
  });
});

describe('viewDir', () => {
  const e = (20 * Math.PI) / 180;
  it('a compass side: the eye that way, elevation up', () => {
    expect(close(viewDir('S', 0), [0, Math.sin(e), Math.cos(e)])).toBe(true); // world +Z is south at north 0
    expect(close(toModel(viewDir('N', 90)), [-Math.cos(e), 0, Math.sin(e)])).toBe(true); // north 90: model -X
    expect(close(toModel(viewDir('E', 0, undefined, 45)), [Math.SQRT1_2, 0, Math.SQRT1_2])).toBe(true);
  });
  it('top: straight down, leaning a hair south', () => {
    const d = toModel(viewDir('top', 0));
    expect([d[0], d[2]].map((v) => v.toFixed(5))).toEqual(['0.00000', '1.00000']);
    expect(d[1]).toBeLessThan(0);
  });
  it('auto: from where the surfaces face, tilted up; a roof as a plan; a closed shape (or none) from the SW, isometric', () => {
    expect(close(viewDir('auto', 90, [0, 1, 0]), viewDir('E', 90))).toBe(true); // north 90: model +Y faces east
    expect(close(viewDir('auto', 0, meanNormal([BLOCK[4]])), viewDir('top', 0))).toBe(true);
    const closed = meanNormal([...BLOCK, FLOOR]);
    expect(close(closed, [0, 0, 0])).toBe(true);
    expect(close(toModel(viewDir('auto', 0, closed)), [-1, -1, 1].map((v) => v / Math.sqrt(3)), 1e-4)).toBe(true);
    expect(viewDir('auto', 0)).toEqual(viewDir('auto', 0, closed));
  });
  it('auto: a plan keeps north up, and a level surface its south side, whatever float noise or a drainage fall says', () => {
    expect(viewDir('auto', 30, [1e-7, 2e-7, 1])).toEqual(viewDir('top', 30)); // one float32 ulp off level
    expect(viewDir('auto', 30, [0.01, 0, 1])).toEqual(viewDir('top', 30)); // a 1 % fall
    expect(close(viewDir('auto', 30, [1e-7, 0, -1]), viewDir('auto', 30, [0, 0, -1]), 1e-6)).toBe(true); // a soffit: from the south
  });
});

describe('findCritical', () => {
  const mesh = (on: 'faces' | 'vertices', per: number): CriticalMesh[] =>
    BLOCK.map((q, k) => ({ ...q, first: per * k, count: per, w: (on === 'faces' ? faceAreas : vertexAreas)(q.positions, q.indices) }));
  const rows = (v: number[]) => v.map((x) => Float64Array.of(x));
  // sun hours per face (two a wall); below 2 h: all of Facade_N, half the roof, half of Facade_W
  const hours = rows([0.5, 1, 8, 8, 1, 3, 4, 4, 10, 1.5]);
  const run = (column: string) => findCritical({ values: hours, col: 0, column, on: 'faces', meshes: mesh('faces', 2), north: 90, mpu: 1, below: 2 });
  it('groups the problem by mesh and facing (north 90), largest first; areas, shares, a view from where it faces', () => {
    const r = run('sunhours_front');
    expect([r.problemArea, r.problemShare]).toEqual([250, 250 / 560]);
    expect(r.clusters.map((c) => [c.path, c.facing, c.side, c.elements, c.area, c.share])).toEqual([
      ['/Site/Block/Facade_N', 'N', 'below', 2, 120, 1],
      ['/Site/Block/Roof', 'up', 'below', 1, 100, 0.5],
      ['/Site/Block/Facade_W', 'W', 'below', 1, 30, 0.5],
    ]);
    const [n] = r.clusters;
    expect([n.mean, n.worst, n.box]).toEqual([0.75, 0.5, { min: [0, 0, 0], max: [0, 20, 6] }]);
    expect(close(n.centroid, [0, 10, 3]) && close(n.normal, [-1, 0, 0])).toBe(true);
    expect(describeView(n.view, 90, 1)).toBe('seen from the N (0°), 20° above the horizon, looking S; perspective 45° vertical; aimed at (0.0, 10.0, 3.0) m');
    expect(n.near).toBeGreaterThan(0); // the cutaway stands between the eye and the wall
    expect(n.near).toBeLessThan(new Vector3(...n.view.eye).distanceTo(new Vector3(...n.view.target)));
  });
  it('a back-side column faces the other way; vertices face as their faces do', () => {
    expect(run('sunhours_back').clusters.map((c) => [c.path, c.facing])).toEqual([['/Site/Block/Facade_N', 'S'], ['/Site/Block/Roof', 'down'], ['/Site/Block/Facade_W', 'E']]);
    const corners4 = rows(BLOCK.flatMap((q) => Array<number>(4).fill(q.name === 'Facade_N' ? 0 : 5)));
    const v = findCritical({ values: corners4, col: 0, column: 'sunhours_front', on: 'vertices', meshes: mesh('vertices', 4), north: 90, mpu: 1, below: 2 });
    expect(v.clusters.map((c) => [c.path, c.facing, c.area, c.share])).toEqual([['/Site/Block/Facade_N', 'N', 120, 1]]);
  });
});

describe('spaces and words', () => {
  it('toWorld undoes toModel; world up is model up', () => {
    expect(close(toWorld(toModel([12.5, -3, 7], 0.01), 0.01), [12.5, -3, 7])).toBe(true);
    expect(close(toModel([0, 1, 0]), [0, 0, 1])).toBe(true);
  });
  it('describeView names the side the eye stands on, its height, where it looks, the lens and the aim in metres', () => {
    const block = boxToWorld({ min: [0, 0, 0], max: [10, 20, 6] }, 0.01); // a stage in centimetres
    expect(describeView(frameView(block, viewDir('SW', 0), LENS).view, 0, 0.01)).toBe('seen from the SW (225°), 20° above the horizon, looking NE; perspective 45° vertical; aimed at (5.0, 10.0, 3.0) m');
    expect(describeView(frameView(block, viewDir('S', 90), { ...LENS, projection: 'orthographic' }).view, 90, 0.01)).toMatch(/^seen from the S \(180°\), 20° above the horizon, looking N; orthographic [\d.]+ m high; aimed at \(5\.0, 10\.0, 3\.0\) m$/);
  });
  it('refuses a box with no extent (a shot of it would come out blank)', () => {
    expect(() => frameView({ min: [1, 2, 3], max: [1, 2, 3] }, viewDir('S', 0), LENS)).toThrow(/^box: /);
  });
});
