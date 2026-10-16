// The app's one <usd-viewer> (the USD_WebViewer submodule): its constructor starts the wasm core and the renderer and
// dispose() is final, so it lives as long as the page and the Viewer moves it into the viewport. Browser-only: the
// node tests never import it.
import 'usd-viewer';

// A Vite hot update re-runs this module: reuse the live element (worker, core, stage), never boot a second one under it.
export const usd = document.querySelector('usd-viewer') ?? document.createElement('usd-viewer');
usd.setAttribute('panels', 'none'); // a bare viewport: the app has its own panels
usd.setAttribute('readonly', ''); // no edits from the view: the meshes are converted once per load
usd.purposes = ['default', 'render']; // what the core's own USD readers keep
usd.sky = 'colour'; // the stage's lighting, never its dome texture behind the model
usd.backgroundColor = 'transparent'; // the page's token background shows through
usd.three.renderer.domElement.setAttribute('aria-label', '3D model viewport');
