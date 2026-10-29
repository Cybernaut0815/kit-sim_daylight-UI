import { describe, expect, it } from 'vitest';
import { columnStats, cumulative, faceAreas, fmtNum, globalRange, histogram, percentile, rangeShares, roundNum, shareAbove, shareBelow, fmtDiff, summarize, unionRange, unitFor, vertexAreas } from './result';

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

describe('stats, histogram and cumulative area', () => {
  const rows = [10, 20, 30, 40, NaN].map((v) => Float64Array.of(v, 2 * v));
  const groups = [{ first: 0, count: 2 }, { first: 2, count: 3 }], weights = [[1, 1], [1, 3, 1]];
  it('weights the mean and total, skips non-finite', () => {
    const s = columnStats(rows, 0, { first: 0, count: 5 }, [1, 1, 1, 3, 1]);
    expect(s.min).toBe(10);
    expect(s.max).toBe(40);
    expect(s.total).toBe(10 + 20 + 30 + 120);
    expect(s.mean).toBeCloseTo(180 / 6);
    expect(columnStats(rows, 1, { first: 2, count: 2 }, [1, 1]).total).toBe(60 + 80);
  });
  it('bins every finite element exactly once over the global range, shares by weight', () => {
    expect(globalRange(rows, 0)).toEqual([10, 40]);
    const h = histogram(rows, 0, groups, weights, 3);
    expect(h.edges).toEqual([10, 20, 30, 40]);
    expect(h.counts).toEqual([1, 1, 2]); // 30 and 40 (max) land in the last bin, NaN dropped
    expect(h.shares.map((s) => Math.round(s * 100))).toEqual([17, 17, 67]); // weights 1, 1, 1 + 3 of 6
    expect([h.below, h.above]).toEqual([0, 0]);
  });
  it('bins only inside a set range; the shares outside it are counted apart', () => {
    const h = histogram(rows, 0, groups, weights, 2, [15, 35]);
    expect(h.edges).toEqual([15, 25, 35]);
    expect(h.counts).toEqual([1, 1]); // 20 and 30; 10 below, 40 above
    expect([...h.shares, h.below, h.above].map((s) => Math.round(s * 100))).toEqual([17, 17, 17, 50]);
  });
  it('cumulative share, percentiles and range shares are area-weighted', () => {
    const c = cumulative(rows, 0, groups, weights);
    expect([...c.v]).toEqual([10, 20, 30, 40]);
    expect([...c.cw].map((w) => Math.round(w * 100))).toEqual([17, 33, 50, 100]);
    expect(shareBelow(c, 30)).toBeCloseTo(2 / 6);
    expect(shareBelow(c, 5)).toBe(0);
    expect(shareAbove(c, 30)).toBeCloseTo(3 / 6);
    expect(shareAbove(c, 40)).toBeCloseTo(0);
    expect(shareAbove(c, 0)).toBe(1);
    expect(percentile(c, 0.1)).toBe(10);
    expect(percentile(c, 0.5)).toBe(30);
    expect(percentile(c, 0.9)).toBe(40);
    expect(rangeShares(c, 15, 35)).toEqual({ below: 1 / 6, above: 0.5, within: 1 - 1 / 6 - 0.5 });
    expect(rangeShares(c, null, null)).toEqual({ below: 0, above: 0, within: 1 });
    expect(Number.isNaN(percentile(cumulative([], 0, [], []), 0.5))).toBe(true);
  });
  it('summarize: two groups, unequal weights, the problem range and thresholds in one area-weighted summary', () => {
    const s = summarize(rows, 0, groups, weights, 15, 35, [20, 45]);
    expect(s).toEqual({
      elements: 5, area: 6, min: 10, p10: 10, median: 30, mean: 30, p90: 40, max: 40, total: 180, // 40 weighs 3: the mean is not 25
      below: 1 / 6, within: 1 - 1 / 6 - 0.5, above: 0.5, atLeast: [1 - 1 / 6, 0],
    });
    expect(summarize(rows, 0, groups, weights).within).toBe(1); // no problem range
    const none = summarize(rows, 0, [{ first: 4, count: 1 }], [[1]], 15, 35, [20]); // only the NaN row
    expect([none.elements, none.area, none.min, none.mean, none.above, none.atLeast[0]]).toEqual([1, 0, NaN, NaN, NaN, NaN]);
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
  it('roundNum is the number fmtNum shows', () => {
    for (const v of [0.123456, 0.000123456, 1.23456e-7, 5, -12.345, 999.6, 1234.5, -1500.4, 1e7 / 3]) expect(roundNum(v)).toBe(Number(fmtNum(v).replace(/,/g, '')));
    expect(roundNum(NaN)).toBeNaN();
  });
});

describe('several models', () => {
  it('unionRange: the named column over every result that has it, wherever it sits', () => {
    const a = { columns: ['radiation_front', 'direct_front'], values: [Float64Array.of(10, 1), Float64Array.of(40, NaN)] };
    const b = { columns: ['direct_front', 'radiation_front'], values: [Float64Array.of(2, -5), Float64Array.of(3, 20)] };
    const c = { columns: ['sunhours_front'], values: [Float64Array.of(1000)] };
    expect(unionRange([a, b, c], 'radiation_front')).toEqual([-5, 40]);
    expect(unionRange([a, b, c], 'direct_front')).toEqual([1, 3]);
    expect(unionRange([c], 'radiation_front')).toEqual([Infinity, -Infinity]);
  });
  it('fmtDiff: signed, in the value\'s format, nothing without a number', () => {
    expect([fmtDiff(12.34), fmtDiff(-1500), fmtDiff(0), fmtDiff(NaN), fmtDiff(Infinity)]).toEqual(['+12.3', '−1,500', '±0', '', '']);
    expect(fmtDiff(-0.05, (v) => `${fmtNum(100 * v)} pts`)).toBe('−5 pts');
  });
});
