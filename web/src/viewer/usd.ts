// The app's one <usd-viewer> (the USD_WebViewer submodule): its constructor starts the wasm core and the renderer and
// dispose() is final, so it lives as long as the page and the Viewer moves it into the viewport. Browser-only: the
// node tests never import it.
import 'usd-viewer';
import type { MaterialNetwork, RenderDelta } from 'usd-viewer';
import type { TextureRead, TextureStats } from '../lib/optics';

// A Vite hot update re-runs this module: reuse the live element (worker, core, stage), never boot a second one under it.
export const usd = document.querySelector('usd-viewer') ?? document.createElement('usd-viewer');
usd.setAttribute('panels', 'none'); // a bare viewport: the app has its own panels
usd.setAttribute('readonly', ''); // no edits from the view: the meshes are converted once per load
usd.purposes = ['default', 'render']; // what the core's own USD readers keep
usd.sky = 'colour'; // the stage's lighting, never its dome texture behind the model
usd.backgroundColor = 'transparent'; // the page's token background shows through
usd.three.renderer.domElement.setAttribute('aria-label', '3D model viewport');

/** The open stage's materials by rid, as the core sends them: what the optics derive from. Listening from before the
 *  first open(): a flush sends a material ahead of the meshes bound to it, so once open() or an edit has resolved, a
 *  bound rid without an entry has none. */
export const materials = new Map<number, { path: string; network?: MaterialNetwork }>();
usd.session.addEventListener('delta', (e) => {
  const d = (e as CustomEvent<RenderDelta>).detail;
  d.removed?.forEach((rid) => materials.delete(rid));
  d.materials?.forEach((m) => materials.set(m.rid, { path: m.path, network: m.network }));
});
usd.session.addEventListener('stageclose', () => materials.clear());

/** textureStats() of a texture read (lib/optics.ts textureReads), from the file's own bytes, decoded and counted in a
 *  worker of its own (gone with its memory once it answers); null when it cannot be read or decoded (readBytes null,
 *  EXR / HDR, a decode error): it then counts as absent. */
export async function readTexture({ file, opacity }: TextureRead): Promise<TextureStats | null> {
  try {
    const bytes = await usd.session.readBytes(file);
    if (!bytes) return null;
    const blob = bytes instanceof Blob ? bytes : new Blob([bytes]), worker = new Worker(new URL('./texstats.worker.ts', import.meta.url), { type: 'module' });
    return await new Promise<TextureStats | null>((resolve) => {
      worker.onmessage = (e: MessageEvent<TextureStats | null>) => resolve(e.data);
      worker.onerror = () => resolve(null);
      worker.postMessage({ blob, opacity });
    }).finally(() => worker.terminate());
  } catch {
    return null;
  }
}
