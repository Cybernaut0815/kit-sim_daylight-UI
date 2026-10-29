// Views: the USD's own cameras and the views saved in the app (this session only, never written to a file), as free
// views of a 3D view, and linked cameras across views. The viewer's world is the stage in its own units under
// `three.root` (rotated for Z-up stages).
// Lens conventions: Hydra hands camera lenses over at 0.1 × the authored value (scene units); only ratios matter for a
// perspective field of view.
import { Box3, Matrix4, Sphere, Vector3, type Object3D } from 'three';
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

/** A camera of the stage under `root` (a viewer's three.root) as that viewer's free view: the orbit target where the
 *  model's centre is along its view (the Views menu, set_camera). */
export function stageView(root: Object3D, camera: StageCamera): ViewState {
  root.updateMatrixWorld();
  const s = new Box3().setFromObject(root).getBoundingSphere(new Sphere());
  return cameraView(camera, root.matrixWorld, s.center, Math.max(s.radius, 1e-6));
}

/** A view as link() sees it: a <usd-viewer>'s free view and its per-frame hooks. */
export interface Linked { view: ViewState; three: { beforeRender: Set<() => void> } }

/**
 * Linked cameras, without a camera event in the viewer: each frame a view draws, its view (as JSON) is compared with
 * the one last seen or written there; a change (orbit, wheel, F, a menu jump, a frame) goes to the other views, whose
 * read-back is kept (the orbit rounds what it is given), so their next frames never echo it back. `lead` hands its view
 * to the others at once; the others trail by one frame. Returns the unlink.
 */
export function link(views: Linked[], lead = views[0]): () => void {
  const seen = new Map<Linked, string>();
  const push = (from: Linked) => {
    const v = from.view;
    seen.set(from, JSON.stringify(v));
    for (const p of views) if (p !== from) { p.view = v; seen.set(p, JSON.stringify(p.view)); }
  };
  const hooks = views.map((p) => [p, () => { if (JSON.stringify(p.view) !== seen.get(p)) push(p); }] as const);
  if (lead) push(lead);
  for (const [p, h] of hooks) p.three.beforeRender.add(h);
  return () => { for (const [p, h] of hooks) p.three.beforeRender.delete(h); };
}
