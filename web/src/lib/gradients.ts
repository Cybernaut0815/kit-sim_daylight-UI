// Result colour scales: hex stop gradients (matplotlib / Ladybug data colormaps and ColorBrewer's single-hue ramps:
// data, not UI chrome), the per-quantity defaults, the user's own gradients and edits (a library in the settings), a
// scaling that spreads the values along the gradient (log, square root, square, equalised) and the "problem range"
// that paints values outside [lo, hi] in two user-chosen colours.
// One mapping for everything: position() says where a value sits between Min (0) and Max (1) under the scaling,
// colorAt() the colour there; the legend, the charts, the exports and the 3D view (paintOf) all go through them.
import type { PaintStyle } from 'usd-viewer';
import type { Settings } from '../store';
import { splitColumn } from './result';

/** `positions`: where each stop sits, 0 to 1 ascending, the first 0 and the last 1; absent: evenly spaced. */
export interface Gradient { key: string; label: string; stops: string[]; positions?: number[] }
/** A gradient as the settings keep it (viz.library, by key): the user's own, or a preset as the user changed it. */
export type GradientDef = Omit<Gradient, 'key'>;
/** The most stops a gradient holds (the viewer's paint takes 16). */
export const MAX_STOPS = 16;

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
  // One hue each, light to dark: a share of the view reads as more of that thing (ColorBrewer 9-class sequential schemes,
  // colorbrewer2.org, Cynthia Brewer, Apache 2.0).
  G('blues', 'Blues', ['#f7fbff', '#deebf7', '#c6dbef', '#9ecae1', '#6baed6', '#4292c6', '#2171b5', '#08519c', '#08306b']),
  G('greens', 'Greens', ['#f7fcf5', '#e5f5e0', '#c7e9c0', '#a1d99b', '#74c476', '#41ab5d', '#238b45', '#006d2c', '#00441b']),
  G('oranges', 'Oranges', ['#fff5eb', '#fee6ce', '#fdd0a2', '#fdae6b', '#fd8d3c', '#f16913', '#d94801', '#a63603', '#7f2704']),
  G('purples', 'Purples', ['#fcfbfd', '#efedf5', '#dadaeb', '#bcbddc', '#9e9ac8', '#807dba', '#6a51a3', '#54278f', '#3f007d']),
];

/** Default per daylight quantity: heat-like for energy, viridis for light levels, blue-to-yellow for sun hours. */
export const DEFAULT_GRADIENT: Record<string, string> = { radiation: 'inferno', direct: 'inferno', diffuse: 'inferno', irradiance: 'magma', illuminance: 'viridis', sunhours: 'cividis' };
// The view analysis: each share in the hue of what it sees (sky blue, ground earth, obstruction grey, glass purple, a
// target group green: any other name is one), sizes and distances on the perceptual maps.
const VIEW_GRADIENT: [RegExp, string][] = [[/^sky$/, 'blues'], [/^ground$/, 'oranges'], [/^(ground_)?obstruction$/, 'greys'], [/^glazing$/, 'purples'], [/^(volume|area)$/, 'plasma'], [/distance(_min)?$/, 'viridis'], [/^reach_/, 'cividis']];
const defaultGradient = (quantity: string) => DEFAULT_GRADIENT[quantity] ?? VIEW_GRADIENT.find(([re]) => re.test(quantity))?.[1] ?? 'greens';
/** Problem-range colours: pure blue under, pure red over. */
export const DEFAULT_BELOW = '#0000ff', DEFAULT_ABOVE = '#ff0000';

/** How the values spread along the gradient between Min and Max. */
export type Scaling = 'linear' | 'log' | 'sqrt' | 'square' | 'equalised';
export const SCALINGS: readonly (readonly [Scaling, string, string])[] = [
  ['linear', 'Linear', 'Equal steps of the value get equal steps of colour.'],
  ['log', 'Logarithmic', 'Equal ratios get equal steps of colour: small values spread out, large ones close up (distances, anything over several orders of magnitude). Values at or under zero sit at the low end.'],
  ['sqrt', 'Square root', 'Stretches the low end: small differences between small values show.'],
  ['square', 'Square', 'Stretches the high end: small differences between large values show.'],
  ['equalised', 'Equalised', 'Every colour covers the same number of elements: the gradient follows how the values are spread, so differences show wherever most values lie.'],
];
/** Distances run over orders of magnitude (0.1 m to Far): logarithmic unless set. */
export const defaultScaling = (quantity: string): Scaling => (/distance(_min)?$/.test(quantity) ? 'log' : 'linear');

/** The gradients to choose from: the presets (as the user changed them), then the user's own. */
export function gradientsOf(library: Readonly<Record<string, GradientDef>> = {}): Gradient[] {
  return [...GRADIENTS.map((g) => (library[g.key] ? { key: g.key, ...library[g.key] } : g)), ...Object.entries(library).filter(([key]) => !GRADIENTS.some((g) => g.key === key)).map(([key, g]) => ({ key, ...g }))];
}
export function gradientFor(quantity: string, key?: string, library: Readonly<Record<string, GradientDef>> = {}): Gradient {
  const all = gradientsOf(library);
  return all.find((g) => g.key === key) ?? all.find((g) => g.key === defaultGradient(quantity)) ?? all[3];
}
/** A gradient definition as the settings may hold it, or null: 2 to 16 '#rrggbb' stops; positions (if any) one per
 *  stop, ascending from 0 to 1. */
export function gradientDef(x: unknown): GradientDef | null {
  const g = x as Partial<GradientDef> | null, n = Array.isArray(g?.stops) ? g.stops.length : 0;
  if (!g || n < 2 || n > MAX_STOPS || !g.stops!.every((h) => typeof h === 'string' && /^#[0-9a-f]{6}$/i.test(h))) return null;
  const p = g.positions, ok = Array.isArray(p) && p.length === n && p[0] === 0 && p[n - 1] === 1 && p.every((v, i) => Number.isFinite(v) && (!i || v >= p[i - 1]))
    && p.some((v, i) => Math.abs(v - i / (n - 1)) > 1e-9); // evenly spaced is no positions: such a gradient paints without a map
  return { label: typeof g.label === 'string' && g.label.trim() ? g.label.trim().slice(0, 40) : 'Gradient', stops: g.stops!.map((h) => h.toLowerCase()), ...(ok ? { positions: [...p] } : {}) };
}
/** The gradient turned round: the colours reversed, each stop at 1 - its position. */
export const flipped = (g: GradientDef): GradientDef => ({ ...g, stops: [...g.stops].reverse(), ...(g.positions ? { positions: g.positions.map((p) => 1 - p).reverse() } : {}) });
/** Where the stops sit (even when no positions are set). */
export const positionsOf = (g: GradientDef): number[] => g.positions ?? g.stops.map((_, i) => i / (g.stops.length - 1));

/** sRGB -> linear per channel: the scales speak the legend sRGB; three.js colour attributes and USD displayColor are linear. */
export const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** '#rrggbb' -> RGB floats 0..1 (anything else -> grey). */
export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return [0.5, 0.5, 0.5];
  return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255) as [number, number, number];
}

const floats = new WeakMap<object, number[][]>(); // by the stops array: an edited gradient is a new one
function stopsOf(g: Gradient): number[][] {
  let s = floats.get(g.stops);
  if (!s) { s = g.stops.map(hexToRgb); floats.set(g.stops, s); }
  return s;
}
/** t in [0, 1] -> where it falls among the stops: k + f, between stop k and k + 1 (0 to stops - 1). */
function among(g: Gradient, t: number): number {
  const n = g.stops.length - 1, u = Math.min(Math.max(t, 0), 1), p = g.positions;
  if (!p) return u * n;
  let k = 0;
  while (k < n - 1 && u >= p[k + 1]) k++;
  const span = p[k + 1] - p[k];
  return k + (span > 0 ? Math.min((u - p[k]) / span, 1) : 1);
}
/** RGB (0..1) at t in [0, 1], linear between the stops. */
export function colorAt(g: Gradient, t: number): [number, number, number] {
  const s = stopsOf(g), at = among(g, t), k = Math.min(Math.floor(at), s.length - 2), f = at - k;
  return [0, 1, 2].map((c) => s[k][c] + f * (s[k + 1][c] - s[k][c])) as [number, number, number];
}
export const hexAt = (g: Gradient, t: number): string => '#' + colorAt(g, t).map((c) => Math.round(c * 255).toString(16).padStart(2, '0')).join('');

/** `knots`: the lowest shown value, then the values at evenly spaced quantiles of those above it (equalised), ascending;
 *  null otherwise. */
export interface Scale { gradient: Gradient; vmin: number; vmax: number; lo: number | null; hi: number | null; below: string; above: string; scaling: Scaling; knots: Float64Array | null }

const KNOTS = 256, SAMPLE = 200_000;
/**
 * The equalised scaling's knots for `column` over `results`, within [vmin, vmax]: the lowest value, then the values at
 * KNOTS evenly spaced quantiles of the values above it. The lowest apart, because results often hold many elements at
 * it (no sun, no sky in view): counted with the others they would take the gradient's whole low end as one colour.
 * Null without two different values.
 * ponytail: a stride sample of at most 200k values per result, each element counting once (not by its area)
 */
export function quantileKnots(results: readonly { data: readonly ArrayLike<number>[]; columns: readonly string[] }[], column: string, vmin: number, vmax: number): Float64Array | null {
  const all: number[] = [];
  for (const r of results) {
    const d = r.data[r.columns.indexOf(column)];
    if (!d) continue;
    for (let i = 0, step = Math.max(1, Math.ceil(d.length / SAMPLE)); i < d.length; i += step) if (Number.isFinite(d[i])) all.push(Math.min(Math.max(d[i], vmin), vmax));
  }
  const s = Float64Array.from(all).sort(), above = s.findIndex((v) => v > s[0]);
  if (above < 0) return null;
  return Float64Array.from({ length: KNOTS + 1 }, (_, k) => (k ? s[above + Math.round(((k - 1) / (KNOTS - 1)) * (s.length - 1 - above))] : s[0]));
}

/** A result column's scale: its quantity's gradient, legend domain (`range`, the data's: every shown model's, unless
 *  Min or Max is set), scaling, problem range, colours. `results`: the shown data, read for the equalised scaling. */
export function scaleFor(column: string, [dmin, dmax]: [number, number], viz: Settings['viz'], results: readonly { data: readonly ArrayLike<number>[]; columns: readonly string[] }[] = []): Scale {
  const q = splitColumn(column)[0], { gradients, scales, ranges, colors } = viz;
  const vmin = scales[q]?.min ?? dmin, vmax = scales[q]?.max ?? dmax, scaling = viz.scalings?.[q] ?? defaultScaling(q);
  return {
    gradient: gradientFor(q, gradients[q], viz.library), vmin, vmax, lo: ranges[q]?.lo ?? null, hi: ranges[q]?.hi ?? null, below: colors.below, above: colors.above,
    scaling, knots: scaling === 'equalised' ? quantileKnots(results, column, vmin, vmax) : null,
  };
}

/**
 * Where a value sits along the gradient: 0 at Min, 1 at Max, by the scale's scaling. Never clamped and never flat
 * between two different values of the data (so a threshold keeps its side), finite for every finite value:
 * - log: equal ratios, equal steps, from Min (when positive, else a thousandth of Max); under that floor it runs on
 *   straight, so zero and negative values keep their order;
 * - sqrt / square: of the linear position, signed outside the range;
 * - equalised: the share of the shown values above the lowest that lie at or under it (straight between the quantile
 *   knots, and beyond them).
 */
export function position(s: Scale, v: number): number {
  const { vmin, vmax } = s, span = vmax - vmin;
  if (!(span > 0)) return Number.isNaN(v) ? NaN : 0;
  const t = (v - vmin) / span;
  if (s.scaling === 'log') {
    const floor = vmin > 0 ? vmin : vmax * 1e-3, decades = Math.log(vmax / floor);
    if (!(floor > 0 && decades > 0)) return t; // nothing positive: as linear
    return (v > floor ? Math.log(v / floor) : v / floor - 1) / decades;
  }
  if (s.scaling === 'sqrt') return Math.sign(t) * Math.sqrt(Math.abs(t));
  if (s.scaling === 'square') return Math.sign(t) * t * t;
  const k = s.scaling === 'equalised' ? s.knots : null;
  if (!k || !(k[k.length - 1] > k[0])) return t;
  const n = k.length - 1;
  if (v <= k[0]) return (v - k[0]) / span;
  if (v >= k[n]) return 1 + (v - k[n]) / span;
  let a = 0, b = n; // the last knot at or under v (k[a] <= v < k[b]): tied knots (many equal values) count as under it
  while (b - a > 1) { const m = (a + b) >> 1; if (k[m] <= v) a = m; else b = m; }
  return (a + (v - k[a]) / (k[b] - k[a])) / n;
}

/** 'below' / 'above' the problem range, else the 0..1 position on the gradient. */
export function place(s: Scale, v: number): 'below' | 'above' | number {
  if (s.lo !== null && v < s.lo) return 'below';
  if (s.hi !== null && v > s.hi) return 'above';
  return Math.min(Math.max(position(s, v), 0), 1) || 0;
}

/** Fill for SVG marks: the range colours outside the range, a gradient hex inside. */
export function svgColor(s: Scale, v: number): string {
  const p = place(s, v);
  return p === 'below' ? s.below : p === 'above' ? s.above : hexAt(s.gradient, p);
}

/**
 * The scale as the viewer's paint draws it on the GPU (usd.paintStyle, usd.paint): the same colours as rgbFor. The
 * viewer maps a value linearly between a min and a max onto evenly spaced stops, so:
 * - a linear scale with even stops goes as it is: the result's own values, the domain and the problem range as
 *   uniforms (`map` null: a new range or bin restyles, nothing is painted again);
 * - any other (a scaling, moved stops) paints `map(value)` instead, the value's place among the stops (0 to 1; beyond
 *   for values outside the range, so the problem range and the hovered bin still split them), with every threshold
 *   through the same map. `key` names the map: the values are painted again when it changes.
 */
export function paintOf(s: Scale): { key: string; map: ((v: number) => number) | null; style: (dim: [number, number] | null) => PaintStyle } {
  const stops = s.gradient.stops, plain = s.scaling === 'linear' && !s.gradient.positions, n = stops.length - 1;
  const map = (v: number) => { const p = position(s, v); return p >= 0 && p <= 1 ? among(s.gradient, p) / n : p; };
  const at = plain ? (v: number) => v : map;
  return {
    key: plain ? '' : `${s.scaling}|${s.vmin}|${s.vmax}|${s.gradient.positions?.join()}|${s.knots?.join()}`,
    map: plain ? null : map,
    style: (dim) => ({
      stops, min: plain ? s.vmin : 0, max: plain ? s.vmax : 1,
      below: s.lo === null ? null : { value: at(s.lo), color: s.below },
      above: s.hi === null ? null : { value: at(s.hi), color: s.above },
      band: dim && [at(dim[0]), at(dim[1])],
    }),
  };
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
