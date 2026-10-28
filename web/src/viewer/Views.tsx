// The run bar's two menus, acting on the active model's view.
// - Views: the model's own cameras and the views saved here. Picking one moves the 3D view there (linked cameras: every
//   view), and orbiting goes on from it. The current view can be saved under a name, and a saved one removed again (the
//   model's cameras cannot). Saved views serve every view, last this session and never go into a file.
// - Download: the active model's result as USD, glTF or OBJ (download.ts).
import { useEffect, useState } from 'react';
import { Box3, Sphere } from 'three';
import type { UsdViewerElement } from 'usd-viewer';
import { cameraView, type SavedView, type StageCamera } from '../lib/views';
import { Alert, Icon, MenuButton } from '../ui';
import { FORMATS, isUsd, type ExportMode, type Format } from './download';

/** The next free "View N" name. */
const nextName = (views: SavedView[]) => `View ${Math.max(0, ...views.map((v) => Number(/^View (\d+)$/.exec(v.name)?.[1] ?? 0))) + 1}`;

export function ViewsMenu({ usd, model, disabled, views, onSave, onRemove }: { usd: UsdViewerElement; model?: string; disabled: boolean; views: SavedView[]; onSave: (v: SavedView) => void; onRemove: (id: string) => void }) {
  const [cameras, setCameras] = useState<StageCamera[]>(() => usd.cameras);
  const [name, setName] = useState('');
  useEffect(() => {
    const update = () => setCameras(usd.cameras);
    update();
    usd.addEventListener('cameraschange', update);
    return () => usd.removeEventListener('cameraschange', update);
  }, [usd]);
  /** A camera of the model as the free view: the orbit target where the model's centre is along its view. */
  const jump = (c: StageCamera) => {
    usd.three.root.updateMatrixWorld();
    const s = new Box3().setFromObject(usd.three.root).getBoundingSphere(new Sphere());
    usd.view = cameraView(c, usd.three.root.matrixWorld, s.center, Math.max(s.radius, 1e-6));
  };
  const save = () => {
    onSave({ id: crypto.randomUUID(), name: name.trim() || nextName(views), view: usd.view });
    setName('');
  };
  return (
    <MenuButton id="views-menu" label="Views" disabled={disabled} title={`${model ? `Model ${model}, the pressed view: ` : ''}jump to a camera of the model or a saved view; save the current view. Saved views serve every view for this session, never a download`}>
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

const FORMAT_LABEL: Record<Format, string> = {
  usdz: '.usdz: USD package', usda: '.usda: USD text', usdc: '.usdc: USD binary', usd: '.usd: USD binary',
  glb: '.glb: glTF binary', gltf: '.gltf: glTF text', obj: '.obj: Wavefront OBJ',
};
const MODE_HELP: Record<ExportMode, string> = {
  replace: 'The result colours replace the receivers’ materials, on the faces they were simulated on (subdivided where the run was), with every result as a value primvar.',
  variants: 'Each receiver gets a variant set "daylight": "original" and one variant per result. The stage is flattened as shown (the model’s own variant sets baked).',
};
/** What a download holds: the mode's help (USD), plus how the format packs it; the drawn model for glTF / OBJ. */
const help = (format: Format, mode: ExportMode) => ({
  usdz: `${MODE_HELP[mode]} ${mode === 'replace' ? 'A layer over the model files, packed with them.' : 'Packed with the files it uses.'}`,
  usda: `${MODE_HELP[mode]} One file; a .zip with the textures it uses, if any.`,
  glb: 'The model as drawn, in metres, receivers coloured as shown (unlit), every result as a value per corner (_DAYLIGHT_*).',
  gltf: 'The model as drawn, in metres, receivers coloured as shown (unlit), every result as a value per corner (_DAYLIGHT_*). One text file.',
  obj: 'The model as drawn, in metres, receivers coloured as shown (vertex colours). OBJ holds no values.',
})[format === 'usdc' || format === 'usd' ? 'usda' : format];

export function DownloadMenu({ model, ready, exporting, error, onDownload }: { model?: string; ready: boolean; exporting: boolean; error: string | null; onDownload: (format: Format, mode: ExportMode) => void }) {
  const [format, setFormat] = useState<Format>('usdz'), [mode, setMode] = useState<ExportMode>('replace');
  const usdFormat = isUsd(format);
  return (
    <MenuButton id="download-menu" label="Download" disabled={!ready} busy={exporting} title={ready ? `${model ? `Model ${model}'s result` : 'The result'} as USD, glTF or OBJ` : 'Run the simulation first'}>
      {() => (
        <>
          <div className="views__format">
            <select className="select" aria-label="Format" value={format} onChange={(e) => setFormat(e.target.value as Format)}>
              {FORMATS.map((f) => <option key={f} value={f}>{FORMAT_LABEL[f]}</option>)}
            </select>
          </div>
          <div className="menu__section">What the file holds</div>
          {(['replace', 'variants'] as const).map((m) => (
            <label key={m} className="menu__item" title={usdFormat ? MODE_HELP[m] : 'USD formats only'}>
              <input className="menu__check" type="radio" name="usd-mode" value={m} checked={mode === m} disabled={!usdFormat} onChange={() => setMode(m)} />
              <span>{m === 'replace' ? 'Colours replace the materials' : 'Variants per result (flattened)'}</span>
            </label>
          ))}
          <p className="views__note text-muted lines-5">{help(format, mode)}</p>
          {error && <Alert title="Download failed">{error}</Alert>}
          <div className="menu__footer views__download">
            <span className="text-muted">{exporting ? <><span className="spinner" aria-hidden="true" /> {usdFormat ? `Packing${mode === 'variants' || format !== 'usdz' ? ', flattening first' : ''}` : 'Writing'}</> : null}</span>
            <button className="btn btn--primary" type="button" disabled={exporting} aria-busy={exporting} onClick={() => onDownload(format, mode)}>Download</button>
          </div>
        </>
      )}
    </MenuButton>
  );
}
