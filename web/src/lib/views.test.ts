import { describe, expect, it } from 'vitest';
import { Matrix4, Vector3 } from 'three';
import { cameraPrims, cameraView, viewMatrix, type SavedView } from './views';

const Y_UP = new Matrix4(), Z_UP = new Matrix4().makeRotationX(-Math.PI / 2); // three.root of a Y-up / a Z-up stage
const near = (a: ArrayLike<number>, b: ArrayLike<number>, eps = 1e-6) => Array.from(a).every((x, i) => Math.abs(x - b[i]) < eps);
/** The matrix4d of a camera prim back as a THREE.Matrix4 (USD rows = elements order). */
const matrixOf = (usda: string) => new Matrix4().fromArray(/matrix4d xformOp:transform = \((.*)\)$/m.exec(usda)![1].replace(/[()]/g, '').split(',').map(Number));

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

describe('cameraPrims', () => {
  const saved = (name: string, view: Partial<SavedView['view']> = {}): SavedView => ({
    id: name, name, aspect: 1.5, near: 0.1, far: 500,
    view: { eye: [0, 3, 10], target: [0, 1, 0], fov: 60, projection: 'perspective', height: 1, ...view },
  });
  it('a camera per view: lens from the fov, the canvas aspect, names made USD identifiers', () => {
    const text = cameraPrims([saved('View 1'), saved('View 1'), saved('2nd')], Y_UP, '    ');
    expect(text.match(/def Camera "(\w+)"/g)).toEqual(['def Camera "View_1"', 'def Camera "View_1_2"', 'def Camera "_2nd"']);
    expect(text).toContain('displayName = "View 1"');
    expect(text).toContain(`float focalLength = ${+(12 / Math.tan(Math.PI / 6)).toPrecision(7)}`);
    expect(text).toContain('float horizontalAperture = 36');
    expect(text).toContain('float verticalAperture = 24');
    expect(text).toContain('float2 clippingRange = (0.1, 500)');
  });
  it('the transform is the view in stage space: root x prim = the view, looking at the target', () => {
    for (const root of [Y_UP, Z_UP]) {
      const view = saved('V').view, prim = matrixOf(cameraPrims([saved('V')], root));
      const world = root.clone().multiply(prim);
      expect(near(world.elements, viewMatrix(view).elements, 1e-9)).toBe(true);
      const eye = new Vector3().setFromMatrixPosition(world), dir = new Vector3(0, 0, -1).transformDirection(world);
      expect(near(eye.toArray(), view.eye)).toBe(true);
      expect(near(dir.toArray(), new Vector3(...view.target).sub(eye).normalize().toArray())).toBe(true);
    }
  });
  it('an orthographic view: the aperture Hydra scales back to the half-height', () => {
    const text = cameraPrims([saved('Top', { projection: 'orthographic', height: 4 })], Y_UP);
    expect(text).toContain('token projection = "orthographic"');
    expect(text).toContain('float verticalAperture = 80'); // 0.1 x 80 / 2 = 4
    expect(text).toContain('float horizontalAperture = 120');
  });
});
