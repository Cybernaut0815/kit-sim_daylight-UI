// The display tools, as the app bar, the Display, Section and Views menus and the Results panel offer them: what the views
// show (set_display), the camera (set_camera, save_view) and shots of any size (screenshot). A shot shows a look of its
// own (staged), put back after it; report figures (report/generate.ts) take shots the same way.
import { flushSync } from 'react-dom';
import { Matrix4, Vector3, type InstancedMesh, type Mesh, type Object3D } from 'three';
import type { UsdViewerElement, ViewState } from 'usd-viewer';
import { boxToWorld, cornersOf, describeView, frameView, meanNormal, viewDir, type Box, type Points, type Vec3 } from '../../lib/frame';
import { fmtNum, roundNum, unitFor } from '../../lib/result';
import { NONE, describe, given, toStage, type Bounds, type Section } from '../../lib/section';
import { idsUnder } from '../../lib/tree';
import { stageView } from '../../lib/views';
import { columnOf } from '../../sets/combine';
import type { Model, Tab } from '../../store';
import { labelScenes, selectionFill } from '../../viewer/Viewer';
import { boundsOf, type Display, type Sky } from '../../viewer/Views';
import { capture, type Shot } from '../../viewer/capture';
import { labelsOf } from '../../viewer/labels';
import { exclusive, type CallToolResult } from '../bridge';
import { SECTION, check } from '../schema';
import { LETTERS, b64, letter, loadedOf, loadedSlots, modelOf, nameOf, ok, runCall, tabOf, type Args, type Ctl, type FieldPreview, type Handler, type PerSlot } from './common';

// ---------------------------------------------------------------------------------------------- the display in words
/** A model's prims as the active model's per-slot entry: absent (none: the whole model) when `paths` is empty. */
const withSlot = (all: PerSlot, slot: number, paths: readonly string[]): PerSlot => { const { [slot]: _was, ...rest } = all; return paths.length ? { ...rest, [slot]: paths } : rest; };
/** The display as app_state gives it and set_display takes it back: the tab (its analysis; on the Combined tab the view
 *  shown), the active model, the column and colouring, the look and the section; sunAround and the field preview's
 *  receivers are the active model's. */
export const display = (x: Ctl) => {
  const t = tabOf(x, x.ui.tab), slot = x.state.active;
  return {
    analysis: x.ui.tab, ...(x.ui.tab === 'combined' ? { id: x.combined.view?.id ?? null } : {}), active: letter(slot), column: t.shown, colourBy: t.colourBy,
    labels: x.ui.labels, labelScale: x.ui.labelScale, labelSpacing: x.ui.labelSpacing, labelLayout: x.ui.labelLayout, labelShow: x.ui.labelShow, labelBox: x.ui.labelBox, labelColour: x.ui.labelColour,
    display: x.ui.display, sky: x.ui.sky, highlight: x.state.bins.length ? x.state.bins : null,
    sunPath: x.ui.sunPath, sunScale: x.sunScale, sunAround: x.sunAround[slot] ?? null,
    fieldPreview: { show: x.field.shown, scale: x.field.scale, density: x.field.density, around: x.field.around[slot] ?? null },
    theme: x.theme, split: x.ui.split, link: x.ui.link, auto: x.ui.auto, section: x.section,
  };
};
/** highlight's ranges as the store keeps the selected bars: each [lo, hi] with lo < hi, in order, overlaps merged. */
function binsOf(h: readonly (readonly [number, number])[] | null): [number, number][] {
  const out: [number, number][] = [];
  for (const [i, [lo, hi]] of (h ?? []).entries()) if (!(lo < hi)) throw new Error(`highlight[${i}]: [lo, hi] with lo < hi`);
  for (const [lo, hi] of [...(h ?? [])].sort((p, q) => p[0] - q[0])) {
    const last = out[out.length - 1];
    if (last && lo <= last[1]) last[1] = Math.max(last[1], hi);
    else out.push([lo, hi]);
  }
  return out;
}
/** The mesh paths at or under `paths` in model `slot` (`receivers`: its View analysis receivers only), as the Time and
 *  View settings panels keep a fit to the selection; null or []: none (the whole model, every receiver). */
function meshPaths(x: Ctl, slot: number, paths: readonly string[] | null, field: string, receivers = false): string[] {
  if (!paths?.length) return [];
  const m = loadedOf(x, letter(slot), field), rows = receivers ? m.viewAnalysis.objects.filter((o) => o.role === 'receiver') : m.objects;
  const ids = new Set(idsUnder(paths, rows)), out = rows.filter((o) => ids.has(o.id)).map((o) => o.path);
  if (!out.length) throw new Error(`${field}: no ${receivers ? 'View analysis receiver' : 'mesh'} at or under ${paths.join(', ')} in model ${letter(slot)}; find prims with model_tree`);
  return out;
}
/** sunAround (null: leave it) as the per-slot fits, for the models `slots`. */
function aroundArg(x: Ctl, slots: readonly number[], paths: readonly string[] | null | undefined): PerSlot | undefined {
  if (paths === undefined) return undefined;
  return slots.reduce((all, k) => withSlot(all, k, meshPaths(x, k, paths, 'sunAround')), x.sunAround);
}
/** fieldPreview (its schema checked) as the field preview's patch, its receivers those of models `slots`. */
function fieldArg(x: Ctl, slots: readonly number[], f: Args | undefined): Partial<FieldPreview> | undefined {
  if (!f) return undefined;
  return {
    ...(f.show !== undefined ? { shown: f.show } : {}), ...(f.scale !== undefined ? { scale: f.scale } : {}), ...(f.density ? { density: f.density } : {}),
    ...(f.around !== undefined ? { around: slots.reduce((all, k) => withSlot(all, k, meshPaths(x, k, f.around, 'fieldPreview.around', true)), x.field.around) } : {}),
  };
}

/** Section boxes round prims: the bounds (model metres) of what is drawn at or under them in model `l` (default the
 *  active one). */
export const boundsIn = (x: Ctl, l?: string): Bounds => (paths, at) => {
  const m = loadedOf(x, l, at), { el } = x.viewer(m.slot), objs = paths.map((p) => el.three.objectsFor(p).filter((o) => o.visible)), k = objs.findIndex((o) => !o.length); // hidden: H, the eye, set_visibility
  if (k >= 0) return `${at}[${k}]: nothing drawn at or under ${paths[k]} in model ${letter(m.slot)}, the active one; find prims with model_tree`;
  return boundsOf(objs.flat(), el.stage?.metersPerUnit ?? 1) ?? `${at}: what is drawn there has no extent`;
};
/** set_display's and screenshot's section `v` (checked against set_display's schema) as the app keeps it, boxes round
 *  prims of model `l` (default the active one); a problem throws, naming its path. */
function sectionArg(x: Ctl, v: Args, l?: string): Section {
  const why = check(SECTION, v, 'section');
  if (why) throw new Error(why);
  const s = given(v, 'section', boundsIn(x, l));
  if (Array.isArray(s)) throw new Error(s.join('; '));
  return s;
}

// ---------------------------------------------------------------------------------------------- cameras
/** A view's eye-to-target distance, m. */
const reach = (v: ViewState, mpu: number) => Math.hypot(...v.eye.map((e, k) => e - v.target[k])) * mpu;
/** A model's camera as set_camera answers it: exact (copy it into view arguments), in words, and its distance in m. */
function viewOf(x: Ctl, slot: number) {
  const { el } = x.viewer(slot), v = el.view, mpu = el.stage?.metersPerUnit ?? 1;
  return { model: letter(slot), view: v, description: describeView(v, x.state.settings.sim.north, mpu), distance: roundNum(reach(v, mpu)) };
}
/** A model coordinate as quoted, m. */
export const cm = (v: number) => Math.round(100 * v) / 100;
/** A view's width / height on screen (16:10 while it has no size). */
const aspectOf = (x: Ctl, slot: number) => { const d = x.viewer(slot).el.three.renderer.domElement; return d.clientWidth > 0 && d.clientHeight > 0 ? d.clientWidth / d.clientHeight : 1.6; };
/** direction, elevation, aspect and projection shape a frame only. */
function frameOnly(a: Args) {
  const k = ['direction', 'elevation', 'aspect', 'projection'].find((f) => a[f] !== undefined);
  if (k && !a.frame) throw new Error(`${k}: goes with frame (frame {} = the whole model)`);
}
/** Drawn objects' vertices in world, an instancer's per copy: a frame fits these, not their axis-aligned boxes.
 *  ponytail: every vertex of every copy, twice per frame; per-copy boxes if a big instancer makes framing slow */
function drawnPoints(objs: readonly Object3D[]): Points {
  for (const o of objs) o.updateWorldMatrix(true, true); // a hidden tab draws no frame that would
  const v = new Vector3(), w = new Matrix4();
  return (f) => {
    for (const root of objs) root.traverse((o) => {
      const p = (o as Mesh).geometry?.getAttribute('position'), im = (o as InstancedMesh).isInstancedMesh ? (o as InstancedMesh) : null;
      for (let k = 0; p && k < (im ? im.count : 1); k++) {
        if (im) im.getMatrixAt(k, w).premultiply(o.matrixWorld);
        else w.copy(o.matrixWorld);
        for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i).applyMatrix4(w); f(v.x, v.y, v.z); }
      }
    });
  };
}
/**
 * set_camera's and screenshot's frame: the drawn meshes at or under frame.paths (every mesh without), or frame.box (model
 * metres), fitted to `aspect` from a.direction at a.elevation (viewDir's defaults when not given) in the view's lens (or
 * a.projection). auto faces frame.normal, else the framed meshes (their backs for a back column).
 */
function framed(x: Ctl, m: Model, a: Args, aspect: number, back: boolean): { view: ViewState; cut: number } {
  const { el } = x.viewer(m.slot), f = a.frame as { paths?: string[]; box?: Box; normal?: Vec3 };
  if (f.paths && f.box) throw new Error('frame: give paths or box, not both');
  let pts: Points, normal = f.normal;
  if (f.box) pts = cornersOf(boxToWorld(f.box, el.stage?.metersPerUnit ?? 1));
  else {
    const ids = new Set(f.paths ? idsUnder(f.paths, m.objects) : m.objects.map((o) => o.id));
    const objs = [...ids].flatMap((id) => x.panes[m.slot]?.meshes.get(id) ?? []);
    if (!objs.length) throw new Error(`frame.paths: no meshes at or under ${f.paths?.join(', ')} in model ${letter(m.slot)}; find prims with model_tree`);
    pts = drawnPoints(objs);
    if ((a.direction ?? 'auto') === 'auto') normal ??= meanNormal((function* () { for (const o of m.objects) if (ids.has(o.id) && !o.instances) { const g = x.meshOf(o.id); if (g) yield g; } })()).map((v) => (back ? -v : v)) as Vec3;
  }
  try {
    return frameView(pts, viewDir(a.direction ?? 'auto', x.state.settings.sim.north, normal, a.elevation), { fov: el.view.fov, aspect, projection: a.projection ?? el.view.projection });
  } catch (e) {
    throw new Error(`frame.${(e as Error).message}`); // 'box: no extent; ...'
  }
}

// ---------------------------------------------------------------------------------------------- shots
const LONG = 1568, MAX_B64 = 800e3; // an image the agent gets: px on its long side; base64 characters per reply
/** A screenshot as the agent gets it: at most 8 MP asked; sent with the long side at most 1568 px, the aspect kept
 *  unless the short side would fall under 16 px (`reshaped`: it is 16 px then). */
export function shotSize(width: number, height: number): { width: number; height: number; reshaped: boolean } {
  if (width * height > 8e6) throw new Error(`width: ${width} x ${height} px is over 8 megapixels; ask for a smaller width or height`);
  const k = Math.min(1, LONG / Math.max(width, height)), w = Math.round(k * width), h = Math.round(k * height);
  return { width: Math.max(16, w), height: Math.max(16, h), reshaped: Math.min(w, h) < 16 };
}
/** One MessageChannel task (not throttled in a hidden tab, unlike timers). */
const tick = () => new Promise<void>((r) => { const ch = new MessageChannel(); ch.port1.onmessage = () => { ch.port1.close(); r(); }; ch.port2.postMessage(null); });
/** Waits until each of `els` shows its sky behind the stage: the viewer loads the HDRI after the sky is set, and a shot
 *  before that would show the plain background. */
async function skyIn(els: readonly UsdViewerElement[], sky: Sky): Promise<void> {
  for (const end = performance.now() + 15e3; els.some((el) => !el.three.scene.background);) {
    if (performance.now() > end) throw new Error(`sky: the ${sky} sky did not load within 15 s`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** How the views look for shots: the tab (its analysis' results and colours; left out: the one shown), the column by
 *  name, the colouring, the display mode, the sky, highlighted value ranges, the sun path and its fit, the field preview,
 *  the ground grid (the overlay frame() skips), a quantity's colour scale Min and Max (`pin`), no bin highlight and no
 *  selection fill (`clean`), a section of their own (model metres; null: none; left out: the user's). */
export interface Look {
  tab?: Tab; column?: string; colourBy?: 'plain' | 'value'; display?: Display; sky?: Sky; bins?: readonly [number, number][]; sunPath?: boolean; sunAround?: PerSlot; field?: Partial<FieldPreview>;
  grid?: boolean; pin?: { quantity: string; min: number; max: number }; clean?: boolean; section?: Section | null;
}
let staging = 0; // looks staged now
/** A look is staged for shots: App keeps it out of the stored settings and view preferences (the restore stores them). */
export const isStaging = () => staging > 0;
const shooting = new Set<UsdViewerElement>(); // the views showing a shot's own section
/** True while view `el` shows a shot's own section: App leaves its section alone then (the shot puts the app's back). */
export const inShot = (el: UsdViewerElement) => shooting.has(el);
/** fn with the views of `slots` showing `look` (each part only when given) and no pointer hover or probe (a bin highlight
 *  and the selection stay, unless clean); all of it put back after fn, also when it throws. */
export async function staged<T>(c: () => Ctl, slots: readonly number[], look: Look, fn: () => Promise<T>): Promise<T> {
  const x = c(), tab = look.tab ?? x.ui.tab, t = tabOf(x, tab), moved = tab !== x.ui.tab, bins = look.clean || moved || look.bins !== undefined;
  if (look.column !== undefined && tab === 'combined') {
    if (!x.combined.views.some((v) => columnOf(v) === look.column)) throw new Error(`id: ${look.column.replace(/^combined_/, '')} is not a combined view (${x.combined.views.map((v) => v.id).join(', ') || 'none saved; save_combined first'})`);
  } else if (look.column !== undefined) {
    const ref = t.models.find((m) => m.result)?.result;
    if (!ref?.columns.includes(look.column)) throw new Error(`column: ${look.column} is not in the first result's columns (${ref?.columns.join(', ') ?? 'no result'}), which the ${tab === 'views' ? 'View analysis' : 'Daylight'} tab shows; run again`);
  }
  const was = { column: t.column, colourBy: t.colourBy, display: x.ui.display, sky: x.ui.sky, sunPath: x.ui.sunPath, sunAround: x.sunAround, field: x.field, bin: x.state.bin, bins: x.state.bins, scale: look.pin && x.state.settings.viz.scales[look.pin.quantity], tab: x.ui.tab };
  const grids = look.grid === undefined ? [] : slots.flatMap((k) => x.viewer(k).el.three.overlay.children.filter((o) => o.userData.frame === false).map((o) => [o, o.visible] as const));
  const fill = look.clean && slots.length ? x.viewer(slots[0]).el : null; // the selection fill: one material for every view
  // the shot's section goes straight to its views, without the gizmo (a drag would edit the shot's); after it they get the
  // app's section as it is then (a Section menu edit meanwhile included) and their gizmo back
  const cuts = look.section === undefined ? [] : slots.map((k) => { const { el } = x.viewer(k); return { el, gizmo: el.sectionGizmo }; });
  staging++;
  try {
    flushSync(() => {
      x.dispatch({ type: 'HOVER', id: null });
      x.dispatch({ type: 'PROBE', probe: null }); // the pointer's, not the shot's
      if (moved) x.setUi((u) => ({ ...u, tab })); // the views show that tab's results and colours
      if (look.column !== undefined) t.dispatch({ type: 'COLUMN', column: look.column });
      if (look.colourBy) t.dispatch({ type: 'COLOUR_BY', colourBy: look.colourBy });
      if (look.display) x.setUi((u) => ({ ...u, display: look.display! }));
      if (look.sky) x.setUi((u) => ({ ...u, sky: look.sky! }));
      if (look.sunPath !== undefined) x.setUi((u) => ({ ...u, sunPath: look.sunPath! }));
      if (look.sunAround) x.setSunAround(look.sunAround);
      if (look.field) x.setField(look.field);
      if (look.pin) x.dispatch({ type: 'VIZ', quantity: look.pin.quantity, patch: { min: look.pin.min, max: look.pin.max } });
      if (bins) { x.dispatch({ type: 'BIN', bin: null }); x.dispatch({ type: 'BINS', bins: look.bins ?? [] }); } // a bin of another tab's column
    });
    if (fill) fill.highlight = { color: '#000000', opacity: 0 }; // after the commit: a colouring change sets it again
    for (const [o] of grids) o.visible = look.grid!;
    for (const { el } of cuts) {
      shooting.add(el);
      el.sectionGizmo = null;
      el.section = toStage(look.section ?? NONE, el.stage?.metersPerUnit ?? 1, el.stage?.upAxis ?? 'Y');
    }
    // one MessageChannel task lets Viewer.tsx's effects run (its usd.paint call); capture() then waits for the paint
    await tick();
    if (look.sky && look.sky !== 'none') await skyIn(slots.map((k) => x.viewer(k).el), look.sky);
    return await fn();
  } finally {
    staging--;
    for (const [o, v] of grids) o.visible = v;
    for (const { el, gizmo } of cuts) {
      shooting.delete(el);
      el.section = toStage(c().section, el.stage?.metersPerUnit ?? 1, el.stage?.upAxis ?? 'Y');
      if (gizmo && !el.sectionGizmo) el.sectionGizmo = gizmo;
    }
    flushSync(() => {
      const z = c(), back = tabOf(z, tab).dispatch;
      if (look.column !== undefined) back({ type: 'COLUMN', column: was.column });
      if (look.colourBy) back({ type: 'COLOUR_BY', colourBy: was.colourBy });
      if (look.display) z.setUi((u) => ({ ...u, display: was.display }));
      if (look.sky) z.setUi((u) => ({ ...u, sky: was.sky }));
      if (look.sunPath !== undefined) z.setUi((u) => ({ ...u, sunPath: was.sunPath }));
      if (look.sunAround) z.setSunAround(was.sunAround);
      if (look.field) z.setField(was.field);
      if (look.pin) z.dispatch({ type: 'VIZ', quantity: look.pin.quantity, patch: { min: was.scale?.min ?? null, max: was.scale?.max ?? null } });
      if (bins) { z.dispatch({ type: 'BIN', bin: was.bin }); z.dispatch({ type: 'BINS', bins: was.bins }); }
      if (moved) z.setUi((u) => ({ ...u, tab: was.tab }));
    });
    if (fill) { const z = c(), u = tabOf(z, z.ui.tab); fill.highlight = selectionFill(u.colourBy === 'value' && !!u.scale); }
  }
}

/** The tab a look names (analysis, or id for a combined view) checked: the column given exists in its results. */
function lookTab(x: Ctl, a: Args): Tab {
  const tab: Tab = a.analysis ?? (a.id !== undefined ? 'combined' : x.ui.tab), ref = tabOf(x, tab).models.find((m) => m.result)?.result;
  if (a.id !== undefined && tab !== 'combined') throw new Error("id: a combined view shows on the Combined tab; give analysis 'combined'");
  if (a.id !== undefined && !x.combined.views.some((v) => v.id === a.id)) throw new Error(`id: no combined view ${a.id} (${x.combined.views.map((v) => v.id).join(', ') || 'none saved; save_combined first'})`);
  if (a.column && tab === 'combined') throw new Error("column: the Combined tab shows a combined view's own column; give its id instead");
  if (a.column && !ref) throw new Error(`column: no ${nameOf(tab as 'daylight' | 'views')} result yet; ${runCall(tab as 'daylight' | 'views')} first`);
  if (a.column && !ref!.columns.includes(a.column)) throw new Error(`column: not in the ${nameOf(tab as 'daylight' | 'views')} result (${ref!.columns.join(', ')})`);
  return tab;
}

// ---------------------------------------------------------------------------------------------- the tools
export const DISPLAY_HANDLERS: Record<string, Handler> = {
  async set_display(a, c) {
    return exclusive(() => {
      const x = c(), tab = lookTab(x, a), t = tabOf(x, tab), slot = a.active ? modelOf(x, a.active, 'active').slot : x.state.active;
      const bins = a.highlight === undefined ? undefined : binsOf(a.highlight), around = aroundArg(x, [slot], a.sunAround), field = fieldArg(x, [slot], a.fieldPreview);
      const ui = Object.fromEntries(['sunPath', 'split', 'link', 'auto', 'labels', 'labelScale', 'labelSpacing', 'labelLayout', 'labelShow', 'labelBox', 'labelColour', 'display', 'sky']
        .filter((k) => a[k] !== undefined).map((k) => [k, a[k]]));
      const section = a.section && sectionArg(x, a.section, a.active); // a view's look: no run key holds it, results stay fresh
      flushSync(() => {
        if (tab !== x.ui.tab) { // as a tab clicked: the probe and the bin highlight belong to the old tab's column
          x.dispatch({ type: 'PROBE', probe: null }); x.dispatch({ type: 'BIN', bin: null }); x.dispatch({ type: 'BINS', bins: [] });
          x.setUi((u) => ({ ...u, tab }));
        }
        if (a.active) x.dispatch({ type: 'ACTIVE', slot: LETTERS.indexOf(a.active) });
        if (a.column) t.dispatch({ type: 'COLUMN', column: a.column });
        if (a.id !== undefined) t.dispatch({ type: 'COLUMN', column: columnOf({ id: a.id }) });
        if (a.colourBy) t.dispatch({ type: 'COLOUR_BY', colourBy: a.colourBy });
        if (bins) { x.dispatch({ type: 'BIN', bin: null }); x.dispatch({ type: 'BINS', bins }); }
        if (a.theme) x.setTheme(a.theme);
        if (a.sunScale !== undefined) x.setSunScale(a.sunScale);
        if (around) x.setSunAround(around);
        if (field) x.setField(field);
        if (Object.keys(ui).length) x.setUi((u) => ({ ...u, ...ui }));
        if (section) x.setSection(section);
      });
      return ok(display(c()));
    });
  },

  async set_camera(a, c) {
    return exclusive(() => {
      const x = c(), m = loadedOf(x, a.model), { el } = x.viewer(m.slot);
      if ([a.view, a.camera, a.frame].filter((v) => v !== undefined).length > 1) throw new Error('view: give one of view, camera or frame');
      frameOnly(a);
      let near: number | undefined; // a frame's cutaway, m
      if (a.frame) {
        const f = framed(x, m, a, a.aspect ?? aspectOf(x, m.slot), !!x.shown?.endsWith('_back'));
        el.view = f.view;
        near = roundNum(f.cut * (el.stage?.metersPerUnit ?? 1));
      } else if (a.view) el.view = a.view;
      else if (a.camera !== undefined) {
        const cam = el.cameras.find((k) => k.path === a.camera), saved = x.views.find((v) => v.name === a.camera);
        if (!cam && !saved) throw new Error(`camera: no stage camera or saved view '${a.camera}' (cameras: ${el.cameras.map((k) => k.path).join(', ') || 'none'}; saved views: ${x.views.map((v) => v.name).join(', ') || 'none'})`);
        el.view = cam ? stageView(el.three.root, cam) : saved!.view;
      } else el.frame(); // the whole model, as Views > Whole model
      // linked cameras follow per drawn frame, and a hidden tab draws none: every view takes it now
      if (x.ui.link) for (const k of loadedSlots(x)) if (k !== m.slot) x.viewer(k).el.view = el.view;
      return ok({ ...viewOf(x, m.slot), ...(near !== undefined ? { near } : {}) });
    });
  },

  async save_view(a, c) {
    return exclusive(() => {
      const x = c(), name = a.name.trim(), names = () => c().views.map((v) => v.name);
      if (!name) throw new Error('name: not blank');
      if (a.remove) {
        if (!x.views.some((v) => v.name === name)) throw new Error(`name: no saved view '${name}' (${names().join(', ') || 'none saved'})`);
        flushSync(() => x.setViews((l) => l.filter((v) => v.name !== name)));
        return ok({ removed: name, views: names() });
      }
      const m = loadedOf(x, a.model), view = x.viewer(m.slot).el.view; // a name taken: that view now shows this camera
      flushSync(() => x.setViews((l) => (l.some((v) => v.name === name) ? l.map((v) => (v.name === name ? { ...v, view } : v)) : [...l, { id: crypto.randomUUID(), name, view }])));
      return ok({ saved: { name, model: letter(m.slot), view }, views: names() });
    });
  },

  async screenshot(a, c) {
    const W: number = a.width ?? 1280, H: number = a.height ?? 800, size = shotSize(W, H);
    if (a.view && a.frame) throw new Error('view: give view or frame, not both');
    frameOnly(a);
    return exclusive(async () => {
      const x = c(), ms = ((a.models ?? [letter(x.state.active)]) as string[]).map((l, i) => loadedOf(x, l, a.models ? `models[${i}]` : 'models')), slots = ms.map((m) => m.slot);
      const tab = lookTab(x, a), section: Section | null | undefined = a.section && sectionArg(x, a.section);
      const words = describe(section === undefined ? x.section : section ?? NONE), labels: boolean = a.labels ?? x.ui.labels;
      // the shot's own look, restored after it
      const look: Look = {
        tab, column: a.id !== undefined ? columnOf({ id: a.id }) : a.column, colourBy: a.colourBy, display: a.display, sky: a.sky, sunPath: a.sunPath, grid: a.grid, section,
        bins: a.highlight === undefined ? undefined : binsOf(a.highlight), sunAround: aroundArg(x, slots, a.sunAround), field: fieldArg(x, slots, a.fieldPreview),
      };
      return staged(c, slots, look, async () => {
        const y = c(), u = tabOf(y, tab), sc = u.scale, north = y.state.settings.sim.north, out: CallToolResult['content'] = [];
        for (const m of ms) {
          const { el } = y.viewer(m.slot), mpu = el.stage?.metersPerUnit ?? 1, L = letter(m.slot), shown = u.models.find((k) => k.slot === m.slot);
          const fr = a.frame ? framed(y, m, a, size.width / size.height, !!u.shown?.endsWith('_back')) : null, view = a.view ?? fr?.view ?? el.view;
          const onSurfaces = labels ? (cam: Parameters<NonNullable<Shot['labels']>>[0]) => { const s = labelScenes.get(el)?.(cam, size.width, size.height); return s ? labelsOf(s) : []; } : undefined;
          const shot = await capture(el, { width: size.width, height: size.height, view, near: a.near === undefined ? undefined : a.near / mpu, type: 'image/jpeg', quality: 0.85, labels: onSurfaces, labelScale: y.ui.labelScale, labelBox: y.ui.labelBox, labelColour: y.ui.labelColour })
            .catch((e: Error) => { throw new Error(e.message.replace(/less than (\S+) here$/, (_, v: string) => `less than ${fmtNum(Number(v) * mpu)} m here`)); }); // near's limit: stage units -> m
          // the reply's base64 within budget: a lower JPEG quality first, then fewer pixels (from the first JPEG)
          let data = await b64(shot), q = 0.85, w = size.width, h = size.height;
          const bmp = data.length > MAX_B64 / ms.length ? await createImageBitmap(shot) : null;
          while (bmp && data.length > MAX_B64 / ms.length && w > 16 && h > 16) {
            if (q > 0.5) q -= 0.15;
            else [w, h] = [Math.max(16, Math.round(0.75 * w)), Math.max(16, Math.round(0.75 * h))];
            const cv = new OffscreenCanvas(w, h);
            cv.getContext('2d')!.drawImage(bmp, 0, 0, w, h);
            data = await b64(await cv.convertToBlob({ type: 'image/jpeg', quality: q }));
          }
          bmp?.close();
          const value = u.colourBy === 'value' && !!sc && !!u.shown && !!shown?.result?.columns.includes(u.shown), unit = u.shown ? unitFor(u.shown).value : '';
          const what = tab === 'combined' ? `the combined view ${y.combined.view?.name ?? u.shown}${unit ? ` in ${unit}` : ''}` : `${u.shown} in ${unit}`;
          const colours = !value ? `the model's own (plain view)${tab === 'combined' && shown && !shown.result ? `; the combined view has no result for it (${y.combined.notes.join('; ') || 'its inputs are running'})` : ''}`
            : `${what}, ${sc!.gradient.label} from ${fmtNum(sc!.vmin)} (low) to ${fmtNum(sc!.vmax)} (high)${sc!.lo !== null ? `; under ${fmtNum(sc!.lo)} ${sc!.below}` : ''}${sc!.hi !== null ? `; over ${fmtNum(sc!.hi)} ${sc!.above}` : ''}; meshes without a value plain grey${labels ? '; values written on the surfaces' : ''}`;
          out.push({ type: 'image', data, mimeType: 'image/jpeg' }, {
            type: 'text',
            text: `Model ${L} (${m.name}): ${w} x ${h} px${w !== W || h !== H ? ` (${W} x ${H} asked; images come at most ${LONG} px on the long side${size.reshaped ? ' and at least 16 px on the short one, so the aspect differs' : ''}${w !== size.width ? ', fewer to keep the reply under 800 KB' : ''})` : ''}, JPEG quality ${q.toFixed(2)}. Camera: ${describeView(view, north, mpu)}; ${fmtNum(reach(view, mpu))} m away${a.near !== undefined ? `; geometry nearer than ${fmtNum(a.near)} m cut away` : fr ? `; near ${roundNum(fr.cut * mpu)} would cut away what stands in front of the frame` : ''}. Colours: ${colours}. Section: ${words}.`,
          });
        }
        return { content: out };
      });
    });
  },
};
