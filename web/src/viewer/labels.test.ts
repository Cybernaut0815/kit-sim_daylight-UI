import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { fmtNum } from '../lib/result';
import type { RunResult } from '../store';
import { MAX_LABELS, cellsOf, elementOf, labelsOf, type LabelScene } from './labels';

/** A w × h plane at (x, y, z) facing the camera, `seg` × `seg` quads (two triangles each: a row per triangle). */
const plane = (w: number, h: number, x: number, y = 0, z = 0, seg = 1) => {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h, seg, seg), new THREE.MeshBasicMaterial());
  m.position.set(x, y, z);
  m.updateMatrixWorld();
  return m;
};
const camera = (width: number, height: number) => {
  const c = new THREE.PerspectiveCamera(50, width / height, 0.1, 100);
  c.position.set(0, 0, 10);
  c.lookAt(0, 0, 0);
  c.updateMatrixWorld();
  c.updateProjectionMatrix();
  return c;
};
/** A result over receivers `meshes` (rows: their triangles), each row's value from `value(receiver, row)`. */
function result(meshes: THREE.Mesh[], value: (k: number, row: number) => number): RunResult {
  const counts = meshes.map((m) => m.geometry.index!.count / 3), firsts = counts.map((_, k) => counts.slice(0, k).reduce((a, b) => a + b, 0));
  const data = new Float32Array(counts.reduce((a, b) => a + b, 0));
  counts.forEach((n, k) => { for (let r = 0; r < n; r++) data[firsts[k] + r] = value(k, r); });
  return { data: [data], columns: ['x_front'], receivers: meshes.map((_, k) => `r${k}`), on: 'faces', manifest: { meshes: counts.map((count, k) => ({ first: firsts[k], count })) } } as unknown as RunResult;
}
function scene(receivers: THREE.Mesh[], others: THREE.Mesh[] = [], o: Partial<LabelScene> = {}, size: [number, number] = [960, 320]): LabelScene {
  const r = result(receivers, (k, row) => 10 * k + row + 0.5);
  return {
    camera: camera(...size), width: size[0], height: size[1], meshes: [...receivers, ...others], receiverOf: (m) => receivers.indexOf(m as THREE.Mesh),
    result: r, column: 0, keeps: () => true, unit: '', cell: [96, 32], ...o,
  };
}
/** The labels three's own raycaster finds for `s` (every visible mesh, every triangle), cell by cell as the sampler goes. */
function reference(s: LabelScene): string[] {
  const ray = new THREE.Raycaster(), seen = new Set<string>(), out: string[] = [];
  ray.near = (s.camera as THREE.PerspectiveCamera).near;
  for (const [x, y] of cellsOf(s)) {
    if (out.length >= MAX_LABELS) break;
    ray.setFromCamera(new THREE.Vector2((x / s.width) * 2 - 1, -(y / s.height) * 2 + 1), s.camera);
    const hit = ray.intersectObjects(s.meshes as THREE.Object3D[], false).find((h) => s.keeps(h.point));
    const k = hit ? s.receiverOf(hit.object) : -1, e = hit && k >= 0 ? elementOf(s.result, k, hit) : null;
    if (e === null || seen.has(`${k}:${e}`)) continue;
    seen.add(`${k}:${e}`);
    out.push(`${x},${y}:${fmtNum(s.result.data[s.column][s.result.manifest.meshes[k].first + e])}`);
  }
  return out;
}
/** An instanced mesh of `geometry`, one instance at each of `at`. */
function instanced(geometry: THREE.BufferGeometry, at: [number, number, number][]) {
  const m = new THREE.InstancedMesh(geometry, new THREE.MeshBasicMaterial(), at.length);
  at.forEach((p, i) => m.setMatrixAt(i, new THREE.Matrix4().makeTranslation(...p)));
  m.updateMatrixWorld();
  return m;
}

describe('value labels', () => {
  it('one label per element, its value as fmtNum text and the unit, centred on a cell of the scene\'s size', () => {
    const left = plane(3, 3, -2), right = plane(3, 3, 2);
    const labels = labelsOf(scene([left, right]));
    expect(labels.map((l) => l.text).sort()).toEqual(['0.5', '1.5', '10.5', '11.5']); // two triangles each, each once
    for (const l of labels) expect([(l.x / 96) % 1, (l.y / 32) % 1]).toEqual([0.5, 0.5]);
    expect(labelsOf({ ...scene([left]), result: result([left], () => 2.5e7) }).map((l) => l.text)).toEqual([fmtNum(2.5e7), fmtNum(2.5e7)]); // its two triangles
    const lux = labelsOf(scene([left, right], [], { unit: 'lx', cell: [120, 40] }));
    expect(lux.map((l) => l.text).sort()).toEqual(['0.5 lx', '1.5 lx', '10.5 lx', '11.5 lx']);
    for (const l of lux) expect([(l.x / 120) % 1, (l.y / 40) % 1]).toEqual([0.5, 0.5]);
  });

  it('finds what three\'s raycaster finds, cell by cell: the faces, the covers, the cut, the cap', () => {
    const fine = plane(12, 4, 0, 0, 0, 9), tilted = plane(3, 3, 3, 0, 1, 4), cover = plane(2, 2, -3, 0.5, 2);
    tilted.rotation.y = 0.7;
    tilted.updateMatrixWorld();
    for (const [o, size] of [[{}, [960, 320]], [{ keeps: (p: THREE.Vector3) => p.x < 2.5 }, [960, 320]], [{}, [1920, 640]], [{ cell: [40, 20] as const }, [960, 320]]] as const) {
      const s = scene([fine, tilted], [cover], o, [...size]), got = labelsOf(s);
      expect(got.map((l) => `${l.x},${l.y}:${l.text}`)).toEqual(reference(s));
      expect(got.length).toBeGreaterThan(5);
    }
    // values per vertex: the hit triangle's corner nearest the hit
    const perVertex = { ...result([fine, tilted], () => 0), on: 'vertices', manifest: { meshes: [{ first: 0, count: 100 }, { first: 100, count: 25 }] }, data: [Float32Array.from({ length: 125 }, (_, i) => i + 0.5)] } as unknown as RunResult;
    const s = scene([fine, tilted], [cover], { result: perVertex }), got = labelsOf(s);
    expect(got.map((l) => `${l.x},${l.y}:${l.text}`)).toEqual(reference(s));
    expect(got.length).toBeGreaterThan(5);
  });

  it('nothing where another mesh covers the receiver, or where the section cuts it away', () => {
    const left = plane(3, 3, -2), right = plane(3, 3, 2), cover = plane(3.5, 3.5, -2, 0, 2);
    expect(labelsOf(scene([left, right], [cover])).map((l) => l.text).sort()).toEqual(['10.5', '11.5']);
    // the cover cut away: the receiver behind shows again; the right receiver cut away: nothing behind it
    expect(labelsOf(scene([left, right], [cover], { keeps: (p) => p.z < 1 && p.x < 0 })).map((l) => l.text).sort()).toEqual(['0.5', '1.5']);
  });

  it('an instance of an instanced mesh covers what lies behind it, the other instances where they stand', () => {
    const left = plane(3, 3, -2), right = plane(3, 3, 2), covers = instanced(new THREE.PlaneGeometry(3.5, 3.5), [[-2, 0, 2], [0, 30, 2]]);
    expect(labelsOf(scene([left, right], [covers])).map((l) => l.text).sort()).toEqual(['10.5', '11.5']);
  });

  it('a mesh in front whose box spans the cells but whose triangles miss them hides nothing', () => {
    const left = plane(3, 3, -2), right = plane(3, 3, 2);
    const corners = new THREE.BufferGeometry(); // two small triangles at opposite corners of a box round both receivers
    corners.setAttribute('position', new THREE.Float32BufferAttribute([-6, -3, 2, -5.5, -3, 2, -6, -2.5, 2, 6, 3, 2, 5.5, 3, 2, 6, 2.5, 2], 3));
    corners.setIndex([0, 1, 2, 3, 4, 5]);
    const frame = new THREE.Mesh(corners, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    frame.updateMatrixWorld();
    expect(labelsOf(scene([left, right], [frame])).map((l) => l.text).sort()).toEqual(['0.5', '1.5', '10.5', '11.5']);
  });

  it('leaves the geometry\'s index in its own order', () => {
    const fine = plane(12, 4, 0, 0, 0, 20), before = Array.from(fine.geometry.index!.array);
    expect(labelsOf(scene([fine])).length).toBeGreaterThan(10);
    expect(Array.from(fine.geometry.index!.array)).toEqual(before);
    expect(fine.geometry.index!.version).toBe(0);
  });

  it('labels a 200k-triangle receiver behind 2,000 meshes well within a second', () => {
    const big = plane(40, 14, 0, 0, 0, 316), others: THREE.Mesh[] = [], piece = new THREE.BoxGeometry(0.2, 0.2, 0.2);
    for (let i = 0; i < 2000; i++) {
      const m = new THREE.Mesh(piece, new THREE.MeshBasicMaterial());
      m.position.set(((i * 37) % 200) / 5 - 20, ((i * 53) % 70) / 5 - 7, 1 + (i % 3));
      m.updateMatrixWorld();
      others.push(m);
    }
    const s = scene([big], others, {}, [1920, 640]), from = performance.now(), labels = labelsOf(s);
    expect(labels.length).toBe(MAX_LABELS);
    expect(performance.now() - from).toBeLessThan(1000);
  });

  it('casts only the cells over the receivers, and stops at the cap', () => {
    const small = plane(1, 1, 3, 1), all = cellsOf(scene([plane(40, 40, 0)]));
    expect(all.length).toBe(10 * 10);
    expect(cellsOf(scene([small])).length).toBeLessThan(12);
    expect(cellsOf(scene([small], [plane(40, 40, 0)])).length).toBeLessThan(12); // an unpainted mesh does not widen them
    const fine = plane(40, 14, 0, 0, 0, 120);
    expect(labelsOf(scene([fine], [], {}, [1920, 640])).length).toBe(MAX_LABELS);
  });
});
