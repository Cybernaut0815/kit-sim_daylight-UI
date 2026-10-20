// The run bar's two menus.
// - Views: the model's own cameras and the views saved here. Picking one moves the 3D view there, and orbiting goes on
//   from it. The current view can be saved under a name, and a saved one removed again (the model's cameras cannot).
// - Download USD: the result as USD (download.ts), with the saved views as cameras if wanted.
import { useEffect, useState } from 'react';
import { Box3, Sphere } from 'three';
import { cameraView, type SavedView, type StageCamera } from '../lib/views';
import { Alert, Icon, MenuButton } from '../ui';
import type { ExportMode } from './download';
import { usd } from './usd';

/** The next free "View N" name. */
const nextName = (views: SavedView[]) => `View ${Math.max(0, ...views.map((v) => Number(/^View (\d+)$/.exec(v.name)?.[1] ?? 0))) + 1}`;

export function ViewsMenu({ disabled, views, onSave, onRemove }: { disabled: boolean; views: SavedView[]; onSave: (v: SavedView) => void; onRemove: (id: string) => void }) {
  const [cameras, setCameras] = useState<StageCamera[]>(() => usd.cameras);
  const [name, setName] = useState('');
  useEffect(() => {
    const update = () => setCameras(usd.cameras);
    update();
    usd.addEventListener('cameraschange', update);
    return () => usd.removeEventListener('cameraschange', update);
  }, []);
  /** A camera of the model as the free view: the orbit target where the model's centre is along its view. */
  const jump = (c: StageCamera) => {
    usd.three.root.updateMatrixWorld();
    const s = new Box3().setFromObject(usd.three.root).getBoundingSphere(new Sphere());
    usd.view = cameraView(c, usd.three.root.matrixWorld, s.center, Math.max(s.radius, 1e-6));
  };
  const save = () => {
    const canvas = usd.three.renderer.domElement, lens = usd.cameraSettings;
    onSave({ id: crypto.randomUUID(), name: name.trim() || nextName(views), view: usd.view, aspect: canvas.clientWidth / Math.max(canvas.clientHeight, 1), near: lens.near, far: lens.far });
    setName('');
  };
  return (
    <MenuButton id="views-menu" label="Views" disabled={disabled} title="Jump to a camera of the model or a saved view; save the current view">
      {(close) => (
        <>
          <button className="menu__item" type="button" onClick={() => { usd.frame(); close(); }}><span>Whole model</span></button>
          <div className="menu__separator" />
          <div className="menu__section">In the model</div>
          {cameras.length
            ? cameras.map((c) => <button key={c.path} className="menu__item" type="button" title={c.path} onClick={() => { jump(c); close(); }}><span>{c.path.slice(c.path.lastIndexOf('/') + 1)}</span></button>)
            : <p className="views__note text-muted">No cameras</p>}
          <div className="menu__separator" />
          <div className="menu__section">Saved</div>
          {views.length
            ? views.map((v) => (
              <div key={v.id} className="views__row">
                <button className="menu__item" type="button" onClick={() => { usd.view = v.view; close(); }}><span>{v.name}</span></button>
                <button className="icon-btn icon-btn--ghost" type="button" aria-label={`Remove ${v.name}`} title={`Remove ${v.name}`} onClick={() => onRemove(v.id)}><Icon name="close" /></button>
              </div>
            ))
            : <p className="views__note text-muted">None yet: save the current view below</p>}
          <form className="menu__footer views__save" onSubmit={(e) => { e.preventDefault(); save(); }}>
            <label className="sr-only" htmlFor="view-name">Name of the new view</label>
            <input className="input" id="view-name" value={name} placeholder={nextName(views)} onChange={(e) => setName(e.target.value)} />
            <button className="btn btn--primary" type="submit">Save view</button>
          </form>
        </>
      )}
    </MenuButton>
  );
}

const HELP: Record<ExportMode, string> = {
  replace: 'One layer over the model files, packed with them. The receivers keep their geometry (or become the subdivided faces they were simulated on), coloured as shown, with every result as a value primvar.',
  variants: 'The stage flattened as shown. Each receiver gets a variant set "daylight": "original" and one variant per result. The model’s own variant sets are baked as shown.',
};

export function DownloadMenu({ ready, exporting, error, views, onDownload }: { ready: boolean; exporting: boolean; error: string | null; views: number; onDownload: (mode: ExportMode, cameras: boolean) => void }) {
  const [mode, setMode] = useState<ExportMode>('replace'), [cameras, setCameras] = useState(true);
  const withCameras = cameras && views > 0;
  return (
    <MenuButton id="download-menu" label="Download USD" disabled={!ready} busy={exporting} title={ready ? 'The result as USD' : 'Run the simulation first'}>
      {() => (
        <>
          <div className="menu__section">What the file holds</div>
          {(['replace', 'variants'] as const).map((m) => (
            <label key={m} className="menu__item" title={HELP[m]}>
              <input className="menu__check" type="radio" name="usd-mode" value={m} checked={mode === m} onChange={() => setMode(m)} />
              <span>{m === 'replace' ? 'Colours replace the materials' : 'Variants per result (flattened)'}</span>
            </label>
          ))}
          <p className="views__note text-muted">{HELP[mode]}</p>
          <div className="menu__separator" />
          <label className="menu__item">
            <input className="menu__check" type="checkbox" checked={withCameras} disabled={!views} onChange={(e) => setCameras(e.target.checked)} />
            <span>Include saved views ({views})</span>
          </label>
          {error && <Alert title="Download failed">{error}</Alert>}
          <div className="menu__footer views__download">
            <span className="text-muted">{exporting ? <><span className="spinner" aria-hidden="true" /> Packing{mode === 'variants' ? ', flattening first' : ''}</> : null}</span>
            <button className="btn btn--primary" type="button" disabled={exporting} aria-busy={exporting} onClick={() => onDownload(mode, withCameras)}>Download</button>
          </div>
        </>
      )}
    </MenuButton>
  );
}
