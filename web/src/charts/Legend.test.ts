import { describe, expect, it } from 'vitest';
import { GRADIENTS, position, type Scale } from '../lib/gradients';
import { legendTicks } from './Legend';

const scale = (more: Partial<Scale>): Scale => ({ gradient: GRADIENTS[3], vmin: 0, vmax: 10, lo: null, hi: null, below: '#0000ff', above: '#ff0000', scaling: 'linear', knots: null, ...more });
const ticks = (s: Scale) => legendTicks(s, (v) => 8 + Math.min(Math.max(position(s, v), 0), 1) * 304); // the legend's own x

describe('legendTicks', () => {
  it('linear: nice steps over the range', () => {
    expect(ticks(scale({}))).toEqual([0, 2, 4, 6, 8, 10]);
  });
  it('log over decades: the powers of ten, evenly apart', () => {
    expect(ticks(scale({ scaling: 'log', vmin: 0.1, vmax: 1000 }))).toEqual([0.1, 1, 10, 100, 1000]);
  });
  it('log within one decade still has ticks: 2 and 5 times a power of ten, then nice steps that fit', () => {
    const t = ticks(scale({ scaling: 'log', vmin: 0.125, vmax: 0.886 }));
    expect(t).toEqual(expect.arrayContaining([0.2, 0.5]));
    expect(t.every((v) => v >= 0.125 && v <= 0.886) && t.every((v, i) => !i || v > t[i - 1])).toBe(true);
  });
  it('a scaling that crowds the ticks keeps only those whose labels stay apart', () => {
    const s = scale({ scaling: 'square' }), t = ticks(s), x = t.map((v) => 8 + position(s, v) * 304);
    expect(t.length).toBeGreaterThanOrEqual(3);
    expect(x.every((p, i) => !i || p - x[i - 1] >= 34)).toBe(true);
  });
});
