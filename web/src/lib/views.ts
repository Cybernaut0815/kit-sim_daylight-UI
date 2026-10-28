// Views: the USD's own cameras and the views saved in the app (this session only, never written to a file), as free
// views of the 3D view. The viewer's world is the stage in its own units under `three.root` (rotated for Z-up stages).
// Lens conventions: Hydra hands camera lenses over at 0.1 × the authored value (scene units); only ratios matter for a
// perspective field of view.
import { Matrix4, Vector3 } from 'three';
import type { CameraParams, ViewState } from 'usd-viewer';

/** A view saved in the app: a free view under a name. */
export interface SavedView { id: string; name: string; view: ViewState }
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
