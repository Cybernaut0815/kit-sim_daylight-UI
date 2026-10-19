// The 3D view. The USD viewer (./usd.ts, the USD_WebViewer submodule) draws the stage and owns navigation and selection
// (kept in step with the store); on top of it: the result colours as overlays on the receivers, the hover tint, the
// sun path and the ground grid in the viewer's overlay group, the probe readout and the scene info. Dragging the sun
// path's suns, handles, arcs and compass ring edits the time settings and north.
import { useEffect, useMemo, useRef, useState, type Dispatch, type ReactNode, type RefObject } from 'react';
import * as THREE from 'three';
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { applyToThree } from 'daylight-mesh';
import type { UsdSessionEventMap } from 'usd-viewer';
import { cssVar } from '../lib/cssVar';
import { lin, rgbFor, type Scale } from '../lib/gradients';
import { idsUnder } from '../lib/tree';
import type { Action, ObjectRow, RunResult } from '../store';
import { Illustration } from '../ui';
import { createSunPath, type Grab, type Ptr, type SunPath, type SunView } from './sunpath';
import { usd } from './usd';

const solid = (name: string) => cssVar(name, '#000', '--bg-surface-2'); // opaque over the viewport background
// Neutral tone mapping (the Plain view) lowers every colour by up to 0.04 (linear) before output; add it back so the grid
// keeps its token colours over the CSS background. Exact below Neutral's 0.76 shoulder, where every zha hairline sits.
// ponytail: the sun path keeps its ~10/255 shift in the Plain view; untone its tokens too if it shows
const untone = (c: THREE.Color) => { const m = Math.min(c.r, c.g, c.b), off = m < 0.04 ? 0.4 * Math.sqrt(m) - m : 0.04; return c.setRGB(c.r + off, c.g + off, c.b + off); };
// Result colours: unlit, so with tone mapping off (the Value view) they are exactly the legend's
const PAINT = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
// The hover tint, over the paint (-1) and the viewer's selection fill (-2); it borrows the hovered object's geometry
const TINT = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
const EMPTY = new THREE.BufferGeometry();
const tint = new THREE.Mesh(EMPTY, TINT); // never dispose its geometry: it is the viewer's
tint.raycast = () => {}; // the viewer's pick walks its objects' children
/** Lets the renderer forget a mesh: it keeps a render object (holding the geometry) per mesh until the mesh fires 'dispose'. */
const release = (m: THREE.Mesh) => (m as unknown as THREE.EventDispatcher<{ dispose: object }>).dispatchEvent({ type: 'dispose' });
const drop = (m: THREE.Mesh) => { m.removeFromParent(); m.geometry.dispose(); release(m); }; // a result overlay, for good

interface Props {
  meshes: ReadonlyMap<string, THREE.Object3D>; // row id -> the viewer's object for it
  stage: number; // bumped per opened model: framed then (a variant switch keeps the camera)
  loading: boolean; objects: ObjectRow[]; selected: Set<string>; hovered: string | null;
  colourBy: 'plain' | 'value'; result: RunResult | null; column: number; scale: Scale | null; bin: [number, number] | null;
  probeLabel: string | null; theme: string; dispatch: Dispatch<Action>; children?: ReactNode; // children: the run bar under the model
  sun: SunView | null; // the sun path to draw (null: hidden)
}

interface Ctx {
  canvas: HTMLCanvasElement; sun: SunPath; gridSpec: { size: number; x: number; y: number; z: number };
  dome: { x: number; y: number; z: number; r: number }; // the sun path, fitted to the model: centre on the ground, radius
}

/** The scene info at the top right of the view: meshes by role, faces and vertices, units, and the frame line. */
function SceneInfo({ objects, stats }: { objects: ObjectRow[]; stats: RefObject<HTMLSpanElement | null> }) {
  const n = (role: ObjectRow['role']) => objects.reduce((k, o) => k + (o.role === role ? 1 : 0), 0), f = (x: number) => x.toLocaleString('en-GB');
  const ignored = n('none'), unit = usd.stage?.metersPerUnit ?? 1;
  return (
    <div className="viewport__info" aria-hidden="true">
      <span>{f(objects.length)} meshes, {f(n('receiver'))} receiving, {f(n('shade'))} shading{ignored ? `, ${f(ignored)} ignored` : ''}</span>
      <span>{f(objects.reduce((k, o) => k + o.tris, 0))} faces, {f(objects.reduce((k, o) => k + o.verts, 0))} vertices{unit !== 1 ? `, 1 unit = ${unit} m` : ''}</span>
      <span ref={stats} />
    </div>
  );
}

export function Viewer({ meshes, stage, loading, objects, selected, hovered, colourBy, result, column, scale, bin, probeLabel, theme, dispatch, children, sun }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const labelsEl = useRef<HTMLDivElement>(null);
  const stats = useRef<HTMLSpanElement>(null); // the frame line of the scene info, written per frame
  const ctx = useRef<Ctx | null>(null);
  const paint = useRef(new Map<string, THREE.Mesh>()); // receiver id -> its result overlay, a child of the viewer's object
  const [ready, setReady] = useState(false); // the core is up: until then the viewer shows its own status
  const byObject = useMemo(() => new Map([...meshes].map(([id, o]) => [o, id])), [meshes]);
  const latest = useRef({ result, column, sun, objects, meshes, byObject }); // read by the handlers, which are bound once
  latest.current = { result, column, sun, objects, meshes, byObject };
  const byValue = result && scale && colourBy === 'value' ? result : null;
  const hasModel = meshes.size > 0, site = sun?.site ?? null, shown = !!sun && hasModel;

  useEffect(() => { usd.ready.then(() => setReady(true), () => {}); }, []); // a failed start: the viewer shows why

  useEffect(() => {
    const el = host.current!, canvas = usd.three.renderer.domElement;
    el.prepend(usd); // first child: the labels, readout, empty state and run bar come later and paint over the viewer's positioned <main>
    const labels = new CSS2DRenderer({ element: labelsEl.current! });
    const sunPath = createSunPath();
    usd.three.overlay.add(sunPath.group);
    const c: Ctx = { canvas, sun: sunPath, gridSpec: { size: 20, x: 0, y: 0, z: 0 }, dome: { x: 0, y: 0, z: 0, r: 10 } };
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
      dispatch({ type: 'SELECTION', paths: [...paths], active, source });
    };
    usd.addEventListener('selectionchange', onSel);

    // Hover and probe: pointermove raycasts the rows' objects (not their children: the overlays) once per frame; the
    // element is the face, or the nearest vertex of the hit face.
    // ponytail: linear raycast over every mesh; three-mesh-bvh past ~1M triangles
    const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), p = new THREE.Vector3();
    const hitAt = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, usd.three.camera); // read again: the viewer swaps cameras
      return ray.intersectObjects([...latest.current.meshes.values()].filter((o) => o.visible), false)[0] ?? null; // hidden: H or the eye
    };
    const pick = (e: PointerEvent) => {
      const hit = hitAt(e), r = canvas.getBoundingClientRect();
      const id = hit && latest.current.byObject.get(hit.object);
      if (!hit || !id) return null;
      const { result, column } = latest.current;
      let element: number | null = null, value = NaN;
      const k = result?.receivers.indexOf(id) ?? -1;
      if (result && k >= 0 && hit.faceIndex != null) {
        if (result.on === 'faces') element = hit.faceIndex;
        else if (hit.face) { // per-vertex results keep the geometry indexed, so the face corners are the row indices
          const mesh = hit.object as THREE.Mesh, pos = mesh.geometry.attributes.position;
          let best = Infinity;
          for (const vi of [hit.face.a, hit.face.b, hit.face.c]) {
            const d = p.fromBufferAttribute(pos, vi).applyMatrix4(mesh.matrixWorld).distanceToSquared(hit.point);
            if (d < best) { best = d; element = vi; }
          }
        }
        const g = result.manifest.meshes[k];
        if (element !== null && element < g.count) value = result.values[g.first + element][column]; else element = null;
      }
      return { id, element, value, x: e.clientX - r.left, y: e.clientY - r.top };
    };
    let raf = 0;
    const onMove = (e: PointerEvent) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const h = pick(e);
        dispatch({ type: 'HOVER', id: h?.id ?? null });
        dispatch({ type: 'PROBE', probe: h && h.element !== null ? { id: h.id, element: h.element, value: h.value } : null });
        if (tip.current && h) tip.current.style.transform = `translate(${h.x + 14}px, ${h.y + 14}px)`; // JS owns the readout's position
      });
    };
    const onLeave = () => { cancelAnimationFrame(raf); dispatch({ type: 'HOVER', id: null }); dispatch({ type: 'PROBE', probe: null }); };
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerleave', onLeave);

    // Sun path drags: capture listeners on the viewport run before the viewer's own (its selection tool and orbit, on
    // the canvas inside its shadow root). A grab stops the event there, so a drag never orbits, selects or probes.
    let grab: Grab | null = null;
    const ours = (e: PointerEvent) => e.composedPath()[0] === canvas; // events from the shadow canvas are retargeted to <usd-viewer>
    const ptr = (e: PointerEvent): Ptr => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, h: r.height }; };
    // The compass ring yields to the model standing in front of it (a click there still selects); geometry lying on the
    // ground under the ring (a site plane) does not hide it.
    const offModel = (e: PointerEvent) => () => { const h = hitAt(e); return !h || h.point.y < c.dome.y + 0.01 * c.dome.r; };
    const onGrab = (e: PointerEvent) => {
      const v = latest.current.sun;
      if (!ours(e) || e.button !== 0 || !v || !latest.current.meshes.size) return; // the run bar lives in the viewport too
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
      const { over, changed } = sunPath.hover(ptr(e), usd.three.camera, offModel(e));
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
      usd.three.overlay.remove(sunPath.group);
      sunPath.dispose();
      labelsEl.current?.replaceChildren();
      usd.three.invalidate();
      ctx.current = null;
    };
  }, [dispatch]);

  // A new model: the sun path's dome and the grid fit every mesh, whatever its role.
  useEffect(() => {
    const c = ctx.current;
    if (!c || !meshes.size) return;
    const box = new THREE.Box3();
    for (const o of meshes.values()) box.expandByObject(o); // an InstancedMesh by the bounds of its instances
    const size = box.getSize(new THREE.Vector3()), centre = box.getCenter(new THREE.Vector3());
    const r0 = Math.hypot(size.x / 2, size.y, size.z / 2) || 1; // the dome stands on the ground and encloses the model
    c.dome = { x: centre.x, y: box.min.y, z: centre.z, r: r0 };
    c.gridSpec = { size: 2 * Math.max(size.x, size.y, size.z, 2.3 * r0), x: centre.x, y: box.min.y, z: centre.z };
  }, [meshes]);

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
  }, [meshes, sun?.north, sun?.scale]); // eslint-disable-line react-hooks/exhaustive-deps -- only north and size move the frame
  useEffect(() => {
    const c = ctx.current;
    if (!c || !sun || !hasModel) return;
    c.sun.show(sun.site, sun.time);
    usd.three.invalidate();
  }, [meshes, sun?.site, sun?.time, theme, shown]); // eslint-disable-line react-hooks/exhaustive-deps -- not north or size

  // The model and the dome in view, once the sun path is placed (the grid opts out of framing: it is a floor).
  useEffect(() => { if (meshes.size) usd.frame(); }, [stage]); // eslint-disable-line react-hooks/exhaustive-deps -- per model, not per variant

  // The ground grid under the model, in the theme's hairline colours.
  useEffect(() => {
    const c = ctx.current;
    if (!c) return;
    const col = (name: string) => { const k = new THREE.Color(solid(name)); return byValue ? k : untone(k); };
    const { size, x, y, z } = c.gridSpec, grid = new THREE.GridHelper(size, 20, col('--border-default'), col('--border-subtle'));
    grid.position.set(x, y, z);
    grid.userData.frame = false; // F and frame() fit the model and the dome, not the floor (the clip planes still see it)
    usd.three.overlay.add(grid);
    usd.three.invalidate();
    return () => { usd.three.overlay.remove(grid); grid.dispose(); };
  }, [meshes, theme, !!byValue]); // eslint-disable-line react-hooks/exhaustive-deps -- the view, not the result

  // The look: the stage's materials in the Plain view; plain grey with tone mapping off (exact legend colours) in the
  // Value view; the selection fill in the accent colour, fainter over results.
  useEffect(() => {
    usd.displayMode = byValue ? 'plain' : 'shaded';
    usd.toneMapping = byValue ? 'none' : 'neutral';
    usd.highlight = { color: `#${new THREE.Color(solid('--accent')).getHexString()}`, opacity: byValue ? 0.12 : 0.14 };
  }, [!!byValue, theme]); // eslint-disable-line react-hooks/exhaustive-deps -- the view, not the result

  // Paint: each receiver gets a result overlay (its geometry copied, coloured per element, a child of the viewer's
  // object); a scale, range or bin change repaints in place.
  useEffect(() => {
    let stale = false;
    (async () => {
      const keep = new Set<string>();
      for (const [id, obj] of meshes) {
        const k = byValue && objects.find((o) => o.id === id)?.role === 'receiver' ? byValue.receivers.indexOf(id) : -1;
        if (!byValue || !scale || k < 0) continue;
        keep.add(id);
        const g = byValue.manifest.meshes[k], vals = new Float64Array(g.count), perFace = byValue.on === 'faces';
        for (let i = 0; i < g.count; i++) vals[i] = byValue.values[g.first + i][column];
        const rgb = rgbFor(scale, vals, bin).map(lin);
        const m = paint.current.get(id), attr = m?.geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
        if (attr && attr.count === (perFace ? 3 * g.count : g.count)) { // repaint in place
          const arr = attr.array as Float32Array;
          if (perFace) for (let i = 0; i < arr.length; i++) arr[i] = rgb[3 * Math.floor(i / 9) + (i % 3)];
          else arr.set(rgb);
          attr.needsUpdate = true;
          continue;
        }
        if (m) { drop(m); paint.current.delete(id); }
        const next = new THREE.Mesh((obj as THREE.Mesh).geometry.clone(), PAINT); // a copy: the viewer's geometry gets no colour stream
        next.raycast = () => {}; // the viewer's pick walks its objects' children
        await applyToThree(next, vals, { material: false, rgb }); // per face: non-indexed, one colour per triangle
        if (stale) { next.geometry.dispose(); return; }
        obj.add(next); // follows the object and leaves with it when the stage closes
        paint.current.set(id, next);
      }
      for (const [id, m] of paint.current) if (!keep.has(id)) { drop(m); paint.current.delete(id); }
      usd.three.invalidate();
    })();
    return () => { stale = true; };
  }, [meshes, objects, byValue, column, scale, bin]);

  // Hover: a light accent tint over the mesh, fainter over results.
  useEffect(() => {
    const o = hovered ? meshes.get(hovered) : undefined;
    if (!o || (o as THREE.InstancedMesh).isInstancedMesh) return; // ponytail: no tint on instanced shades (a child draws once, not per instance)
    tint.geometry = (o as THREE.Mesh).geometry;
    TINT.color.set(solid('--accent'));
    TINT.opacity = byValue?.receivers.includes(hovered!) ? 0.1 : 0.22; // from the props: the paint lands asynchronously
    o.add(tint);
    usd.three.invalidate();
    return () => { tint.removeFromParent(); usd.three.invalidate(); };
  }, [hovered, meshes, byValue, theme]);
  // A new model: the tint lets go of the last one's geometry (the renderer would hold it until the next hover).
  useEffect(() => () => { tint.geometry = EMPTY; release(tint); }, [meshes]);

  // The store's selection (tree, results table, All / None) shown by the viewer, unless it already covers exactly these rows.
  useEffect(() => {
    const have = idsUnder(usd.selection, objects);
    if (have.length === selected.size && have.every((id) => selected.has(id))) return;
    // ponytail: the viewer fills at most 2000 prims
    usd.select(objects.filter((o) => selected.has(o.id)).flatMap((o) => o.paths ?? [o.path])); // every copy of a natively instanced row
  }, [selected, objects]);

  return (
    <div ref={host} className="viewport">
      <div ref={labelsEl} className="viewport__labels" aria-hidden="true" />
      <div ref={tip} className="readout readout--float" hidden={!probeLabel} aria-hidden="true">{probeLabel}</div>
      {hasModel && <SceneInfo objects={objects} stats={stats} />}
      {ready && !hasModel && !loading && (
        <div className="empty-state">
          <div className="empty-state__icon"><Illustration kind="model" /></div>
          <h3>Open a model</h3>
          <p>Pick a .usd, .usda, .usdc, .usdz, .glb, .gltf or .obj in the Model panel. Click a mesh to select it; Shift adds, Ctrl removes, Shift+drag selects a box.</p>
        </div>
      )}
      {children && <div className="viewport__bar">{children}</div>}
    </div>
  );
}
