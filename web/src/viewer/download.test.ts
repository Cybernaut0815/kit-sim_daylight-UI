import { describe, expect, it } from 'vitest';
import type { ObjectRow, RunResult } from '../store';
import { MAX_TRIANGLES, npyHeader, tooBig, valuesFiles } from './download';

/** A two-column result of 3 rows (receiver a: rows 0-1, b: row 2), the columns views of one buffer as runRemote returns them. */
const result = (): RunResult => {
  const buf = Float32Array.of(1, 2, 3, 10, 20, 30).buffer;
  return {
    data: [new Float32Array(buf, 0, 3), new Float32Array(buf, 12, 3)], weights: Float32Array.of(0.5, 0.5, 2), columns: ['radiation_front', 'sunhours_front'],
    receivers: ['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'], on: 'faces', elapsed: 1,
    key: JSON.stringify([['--optics', '11111111-1111-1111-1111-111111111111/0=0.5,0'], null, ['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'], []]),
    manifest: { columns: ['radiation_front', 'sunhours_front'], duration_h: 10, dirs: { sky: 1, ground: 1, sun: 1 }, meshes: [{ name: 'h', first: 0, count: 2 }, { name: 'h_2', first: 2, count: 1 }] },
  };
};
const rows: ObjectRow[] = [{ id: '11111111-1111-1111-1111-111111111111', name: 'a', path: '/W/A', tris: 2, verts: 4, role: 'receiver' }, { id: '22222222-2222-2222-2222-222222222222', name: 'b', path: '/W/B', tris: 1, verts: 3, role: 'receiver' }];

describe('values download', () => {
  it('an npy header is NumPy v1.0, <f4, Fortran order, padded to 64 bytes', () => {
    const h = npyHeader([3, 2]), text = new TextDecoder().decode(h.subarray(10));
    expect(Array.from(h.subarray(0, 8))).toEqual([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 1, 0]);
    expect(h.length % 64).toBe(0);
    expect(h[8] + 256 * h[9]).toBe(h.length - 10);
    expect(text.trimEnd()).toBe("{'descr': '<f4', 'fortran_order': True, 'shape': (3, 2), }");
    expect(new TextDecoder().decode(npyHeader([3])).includes("'shape': (3,)")).toBe(true);
  });
  it('values.npy holds the columns one after another, weights.npy the areas, values.json what each row is', () => {
    const files = new Map(valuesFiles(result(), rows)), v = files.get('values.npy')!, w = files.get('weights.npy')!;
    const f32 = (b: Uint8Array) => Array.from(new Float32Array(b.slice(npyHeader([1]).length).buffer)); // headers here are 64 bytes long
    expect(f32(v)).toEqual([1, 2, 3, 10, 20, 30]);
    expect(f32(w)).toEqual([0.5, 0.5, 2]);
    const meta = JSON.parse(new TextDecoder().decode(files.get('values.json')!));
    expect([meta.columns, meta.rows, meta.elements]).toEqual([['radiation_front', 'sunhours_front'], 3, 'faces']);
    expect(meta.meshes).toEqual([{ path: '/W/A', first: 0, count: 2 }, { path: '/W/B', first: 2, count: 1 }]);
    expect(meta.args).toEqual(['--optics', '/W/A/0=0.5,0']); // mesh ids as prim paths
    const apart = { ...result(), data: [Float32Array.of(1, 2, 3), Float32Array.of(10, 20, 30)] }; // columns in buffers of their own
    expect(f32(new Map(valuesFiles(apart, rows)).get('values.npy')!)).toEqual([1, 2, 3, 10, 20, 30]);
  });
  it('every other format is refused above the triangle bound, values never', () => {
    expect(tooBig('usdz', MAX_TRIANGLES)).toBeNull();
    expect(tooBig('glb', MAX_TRIANGLES + 1)).toMatch(/too big .* Values \(\.npy \+ \.json, zip\)/);
    expect(tooBig('values', 17_244_108)).toBeNull();
  });
});
