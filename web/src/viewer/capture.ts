// Screenshots of a 3D view at any width × height, also while the tab is hidden: the view's renderer draws its scene once
// more, through a camera of its own (the given view, or the view's current one, at the shot's aspect), into a render
// target of its own, and reads it back. The user's camera, canvas and linked views stay as they are, and nothing waits
// for an animation frame. Tone mapping and sRGB are the screen's (three's output target), so value colours equal the
// legend's; the transparent background becomes white. Near and far follow the viewer's rule for the shot's eye
// (USD_WebViewer viewport.ts fitClipPlanes); `near` overrides near: a cutaway that clips what stands in front.
// No import of ./usd.ts: the node tests import this module.
import { Box3, OrthographicCamera, PerspectiveCamera, RenderTarget, Sphere } from 'three';
import type { UsdViewerElement, ViewState } from 'usd-viewer';

export interface Shot { width: number; height: number; view?: ViewState; near?: number; type?: 'image/png' | 'image/jpeg'; quality?: number }
/** The largest shot: 8192 px a side (WebGPU's default texture limit: the viewer asks for no more) and 4096 × 4096 px in
 *  all (a shot holds about 64 B of GPU memory per pixel while it renders: 4× MSAA half-float colour, depth, output). */
export const MAX_SIDE = 8192, MAX_PIXELS = 4096 * 4096;
/** A WebGPU device's error scopes (lib.dom has no GPUDevice yet). */
interface ErrorScopes { pushErrorScope(filter: 'out-of-memory'): void; popErrorScope(): Promise<GPUError | null> }
/** What the WebGL read-back takes from three's WebGL backend: its context, its binding cache, a texture's GL object. */
interface GLBackend { gl: WebGL2RenderingContext; state: { bindFramebuffer(target: number, fb: WebGLFramebuffer | null): void }; get(o: object): { textureGPU: WebGLTexture } }

/** A camera showing `view` at `aspect` (width / height), as the viewer's free camera does (up +Y; its clamps: fov
 *  0.01-179°, half-height >= 1e-6, eye on the target looks along -Z). */
export function camera(view: ViewState, aspect: number): PerspectiveCamera | OrthographicCamera {
  const h = Math.max(view.height, 1e-6), fov = Math.min(Math.max(view.fov, 0.01), 179);
  const cam = view.projection === 'orthographic' ? new OrthographicCamera(-h * aspect, h * aspect, h, -h) : new PerspectiveCamera(fov, aspect);
  cam.position.fromArray(view.eye);
  const [x, y, z] = view.target, same = cam.position.distanceToSquared({ x, y, z }) < 1e-18;
  cam.lookAt(x, y, same ? z - 1 : z);
  cam.updateMatrixWorld();
  return cam;
}

/**
 * Read-back RGBA8 rows -> a top-down, opaque image: WebGPU pads every row but the last to 256 bytes, WebGL reads
 * bottom-up. The colours are premultiplied (the view clears to alpha 0), so each lands on white as the page would
 * composite it: rgb + 255 - alpha.
 */
export function unpack(px: ArrayLike<number>, w: number, h: number, webgl: boolean): Uint8ClampedArray<ArrayBuffer> {
  const row = 4 * w, stride = webgl ? row : Math.ceil(row / 256) * 256, out = new Uint8ClampedArray(row * h);
  for (let y = 0; y < h; y++) {
    const from = (webgl ? h - 1 - y : y) * stride;
    for (let i = 0; i < row; i += 4) {
      const o = y * row + i, white = 255 - px[from + i + 3];
      out[o] = px[from + i] + white;
      out[o + 1] = px[from + i + 1] + white;
      out[o + 2] = px[from + i + 2] + white;
      out[o + 3] = 255;
    }
  }
  return out;
}

/** A width × height image of `el`'s scene over white, PNG unless `type` says otherwise. */
export async function capture(el: UsdViewerElement, s: Shot): Promise<Blob> {
  const { width: W, height: H } = s;
  if (!(Number.isInteger(W) && Number.isInteger(H) && Math.min(W, H) >= 16 && Math.max(W, H) <= MAX_SIDE && W * H <= MAX_PIXELS)) {
    throw new Error(`${W} × ${H} px: a shot is 16 to ${MAX_SIDE} px a side and at most 4096 × 4096 px in all`);
  }
  await el.ready;
  const three = el.three, r = three.renderer, cam = camera(s.view ?? el.view, W / H);
  const box = new Box3(); // the stage and the overlay shown (sun path, grid) in one sphere
  for (const o of three.overlay.children) if (o.visible) box.expandByObject(o);
  const sphere = box.getBoundingSphere(new Sphere()).union(new Box3().setFromObject(three.root).getBoundingSphere(new Sphere()));
  if (sphere.radius > 0) {
    const d = cam.position.distanceTo(sphere.center);
    cam.near = cam instanceof OrthographicCamera ? d - 2 * sphere.radius : Math.max((d - sphere.radius) / 2, 1e-3 * sphere.radius);
    cam.far = d + 2 * sphere.radius;
  }
  if (s.near !== undefined) {
    if (!Number.isFinite(s.near) || s.near >= cam.far || (s.near <= 0 && cam instanceof PerspectiveCamera)) throw new Error(`near: more than 0 and less than ${cam.far.toPrecision(3)} here`);
    cam.near = s.near;
  }
  cam.updateProjectionMatrix();
  // ponytail: three keeps its output pass per internal target past rt.dispose() (Renderer._quadCache), a few kB per shot;
  // keep one target per size if a session ever takes thousands
  const rt = new RenderTarget(W, H, { depthBuffer: false }); // colour only: the scene draws into three's internal target
  const was = [r.getRenderTarget(), r.getOutputRenderTarget()] as const;
  const gpu = el.backend === 'webgpu' ? (r.backend as unknown as { device: ErrorScopes }).device : null;
  try {
    let read: ArrayLike<number> | Promise<ArrayLike<number>>, oom: Promise<GPUError | null> | undefined;
    gpu?.pushErrorScope('out-of-memory');
    try {
      r.setOutputRenderTarget(rt); // tone mapping and sRGB as on screen (setRenderTarget alone skips both)
      r.render(three.scene, cam);
      if (gpu) read = r.readRenderTargetPixelsAsync(rt, 0, 0, W, H); // allocates and submits now, inside the scope
      else {
        // WebGL reads at once: three's async read-back polls its fence once an animation frame, and a hidden tab runs
        // none. Through three's binding cache, as its own read-back does.
        // ponytail: the page stalls until the GPU is done (seconds for a big shot under SwiftShader); a pixel-pack
        // buffer and a fence polled off a MessageChannel if that hurts
        const b = r.backend as unknown as GLBackend, gl = b.gl, fb = gl.createFramebuffer(), out = new Uint8Array(4 * W * H);
        b.state.bindFramebuffer(gl.READ_FRAMEBUFFER, fb);
        gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, b.get(rt.texture).textureGPU, 0);
        gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, out); // tight rows, bottom-up: unpack's WebGL case
        b.state.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
        gl.deleteFramebuffer(fb);
        read = out;
      }
    } finally {
      r.setRenderTarget(was[0]); // render() leaves rt bound after its output pass: the view's next frame would draw into it
      r.setOutputRenderTarget(was[1]);
      oom = gpu?.popErrorScope();
    }
    const [px, error] = await Promise.all([read, oom]);
    if (error) throw new Error(`${W} × ${H} px needs more GPU memory than is free: take a smaller shot`);
    const canvas = new OffscreenCanvas(W, H);
    canvas.getContext('2d')!.putImageData(new ImageData(unpack(px, W, H, el.backend === 'webgl2'), W, H), 0, 0);
    return await canvas.convertToBlob({ type: s.type ?? 'image/png', quality: s.quality });
  } finally {
    rt.dispose();
  }
}
