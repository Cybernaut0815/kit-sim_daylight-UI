// Views: the USD's own cameras and the views saved in the app, as free views of the 3D view and as USD Camera prims.
// The viewer's world is the stage in its own units under `three.root` (rotated for Z-up stages), so stage space is
// root⁻¹ × world. Lens conventions: Hydra hands camera lenses over at 0.1 × the authored value (scene units); the
// free camera's focal length is 35 mm equivalent on a 24 mm gate; only ratios matter for a perspective field of view.
import { Matrix4, Vector3 } from 'three';
import { dmeshStems } from 'daylight-mesh';
import type { CameraParams, ViewState } from 'usd-viewer';

/** A view saved in the app: the free view, the canvas aspect and the clip range when it was saved. */
export interface SavedView { id: string; name: string; view: ViewState; aspect: number; near: number; far: number }
/** A stage camera as the viewer lists it: lens in scene units, world matrix in stage space. */
export interface StageCamera { path: string; params: CameraParams; matrix: ArrayLike<number> }

const DEG = 180 / Math.PI;

/**
 * A stage camera as a free view: its eye and direction, its field of view (orthographic: its half-height), and the
 * orbit target at the depth of the model's centre along the view (at least 5 % of the model's radius ahead).
 */
export function cameraView(camera: StageCamera, root: Matrix4, centre: Vector3, radius: number): ViewState {
  const world = root.clone().multiply(new Matrix4().fromArray(Array.from(camera.matrix)));
  const e = world.elements, eye = new Vector3().setFromMatrixPosition(world);
  const dir = new Vector3(-e[8], -e[9], -e[10]).normalize(); // a camera looks down its -Z
  const depth = Math.max(centre.clone().sub(eye).dot(dir), 0.05 * radius, 1e-3);
  const p = camera.params, ortho = p.projection === 'orthographic', ratio = p.verticalAperture / (2 * p.focalLength);
  const lens = Number.isFinite(ratio) && ratio > 0;
  return {
    eye: [eye.x, eye.y, eye.z], target: eye.clone().addScaledVector(dir, depth).toArray(),
    fov: lens ? 2 * Math.atan(ratio) * DEG : 45,
    projection: ortho ? 'orthographic' : 'perspective',
    height: ortho ? p.verticalAperture / 2 : depth * (lens ? ratio : 0.4),
  };
}

/** The world matrix of a free view as a camera: at the eye, looking at the target, up +Y (the orbit's up). */
export function viewMatrix(v: ViewState): Matrix4 {
  const eye = new Vector3(...v.eye);
  return new Matrix4().lookAt(eye, new Vector3(...v.target), new Vector3(0, 1, 0)).setPosition(eye);
}

const dbl = (x: number) => (Number.isFinite(x) ? String(+x.toPrecision(15)) : '0'); // matrix4d: doubles (survey coordinates)
const flt = (x: number) => (Number.isFinite(x) ? String(+x.toPrecision(7)) : '0');

/**
 * Saved views as USD Camera prims (usda, every line at `indent`), in stage space: the free camera's lens (perspective:
 * focal length on a 24 high gate, as tenths of a scene unit; orthographic: the half-height as the aperture Hydra
 * scales by 0.1), the canvas aspect of the moment it was saved, its clip range. Names: USD identifiers, unique.
 */
export function cameraPrims(views: SavedView[], root: Matrix4, indent = ''): string {
  const toStage = root.clone().invert(), i1 = `${indent}    `;
  const names = dmeshStems(views.map((v) => v.name.replace(/[^A-Za-z0-9_]/g, '_').replace(/^(?=\d)/, '_')), 'View');
  return views.map((v, k) => {
    const e = toStage.clone().multiply(viewMatrix(v.view)).elements, row = (i: number) => `(${[0, 1, 2, 3].map((j) => dbl(e[i + j])).join(', ')})`;
    const ortho = v.view.projection === 'orthographic';
    const vA = ortho ? 20 * v.view.height : 24, focal = ortho ? 50 : 12 / Math.tan((v.view.fov * Math.PI) / 360);
    const near = Math.max(v.near, 1e-6), far = Math.max(v.far, near * 10);
    return [
      `${indent}def Camera "${names[k]}" (`,
      `${i1}displayName = ${JSON.stringify(v.name)}`,
      `${indent})`,
      `${indent}{`,
      `${i1}float2 clippingRange = (${flt(near)}, ${flt(far)})`,
      `${i1}float focalLength = ${flt(focal)}`,
      `${i1}float horizontalAperture = ${flt(vA * v.aspect)}`,
      `${i1}token projection = "${ortho ? 'orthographic' : 'perspective'}"`,
      `${i1}float verticalAperture = ${flt(vA)}`,
      `${i1}matrix4d xformOp:transform = (${[0, 4, 8, 12].map(row).join(', ')})`,
      `${i1}uniform token[] xformOpOrder = ["xformOp:transform"]`,
      `${indent}}`,
      '',
    ].join('\n');
  }).join('\n');
}
