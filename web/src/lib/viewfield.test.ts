import { describe, expect, it } from 'vitest';
import { compass, type Vec3 } from './frame';
import { candidatesOf, dirOf, frameOf, glyphOf, panX, panY, planOutline, rayGrid, sampleEyes, sectionOutline, type EyeMesh } from './viewfield';

const near = (a: Vec3, b: Vec3, digits = 9) => a.forEach((x, i) => expect(x).toBeCloseTo(b[i], digits));
const S30 = Math.sin(Math.PI / 6), C30 = Math.cos(Math.PI / 6);
const I4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** An n x n grid of quads in the world's XZ plane (y = 0), facing +Y, `size` wide. */
function plate(n: number, size: number, matrix = I4): EyeMesh {
  const positions: number[] = [], indices: number[] = [];
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) positions.push((i / n) * size, 0, (-j / n) * size);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const a = j * (n + 1) + i, b = a + 1, c = a + n + 2, d = a + n + 1;
    indices.push(a, b, c, a, c, d);
  }
  return { positions, indices, matrix };
}

describe('the field frame (docs/views.md)', () => {
  it('a wall facing true north has right = east and up = +Z, whatever north is', () => {
    for (const north of [0, 30, 90]) {
      const { N, E } = compass(north), fr = frameOf(N, north, 'normal');
      near(fr.f, N); near(fr.r, E); near(fr.u, [0, 0, 1]);
      expect(frameOf(N, north, 'level')).toEqual(fr); // a vertical face: the level gaze is the same frame
    }
  });

  it('a roof sloping south: up is uphill about the normal, +Z with the level gaze', () => {
    const n: Vec3 = [0, -S30, C30], normal = frameOf(n, 0, 'normal'), level = frameOf(n, 0, 'level');
    near(normal.f, n); near(normal.r, [-1, 0, 0]); near(normal.u, [0, C30, S30]);
    near(level.f, [0, -1, 0]); near(level.r, [-1, 0, 0]); near(level.u, [0, 0, 1]);
    near(dirOf(level, 0, 0), [0, -1, 0]); // the level gaze looks at the horizon
  });

  it('a face looking straight up (or within 1e-3 of it) has right = east and up = south, either gaze', () => {
    for (const north of [0, 90]) for (const gaze of ['normal', 'level'] as const) {
      const { N, E } = compass(north), fr = frameOf([0, 0, 1], north, gaze);
      near(fr.f, [0, 0, 1]); near(fr.r, E); near(fr.u, [-N[0], -N[1], -N[2]]);
    }
    const tilt = frameOf([4e-4, 0, 1], 0, 'level');
    near(tilt.f, [4e-4, 0, 1], 6); near(tilt.u, [0, -1, 0], 6);
    expect(Math.abs(tilt.r[0] * tilt.f[0] + tilt.r[1] * tilt.f[1] + tilt.r[2] * tilt.f[2])).toBeLessThan(1e-12); // square to the normal
  });

  it('all around: azimuth 0 is true north, 90 east, turned with north; elevation about the horizon', () => {
    for (const north of [0, 45]) {
      const { N, E } = compass(north), fr = frameOf([1, 0, 0], north, 'normal', true);
      near(dirOf(fr, 0, 0), N); near(dirOf(fr, 90, 0), E); near(dirOf(fr, 0, 90), [0, 0, 1]);
      near(dirOf(fr, 180, -30), [-N[0] * C30, -N[1] * C30, -S30]);
    }
  });
});

describe('the ray grid', () => {
  it('counts the rays as the Cell help does and thins the lines drawn', () => {
    const g = rayGrid([120, -70, 50], 2);
    expect([g.cols, g.rows, g.all, g.flat]).toEqual([60, 60, false, false]);
    expect([g.az, g.el]).toEqual([[-60, 60], [-70, 50]]);
    expect(g.azLines.length).toBeLessThanOrEqual(9);
    expect([g.azLines[0], g.azLines.at(-1), g.elLines[0], g.elLines.at(-1)]).toEqual([-60, 60, -70, 50]);
    const all = rayGrid([360, -70, 50], 0.5);
    expect([all.cols, all.rows, all.az[0], all.az[1]]).toEqual([720, 240, 0, 360]);
    expect(all.azLines.length).toBeLessThanOrEqual(9);
    expect(all.elLines.length).toBeLessThanOrEqual(9);
    const flat = rayGrid([360, 0, 0], 2);
    expect([flat.cols, flat.rows, flat.flat, flat.elLines]).toEqual([180, 1, true, [0]]);
    expect(rayGrid([1, 0, 0.4], 5)).toMatchObject({ cols: 1, rows: 1 }); // at least one each
    // the lines sit on cell edges
    for (const a of g.azLines) { const k = (a - g.az[0]) / 2; expect(Math.abs(k - Math.round(k))).toBeLessThan(1e-9); }
  });

  it('the outlines: a wedge about the gaze in plan, LO to HI from the side, the panorama in fractions', () => {
    const g = rayGrid([120, -70, 50], 2), plan = planOutline(g), side = sectionOutline(g);
    expect(plan[0]).toEqual([0, 0]);
    near([...plan[1], 0], [-Math.sin(Math.PI / 3), -0.5, 0]); // -60°: up-left
    expect(plan.at(-1)).toEqual([0, 0]);
    near([...side[1], 0], [Math.cos((50 * Math.PI) / 180), -Math.sin((50 * Math.PI) / 180), 0]); // HI first, above the gaze
    near([...side.at(-2)!, 0], [Math.cos((70 * Math.PI) / 180), Math.sin((70 * Math.PI) / 180), 0]);
    expect(planOutline(rayGrid([360, 0, 0], 2))[0]).not.toEqual([0, 0]); // a ring, not a wedge
    expect(sectionOutline(rayGrid([360, 0, 0], 2))).toEqual([[0, 0], [1, 0]]);
    expect([panX(g, -60), panX(g, 0), panX(g, 60), panY(90), panY(0), panY(-90)]).toEqual([1 / 3, 0.5, 2 / 3, 0, 0.5, 1]);
    expect(panX(rayGrid([360, -70, 50], 2), 90)).toBe(0.25);
  });

  it('the glyph: unit-length points about the eye, a patch of triangles, a fan when flat', () => {
    for (const fov of [[120, -70, 50], [360, -70, 50], [120, 0, 0], [360, 0, 0], [60, -90, 90]] as const) {
      const { lines, tris } = glyphOf(rayGrid([...fov], 2));
      expect(lines.length % 6).toBe(0);
      expect(tris.length % 9).toBe(0);
      expect(tris.length).toBeGreaterThan(0);
      for (let i = 0; i < lines.length; i += 3) {
        const r = Math.hypot(lines[i], lines[i + 1], lines[i + 2]);
        expect(r < 1e-6 || Math.abs(r - 1) < 1e-6).toBe(true);
      }
      expect(lines.length / 6).toBeLessThan(400); // thinned: a few hundred segments, whatever the cell
    }
    const { lines } = glyphOf(rayGrid([120, -70, 50], 0.5)), coarse = glyphOf(rayGrid([120, -70, 50], 5)).lines;
    expect(lines.length).toBeLessThanOrEqual(coarse.length * 2);
  });
});

describe('where the preview puts its eyes', () => {
  it('candidates: at most about the cap, at least one per mesh, world centroids and unit normals', () => {
    const big = plate(100, 10), one = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: null, matrix: I4 };
    const c = candidatesOf([big, one], 5000);
    expect(c.count).toBeLessThanOrEqual(5001);
    expect(c.count).toBeGreaterThan(4000);
    near([...c.normal.slice(0, 3)] as Vec3, [0, 1, 0]);
    near([...c.normal.slice(3 * (c.count - 1), 3 * c.count)] as Vec3, [0, 0, 1]); // the lone triangle
    const moved = candidatesOf([plate(2, 2, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 7, 1])]);
    expect(moved.centroid[1]).toBe(6);
    expect(moved.span).toBeCloseTo(Math.SQRT2); // half the diagonal of the 2 x 2 plate, wherever it stands: the glyphs' size
    const mirrored = candidatesOf([plate(2, 2, [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])]);
    expect(mirrored.normal[1]).toBe(1); // mirrored across X: turned as the core turns a mirrored mesh, still facing +Y
    expect(candidatesOf([{ positions: [0, 0, 0, 1, 0, 0, 2, 0, 0], indices: [0, 1, 2], matrix: I4 }])).toMatchObject({ count: 0, span: 0 }); // degenerate
  });

  it('eyes: under the cap, deterministic, both sides doubled and offset along each side', () => {
    const c = candidatesOf([plate(200, 50)]);
    const o = { spacing: 0.5, max: 30, on: 'faces' as const, sides: 'front' as const, offset: 0 };
    const front = sampleEyes(c, o);
    expect(front.count).toBeLessThanOrEqual(30);
    expect(front.count).toBeGreaterThan(5);
    expect(sampleEyes(c, o)).toEqual(front);
    const both = sampleEyes(c, { ...o, sides: 'both', offset: 1.5 });
    expect(both.count % 2).toBe(0);
    expect(both.count).toBeLessThanOrEqual(30);
    near([...both.n.slice(0, 3)] as Vec3, [0, 1, 0]);
    near([...both.n.slice(3, 6)] as Vec3, [0, -1, 0]);
    expect(both.p[1]).toBeCloseTo(1.5, 6);
    expect(both.p[4]).toBeCloseTo(-1.5, 6);
    const back = sampleEyes(c, { ...o, sides: 'back' });
    expect(back.n[1]).toBe(-1);
    // few candidates: one per voxel, not every triangle
    const small = candidatesOf([plate(4, 1)]), spread = sampleEyes(small, { ...o, spacing: 0.5, max: 400 });
    expect(spread.count).toBeLessThan(small.count);
    expect(spread.count).toBeGreaterThan(1);
    // the section: what it cuts away has no eyes
    const cut = sampleEyes(c, { ...o, keep: (x) => x < 25 });
    expect(cut.count).toBeGreaterThan(0);
    for (let i = 0; i < cut.count; i++) expect(cut.p[3 * i]).toBeLessThan(25);
    // on vertices: at a corner of the triangle
    const corner = sampleEyes(small, { ...o, on: 'vertices', max: 1 });
    expect([0, 0.25, 0.5, 0.75, 1].some((v) => Math.abs(corner.p[0] - v) < 1e-6)).toBe(true);
  });

  it('opposite faces of a thin wall keep their own eyes', () => {
    const wall = plate(10, 1), I = Array.from(wall.indices!), flip = { ...wall, indices: I.map((_, i) => I[i - (i % 3) + [0, 2, 1][i % 3]]) };
    const e = sampleEyes(candidatesOf([wall, flip]), { spacing: 5, max: 400, on: 'faces', sides: 'front', offset: 0 });
    expect(e.count).toBe(2);
    expect([e.n[1], e.n[4]]).toEqual([1, -1]);
  });
});
