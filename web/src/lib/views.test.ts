import { describe, expect, it } from 'vitest';
import { Matrix4, Vector3 } from 'three';
import type { ViewState } from 'usd-viewer';
import { cameraView, link } from './views';

const Y_UP = new Matrix4(), Z_UP = new Matrix4().makeRotationX(-Math.PI / 2); // three.root of a Y-up / a Z-up stage
const near = (a: ArrayLike<number>, b: ArrayLike<number>, eps = 1e-6) => Array.from(a).every((x, i) => Math.abs(x - b[i]) < eps);

describe('cameraView', () => {
  it('a stage camera: its eye, its fov from the lens, the orbit target at the model centre depth', () => {
    // the showcase camera: at (0, 2.5, 9) looking down -Z, focal 28 / aperture 24 authored (2.8 / 2.4 from Hydra)
    const v = cameraView({ path: '/World/Camera', params: { projection: 'perspective', focalLength: 2.8, horizontalAperture: 3.6, verticalAperture: 2.4, clippingRange: [0.1, 1000] }, matrix: new Matrix4().makeTranslation(0, 2.5, 9).toArray() }, Y_UP, new Vector3(0, 0, 0), 5);
    expect(near(v.eye, [0, 2.5, 9])).toBe(true);
    expect(near(v.target, [0, 2.5, 0])).toBe(true);
    expect(v.fov).toBeCloseTo(2 * Math.atan(2.4 / 5.6) * (180 / Math.PI), 6);
    expect(v.projection).toBe('perspective');
  });
  it('a Z-up stage: the camera is placed through three.root; an orthographic one takes its half-height', () => {
    const stage = new Matrix4().makeTranslation(0, -10, 2).multiply(new Matrix4().makeRotationX(Math.PI / 2)); // looks along +Y in a Z-up stage
    const v = cameraView({ path: '/C', params: { projection: 'orthographic', focalLength: 5, horizontalAperture: 8, verticalAperture: 6, clippingRange: [1, 100] }, matrix: stage.toArray() }, Z_UP, new Vector3(), 1);
    expect(near(v.eye, new Vector3(0, -10, 2).applyMatrix4(Z_UP).toArray())).toBe(true); // world = root x stage
    expect(near(new Vector3(...v.target).sub(new Vector3(...v.eye)).normalize().toArray(), [0, 0, -1])).toBe(true); // stage +Y is world -Z
    expect([v.projection, v.height]).toEqual(['orthographic', 3]);
  });
});

describe('link', () => {
  /** A view as the viewer has it: setting it nudges the eye (OrbitControls rounds what it is given); draw() runs its hooks. */
  const view = (x: number) => {
    let v: ViewState = { eye: [x, 0, 10], target: [0, 0, 0], fov: 45, projection: 'perspective', height: 1 };
    const p = {
      writes: 0,
      get view() { return v; },
      set view(s: ViewState) { p.writes++; v = { ...s, eye: [s.eye[0] + 1e-9, s.eye[1], s.eye[2]] }; },
      three: { beforeRender: new Set<() => void>() },
      draw: () => { for (const h of p.three.beforeRender) h(); },
      orbit: (x2: number) => { v = { ...v, eye: [x2, 0, 10] }; },
    };
    return p;
  };
  it('the lead hands its view over; an orbit in one view reaches the others, never echoed back; unlink stops it', () => {
    const [a, b, c] = [view(1), view(2), view(3)];
    const unlink = link([a, b, c], b);
    expect([a.view.eye[0], c.view.eye[0]].map((x) => Math.round(x))).toEqual([2, 2]);
    const writes = () => [a.writes, b.writes, c.writes];
    const before = writes();
    for (const p of [a, b, c]) p.draw();
    expect(writes()).toEqual(before); // nothing moved: nothing written
    a.orbit(7);
    a.draw();
    expect([b.view.eye[0], c.view.eye[0]].map((x) => Math.round(x))).toEqual([7, 7]);
    const after = writes();
    for (const p of [b, c, a]) p.draw();
    expect(writes()).toEqual(after); // the others' read-back is no change of theirs
    unlink();
    c.orbit(9);
    c.draw();
    expect(Math.round(a.view.eye[0])).toBe(7);
    expect([a, b, c].every((p) => p.three.beforeRender.size === 0)).toBe(true);
  });
});
