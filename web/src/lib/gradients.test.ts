import { describe, expect, it } from 'vitest';
import type { PaintStyle } from 'usd-viewer';
import { colorAt, gradientFor, GRADIENTS, hexAt, hexToRgb, paintStyleOf, place, rgbFor, svgColor, type Gradient, type Scale } from './gradients';

const grey: Gradient = { key: 'g', label: 'g', stops: ['#000000', '#ffffff'] };
const scale: Scale = { gradient: grey, vmin: 0, vmax: 10, lo: 2, hi: 8, below: '#0000ff', above: '#ff0000' };

describe('gradients', () => {
  it('interpolates between stops and formats hex', () => {
    expect(colorAt(grey, 0)).toEqual([0, 0, 0]);
    expect(colorAt(grey, 1)).toEqual([1, 1, 1]);
    expect(hexAt(grey, 0.5)).toBe('#808080');
    expect(colorAt(grey, 2)).toEqual([1, 1, 1]); // clamped
    expect(hexAt(gradientFor('radiation'), 0)).toBe('#000004'); // inferno by default
    expect(gradientFor('radiation', 'viridis').key).toBe('viridis');
    expect(gradientFor('unknown', 'nope').key).toBe('viridis');
    expect(hexToRgb('#ff0080')).toEqual([1, 0, 128 / 255]);
    expect(hexToRgb('red')).toEqual([0.5, 0.5, 0.5]);
  });
  it('places values below, above or on the gradient', () => {
    expect(place(scale, 1)).toBe('below');
    expect(place(scale, 9)).toBe('above');
    expect(place(scale, 5)).toBe(0.5);
    expect(place({ ...scale, lo: null, hi: null }, 20)).toBe(1);
    expect(place({ ...scale, vmax: 0 }, 5)).toBe(0); // degenerate domain
    expect(svgColor(scale, 1)).toBe('#0000ff');
    expect(svgColor(scale, 9)).toBe('#ff0000');
    expect(svgColor(scale, 5)).toBe('#808080');
  });
  it('paints RGB per value, fades everything outside the hovered bin', () => {
    const rgb = rgbFor(scale, [1, 5, 9, NaN], null);
    expect(Array.from(rgb.subarray(0, 3))).toEqual([0, 0, 1]);
    expect(Array.from(rgb.subarray(6, 9))).toEqual([1, 0, 0]);
    expect(rgb[3]).toBeCloseTo(0.5);
    expect(rgb[9]).toBe(0.5); // non-finite -> grey
    const dim = rgbFor(scale, [5, 6], [4.9, 5.1]);
    expect(dim[0]).toBeCloseTo(0.5); // inside the bin: unchanged
    expect(dim[3]).toBeCloseTo(0.15 * 0.6 + 0.85 * 0.6); // outside: pulled to grey
  });
  it('gives the viewer a paint style that colours as rgbFor does', () => {
    // USD_WebViewer materials.ts paintLook's shader, in JS (its e2e test checks the GPU against the same legend)
    const shade = (p: PaintStyle, v: number) => {
      const s = p.stops.map(hexToRgb), last = s.length - 1, span = p.max - p.min;
      const u = (span > 0 ? Math.min(Math.max((v - p.min) / span, 0), 1) : 0) * last, k = Math.min(Math.floor(u), last - 1);
      const c = !Number.isFinite(v) ? [0.5, 0.5, 0.5] : p.below && v < p.below.value ? hexToRgb(p.below.color) : p.above && v > p.above.value ? hexToRgb(p.above.color)
        : s[k].map((x, j) => x + (u - k) * (s[k + 1][j] - x));
      return p.band && !(v >= p.band[0] && v < p.band[1]) ? c.map((x) => 0.15 * x + 0.51) : c;
    };
    const values = [-1, 0, 1.9, 2, 3.3, 5, 7.7, 8, 8.1, 10, 11, NaN];
    for (const s of [scale, { ...scale, gradient: GRADIENTS[0], lo: null, hi: null }, { ...scale, vmax: 0 }]) {
      for (const dim of [null, [3, 6]] as const) {
        const want = rgbFor(s, values, dim ? [...dim] : null);
        values.forEach((v, i) => shade(paintStyleOf(s, dim ? [...dim] : null), v).forEach((c, j) => expect(c).toBeCloseTo(want[3 * i + j], 6)));
      }
    }
  });
});
