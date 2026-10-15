// three.js viewport: render on demand, orbit, grid, pick / hover by raycast, materials painted from zha tokens or,
// with results, from the result gradient and the problem range; the cursor's element is probed and read out. The sun
// path is drawn around the model; dragging its suns, handles and arcs edits the time settings.
import { useEffect, useRef, type Dispatch, type ReactNode } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { applyToThree } from 'daylight-mesh';
import { cssVar } from '../lib/cssVar';
import { rgbFor, type Scale } from '../lib/gradients';
import { listMeshes } from '../lib/loaders';
import type { Action, ObjectRow, RunResult } from '../store';
import { Illustration } from '../ui';
import { createSunPath, type Grab, type Ptr, type SunPath, type SunView } from './sunpath';

const solid = (name: string) => cssVar(name, '#000', '--bg-surface-2'); // opaque over the viewport background: three.js drops alpha
const GREY = 0xb4b4b4; // every unpainted mesh: a neutral, opaque, lit grey (a scene material colour, not UI chrome)

interface Props {
  group: THREE.Group | null; loading: boolean; objects: ObjectRow[]; selected: Set<string>; hovered: string | null;
  colourBy: 'plain' | 'value'; result: RunResult | null; column: number; scale: Scale | null; bin: [number, number] | null;
  probeLabel: string | null; theme: string; dispatch: Dispatch<Action>; children?: ReactNode; // children: the run bar under the model
  sun: SunView | null; // the sun path to draw (null: hidden)
}

interface Ctx {
  renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera; controls: OrbitControls;
  model: THREE.Group | null; meshes: THREE.Mesh[]; gridSpec: { size: number; x: number; y: number; z: number };
  sun: SunPath; dome: { x: number; y: number; z: number; r: number }; // the sun path, fitted to the model: centre on the ground, radius
  render: () => void;
}

export function Viewer({ group, loading, objects, selected, hovered, colourBy, result, column, scale, bin, probeLabel, theme, dispatch, children, sun }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const labelsEl = useRef<HTMLDivElement>(null);
  const ctx = useRef<Ctx | null>(null);
  const latest = useRef({ result, column, sun }); // read by the pointer handlers, which are bound once
  latest.current = { result, column, sun };

  useEffect(() => {
    const el = host.current!;
    const renderer = new THREE.WebGLRenderer({ canvas: canvas.current!, antialias: true, alpha: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setClearColor(0x000000, 0); // transparent: the .viewport token background shows through in both themes
    renderer.localClippingEnabled = true; // the sun path is cut at the horizon
    const labels = new CSS2DRenderer({ element: labelsEl.current! });
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
    camera.position.set(8, 6, 8);
    const controls = new OrbitControls(camera, renderer.domElement);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x666666, 2)); // white light, not a palette colour
    const sun = new THREE.DirectionalLight(0xffffff, 2);
    sun.position.set(5, 10, 7);
    scene.add(sun);
    const sunPath = createSunPath();
    scene.add(sunPath.group);
    let queued = false;
    const render = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; renderer.render(scene, camera); labels.render(scene, camera); });
    };
    controls.addEventListener('change', render);
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth, h = el.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      labels.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      render();
    });
    ro.observe(el);
    const c: Ctx = { renderer, scene, camera, controls, model: null, meshes: [], gridSpec: { size: 20, x: 0, y: 0, z: 0 }, sun: sunPath, dome: { x: 0, y: 0, z: 0, r: 10 }, render };
    ctx.current = c;

    // Picking: pointerup within 4 px of pointerdown selects (shift / ctrl toggles); pointermove hovers and probes the
    // element under the cursor (the face, or the nearest vertex of the hit face), one raycast per frame.
    // ponytail: linear raycast over every mesh; three-mesh-bvh past ~1M triangles
    const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), p = new THREE.Vector3();
    const pick = (e: PointerEvent) => {
      const r = renderer.domElement.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      const hit = ray.intersectObjects(c.meshes, false)[0];
      if (!hit) return null;
      const mesh = hit.object as THREE.Mesh, id = mesh.userData.id as string, { result, column } = latest.current;
      let element: number | null = null, value = NaN;
      const k = result?.receivers.indexOf(id) ?? -1;
      if (result && k >= 0 && hit.faceIndex !== undefined) {
        if (result.on === 'faces') element = hit.faceIndex;
        else if (hit.face) { // per-vertex results keep the geometry indexed, so the face corners are the row indices
          const pos = mesh.geometry.attributes.position;
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
    let down: [number, number] | null = null, raf = 0;
    const dom = renderer.domElement;
    const onDown = (e: PointerEvent) => { down = [e.clientX, e.clientY]; };
    const onUp = (e: PointerEvent) => {
      if (down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) < 4) {
        const id = pick(e)?.id ?? null;
        dispatch({ type: 'SELECT', ids: id ? [id] : [], additive: e.shiftKey || e.ctrlKey });
      }
      down = null;
    };
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
    dom.addEventListener('pointerdown', onDown);
    dom.addEventListener('pointerup', onUp);
    dom.addEventListener('pointermove', onMove);
    dom.addEventListener('pointerleave', onLeave);

    // Sun path drags: capture listeners on the viewport run before OrbitControls and the handlers above (all on the
    // canvas). A grab stops the event there, so a drag never orbits, selects or probes.
    let grab: Grab | null = null;
    const ptr = (e: PointerEvent): Ptr => { const r = dom.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, h: r.height }; };
    const onGrab = (e: PointerEvent) => {
      const v = latest.current.sun;
      if (e.target !== dom || e.button !== 0 || !v || !c.model) return; // the run bar lives in the viewport too
      grab = sunPath.grab(ptr(e), camera, v);
      if (!grab) return;
      e.stopPropagation();
      dom.setPointerCapture(e.pointerId); // on the canvas: the cursor follows the capture target; the capture listeners above still run first
      dom.classList.add('viewport__grabbing');
      cancelAnimationFrame(raf);
      render();
    };
    const onDrag = (e: PointerEvent) => {
      const v = latest.current.sun;
      if (grab) {
        e.stopPropagation();
        const patch = v && sunPath.drag(grab, ptr(e), camera, v);
        if (patch) dispatch({ type: 'TIME', patch }); // the same fields the Time panel writes: its controls follow
        return;
      }
      if (e.target !== dom || !v || !c.model) return;
      const { over, changed } = sunPath.hover(ptr(e), camera);
      dom.classList.toggle('viewport__grab', over);
      if (changed) render();
    };
    const onDrop = (e: PointerEvent) => {
      if (!grab) return;
      e.stopPropagation();
      grab = null;
      if (dom.hasPointerCapture(e.pointerId)) dom.releasePointerCapture(e.pointerId);
      dom.classList.remove('viewport__grabbing');
    };
    const onOut = () => { dom.classList.remove('viewport__grab'); if (!grab && sunPath.hover(null, camera).changed) render(); };
    el.addEventListener('pointerdown', onGrab, true);
    el.addEventListener('pointermove', onDrag, true);
    el.addEventListener('pointerup', onDrop, true);
    el.addEventListener('pointercancel', onDrop, true);
    dom.addEventListener('pointerleave', onOut);
    return () => {
      ro.disconnect();
      controls.dispose();
      dom.removeEventListener('pointerdown', onDown);
      dom.removeEventListener('pointerup', onUp);
      dom.removeEventListener('pointermove', onMove);
      dom.removeEventListener('pointerleave', onLeave);
      el.removeEventListener('pointerdown', onGrab, true);
      el.removeEventListener('pointermove', onDrag, true);
      el.removeEventListener('pointerup', onDrop, true);
      el.removeEventListener('pointercancel', onDrop, true);
      dom.removeEventListener('pointerleave', onOut);
      sunPath.dispose();
      labelsEl.current?.replaceChildren();
      renderer.dispose();
      ctx.current = null;
    };
  }, [dispatch]);

  // New model: swap it in, give every mesh its own material, frame the camera.
  useEffect(() => {
    const c = ctx.current;
    if (!c) return;
    if (c.model) c.scene.remove(c.model);
    c.model = group;
    c.meshes = group ? listMeshes(group) : [];
    if (!group) return c.render();
    c.scene.add(group);
    for (const m of c.meshes) {
      m.userData.source = m.geometry; // the untouched geometry; value painting works on a clone
      m.material = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0, side: THREE.DoubleSide });
    }
    const box = new THREE.Box3().setFromObject(group), size = box.getSize(new THREE.Vector3()), centre = box.getCenter(new THREE.Vector3());
    const r0 = Math.hypot(size.x / 2, size.y, size.z / 2) || 1; // the sun path's dome stands on the ground and encloses the model
    c.dome = { x: centre.x, y: box.min.y, z: centre.z, r: r0 };
    const dim = Math.max(size.x, size.y, size.z, 2.3 * r0), dist = (dim / Math.tan((c.camera.fov * Math.PI) / 360)) * 0.75; // the dome and its labels in view
    c.camera.position.copy(centre).add(new THREE.Vector3(1, 0.7, 1).normalize().multiplyScalar(dist));
    c.camera.near = dist / 500;
    c.camera.far = dist * 50;
    c.camera.updateProjectionMatrix();
    c.controls.target.copy(centre);
    c.controls.update();
    c.gridSpec = { size: dim * 2, x: centre.x, y: box.min.y, z: centre.z };
  }, [group]);

  // Sun path: the scaffold follows the site and the theme, the frame the model, north and size, the active layer the time.
  const site = sun?.site ?? null, shown = !!sun && !!group;
  useEffect(() => {
    const c = ctx.current;
    if (!c) return;
    c.sun.group.visible = shown;
    if (shown && site) c.sun.build(site);
    c.render();
  }, [site, theme, shown]);
  useEffect(() => {
    const c = ctx.current;
    if (!c || !sun) return;
    c.sun.frame(c.dome.x, c.dome.y, c.dome.z, c.dome.r * sun.scale, sun.north);
    c.render();
  }, [group, sun?.north, sun?.scale]); // eslint-disable-line react-hooks/exhaustive-deps -- only north and size move the frame
  useEffect(() => {
    const c = ctx.current;
    if (!c || !sun || !group) return;
    c.sun.show(sun.site, sun.time);
    c.render();
  }, [group, sun?.site, sun?.time, theme, shown]); // eslint-disable-line react-hooks/exhaustive-deps -- not north or size

  // The ground grid under the model, in the theme's hairline colours.
  useEffect(() => {
    const c = ctx.current;
    if (!c) return;
    const { size, x, y, z } = c.gridSpec, grid = new THREE.GridHelper(size, 20, solid('--border-default'), solid('--border-subtle'));
    grid.position.set(x, y, z);
    c.scene.add(grid);
    c.render();
    return () => { c.scene.remove(grid); grid.dispose(); };
  }, [group, theme]);

  // Paint: role colours from tokens, hover / selection as accent emissive, or the result colours per element.
  useEffect(() => {
    const c = ctx.current;
    if (!c) return;
    let stale = false;
    (async () => {
      const accent = solid('--accent');
      const byValue = result && scale && colourBy === 'value' ? result : null;
      for (const mesh of c.meshes) {
        const id = mesh.userData.id as string, row = objects.find((o) => o.id === id);
        if (!row) continue;
        const mat = mesh.material as THREE.MeshStandardMaterial, source = mesh.userData.source as THREE.BufferGeometry;
        const k = byValue?.receivers.indexOf(id) ?? -1, painted = !!byValue && !!scale && k >= 0 && row.role === 'receiver';
        if (byValue && scale && painted) {
          const g = byValue.manifest.meshes[k], vals = new Float64Array(g.count);
          for (let i = 0; i < g.count; i++) vals[i] = byValue.values[g.first + i][column];
          const rgb = rgbFor(scale, vals, bin), perFace = byValue.on === 'faces';
          const attr = mesh.geometry !== source ? (mesh.geometry.getAttribute('color') as THREE.BufferAttribute | undefined) : undefined;
          if (attr && attr.count === (perFace ? 3 * g.count : g.count)) { // repaint in place (scale, range or bin changed)
            const arr = attr.array as Float32Array;
            if (perFace) for (let i = 0; i < arr.length; i++) arr[i] = rgb[3 * Math.floor(i / 9) + (i % 3)];
            else arr.set(rgb);
            attr.needsUpdate = true;
          } else {
            if (mesh.geometry !== source) mesh.geometry.dispose();
            mesh.geometry = source.clone(); // the per-face path goes non-indexed, so paint a copy and keep the source for picking
            await applyToThree(mesh, vals, { material: false, rgb });
            if (stale) return;
          }
          mat.color.setRGB(1, 1, 1);
        } else {
          if (mesh.geometry !== source) { mesh.geometry.dispose(); mesh.geometry = source; }
          mat.color.set(GREY);
        }
        if (mat.vertexColors !== painted) { mat.vertexColors = painted; mat.needsUpdate = true; } // a shader switch; colours are uniforms
        // a value-painted mesh keeps its colours readable: a faint tint only; grey stays grey: a light accent tint
        const hi = hovered === id ? (painted ? 0.1 : 0.22) : selected.has(id) ? (painted ? 0.12 : 0.14) : 0;
        mat.emissive.set(hi ? accent : 0x000000);
        mat.emissiveIntensity = hi;
      }
      c.render();
    })();
    return () => { stale = true; };
  }, [group, objects, selected, hovered, colourBy, result, column, scale, bin, theme]);

  return (
    <div ref={host} className="viewport">
      <canvas ref={canvas} aria-label="3D model viewport" />
      <div ref={labelsEl} className="viewport__labels" aria-hidden="true" />
      <div ref={tip} className="readout readout--float" hidden={!probeLabel} aria-hidden="true">{probeLabel}</div>
      {!group && (
        <div className="empty-state">
          <div className="empty-state__icon"><Illustration kind="model" /></div>
          {loading ? <><span className="spinner" aria-hidden="true" /><p>Loading the model</p></> : <><h3>Open a model</h3><p>Pick a .glb, .gltf or .obj in the Model panel. Click a mesh to select it, shift-click to add.</p></>}
        </div>
      )}
      {children && <div className="viewport__bar">{children}</div>}
    </div>
  );
}
