// The app's <usd-viewer>s (the USD_WebViewer submodule), one per model slot (A..D): each constructor starts a wasm core
// and a renderer, and dispose() is final, so an element lives as long as the page (a removed model's is closed and waits
// for the next model in its slot); its Viewer moves it into its pane. Slot 0 starts with the page. Browser-only: the
// node tests never import it.
import 'usd-viewer';
import type { MaterialNetwork, RenderDelta, UsdViewerElement } from 'usd-viewer';
import type { TextureRead, TextureStats } from '../lib/optics';

/** A slot's viewer and its open stage's materials by rid, as its core sends them: what the optics derive from (rids
 *  are per core). Listening from before the first open(): a flush sends a material ahead of the meshes bound to it, so
 *  once open() or an edit has resolved, a bound rid without an entry has none. */
export interface Slot { el: UsdViewerElement; materials: Map<number, { path: string; network?: MaterialNetwork }> }
const pool: Slot[] = [];

/** Slot k's viewer (model A..D), made on first use with the app's look. */
export function viewer(slot: number): Slot {
  if (pool[slot]) return pool[slot];
  // A Vite hot update re-runs this module: reuse the live element (worker, core, stage), never boot a second one under it.
  const el = document.querySelector<UsdViewerElement>(`usd-viewer[data-slot="${slot}"]`) ?? document.createElement('usd-viewer');
  el.dataset.slot = String(slot);
  el.setAttribute('panels', 'none'); // a bare viewport: the app has its own panels
  el.setAttribute('readonly', ''); // no edits from the view: the meshes are converted once per load
  el.purposes = ['default', 'render']; // what the core's own USD readers keep
  el.sky = 'colour'; // the stage's lighting, never its dome texture behind the model
  el.backgroundColor = 'transparent'; // the page's token background shows through
  el.three.renderer.domElement.setAttribute('aria-label', `3D view of model ${'ABCD'[slot]}`);
  const materials: Slot['materials'] = new Map();
  el.session.addEventListener('delta', (e) => {
    const d = (e as CustomEvent<RenderDelta>).detail;
    d.removed?.forEach((rid) => materials.delete(rid));
    d.materials?.forEach((m) => materials.set(m.rid, { path: m.path, network: m.network }));
  });
  el.session.addEventListener('stageclose', () => materials.clear());
  return (pool[slot] = { el, materials });
}
viewer(0); // the first core starts with the page

/** textureStats() of a texture read (lib/optics.ts textureReads), from the file's own bytes in `el`'s core, decoded and
 *  counted in a worker of its own (gone with its memory once it answers); null when it cannot be read or decoded
 *  (readBytes null, EXR / HDR, a decode error): it then counts as absent. */
export async function readTexture(el: UsdViewerElement, { file, opacity }: TextureRead): Promise<TextureStats | null> {
  try {
    const bytes = await el.session.readBytes(file);
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
