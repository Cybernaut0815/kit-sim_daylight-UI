import { describe, expect, it } from 'vitest';
import { columnStats, faceAreas, fmtNum, globalRange, histogram, unitFor, vertexAreas } from './result';

// unit square in the XY plane as two triangles
const pos = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0];
const idx = [0, 1, 2, 0, 2, 3];

describe('areas', () => {
  it('triangle areas and their vertex split sum to the same total', () => {
    const fa = faceAreas(pos, idx);
    expect([...fa]).toEqual([0.5, 0.5]);
    const va = vertexAreas(pos, idx);
    expect(va.length).toBe(4);
    expect(va.reduce((a, b) => a + b)).toBeCloseTo(1);
    expect(va[0]).toBeCloseTo(1 / 3); // vertex 0 is in both faces
    expect(va[1]).toBeCloseTo(1 / 6);
  });
});

describe('stats and histogram', () => {
  const rows = [10, 20, 30, 40, NaN].map((v) => Float64Array.of(v, 2 * v));
  it('weights the mean and total, skips non-finite', () => {
    const s = columnStats(rows, 0, { first: 0, count: 5 }, [1, 1, 1, 3, 1]);
    expect(s.min).toBe(10);
    expect(s.max).toBe(40);
    expect(s.total).toBe(10 + 20 + 30 + 120);
    expect(s.mean).toBeCloseTo(180 / 6);
    expect(columnStats(rows, 1, { first: 2, count: 2 }, [1, 1]).total).toBe(60 + 80);
  });
  it('bins every finite element exactly once over the global range', () => {
    expect(globalRange(rows, 0)).toEqual([10, 40]);
    const groups = [{ first: 0, count: 2 }, { first: 2, count: 3 }];
    const h = histogram(rows, 0, groups, 3);
    expect(h.edges).toEqual([10, 20, 30, 40]);
    expect(h.counts[0]).toEqual([1, 1, 0]);
    expect(h.counts[1]).toEqual([0, 0, 2]); // 30 and 40 (max) land in the last bin, NaN dropped
    expect(h.counts.flat().reduce((a, b) => a + b)).toBe(4);
  });
});

describe('units and formatting', () => {
  it('maps columns to units', () => {
    expect(unitFor('radiation_front')).toEqual({ value: 'kWh/m²', total: 'kWh' });
    expect(unitFor('sunhours_back').value).toBe('h');
    expect(unitFor('nonsense').value).toBe('');
  });
  it('formats compactly', () => {
    expect(fmtNum(1234.5)).toBe('1,235');
    expect(fmtNum(0.123456)).toBe('0.123');
    expect(fmtNum(NaN)).toBe('–');
  });
});
