// Result maths: element weights (areas), per-mesh statistics, histogram bins, the summary every quoted number comes
// from, units and number formatting. A result is read one column at a time (RunResult.data[c]: the column's value per
// row); weights[k] are the element areas of groups[k], index 0 at its first row.
export interface Group { first: number; count: number }

/** Triangle areas 0.5 * |(b - a) x (c - a)|, one per face. */
export function faceAreas(positions: ArrayLike<number>, indices: ArrayLike<number>): Float64Array {
  const n = indices.length / 3, out = new Float64Array(n);
  for (let f = 0; f < n; f++) {
    const a = 3 * indices[3 * f], b = 3 * indices[3 * f + 1], c = 3 * indices[3 * f + 2];
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx;
    out[f] = 0.5 * Math.sqrt(x * x + y * y + z * z);
  }
  return out;
}

/** Each face's area split equally over its three vertices (Σ equals Σ faceAreas). */
export function vertexAreas(positions: ArrayLike<number>, indices: ArrayLike<number>): Float64Array {
  const fa = faceAreas(positions, indices), out = new Float64Array(positions.length / 3);
  for (let f = 0; f < fa.length; f++) { const w = fa[f] / 3; out[indices[3 * f]] += w; out[indices[3 * f + 1]] += w; out[indices[3 * f + 2]] += w; }
  return out;
}

export interface Stats { count: number; min: number; max: number; mean: number; total: number; area: number }

/** One mesh's column: min, max, area-weighted mean, Σ weight × value (the donut share) over its rows [first, first + count). */
export function columnStats(col: ArrayLike<number>, g: Group, weights: ArrayLike<number>): Stats {
  let min = Infinity, max = -Infinity, total = 0, area = 0;
  for (let i = 0; i < g.count; i++) {
    const v = col[g.first + i];
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
    total += v * weights[i];
    area += weights[i];
  }
  return { count: g.count, min, max, mean: area ? total / area : NaN, total, area };
}

/** Finite [min, max] of one column over all rows. */
export function globalRange(col: ArrayLike<number>): [number, number] {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < col.length; i++) { const v = col[i]; if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } }
  return [lo, hi];
}

/** Finite [min, max] of the column named `name` over several results (one without it adds nothing): one colour scale
 *  for every model. */
export function unionRange(results: readonly { data: readonly ArrayLike<number>[]; columns: readonly string[] }[], name: string): [number, number] {
  let lo = Infinity, hi = -Infinity;
  for (const r of results) {
    const c = r.columns.indexOf(name);
    if (c < 0) continue;
    const [a, b] = globalRange(r.data[c]);
    lo = Math.min(lo, a);
    hi = Math.max(hi, b);
  }
  return [lo, hi];
}

/**
 * Fixed bins over `range` (default the column's global range); `shares[bin]` = share of the total weight (area),
 * `counts[bin]` = elements; every finite row inside the range lands in exactly one bin, `below` / `above` = the shares
 * outside it. `weights[k]` belongs to `groups[k]`.
 */
export function histogram(col: ArrayLike<number>, groups: Group[], weights: ArrayLike<number>[], bins = 24, range = globalRange(col)): { edges: number[]; shares: number[]; counts: number[]; below: number; above: number } {
  const [lo, hi] = range, span = hi - lo || 1;
  const edges = Array.from({ length: bins + 1 }, (_, i) => lo + (span * i) / bins);
  const shares = new Array<number>(bins).fill(0), counts = new Array<number>(bins).fill(0);
  let total = 0, below = 0, above = 0;
  groups.forEach((g, k) => {
    for (let i = 0; i < g.count; i++) {
      const v = col[g.first + i], w = weights[k][i];
      if (!Number.isFinite(v)) continue;
      total += w;
      if (v < lo) below += w;
      else if (v > hi) above += w;
      else {
        const b = Math.min(Math.floor(((v - lo) / span) * bins), bins - 1);
        shares[b] += w;
        counts[b]++;
      }
    }
  });
  return { edges, shares: total ? shares.map((s) => s / total) : shares, counts, below: total ? below / total : 0, above: total ? above / total : 0 };
}

/** Values ascending with the cumulative share of weight (area) at or below each: percentiles, range shares, the area curve. */
export interface Cumulative { v: Float32Array; cw: Float64Array }

/**
 * The finite values in ascending order, in O(n) (a comparison sort of 17M values took 5-20 s): an LSD radix sort, 4
 * passes of 8 bits (a pass whose digit every value shares is skipped), of the float32 bits made order-preserving, carrying
 * each value's weight. Radix sorting is stable, so equal values keep the rows' order and every sum is the one a stable
 * sort by value gives. Values and weights are read as float32, which results are: nothing is rounded.
 */
export function cumulative(col: ArrayLike<number>, groups: Group[], weights: ArrayLike<number>[]): Cumulative {
  let n = 0;
  for (const g of groups) for (let i = 0; i < g.count; i++) if (Number.isFinite(col[g.first + i])) n++;
  let key = new Uint32Array(n), w = new Float32Array(n), key2 = new Uint32Array(n), w2 = new Float32Array(n);
  const f = new Float32Array(key.buffer), counts = new Uint32Array(4 * 256);
  n = 0;
  groups.forEach((g, k) => { for (let i = 0; i < g.count; i++) { const v = col[g.first + i]; if (Number.isFinite(v)) { f[n] = v + 0; w[n++] = weights[k][i]; } } }); // + 0: -0 ties with 0 (and comes back as 0)
  for (let i = 0; i < n; i++) { // negative: every bit flipped (the larger magnitude first); positive: above them all
    const b = key[i], u = (key[i] = b & 0x80000000 ? ~b : b | 0x80000000);
    counts[u & 255]++; counts[256 + ((u >>> 8) & 255)]++; counts[512 + ((u >>> 16) & 255)]++; counts[768 + (u >>> 24)]++;
  }
  for (let d = 0; d < 4; d++) {
    const c = counts.subarray(256 * d, 256 * (d + 1)), s = 8 * d;
    if (!n || c[(key[0] >>> s) & 255] === n) continue;
    for (let j = 0, at = 0; j < 256; j++) { const m = c[j]; c[j] = at; at += m; }
    for (let i = 0; i < n; i++) { const u = key[i], p = c[(u >>> s) & 255]++; key2[p] = u; w2[p] = w[i]; }
    [key, key2, w, w2] = [key2, key, w2, w];
  }
  for (let i = 0; i < n; i++) { const u = key[i]; key[i] = u & 0x80000000 ? u ^ 0x80000000 : ~u; } // the float bits again
  const v = new Float32Array(key.buffer), cw = new Float64Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) cw[i] = acc += w[i];
  const total = acc || 1;
  for (let i = 0; i < n; i++) cw[i] /= total;
  return { v, cw };
}

const firstIndex = (c: Cumulative, pred: (x: number) => boolean) => { let lo = 0, hi = c.v.length; while (lo < hi) { const m = (lo + hi) >> 1; if (pred(c.v[m])) hi = m; else lo = m + 1; } return lo; };

/** Share of the area whose value is strictly below x. */
export function shareBelow(c: Cumulative, x: number): number { const i = firstIndex(c, (v) => v >= x); return i === 0 ? 0 : c.cw[i - 1]; }
/** Share of the area whose value is strictly above x. */
export function shareAbove(c: Cumulative, x: number): number { const i = firstIndex(c, (v) => v > x); return i === 0 ? 1 : Math.max(0, 1 - c.cw[i - 1]); }
/** Smallest value whose cumulative area share reaches p (0..1); NaN without data. */
export function percentile(c: Cumulative, p: number): number {
  const n = c.v.length;
  if (!n) return NaN;
  let lo = 0, hi = n - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (c.cw[m] < p) lo = m + 1; else hi = m; }
  return c.v[lo];
}
/** Area shares under / inside / over the problem range (null bound = open). */
export function rangeShares(c: Cumulative, lo: number | null, hi: number | null): { below: number; within: number; above: number } {
  const below = lo === null ? 0 : shareBelow(c, lo), above = hi === null ? 0 : shareAbove(c, hi);
  return { below, above, within: Math.max(0, 1 - below - above) };
}

export interface Summary { elements: number; area: number; min: number; p10: number; median: number; mean: number; p90: number; max: number; total: number; below: number; within: number; above: number; atLeast: number[] }

/**
 * One column over groups of rows (`weights[k]` belongs to `groups[k]`), area-weighted: the one source of the numbers the
 * tools, the charts and the reports quote. below / within / above: the shares of the problem range [lo, hi] (null =
 * open); atLeast[i]: the share at or above thresholds[i]. Values and shares are NaN where no element has a value.
 */
export function summarize(col: ArrayLike<number>, groups: Group[], weights: ArrayLike<number>[], lo: number | null = null, hi: number | null = null, thresholds: readonly number[] = []): Summary {
  const s = groups.map((g, k) => columnStats(col, g, weights[k])), c = cumulative(col, groups, weights), n = c.v.length;
  const sum = (f: (x: Stats) => number) => s.reduce((a, x) => a + f(x), 0), area = sum((x) => x.area), total = sum((x) => x.total);
  const share = (v: number) => (n ? v : NaN), r = rangeShares(c, lo, hi); // the shares of nothing would read as "all above"
  return {
    elements: sum((x) => x.count), area, min: n ? c.v[0] : NaN, p10: percentile(c, 0.1), median: percentile(c, 0.5), mean: area ? total / area : NaN,
    p90: percentile(c, 0.9), max: n ? c.v[n - 1] : NaN, total, below: share(r.below), within: share(r.within), above: share(r.above),
    atLeast: thresholds.map((x) => share(1 - shareBelow(c, x))),
  };
}

const UNITS: Record<string, [string, string]> = {
  radiation: ['kWh/m²', 'kWh'], direct: ['kWh/m²', 'kWh'], diffuse: ['kWh/m²', 'kWh'],
  irradiance: ['W/m²', 'W'], illuminance: ['lx', 'lm'], sunhours: ['h', 'h·m²'],
};

/** What each result column means, in plain words, shown under the column selector. */
export const QUANTITY_HELP: Record<string, string> = {
  radiation: 'Solar energy received over the period, kWh per m²: sun, sky and ground light weighted by their angle on the surface, minus what the scene blocks (with Transmission on, glass, screens and trees let their share through), plus what it reflects with Reflections on. The basis for solar gains, overheating and PV yield.',
  direct: 'Only the beam from the sun disc, kWh/m² over the period, times the transmittance of the glass, screens and trees it crosses when Transmission is on. Zero whenever the sun is down or hidden behind solid geometry, so it shows where shading works.',
  diffuse: 'Only sky and ground-reflected light, kWh/m² over the period, plus the light the scene reflects when Reflections are on. Smooth and hardly changed by small obstructions; the larger share in overcast climates.',
  irradiance: 'Average power received, W/m², over the evaluated hours (for one instant, the value at that moment). A clear noon on a sun-facing surface gives about 1,000 W/m².',
  illuminance: 'Average daylight level, lux, over the evaluated hours, nights included. Task targets such as 300 to 500 lx for desk work apply to an instant or to occupied hours only; a clear day outdoors gives 50,000 lx and more.',
  sunhours: 'Hours in the period when the sun is up and not blocked by any geometry; no weather: the classic solar-access measure (EN 17037, BRE sunlight checks). With Transmission on, equivalent full-sun hours: an hour behind a surface transmitting 0.6 counts 0.6; for EN 17037 / BRE window checks set the glazing to Opening, or its mesh to Ignore.',
};
export const SIDE_HELP: Record<string, string> = { front: 'Front side: where the face normal points.', back: 'Back side: opposite the face normal.' };

/** Column name 'radiation_front' -> per-element and area-integrated units. */
export function unitFor(column: string): { value: string; total: string } {
  const [value, total] = UNITS[column.split('_')[0]] ?? ['', ''];
  return { value, total };
}

/** 'radiation_front' -> 'Radiation, front', 'sunhours_back' -> 'Sun hours, back'; a quantity alone -> 'Sun hours'. */
export const columnLabel = (column: string): string => { const [q, side] = column.split('_'); return `${q === 'sunhours' ? 'Sun hours' : `${q[0].toUpperCase()}${q.slice(1)}`}${side ? `, ${side}` : ''}`; };

/** The number fmtNum shows: 3 significant digits below 1000, whole above (the tools quote what the app and the PDF show). */
export const roundNum = (v: number): number => (Math.abs(v) >= 1000 ? Math.round(v) : Number(v.toPrecision(3)));
/** A share (0..1) as the percent ui.tsx pct shows: whole, one decimal under 10 %. */
export const roundPct = (x: number): number => Number((100 * x).toFixed(x > 0 && x < 0.1 ? 1 : 0));

/** Compact tabular number: 3 significant digits below 1000, thousands grouped above. */
export function fmtNum(v: number): string {
  if (!Number.isFinite(v)) return '–';
  return Math.abs(v) >= 1000 ? roundNum(v).toLocaleString('en-GB') : roundNum(v).toString();
}

/** A difference to the reference model, signed, in the value's format; '' when either side has none. */
export const fmtDiff = (d: number, fmt: (v: number) => string = fmtNum): string => (Number.isFinite(d) ? `${d > 0 ? '+' : d < 0 ? '−' : '±'}${fmt(Math.abs(d))}` : '');
