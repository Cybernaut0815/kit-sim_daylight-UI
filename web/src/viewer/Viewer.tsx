// A 3D view, one per model. Its USD viewer (./usd.ts, the USD_WebViewer submodule) draws the stage and owns navigation
// and selection (kept in step with the store), and paints the result colours from the receivers' values; on top of it:
// the hover tint, the sun path and the ground grid in the viewer's overlay group, the probe readout, the scene info and, with
// several models, the model's name. Dragging the sun path's suns, handles, arcs and compass ring edits the time settings
// and north. A click or a key pressed in the view makes its model the active one (focus alone does not: Tab passes
// the views without changing the model the panels and the run bar act on). The viewer's section cuts the model, its
// result colours and the hover tint alike (never the sun path, the grid or the labels: diagrams, not the model), and its
// gizmo takes the pointer before the sun path.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import * as THREE from 'three';
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import type { UsdSessionEventMap, UsdViewerElement } from 'usd-viewer';
import { cssVar } from '../lib/cssVar';
import { paintOf, type Scale } from '../lib/gradients';
import { drawnValues } from '../lib/topology';
import { idsUnder } from '../lib/tree';
import type { Action, ObjectRow, RunResult, Tab } from '../store';
import { Alert, Illustration } from '../ui';
import { cancelLabels, elementOf, enqueue, sampler, type LabelScene } from './labels';
import { createSunPath, type Grab, type Ptr, type SunPath, type SunView } from './sunpath';
import type { Display } from './Views';

const solid = (name: string) => cssVar(name, '#000', '--bg-surface-2'); // opaque over the viewport background
/** The viewers' selection fill (one material for all of them): the accent, fainter over result colours. */
export const selectionFill = (byValue: boolean) => ({ color: `#${new THREE.Color(solid('--accent')).getHexString()}`, opacity: byValue ? 0.12 : 0.14 });
// Neutral tone mapping (the Plain view) lowers every colour by up to 0.04 (linear) before output; add it back so the grid
// keeps its token colours over the CSS background. Exact below Neutral's 0.76 shoulder, where every kit-ui hairline sits.
// ponytail: the sun path keeps its ~10/255 shift in the Plain view; untone its tokens too if it shows
const untone = (c: THREE.Color) => { const m = Math.min(c.r, c.g, c.b), off = m < 0.04 ? 0.4 * Math.sqrt(m) - m : 0.04; return c.setRGB(c.r + off, c.g + off, c.b + off); };
/** A view's hover tint, per view: a mesh has one parent, and each view's [meshes] cleanup resets it. A node material,
 *  made once (each new one compiles its shaders), so that the viewer can section it. */
function look() {
  // Over the viewer's selection fill (-2); it borrows the hovered object's geometry
  const TINT = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
  const EMPTY = new THREE.BufferGeometry();
  const tint = new THREE.Mesh(EMPTY, TINT); // never dispose its geometry: it is the viewer's
  tint.raycast = () => {}; // the viewer's pick walks its objects' children
  return { TINT, EMPTY, tint };
}
/** Lets the renderer forget a mesh: it keeps a render object (holding the geometry) per mesh until the mesh fires 'dispose'. */
const release = (m: THREE.Mesh) => (m as unknown as THREE.EventDispatcher<{ dispose: object }>).dispatchEvent({ type: 'dispose' });
/** The most vertices a painted mesh gets the hover tint for: the viewer's paint freed its own GPU copy, which the tint
 *  uploads again while it shows. */
const TINT_PAINTED = 65_536;

interface Props {
  usd: UsdViewerElement; slot: number; // this view's viewer (./usd.ts) and its model's slot
  meshes: ReadonlyMap<string, THREE.Object3D>; // row id -> the viewer's object for it
  stage: number; // bumped per opened model: framed then (a variant switch keeps the camera)
  follow: UsdViewerElement | null; // linked cameras: a view that shows a model, whose camera a new model takes instead of its own framing
  loading: boolean; error?: string | null; objects: ObjectRow[]; selected: Set<string>; hovered: string | null; // error: shown here (several models)
  colourBy: 'plain' | 'value'; result: RunResult | null; column: number; scale: Scale | null; bin: [number, number] | null;
  bins?: readonly [number, number][]; // the selected histogram bars' value ranges: kept bright with the hovered one
  probeLabel: string | null; theme: string; dispatch: Dispatch<Action>; children?: ReactNode; // children: the model's name chip (several models)
  sun: SunView | null; // the sun path to draw (null: hidden)
  around?: readonly string[] | null; // the prim paths of the meshes the sun path is fitted to (null: the whole model)
  section: string | null; // the section shown, in words (null: none)
  analysis?: Tab; // whose roles `objects` carry (the scene info's words)
  display: Display; // the viewer's display mode (the Display menu), with results or without
  labels?: boolean; // value labels on the painted receivers (the Display menu's "Values on the surfaces")
}

/** Per view, its label scene for a camera and size while it paints values (the agent's screenshots: labels.ts labelsOf). */
export const labelScenes = new WeakMap<UsdViewerElement, (camera: THREE.Camera, width: number, height: number) => LabelScene | null>();

interface Ctx {
  canvas: HTMLCanvasElement; sun: SunPath; gridSpec: { size: number; x: number; y: number; z: number };
  grid: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>; // one object and material for good, a new geometry per size or theme
  dome: { x: number; y: number; z: number; r: number }; // the sun path, fitted to the model: centre on the ground, radius
}

/** The scene info at the top right of the view: meshes by role, drawn triangles and vertices, units, the section, and the frame
 *  line. */
function SceneInfo({ objects, unit, section, stats, analysis }: { objects: ObjectRow[]; unit: number; section: string | null; stats: RefObject<HTMLSpanElement | null>; analysis?: Tab }) {
  const n = (role: ObjectRow['role']) => objects.reduce((k, o) => k + (o.role === role ? 1 : 0), 0), f = (x: number) => x.toLocaleString('en-GB');
  const ignored = n('none'), targets = objects.reduce((k, o) => k + (o.role === 'shade' && o.group ? 1 : 0), 0);
  return (
    <div className="viewport__info" aria-hidden="true">
      {analysis === 'combined'
        ? <span>{f(objects.length)} meshes, {f(n('receiver'))} in the combined view</span>
        : <span>{f(objects.length)} meshes, {f(n('receiver'))} receiving, {analysis === 'views' ? `${f(n('shade') - targets)} blocking, ${f(targets)} targets` : `${f(n('shade'))} shading`}{ignored ? `, ${f(ignored)} ignored` : ''}</span>}
      <span>{f(objects.reduce((k, o) => k + o.tris, 0))} triangles, {f(objects.reduce((k, o) => k + o.verts, 0))} vertices{unit !== 1 ? `, 1 unit = ${unit} m` : ''}</span>
      {section && <span>Section: {section}</span>}
      <span ref={stats} />
    </div>
  );
}

export function Viewer({ usd, slot, meshes, stage, follow, loading, error, objects, selected, hovered, colourBy, result, column, scale, bin, bins, probeLabel, theme, dispatch, children, sun, around, section, analysis, display, labels = false }: Props) {
  const [{ TINT, EMPTY, tint }] = useState(look);
  // cut with the model from the first section on; registered per mount, as a dispose lets go of it (StrictMode runs
  // this twice)
  useEffect(() => {
    usd.three.section(TINT);
    return () => TINT.dispose();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- the view's own material, for its life
  const host = useRef<HTMLDivElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const at = useRef({ x: 0, y: 0 }); // the cursor in the canvas, where the floating readout sits
  /** JS owns the readout's position: right of the cursor, or left of it where the view would cut it. */
  const place = () => {
    const t = tip.current, { x, y } = at.current, w = t?.offsetWidth ?? 0;
    if (t) t.style.transform = `translate(${x + 14 + w > usd.three.renderer.domElement.clientWidth ? Math.max(x - 14 - w, 0) : x + 14}px, ${y + 14}px)`;
  };
  useLayoutEffect(place, [probeLabel]); // eslint-disable-line react-hooks/exhaustive-deps -- its width is known once its text is in
  const labelsEl = useRef<HTMLDivElement>(null);
  const stats = useRef<HTMLSpanElement>(null); // the frame line of the scene info, written per frame
  const ctx = useRef<Ctx | null>(null);
  const [ready, setReady] = useState(false); // the core is up: until then the viewer shows its own status
  const byObject = useMemo(() => new Map([...meshes].map(([id, o]) => [o, id])), [meshes]);
  // receiver id -> its index in the result's receivers (manifest.meshes order): the probe, the paint and the tint look
  // up one id each, not a scan of 14k receivers per mesh
  const recv = useMemo(() => new Map(result?.receivers.map((id, k) => [id, k])), [result]);
  const latest = useRef({ result, column, sun, objects, meshes, byObject, recv }); // read by the handlers, which are bound once
  latest.current = { result, column, sun, objects, meshes, byObject, recv };
  const byValue = result && scale && colourBy === 'value' ? result : null;
  const hasModel = meshes.size > 0, site = sun?.site ?? null, shown = !!sun && hasModel;

  useEffect(() => { usd.ready.then(() => setReady(true), () => {}); }, [usd]); // a failed start: the viewer shows why

  useEffect(() => {
    const el = host.current!, canvas = usd.three.renderer.domElement;
    el.prepend(usd); // first child: the labels, readout, empty state and run bar come later and paint over the viewer's positioned <main>
    const labels = new CSS2DRenderer({ element: labelsEl.current! });
    const sunPath = createSunPath();
    usd.three.overlay.add(sunPath.group);
    const grid = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ vertexColors: true, toneMapped: false }));
    grid.userData.frame = false; // F and frame() fit the model and the dome, not the floor (the clip planes still see it)
    grid.visible = false;
    usd.three.overlay.add(grid);
    const c: Ctx = { canvas, sun: sunPath, grid, gridSpec: { size: 20, x: 0, y: 0, z: 0 }, dome: { x: 0, y: 0, z: 0, r: 10 } };
    ctx.current = c;

    // Every frame, with that frame's camera: the sun-path labels (the sun path only, never the stage), and the scene
    // info's frame line: frames in the last second, the frame's CPU time and draw calls, at most twice a second.
    let lw = 0, lh = 0, times: number[] = [], written = 0, idle = 0;
    const stat = (text: string) => { if (stats.current) stats.current.textContent = text; };
    const onFrame = () => {
      const t0 = performance.now();
      if (canvas.clientWidth !== lw || canvas.clientHeight !== lh) labels.setSize((lw = canvas.clientWidth), (lh = canvas.clientHeight));
      labels.render(sunPath.group as unknown as THREE.Scene, usd.three.camera); // ponytail: typed Scene, takes any Object3D
      queueMicrotask(() => { // after the viewer's renderer.render, in the same task
        const now = performance.now(), ms = (now - t0).toFixed(1), calls = usd.three.renderer.info.render.drawCalls;
        times.push(now);
        while (times[0] <= now - 1000) times.shift();
        if (now - written >= 500) { written = now; stat(`${times.length} fps, ${ms} ms per frame, ${calls} draw calls`); }
        clearTimeout(idle);
        idle = window.setTimeout(() => { times = []; stat(`idle, last frame ${ms} ms, ${calls} draw calls`); }, 1100);
      });
    };
    usd.three.beforeRender.add(onFrame);

    // The viewer's selection is the app's (the view, the hierarchy, the results table through usd.select): the store
    // mirrors its prims and the rows at or under them.
    const onSel = (e: Event) => {
      const { paths, source, active } = (e as UsdSessionEventMap['selectionchange']).detail;
      dispatch({ type: 'SELECTION', slot, paths: [...paths], active, source });
    };
    usd.addEventListener('selectionchange', onSel);

    // Hover and probe: pointermove raycasts the rows' objects (not their children: the overlays) once per frame; the
    // element is the face the hit triangle belongs to, or the point at the nearest corner of that triangle (the
    // receiver's own faces and points: lib/topology.ts). What the section cuts away is passed through.
    // ponytail: linear raycast over every mesh; three-mesh-bvh past ~1M triangles
    const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), p = new THREE.Vector3();
    const hitAt = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, usd.three.camera); // read again: the viewer swaps cameras
      return ray.intersectObjects([...latest.current.meshes.values()].filter((o) => o.visible), false).find((h) => usd.three.keeps(h.point)) ?? null; // hidden: H or the eye
    };
    const pick = (e: PointerEvent) => {
      const hit = hitAt(e), r = canvas.getBoundingClientRect();
      const id = hit && latest.current.byObject.get(hit.object);
      if (!hit || !id) return null;
      const { result, column, recv } = latest.current, k = recv.get(id) ?? -1;
      const element = result && k >= 0 ? elementOf(result, k, hit, p) : null;
      const value = element === null ? NaN : result!.data[column][result!.manifest.meshes[k].first + element];
      return { id, element, value, x: e.clientX - r.left, y: e.clientY - r.top };
    };
    let raf = 0;
    const onMove = (e: PointerEvent) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const h = pick(e);
        dispatch({ type: 'HOVER', id: h?.id ?? null });
        dispatch({ type: 'PROBE', probe: h && h.element !== null ? { id: h.id, element: h.element, value: h.value } : null });
        if (h) { at.current = { x: h.x, y: h.y }; place(); }
      });
    };
    const onLeave = () => { cancelAnimationFrame(raf); dispatch({ type: 'HOVER', id: null }); dispatch({ type: 'PROBE', probe: null }); };
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerleave', onLeave);

    // Sun path drags: capture listeners on the viewport run before the viewer's own (its selection tool and orbit, on
    // the canvas inside its shadow root). A grab stops the event there, so a drag never orbits, selects or probes. Over
    // the section gizmo's handles, and while one is dragged, the sun path lets the viewer have the pointer.
    let grab: Grab | null = null;
    const ours = (e: PointerEvent) => e.composedPath()[0] === canvas; // events from the shadow canvas are retargeted to <usd-viewer>
    const ptr = (e: PointerEvent): Ptr => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, h: r.height }; };
    // The compass ring yields to the model standing in front of it (a click there still selects); geometry lying on the
    // ground under the ring (a site plane) does not hide it.
    const offModel = (e: PointerEvent) => () => { const h = hitAt(e); return !h || h.point.y < c.dome.y + 0.01 * c.dome.r; };
    const onGrab = (e: PointerEvent) => {
      const v = latest.current.sun;
      if (!ours(e) || e.button !== 0 || !v || !latest.current.meshes.size || usd.sectionGizmoAt(e.clientX, e.clientY)) return; // the run bar lives in the viewport too
      if (sunPath.hover(ptr(e), usd.three.camera, offModel(e)).changed) usd.three.invalidate(); // a press with no hover before it (touch, pen) gets the look too
      grab = sunPath.grab(ptr(e), usd.three.camera, v, offModel(e));
      if (!grab) return;
      e.stopPropagation();
      canvas.setPointerCapture(e.pointerId);
      usd.classList.add('viewport__grabbing');
      cancelAnimationFrame(raf);
      usd.three.invalidate();
    };
    const onDrag = (e: PointerEvent) => {
      const v = latest.current.sun;
      if (grab) {
        e.stopPropagation();
        const d = v && sunPath.drag(grab, ptr(e), usd.three.camera, v);
        if (d?.time) dispatch({ type: 'TIME', patch: d.time }); // the same fields the Time and Location panels write: their controls follow
        if (d?.north !== undefined) dispatch({ type: 'SIM', patch: { north: d.north } });
        return;
      }
      if (!ours(e) || !v || !latest.current.meshes.size) return;
      const { over, changed } = sunPath.hover(usd.sectionGizmoAt(e.clientX, e.clientY) ? null : ptr(e), usd.three.camera, offModel(e));
      usd.classList.toggle('viewport__grab', over);
      if (changed) usd.three.invalidate();
    };
    const onDrop = (e: PointerEvent) => {
      if (!grab) return;
      e.stopPropagation();
      grab = null;
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
      usd.classList.remove('viewport__grabbing');
      const { over, changed } = sunPath.hover(e.type === 'pointerup' ? ptr(e) : null, usd.three.camera, offModel(e)); // the look of what is under the pointer now
      usd.classList.toggle('viewport__grab', over);
      if (changed) usd.three.invalidate();
    };
    const onOut = () => { usd.classList.remove('viewport__grab'); if (!grab && sunPath.hover(null, usd.three.camera).changed) usd.three.invalidate(); };
    el.addEventListener('pointerdown', onGrab, true);
    el.addEventListener('pointermove', onDrag, true);
    el.addEventListener('pointerup', onDrop, true);
    el.addEventListener('pointercancel', onDrop, true);
    canvas.addEventListener('pointerleave', onOut);
    // The element outlives this effect (StrictMode runs it twice, Fast Refresh on edits): undo every addition.
    return () => {
      clearTimeout(idle);
      cancelAnimationFrame(raf);
      usd.three.beforeRender.delete(onFrame);
      usd.removeEventListener('selectionchange', onSel);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
      el.removeEventListener('pointerdown', onGrab, true);
      el.removeEventListener('pointermove', onDrag, true);
      el.removeEventListener('pointerup', onDrop, true);
      el.removeEventListener('pointercancel', onDrop, true);
      canvas.removeEventListener('pointerleave', onOut);
      usd.three.overlay.remove(sunPath.group, grid);
      sunPath.dispose();
      grid.geometry.dispose();
      grid.material.dispose();
      labelsEl.current?.replaceChildren();
      usd.three.invalidate();
      ctx.current = null;
    };
  }, [dispatch, usd, slot]);

  // A new model: the sun path's dome and the grid fit every mesh, whatever its role. The dome alone fits the meshes
  // at the `around` paths instead, when given (the Time panel's "Around selection"): it stands on their lowest point
  // and encloses them; paths that are gone (a variant switched) leave the whole model.
  useEffect(() => {
    const c = ctx.current;
    if (!c || !meshes.size) return;
    const box = new THREE.Box3(), part = new THREE.Box3(), want = new Set(around);
    for (const o of meshes.values()) box.expandByObject(o); // an InstancedMesh by the bounds of its instances
    for (const o of objects) { const m = want.has(o.path) && meshes.get(o.id); if (m) part.expandByObject(m); }
    const domeOf = (b: THREE.Box3) => { const s = b.getSize(new THREE.Vector3()), at = b.getCenter(new THREE.Vector3()); return { x: at.x, y: b.min.y, z: at.z, r: Math.hypot(s.x / 2, s.y, s.z / 2) || 1 }; };
    const size = box.getSize(new THREE.Vector3()), whole = domeOf(box); // the dome stands on the ground and encloses the model
    c.dome = part.isEmpty() ? whole : domeOf(part);
    c.gridSpec = { size: 2 * Math.max(size.x, size.y, size.z, 2.3 * whole.r), x: whole.x, y: whole.y, z: whole.z };
  }, [meshes, around]); // eslint-disable-line react-hooks/exhaustive-deps -- the rows' paths change with the meshes

  // Sun path: the scaffold follows the site and the theme, the frame the model, north and size, the active layer the time.
  useEffect(() => {
    const c = ctx.current;
    if (!c) return;
    c.sun.group.visible = shown;
    if (shown && site) c.sun.build(site);
    usd.three.invalidate();
  }, [site, theme, shown]);
  useEffect(() => {
    const c = ctx.current;
    if (!c) return;
    c.sun.frame(c.dome.x, c.dome.y, c.dome.z, c.dome.r * (sun?.scale ?? 1), sun?.north ?? 0); // placed while hidden too
    usd.three.invalidate();
  }, [meshes, around, sun?.north, sun?.scale]); // eslint-disable-line react-hooks/exhaustive-deps -- only the fit, north and size move the frame
  useEffect(() => {
    const c = ctx.current;
    if (!c || !sun || !hasModel) return;
    c.sun.show(sun.site, sun.time);
    usd.three.invalidate();
  }, [meshes, sun?.site, sun?.time, theme, shown]); // eslint-disable-line react-hooks/exhaustive-deps -- not north or size

  // A new model, once the sun path is placed: next to a linked view, that view's camera; else the model and the dome in
  // view (the grid opts out of framing: it is a floor).
  useEffect(() => {
    if (!meshes.size) return;
    if (follow) usd.view = follow.view;
    else usd.frame();
  }, [stage]); // eslint-disable-line react-hooks/exhaustive-deps -- per model, not per variant

  // The ground grid under the model, in the theme's hairline colours: a new geometry on the one grid object (a new
  // material would compile its shaders again).
  useEffect(() => {
    const c = ctx.current;
    if (!c) return;
    const col = (name: string) => { const k = new THREE.Color(solid(name)); return byValue ? k : untone(k); };
    const { size, x, y, z } = c.gridSpec, helper = new THREE.GridHelper(size, 20, col('--border-default'), col('--border-subtle'));
    helper.material.dispose(); // never drawn: only its geometry is used
    c.grid.geometry.dispose();
    c.grid.geometry = helper.geometry;
    c.grid.position.set(x, y, z);
    c.grid.visible = true;
    usd.three.invalidate();
  }, [meshes, theme, !!byValue]); // eslint-disable-line react-hooks/exhaustive-deps -- the view, not the result

  // The look: the stage in the display mode of the Display menu, results shown or not (the painted receivers draw their
  // colours alone in every mode); tone mapping off in the Value view (exact legend colours; the stage's materials draw
  // untoned there); the selection fill in the accent colour, fainter over results.
  useEffect(() => {
    usd.displayMode = display;
    usd.toneMapping = byValue ? 'none' : 'neutral';
    usd.highlight = selectionFill(!!byValue);
  }, [!!byValue, theme, display]); // eslint-disable-line react-hooks/exhaustive-deps -- the view, not the result

  // Paint: the viewer draws the receivers from their values, the colours from the scale and the hovered bin as a style
  // of uniforms (set first: the paint's first frame has it). The same receivers and column again (a new scale, range or
  // bin) only restyle. A receiver's rows are its own faces or points (lib/topology.ts): a face's value goes to each of
  // its drawn triangles, a point's to the drawn corners that name it (so two parts meeting at one drawn vertex keep
  // their own values). A receiver sent as drawn has a row per triangle or vertex: views into the column, no copies.
  // A scaling or moved stops (lib/gradients paintOf): the values go through its map on the way, and are painted again
  // when the map changes (its key); a linear scale with even stops stays uniforms only.
  const paint = useMemo(() => (scale ? paintOf(scale) : null), [scale]);
  useEffect(() => {
    if (paint) usd.paintStyle = paint.style(bin || bins?.length ? [...(bins ?? []), ...(bin ? [bin] : [])] : null); // the selected bars and the hovered one
  }, [paint, bin, bins]); // eslint-disable-line react-hooks/exhaustive-deps -- the view's viewer, for its life
  useEffect(() => {
    const items: { rid: number; values: Float32Array }[] = [];
    const perVertex = byValue?.on === 'vertices', corners = perVertex && !!byValue.forms?.some(Boolean); // one mode per paint
    const map = paint?.map ?? undefined;
    if (byValue && scale) {
      const role = new Map(objects.map((o) => [o.id, o.role])), col = byValue.data[column];
      for (const [id, obj] of meshes) {
        const k = role.get(id) === 'receiver' ? recv.get(id) ?? -1 : -1;
        if (k < 0) continue;
        const g = byValue.manifest.meshes[k], rows = col.subarray(g.first, g.first + g.count), index = (obj as THREE.Mesh).geometry?.index?.array;
        items.push({ rid: obj.userData.rid as number, values: perVertex && !(corners && index) ? (map ? rows.map(map) : rows) : drawnValues(rows, byValue.forms?.[k] ?? null, byValue.on, index ?? [], map) });
      }
    }
    void usd.paint(items, !perVertex ? 'face' : corners ? 'corner' : 'vertex'); // the viewer warns about what it skips (its log)
  }, [meshes, objects, byValue, recv, column, !!scale, paint?.key]); // eslint-disable-line react-hooks/exhaustive-deps -- a new scale restyles above, a new map paints again

  // Value labels (labels.ts): the label scene for this view's camera and size while it paints values (the agent's shots
  // take it whatever the toggle); with the toggle on, the layer hides while the camera moves (one write per move) and
  // fills in idle slices 200 ms after it rests, again on a new result, column, section, rows or meshes.
  const valuesEl = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const layer = valuesEl.current!, owner = layer;
    const role = new Map(objects.map((o) => [o.id, o.role]));
    const sceneOf = (camera: THREE.Camera, width: number, height: number): LabelScene | null => (!byValue ? null : {
      camera, width, height, meshes: [...meshes.values()].filter((o) => o.visible), result: byValue, column, keeps: (q) => usd.three.keeps(q),
      receiverOf: (o) => { const id = byObject.get(o); return id && role.get(id) === 'receiver' ? recv.get(id) ?? -1 : -1; },
    });
    labelScenes.set(usd, sceneOf);
    layer.replaceChildren();
    if (!labels || !byValue) return () => { cancelLabels(owner); labelScenes.delete(usd); };
    const last = new Float64Array(32);
    const moved = () => {
      const c = usd.three.camera, a = c.matrixWorld.elements, b = c.projectionMatrix.elements;
      let changed = false;
      for (let i = 0; i < 16; i++) {
        if (last[i] !== a[i]) { last[i] = a[i]; changed = true; }
        if (last[16 + i] !== b[i]) { last[16 + i] = b[i]; changed = true; }
      }
      return changed;
    };
    const start = () => {
      const canvas = usd.three.renderer.domElement, s = canvas.clientWidth && canvas.clientHeight ? sceneOf(usd.three.camera, canvas.clientWidth, canvas.clientHeight) : null;
      if (!s) return;
      const sm = sampler(s);
      let drawn = 0;
      layer.replaceChildren();
      layer.hidden = false;
      enqueue(owner, (until) => {
        const done = sm.step(until);
        for (; drawn < sm.labels.length; drawn++) {
          const l = sm.labels[drawn], d = document.createElement('div');
          d.className = 'tooltip';
          d.textContent = l.text;
          d.style.transform = `translate(${l.x}px, ${l.y}px) translate(-50%, -50%)`; // JS owns a tooltip's place
          layer.append(d);
        }
        return done;
      });
    };
    let timer = 0;
    const onFrame = () => {
      if (!moved()) return;
      if (!layer.hidden) layer.hidden = true;
      cancelLabels(owner);
      clearTimeout(timer);
      timer = window.setTimeout(start, 200);
    };
    moved();
    usd.three.beforeRender.add(onFrame);
    timer = window.setTimeout(start, 200);
    return () => { clearTimeout(timer); cancelLabels(owner); usd.three.beforeRender.delete(onFrame); labelScenes.delete(usd); layer.replaceChildren(); };
  }, [labels, byValue, column, objects, meshes, byObject, recv, section, usd]);

  // Hover: a light accent tint over the mesh, fainter over results.
  useEffect(() => {
    const o = hovered ? meshes.get(hovered) : undefined;
    if (!o || (o as THREE.InstancedMesh).isInstancedMesh) return; // ponytail: no tint on instanced shades (a child draws once, not per instance)
    const g = (o as THREE.Mesh).geometry, painted = !!byValue && recv.has(hovered!);
    if (painted && g.attributes.position.count > TINT_PAINTED) return; // ponytail: none on big painted meshes; the paint's own pieces if that is missed
    tint.geometry = g;
    TINT.color.set(solid('--accent'));
    TINT.opacity = painted ? 0.1 : 0.22;
    o.add(tint);
    usd.three.invalidate();
    // a painted mesh's GPU copy goes again with the tint (the viewer's paint freed it; its arrays stay for picks)
    return () => { tint.removeFromParent(); if (painted) g.dispose(); usd.three.invalidate(); };
  }, [hovered, meshes, byValue, recv, theme]);
  // A new model: the tint lets go of the last one's geometry (the renderer would hold it until the next hover).
  useEffect(() => () => { tint.geometry = EMPTY; release(tint); }, [meshes]);

  // The store's selection (tree, results table, All / None) shown by the viewer, unless it already covers exactly these rows.
  useEffect(() => {
    const have = idsUnder(usd.selection, objects);
    if (have.length === selected.size && have.every((id) => selected.has(id))) return;
    // ponytail: the viewer fills at most 2000 prims
    usd.select(objects.filter((o) => selected.has(o.id)).flatMap((o) => o.paths ?? [o.path])); // every copy of a natively instanced row
  }, [selected, objects]);

  // A click or a key anywhere in the view (not pointerdown: a value typed in the Materials table commits on blur, which
  // comes first, to the model it was typed for); Tab and a lone modifier only pass through (Shift+Tab presses Shift here).
  const activate = () => dispatch({ type: 'ACTIVE', slot });
  const onKey = (e: KeyboardEvent) => { if (!/^(Tab|Shift|Control|Alt|Meta)$/.test(e.key)) activate(); };
  return (
    <div ref={host} className="viewport" onClick={activate} onKeyDown={onKey}>
      <div ref={labelsEl} className="viewport__labels" aria-hidden="true" />
      <div ref={valuesEl} className="viewport__values" data-density="compact" aria-hidden="true" />
      <div ref={tip} className="readout readout--float" hidden={!probeLabel} aria-hidden="true">{probeLabel}</div>
      {children && (
        <div className="viewport__name">
          {children}
          {error && hasModel && <span className="badge badge--warning" title={error}><span className="dot" />Problems</span>}
        </div>
      )}
      {hasModel && <SceneInfo objects={objects} unit={usd.stage?.metersPerUnit ?? 1} section={section} stats={stats} analysis={analysis} />}
      {ready && !hasModel && !loading && (error
        ? <div className="empty-state"><Alert title="Problems loading the model">{error}</Alert></div>
        : (
          <div className="empty-state">
            <div className="empty-state__icon"><Illustration kind="model" /></div>
            <h3>Open a model</h3>
            <p>Pick a .usd, .usda, .usdc, .usdz, .glb, .gltf or .obj in the Model panel. Click a mesh to select it; Shift adds, Ctrl removes, Shift+drag selects a box.</p>
          </div>
        ))}
    </div>
  );
}
