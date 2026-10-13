// three.js viewport: render on demand, orbit, grid, pick/hover by raycast, materials painted from zha tokens.
import { useEffect, useRef, type Dispatch } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { applyToThree } from 'daylight-mesh';
import { cssVar } from '../lib/cssVar';

const solid = (name: string) => cssVar(name, '#000', '--bg-surface-2'); // opaque over the viewport background: three.js drops alpha
import { listMeshes } from '../lib/loaders';
import { globalRange } from '../lib/result';
import { slotVar, type Action, type ObjectRow, type RunResult } from '../store';
import { Illustration } from '../ui';

interface Props {
  group: THREE.Group | null; loading: boolean; objects: ObjectRow[]; selected: Set<string>; hovered: string | null;
  colourBy: 'mesh' | 'value'; result: RunResult | null; column: number; theme: string; dispatch: Dispatch<Action>;
}

interface Ctx {
  renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera; controls: OrbitControls;
  model: THREE.Group | null; meshes: THREE.Mesh[]; grid: THREE.GridHelper | null; gridSpec: { size: number; x: number; y: number; z: number };
  render: () => void;
}

export function Viewer({ group, loading, objects, selected, hovered, colourBy, result, column, theme, dispatch }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const ctx = useRef<Ctx | null>(null);

  useEffect(() => {
    const el = host.current!;
    const renderer = new THREE.WebGLRenderer({ canvas: canvas.current!, antialias: true, alpha: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setClearColor(0x000000, 0); // transparent: the .viewport token background shows through in both themes
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
    camera.position.set(8, 6, 8);
    const controls = new OrbitControls(camera, renderer.domElement);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x666666, 2)); // white light, not a palette colour
    const sun = new THREE.DirectionalLight(0xffffff, 2);
    sun.position.set(5, 10, 7);
    scene.add(sun);
    let queued = false;
    const render = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; renderer.render(scene, camera); });
    };
    controls.addEventListener('change', render);
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth, h = el.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      render();
    });
    ro.observe(el);
    const c: Ctx = { renderer, scene, camera, controls, model: null, meshes: [], grid: null, gridSpec: { size: 20, x: 0, y: 0, z: 0 }, render };
    ctx.current = c;

    // Picking: pointerup within 4 px of pointerdown selects (shift / ctrl toggles); pointermove hovers, one raycast per frame.
    // ponytail: linear raycast over every mesh; three-mesh-bvh past ~1M triangles
    const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
    const pick = (e: PointerEvent): string | null => {
      const r = renderer.domElement.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      return (ray.intersectObjects(c.meshes, false)[0]?.object.userData.id as string | undefined) ?? null;
    };
    let down: [number, number] | null = null, raf = 0;
    const dom = renderer.domElement;
    const onDown = (e: PointerEvent) => { down = [e.clientX, e.clientY]; };
    const onUp = (e: PointerEvent) => {
      if (down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) < 4) {
        const id = pick(e);
        dispatch({ type: 'SELECT', ids: id ? [id] : [], additive: e.shiftKey || e.ctrlKey });
      }
      down = null;
    };
    const onMove = (e: PointerEvent) => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => dispatch({ type: 'HOVER', id: pick(e) })); };
    const onLeave = () => { cancelAnimationFrame(raf); dispatch({ type: 'HOVER', id: null }); };
    dom.addEventListener('pointerdown', onDown);
    dom.addEventListener('pointerup', onUp);
    dom.addEventListener('pointermove', onMove);
    dom.addEventListener('pointerleave', onLeave);
    return () => {
      ro.disconnect();
      controls.dispose();
      dom.removeEventListener('pointerdown', onDown);
      dom.removeEventListener('pointerup', onUp);
      dom.removeEventListener('pointermove', onMove);
      dom.removeEventListener('pointerleave', onLeave);
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
    const dim = Math.max(size.x, size.y, size.z) || 1, dist = (dim / Math.tan((c.camera.fov * Math.PI) / 360)) * 0.75;
    c.camera.position.copy(centre).add(new THREE.Vector3(1, 0.7, 1).normalize().multiplyScalar(dist));
    c.camera.near = dist / 500;
    c.camera.far = dist * 50;
    c.camera.updateProjectionMatrix();
    c.controls.target.copy(centre);
    c.controls.update();
    c.gridSpec = { size: dim * 2, x: centre.x, y: box.min.y, z: centre.z };
  }, [group]);

  // Paint: role colours from tokens, hover / selection as accent emissive, or colour-by-value through applyToThree.
  useEffect(() => {
    const c = ctx.current;
    if (!c) return;
    let stale = false;
    (async () => {
      if (c.grid) c.scene.remove(c.grid);
      c.grid = new THREE.GridHelper(c.gridSpec.size, 20, solid('--border-default'), solid('--border-subtle'));
      c.grid.position.set(c.gridSpec.x, c.gridSpec.y, c.gridSpec.z);
      c.scene.add(c.grid);
      const accent = solid('--accent'), shade = solid('--bg-surface-3'), none = solid('--text-disabled');
      const range = result && colourBy === 'value' ? globalRange(result.values, column) : null;
      for (const mesh of c.meshes) {
        const id = mesh.userData.id as string, row = objects.find((o) => o.id === id);
        if (!row) continue;
        const mat = mesh.material as THREE.MeshStandardMaterial, source = mesh.userData.source as THREE.BufferGeometry;
        const k = result?.receivers.indexOf(id) ?? -1;
        if (range && k >= 0 && row.role === 'receiver') {
          const g = result!.manifest.meshes[k], vals = new Float64Array(g.count);
          for (let i = 0; i < g.count; i++) vals[i] = result!.values[g.first + i][column];
          if (mesh.geometry !== source) mesh.geometry.dispose();
          mesh.geometry = source.clone(); // ponytail: geometry clone per repaint; write the colour attribute directly if memory bites
          await applyToThree(mesh, vals, { material: false, vmin: range[0], vmax: range[1] });
          if (stale) return;
          mat.vertexColors = true;
          mat.color.setRGB(1, 1, 1);
        } else {
          if (mesh.geometry !== source) { mesh.geometry.dispose(); mesh.geometry = source; }
          mat.vertexColors = false;
          mat.color.set(row.role === 'receiver' ? solid(slotVar(row.slot)) : row.role === 'shade' ? shade : none);
        }
        mat.transparent = row.role === 'none';
        mat.opacity = row.role === 'none' ? 0.35 : 1;
        const hi = hovered === id ? 0.35 : selected.has(id) ? 0.6 : 0;
        mat.emissive.set(hi ? accent : 0x000000);
        mat.emissiveIntensity = hi;
        mat.needsUpdate = true;
      }
      c.render();
    })();
    return () => { stale = true; };
  }, [group, objects, selected, hovered, colourBy, result, column, theme]);

  return (
    <div ref={host} className="viewport">
      <canvas ref={canvas} aria-label="3D model viewport" />
      {!group && (
        <div className="empty-state">
          <div className="empty-state__icon"><Illustration kind="model" /></div>
          {loading ? <><span className="spinner" aria-hidden="true" /><p>Loading the model</p></> : <><h3>Open a model</h3><p>Pick a .glb, .gltf or .obj in the Model panel. Click a mesh to select it, shift-click to add.</p></>}
        </div>
      )}
    </div>
  );
}
