import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { fmtNum } from '../lib/result';
import type { RunResult } from '../store';
import { MAX_LABELS, cellsOf, labelsOf, type LabelScene } from './labels';

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
  return { camera: camera(...size), width: size[0], height: size[1], meshes: [...receivers, ...others], receiverOf: (m) => receivers.indexOf(m as THREE.Mesh), result: r, column: 0, keeps: () => true, ...o };
}

describe('value labels', () => {
  it('one label per element, its value as fmtNum text, centred on a cell', () => {
    const left = plane(3, 3, -2), right = plane(3, 3, 2);
    const labels = labelsOf(scene([left, right]));
    expect(labels.map((l) => l.text).sort()).toEqual(['0.5', '1.5', '10.5', '11.5']); // two triangles each, each once
    for (const l of labels) expect([(l.x / 96) % 1, (l.y / 32) % 1]).toEqual([0.5, 0.5]);
    expect(labelsOf({ ...scene([left]), result: result([left], () => 2.5e7) }).map((l) => l.text)).toEqual([fmtNum(2.5e7), fmtNum(2.5e7)]); // its two triangles
  });

  it('nothing where another mesh covers the receiver, or where the section cuts it away', () => {
    const left = plane(3, 3, -2), right = plane(3, 3, 2), cover = plane(3.5, 3.5, -2, 0, 2);
    expect(labelsOf(scene([left, right], [cover])).map((l) => l.text).sort()).toEqual(['10.5', '11.5']);
    // the cover cut away: the receiver behind shows again; the right receiver cut away: nothing behind it
    expect(labelsOf(scene([left, right], [cover], { keeps: (p) => p.z < 1 && p.x < 0 })).map((l) => l.text).sort()).toEqual(['0.5', '1.5']);
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
