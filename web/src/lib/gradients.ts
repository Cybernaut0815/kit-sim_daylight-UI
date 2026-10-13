// Result colour scales: evenly spaced hex stops (matplotlib / Ladybug data colormaps, data not UI chrome), the
// per-quantity defaults, and the "problem range" that paints values outside [lo, hi] in the diverging polarity tokens.
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

export function gradientFor(quantity: string, key?: string): Gradient {
  return GRADIENTS.find((g) => g.key === key) ?? GRADIENTS.find((g) => g.key === DEFAULT_GRADIENT[quantity]) ?? GRADIENTS[3];
}

const floats = new Map<string, number[][]>();
function stopsOf(g: Gradient): number[][] {
  let s = floats.get(g.key);
  if (!s) { s = g.stops.map((h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)); floats.set(g.key, s); }
  return s;
}

/** RGB (0..1) at t in [0, 1], linear between the stops. */
export function colorAt(g: Gradient, t: number): [number, number, number] {
  const s = stopsOf(g), n = s.length - 1, u = Math.min(Math.max(t, 0), 1), k = Math.min(Math.floor(u * n), n - 1), f = u * n - k;
  return [0, 1, 2].map((c) => s[k][c] + f * (s[k + 1][c] - s[k][c])) as [number, number, number];
}
export const hexAt = (g: Gradient, t: number): string => '#' + colorAt(g, t).map((c) => Math.round(c * 255).toString(16).padStart(2, '0')).join('');

export const BELOW_VAR = '--chart-div-neg-3', ABOVE_VAR = '--chart-div-pos-3'; // polarity tokens: under the range / over the range

export interface Scale { gradient: Gradient; vmin: number; vmax: number; lo: number | null; hi: number | null }

/** 'below' / 'above' the problem range, else the 0..1 position on the gradient. */
export function place(s: Scale, v: number): 'below' | 'above' | number {
  if (s.lo !== null && v < s.lo) return 'below';
  if (s.hi !== null && v > s.hi) return 'above';
  const span = s.vmax - s.vmin;
  return span > 0 ? Math.min(Math.max((v - s.vmin) / span, 0), 1) : 0;
}

/** Fill for SVG marks: the polarity tokens outside the range, a gradient hex inside. */
export function svgColor(s: Scale, v: number): string {
  const p = place(s, v);
  return p === 'below' ? `var(${BELOW_VAR})` : p === 'above' ? `var(${ABOVE_VAR})` : hexAt(s.gradient, p);
}

/**
 * RGB floats (3 per value) for three.js. `below` / `above` are the resolved polarity colours; with `dim` = [lo, hi)
 * every value outside that bin fades towards grey, so a hovered histogram bar shows where its elements sit.
 */
export function rgbFor(s: Scale, values: ArrayLike<number>, below: ArrayLike<number>, above: ArrayLike<number>, dim: [number, number] | null): Float32Array {
  const out = new Float32Array(3 * values.length);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    let c: ArrayLike<number> = [0.5, 0.5, 0.5];
    if (Number.isFinite(v)) { const p = place(s, v); c = p === 'below' ? below : p === 'above' ? above : colorAt(s.gradient, p); }
    const k = dim && !(v >= dim[0] && v < dim[1]) ? 0.15 : 1;
    for (let j = 0; j < 3; j++) out[3 * i + j] = k * c[j] + (1 - k) * 0.6;
  }
  return out;
}
