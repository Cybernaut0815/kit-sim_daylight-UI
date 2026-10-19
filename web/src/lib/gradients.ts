// Result colour scales: evenly spaced hex stops (matplotlib / Ladybug data colormaps, data not UI chrome), the
// per-quantity defaults, and the "problem range" that paints values outside [lo, hi] in two user-chosen colours.
import { globalRange } from './result';
import type { Settings } from '../store';

export interface Gradient { key: string; label: string; stops: string[] }

const G = (key: string, label: string, stops: string[]): Gradient => ({ key, label, stops });
export const GRADIENTS: Gradient[] = [
  G('inferno', 'Inferno', ['#000004', '#1b0c41', '#4a0c6b', '#781c6d', '#a52c60', '#cf4446', '#ed6925', '#fb9b06', '#fcffa4']),
  G('magma', 'Magma', ['#000004', '#180f3d', '#440f76', '#721f81', '#9e2f7f', '#cd4071', '#f1605d', '#fd9668', '#fcfdbf']),
  G('plasma', 'Plasma', ['#0d0887', '#46039f', '#7201a8', '#9c179e', '#bd3786', '#d8576b', '#ed7953', '#fb9f3a', '#f0f921']),
  G('viridis', 'Viridis', ['#440154', '#472d7b', '#3b528b', '#2c728e', '#21918c', '#28ae80', '#5ec962', '#addc30', '#fde725']),
  G('cividis', 'Cividis', ['#00204c', '#00336f', '#39486b', '#575d6d', '#707173', '#8a8779', '#a69d75', '#c4b56c', '#ffea46']),
  G('turbo', 'Turbo', ['#30123b', '#4675ed', '#1bcfd4', '#5ef961', '#c1f334', '#f6a327', '#f36315', '#c42503', '#7a0403']),
  G('ladybug', 'Ladybug', ['#4b6ba9', '#7393ca', '#aac8f7', '#c1d5d0', '#f5ef67', '#fce64a', '#ef9c15', '#ea7b00', '#ea2600']),
  G('greys', 'Greys', ['#f7f7f7', '#e3e3e3', '#cccccc', '#b0b0b0', '#8f8f8f', '#6e6e6e', '#4e4e4e', '#303030', '#101010']),
];

/** Default per quantity: heat-like for energy, viridis for light levels, blue-to-yellow for sun hours. */
export const DEFAULT_GRADIENT: Record<string, string> = { radiation: 'inferno', direct: 'inferno', diffuse: 'inferno', irradiance: 'magma', illuminance: 'viridis', sunhours: 'cividis' };
/** Problem-range colours: pure blue under, pure red over. */
export const DEFAULT_BELOW = '#0000ff', DEFAULT_ABOVE = '#ff0000';

export function gradientFor(quantity: string, key?: string): Gradient {
  return GRADIENTS.find((g) => g.key === key) ?? GRADIENTS.find((g) => g.key === DEFAULT_GRADIENT[quantity]) ?? GRADIENTS[3];
}

/** sRGB -> linear per channel: the scales speak the legend sRGB; three.js colour attributes and USD displayColor are linear. */
export const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** '#rrggbb' -> RGB floats 0..1 (anything else -> grey). */
export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return [0.5, 0.5, 0.5];
  return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255) as [number, number, number];
}

const floats = new Map<string, number[][]>();
function stopsOf(g: Gradient): number[][] {
  let s = floats.get(g.key);
  if (!s) { s = g.stops.map(hexToRgb); floats.set(g.key, s); }
  return s;
}

/** RGB (0..1) at t in [0, 1], linear between the stops. */
export function colorAt(g: Gradient, t: number): [number, number, number] {
  const s = stopsOf(g), n = s.length - 1, u = Math.min(Math.max(t, 0), 1), k = Math.min(Math.floor(u * n), n - 1), f = u * n - k;
  return [0, 1, 2].map((c) => s[k][c] + f * (s[k + 1][c] - s[k][c])) as [number, number, number];
}
export const hexAt = (g: Gradient, t: number): string => '#' + colorAt(g, t).map((c) => Math.round(c * 255).toString(16).padStart(2, '0')).join('');

export interface Scale { gradient: Gradient; vmin: number; vmax: number; lo: number | null; hi: number | null; below: string; above: string }

/** A result column's scale: its quantity's gradient, legend domain (the data range unless set), problem range, colours. */
export function scaleFor(values: Float64Array[], columns: string[], column: number, viz: Settings['viz']): Scale {
  const q = columns[column].split('_')[0], { gradients, scales, ranges, colors } = viz, [dmin, dmax] = globalRange(values, column);
  return { gradient: gradientFor(q, gradients[q]), vmin: scales[q]?.min ?? dmin, vmax: scales[q]?.max ?? dmax, lo: ranges[q]?.lo ?? null, hi: ranges[q]?.hi ?? null, below: colors.below, above: colors.above };
}

/** 'below' / 'above' the problem range, else the 0..1 position on the gradient. */
export function place(s: Scale, v: number): 'below' | 'above' | number {
  if (s.lo !== null && v < s.lo) return 'below';
  if (s.hi !== null && v > s.hi) return 'above';
  const span = s.vmax - s.vmin;
  return span > 0 ? Math.min(Math.max((v - s.vmin) / span, 0), 1) : 0;
}

/** Fill for SVG marks: the range colours outside the range, a gradient hex inside. */
export function svgColor(s: Scale, v: number): string {
  const p = place(s, v);
  return p === 'below' ? s.below : p === 'above' ? s.above : hexAt(s.gradient, p);
}

/**
 * RGB floats (3 per value) for three.js. With `dim` = [lo, hi) every value outside that bin fades towards grey, so a
 * hovered histogram bar shows where its elements sit.
 */
export function rgbFor(s: Scale, values: ArrayLike<number>, dim: [number, number] | null): Float32Array {
  const out = new Float32Array(3 * values.length), below = hexToRgb(s.below), above = hexToRgb(s.above);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    let c: ArrayLike<number> = [0.5, 0.5, 0.5];
    if (Number.isFinite(v)) { const p = place(s, v); c = p === 'below' ? below : p === 'above' ? above : colorAt(s.gradient, p); }
    const k = dim && !(v >= dim[0] && v < dim[1]) ? 0.15 : 1;
    for (let j = 0; j < 3; j++) out[3 * i + j] = k * c[j] + (1 - k) * 0.6;
  }
  return out;
}
