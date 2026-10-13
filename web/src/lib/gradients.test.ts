import { describe, expect, it } from 'vitest';
import { colorAt, gradientFor, hexAt, place, rgbFor, svgColor, type Gradient, type Scale } from './gradients';

const grey: Gradient = { key: 'g', label: 'g', stops: ['#000000', '#ffffff'] };
const scale: Scale = { gradient: grey, vmin: 0, vmax: 10, lo: 2, hi: 8 };

describe('gradients', () => {
  it('interpolates between stops and formats hex', () => {
    expect(colorAt(grey, 0)).toEqual([0, 0, 0]);
    expect(colorAt(grey, 1)).toEqual([1, 1, 1]);
    expect(hexAt(grey, 0.5)).toBe('#808080');
    expect(colorAt(grey, 2)).toEqual([1, 1, 1]); // clamped
    expect(hexAt(gradientFor('radiation'), 0)).toBe('#000004'); // inferno by default
    expect(gradientFor('radiation', 'viridis').key).toBe('viridis');
    expect(gradientFor('unknown', 'nope').key).toBe('viridis');
  });
  it('places values below, above or on the gradient', () => {
    expect(place(scale, 1)).toBe('below');
    expect(place(scale, 9)).toBe('above');
    expect(place(scale, 5)).toBe(0.5);
    expect(place({ ...scale, lo: null, hi: null }, 20)).toBe(1);
    expect(place({ ...scale, vmax: 0 }, 5)).toBe(0); // degenerate domain
    expect(svgColor(scale, 1)).toBe('var(--chart-div-neg-3)');
    expect(svgColor(scale, 5)).toBe('#808080');
  });
  it('paints RGB per value, fades everything outside the hovered bin', () => {
    const rgb = rgbFor(scale, [1, 5, 9, NaN], [0, 0, 1], [1, 0, 0], null);
    expect(Array.from(rgb.subarray(0, 3))).toEqual([0, 0, 1]);
    expect(Array.from(rgb.subarray(6, 9))).toEqual([1, 0, 0]);
    expect(rgb[3]).toBeCloseTo(0.5);
    expect(rgb[9]).toBe(0.5); // non-finite -> grey
    const dim = rgbFor(scale, [5, 6], [0, 0, 1], [1, 0, 0], [4.9, 5.1]);
    expect(dim[0]).toBeCloseTo(0.5); // inside the bin: unchanged
    expect(dim[3]).toBeCloseTo(0.15 * 0.6 + 0.85 * 0.6); // outside: pulled to grey
  });
});
