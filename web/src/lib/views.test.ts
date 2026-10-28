import { describe, expect, it } from 'vitest';
import { Matrix4, Vector3 } from 'three';
import { cameraView } from './views';

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
