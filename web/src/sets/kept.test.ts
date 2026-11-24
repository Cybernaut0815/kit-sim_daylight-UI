import { describe, expect, it } from 'vitest';
import type { RunResult } from '../store';
import { bytesOf, keptCache } from './kept';

// A result of `rows` float32 rows in one column (4 bytes a value, plus as many for the weights).
const result = (key: string, rows: number): RunResult => ({
  data: [new Float32Array(rows)], weights: new Float32Array(rows), columns: ['radiation_front'], receivers: ['a'], on: 'faces', key, elapsed: 0,
  manifest: { columns: ['radiation_front'], meshes: [{ name: 'a', first: 0, count: rows }] } as unknown as RunResult['manifest'],
});

describe('kept', () => {
  it('counts the columns and the weights', () => {
    expect(bytesOf(result('k', 10))).toBe(80);
  });

  it('gives back a result by slot and run key only', () => {
    const k = keptCache();
    const r = result('k1', 4);
    k.put(0, r);
    expect(k.get(0, 'k1')).toBe(r);
    expect(k.get(1, 'k1')).toBeUndefined(); // another model, the same inputs
    expect(k.get(0, 'k2')).toBeUndefined();
  });

  it('drops the least recently used above the byte budget', () => {
    const k = keptCache(200); // 2 results of 80 bytes fit, 3 do not
    k.put(0, result('a', 10));
    k.put(0, result('b', 10));
    k.get(0, 'a'); // used: b is the oldest now
    k.put(0, result('c', 10));
    expect(k.get(0, 'b')).toBeUndefined();
    expect(k.get(0, 'a')).toBeDefined();
    expect(k.get(0, 'c')).toBeDefined();
    expect(k.bytes()).toBe(160);
  });

  it('never keeps one result bigger than the budget, and replaces an equal key', () => {
    const k = keptCache(100);
    k.put(0, result('big', 20)); // 160 bytes
    expect(k.size()).toBe(0);
    k.put(0, result('a', 5));
    k.put(0, result('a', 10));
    expect(k.size()).toBe(1);
    expect(k.bytes()).toBe(80);
  });

  it('purges a slot on LOAD, RELOAD and REMOVE, and keeps every finished run', () => {
    const k = keptCache();
    k.observe({ type: 'RUN', slot: 0, run: { status: 'done', result: result('a', 2) } });
    k.observe({ type: 'RUN', slot: 1, run: { status: 'done', result: result('b', 2) }, tab: 'views' });
    k.observe({ type: 'RUN', slot: 2, run: { status: 'done', result: result('c', 2) } });
    k.observe({ type: 'RUN', slot: 3, run: { status: 'done', result: result('d', 2) } });
    k.observe({ type: 'RUN', slot: 3, run: { status: 'error', message: 'x' } });
    expect(k.size()).toBe(4);
    k.observe({ type: 'LOAD', slot: 0, objects: [] });
    k.observe({ type: 'RELOAD', slot: 1, objects: [] });
    k.observe({ type: 'REMOVE', slot: 2 });
    expect(k.get(0, 'a') ?? k.get(1, 'b') ?? k.get(2, 'c')).toBeUndefined();
    expect(k.get(3, 'd')).toBeDefined(); // the other models keep theirs
    expect(k.bytes()).toBe(16);
  });
});
