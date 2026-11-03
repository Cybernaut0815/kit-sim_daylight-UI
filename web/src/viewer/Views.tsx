// The run bar's menus, acting on the active model's view.
// - Views: the model's own cameras, the reports' views and the views saved here. Picking one moves the 3D view there
//   (linked cameras: every view), and orbiting goes on from it; a report's view also brings its section (or none). The
//   current view can be saved under a name, and a saved one removed again (the model's cameras cannot); a report's view
//   takes the current view and section with Update. Saved views (cameras only) serve every view, last this session and
//   never go into a file.
// - Section: every view's clipping planes and boxes (view only), added and edited in the active view.
// - Download: the active model's result as USD, glTF or OBJ (download.ts).
// - Reports (only while there are any): a report's PDF generated from the current results, opened, or the report deleted.
import { Fragment, useEffect, useState } from 'react';
import { Box3, type Object3D } from 'three';
import type { SectionGizmo, UsdViewerElement, ViewState } from 'usd-viewer';
import { toModel, type Box, type Vec3 } from '../lib/frame';
import { MAX, NONE, boxOf, direction, mm, validate, type Section } from '../lib/section';
import { stageView, type SavedView, type StageCamera } from '../lib/views';
import { generation } from '../report/generate';
import { inApp, readiness, type AppView, type Stored } from '../report/spec';
import { Alert, Icon, MenuButton, NumberField, Segmented } from '../ui';
import { FORMATS, isUsd, type ExportMode, type Format } from './download';

/** The next free "View N" name. */
const nextName = (views: SavedView[]) => `View ${Math.max(0, ...views.map((v) => Number(/^View (\d+)$/.exec(v.name)?.[1] ?? 0))) + 1}`;

/** onReportView: report `id`'s view block `block` (named `name`) takes the camera `view`, in stage units of `mpu` m (and
 *  the section now); onSection: a report view picked, its section. */
export function ViewsMenu({ usd, model, disabled, views, reports, onSave, onRemove, onReportView, onSection }: {
  usd: UsdViewerElement; model?: string; disabled: boolean; views: SavedView[]; reports: Stored[] | null; onSave: (v: SavedView) => void; onRemove: (id: string) => void;
  onReportView: (id: string, block: number, name: string, view: ViewState, mpu: number) => void; onSection: (s: Section) => void;
}) {
  const [cameras, setCameras] = useState<StageCamera[]>(() => usd.cameras);
  const [name, setName] = useState('');
  useEffect(() => {
    const update = () => setCameras(usd.cameras);
    update();
    usd.addEventListener('cameraschange', update);
    return () => usd.removeEventListener('cameraschange', update);
  }, [usd]);
  const save = () => {
    onSave({ id: crypto.randomUUID(), name: name.trim() || nextName(views), view: usd.view });
    setName('');
  };
  return (
    <MenuButton id="views-menu" label="Views" disabled={disabled} title={`${model ? `Model ${model}, the pressed view: jump` : 'Jump'} to a camera of the model or a saved view; save the current view. Saved views serve every view for this session, never a download`}>
      {(close) => (
        <>
          <button className="menu__item" type="button" onClick={() => { usd.frame(); close(); }}><span>Whole model</span></button>
          <div className="menu__separator" />
          <div className="menu__section">In the model</div>
          {cameras.length
            ? cameras.map((c) => <button key={c.path} className="menu__item" type="button" title={c.path} onClick={() => { usd.view = stageView(usd.three.root, c); close(); }}><span>{c.path.slice(c.path.lastIndexOf('/') + 1)}</span></button>)
            : <p className="views__note text-muted">No cameras</p>}
          {reports?.map((r) => {
            const vs = r.spec.blocks.flatMap((b, i) => (b.type === 'view' ? [{ b, i }] : []));
            return vs.length > 0 && (
              <Fragment key={r.id}>
                <div className="menu__separator" />
                <div className="menu__section">Report: {r.spec.title}</div>
                {vs.map(({ b, i }) => (
                  <div key={i} className="views__row">
                    <button className="menu__item" type="button" title={b.caption} onClick={() => { usd.view = b.view; onSection(b.section ?? NONE); close(); }}><span>{b.name}</span></button>
                    <button className="btn btn--ghost" type="button" aria-label={`Update ${b.name} of ${r.spec.title}`} title={`${b.name} of this report takes the current view and section, from its next PDF on`} onClick={() => { onReportView(r.id, i, b.name, usd.view, usd.stage?.metersPerUnit ?? 1); close(); }}>Update</button>
                  </div>
                ))}
              </Fragment>
            );
          })}
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

/** Drawn objects' bounds in model metres (the stage `mpu` m per unit), for a section box round them (the Section menu's,
 *  an agent's paths); null when they have no extent.
 *  ponytail: square to the model axes, so loose round a turned building (Rotate turns it); fit the smallest turned
 *  footprint of their points if tight boxes matter */
export function boundsOf(objects: readonly Object3D[], mpu: number): Box | null {
  const world = new Box3();
  for (const o of objects) {
    o.updateWorldMatrix(true, false); // a background tab may not have drawn since the model loaded
    world.expandByObject(o);
  }
  if (world.isEmpty()) return null;
  const a = toModel(world.min.toArray(), mpu), b = toModel(world.max.toArray(), mpu);
  return { min: a.map((v, k) => Math.min(v, b[k])) as Vec3, max: a.map((v, k) => Math.max(v, b[k])) as Vec3 };
}

/** A point's or a direction's x, y (and z) as number fields under one legend; a blank field keeps its number. */
function Coords({ id, legend, value, onCommit }: { id: string; legend: string; value: readonly number[]; onCommit: (v: number[]) => void }) {
  return (
    <fieldset className="field">
      <legend>{legend}</legend>
      <div className="scale-row__cols">
        {value.map((v, k) => <NumberField key={k} id={`${id}-${'xyz'[k]}`} label={'xyz'[k]} value={v} onCommit={(n) => { if (Number.isFinite(n) && n !== v) onCommit(value.with(k, n)); }} />)}
      </div>
    </fieldset>
  );
}

/**
 * The section every view shows (lib/section.ts, model metres), view only: on or off, cleared; planes and boxes added from
 * the pressed view `usd` (at its target, round its selection) and edited there with the viewer's gizmo, or here by the
 * numbers. onChange: the whole section, and where the gizmo goes once the views have it (null: off; left out: it stays).
 */
export function SectionMenu({ usd, section, disabled, onChange }: { usd: UsdViewerElement; section: Section; disabled: boolean; onChange: (s: Section, gizmo?: SectionGizmo | null) => void }) {
  const [refused, setRefused] = useState({ why: '', n: 0 }); // a number that would make an entry unusable: why; n puts the fields back on the numbers
  const { planes, boxes } = section, mpu = usd.stage?.metersPerUnit ?? 1;
  const put = (patch: Partial<Section>, gizmo?: SectionGizmo | null) => {
    const next = { ...section, ...patch }, why = validate(next, 'section')[0]?.replace(/^section\.(planes|boxes)\[(\d+)\]\./, (_, k: string, i: string) => `${k === 'planes' ? 'Plane' : 'Box'} ${Number(i) + 1} `);
    setRefused((r) => ({ why: why ?? '', n: r.n + (why ? 1 : 0) }));
    if (!why) onChange(next, gizmo);
  };
  const target = () => toModel(usd.view.target, mpu).map(mm) as Vec3; // where the view orbits, model metres
  const facing = () => { const { eye, target: t } = usd.view; return direction(toModel([t[0] - eye[0], t[1] - eye[1], t[2] - eye[2]])); };
  /** A box showing the selected prims (the whole model without), 1 % of their diagonal larger all round. */
  const around = () => {
    const picked = usd.selection.flatMap((p) => usd.three.objectsFor(p)), b = boundsOf(picked.length ? picked : [usd.three.root], mpu);
    if (b) put({ boxes: [...boxes, { keep: 'inside', ...boxOf(b) }] }, { box: boxes.length });
  };
  /** Plane or box i goes: the gizmo lets go of it, or follows the entry it edits an index down. */
  const remove = (kind: 'plane' | 'box', i: number) => {
    const g = usd.sectionGizmo as { plane?: number; box?: number } | null, at = g?.[kind] ?? -1;
    put(kind === 'plane' ? { planes: planes.toSpliced(i, 1) } : { boxes: boxes.toSpliced(i, 1) }, at < i ? undefined : at === i ? null : ({ ...g, [kind]: at - 1 } as SectionGizmo));
  };
  /** An entry's heading: its name, its buttons [label, tooltip, action], Remove. */
  const head = (kind: 'plane' | 'box', i: number, buttons: [string, string, () => void][]) => (
    <div className="cluster cluster--between">
      <span className="menu__section">{kind === 'plane' ? 'Plane' : 'Box'} {i + 1}</span>
      <span className="cluster">
        {buttons.map(([label, help, act]) => <button key={label} className="btn btn--ghost" type="button" title={help} onClick={act}>{label}</button>)}
        <button className="icon-btn icon-btn--ghost" type="button" aria-label={`Remove ${kind} ${i + 1}`} title={`Remove ${kind} ${i + 1}`} onClick={() => remove(kind, i)}><Icon name="close" /></button>
      </span>
    </div>
  );
  return (
    <MenuButton id="section-menu" label="Section" icon="section" disabled={disabled} title="Section: clipping planes and boxes">
      {(close) => {
        const edit = (g: SectionGizmo) => { usd.sectionGizmo = g; close(); }; // the gizmo in the view: its handles take the next drag
        return (
          <>
            <div className="views__row">
              <label className="menu__item"><input className="menu__check" type="checkbox" checked={section.on} disabled={!planes.length && !boxes.length} onChange={(e) => put({ on: e.target.checked })} /><span>Section on</span></label>
              <button className="btn btn--ghost" type="button" disabled={!planes.length && !boxes.length} onClick={() => put(NONE)}>Clear</button>
            </div>
            <p className="views__note text-muted">View only: runs, results, charts and downloads use the whole model.</p>
            {refused.why && <Alert title="Not applied">{refused.why}</Alert>}
            <div className="menu__section">Add a plane</div>
            <button className="menu__item" type="button" disabled={planes.length >= MAX} title="Level with the point the view orbits; keeps what lies below" onClick={() => put({ planes: [...planes, { point: target(), normal: [0, 0, -1] }] }, { plane: planes.length })}><span>Horizontal</span></button>
            <button className="menu__item" type="button" disabled={planes.length >= MAX} title="Through the point the view orbits, square to the view; keeps what lies beyond it" onClick={() => put({ planes: [...planes, { point: target(), normal: facing() }] }, { plane: planes.length })}><span>Facing the view</span></button>
            <div className="menu__section">Add a box</div>
            <button className="menu__item" type="button" disabled={boxes.length >= MAX} title="Round the selected prims (the whole model when none is), a little larger; shows what is inside" onClick={around}><span>{usd.selection.length ? 'Around the selection' : 'Around the model'}</span></button>
            <Fragment key={refused.n}>
              {planes.map((p, i) => (
                <Fragment key={`p${i}`}>
                  <div className="menu__separator" />
                  {head('plane', i, [
                    ['Edit', 'Move it along its normal with the arrow in the view', () => edit({ plane: i })],
                    ['Tilt', 'Tilt it with the rings in the view', () => edit({ plane: i, rotate: true })],
                    ['Flip', 'Keep the other side', () => put({ planes: planes.with(i, { ...p, normal: p.normal.map((v) => -v + 0) as Vec3 }) })],
                  ])}
                  <div className="stack chart-menu">
                    <Coords id={`section-p${i}-point`} legend="Point (m)" value={p.point} onCommit={(v) => put({ planes: planes.with(i, { ...p, point: v as Vec3 }) })} />
                    <Coords id={`section-p${i}-normal`} legend="Normal, towards the side kept" value={p.normal} onCommit={(v) => put({ planes: planes.with(i, { ...p, normal: v as Vec3 }) })} />
                  </div>
                </Fragment>
              ))}
              {boxes.map((b, i) => {
                const set = (patch: Partial<Section['boxes'][number]>) => put({ boxes: boxes.with(i, { ...b, ...patch }) });
                return (
                  <Fragment key={`b${i}`}>
                    <div className="menu__separator" />
                    {head('box', i, [
                      ['Edit', 'Move the whole box with the arrows in the view; click a dot to move a corner (in plan) or a face (up and down) alone', () => edit({ box: i })],
                      ['Rotate', 'Turn it about the vertical with the ring in the view', () => edit({ box: i, rotate: true })],
                    ])}
                    <div className="stack chart-menu">
                      <Segmented name={`section-b${i}-keep`} label={`Box ${i + 1}`} value={b.keep} options={[['inside', 'Show inside'], ['outside', 'Cut out']] as const} onChange={(keep) => set({ keep })} />
                      <div className="scale-row__cols">
                        <NumberField id={`section-b${i}-bottom`} label="Bottom (m)" value={b.bottom} onCommit={(v) => { if (Number.isFinite(v) && v !== b.bottom) set({ bottom: v }); }} />
                        <NumberField id={`section-b${i}-top`} label="Top (m)" value={b.top} onCommit={(v) => { if (Number.isFinite(v) && v !== b.top) set({ top: v }); }} />
                      </div>
                      {b.footprint.map((corner, c) => <Coords key={c} id={`section-b${i}-c${c}`} legend={`Corner ${c + 1} (m)`} value={corner} onCommit={(v) => set({ footprint: b.footprint.with(c, v as [number, number]) as Section['boxes'][number]['footprint'] })} />)}
                    </div>
                  </Fragment>
                );
              })}
            </Fragment>
          </>
        );
      }}
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
          <p className="views__note text-muted">Sections are view only and not exported.</p>
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

/**
 * The stored reports (the last changed first): the one picked, whether it can be generated now or what to restore first
 * (`app`: the app as a report sees it), its last error (`error`: a change or delete of one, else its last generation's),
 * Delete, Open PDF and Generate PDF. A generation shows the same whether it started here or not. `onOpen`: on every open.
 */
export function ReportsMenu({ reports, app, error, onOpen, onGenerate, onDelete }: {
  reports: Stored[]; app: AppView; error: { id?: string; title: string; message: string } | null; onOpen: () => void; onGenerate: (id: string) => void; onDelete: (id: string) => void;
}) {
  const [pick, setPick] = useState<string | null>(null);
  useEffect(() => { if (error?.id) setPick(error.id); }, [error]); // a failed change: its report
  const list = [...reports].sort((a, b) => b.spec.updated.localeCompare(a.spec.updated)), r = list.find((x) => x.id === pick) ?? list[0];
  const { generating, lastError } = generation(r.id), no = [...new Set(readiness(r.spec, app).map(inApp))], failed = error ?? (lastError ? { title: 'PDF not generated', message: inApp(lastError) } : null);
  useEffect(() => { // the popover's own toggle: MenuButton keeps its element
    const m = document.getElementById('reports-menu'), on = (e: Event) => { if ((e as ToggleEvent).newState === 'open') onOpen(); };
    m?.addEventListener('toggle', on);
    return () => m?.removeEventListener('toggle', on);
  }, [onOpen]);
  return (
    // an icon: the run bar keeps its rows (one at 1440 px with one model), as without reports
    <MenuButton id="reports-menu" label="Reports" icon="report" busy={reports.some((x) => generation(x.id).generating)} title="Reports: a report's PDF, generated from the current results; open it, or delete the report">
      {() => (
        <>
          <div className="views__format">
            <select className="select" aria-label="Report" value={r.id} onChange={(e) => setPick(e.target.value)}>
              {list.map((x) => <option key={x.id} value={x.id}>{x.spec.title}</option>)}
            </select>
          </div>
          <div className="views__note text-muted" role="status">
            {generating ? <><span className="spinner" aria-hidden="true" /> Generating the PDF</> : no.length ? no.map((p) => <p key={p}>{p[0].toUpperCase() + p.slice(1)}</p>) : 'Ready'}
          </div>
          {failed && <Alert title={failed.title}>{failed.message}</Alert>}
          <div className="menu__footer views__download">
            <button className="btn btn--danger" type="button" disabled={generating} onClick={() => { if (confirm(`Delete the report "${r.spec.title}" and its PDF? This cannot be undone.`)) onDelete(r.id); }}>Delete</button>
            <div className="cluster">
              <button className="btn btn--secondary" type="button" disabled={!r.pdf} title={r.pdf ? undefined : 'Generate it first'} onClick={() => window.open(`/reports/${r.id}/pdf`)}>Open PDF</button>
              <button className="btn btn--primary" type="button" disabled={generating || no.length > 0} aria-busy={generating} onClick={() => onGenerate(r.id)}>Generate PDF</button>
            </div>
          </div>
        </>
      )}
    </MenuButton>
  );
}
