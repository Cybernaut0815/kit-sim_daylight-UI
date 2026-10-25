// Result maths: element weights (areas), per-mesh statistics, histogram bins, units and number formatting.
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
export function columnStats(values: Float64Array[], col: number, g: Group, weights: ArrayLike<number>): Stats {
  let min = Infinity, max = -Infinity, total = 0, area = 0;
  for (let i = 0; i < g.count; i++) {
    const v = values[g.first + i][col];
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
    total += v * weights[i];
    area += weights[i];
  }
  return { count: g.count, min, max, mean: area ? total / area : NaN, total, area };
}

/** Finite [min, max] of one column over all rows. */
export function globalRange(values: Float64Array[], col: number): [number, number] {
  let lo = Infinity, hi = -Infinity;
  for (const row of values) { const v = row[col]; if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } }
  return [lo, hi];
}

/**
 * Fixed bins over `range` (default the column's global range); `shares[bin]` = share of the total weight (area),
 * `counts[bin]` = elements; every finite row inside the range lands in exactly one bin, `below` / `above` = the shares
 * outside it. `weights[k]` belongs to `groups[k]`.
 */
export function histogram(values: Float64Array[], col: number, groups: Group[], weights: ArrayLike<number>[], bins = 24, range = globalRange(values, col)): { edges: number[]; shares: number[]; counts: number[]; below: number; above: number } {
  const [lo, hi] = range, span = hi - lo || 1;
  const edges = Array.from({ length: bins + 1 }, (_, i) => lo + (span * i) / bins);
  const shares = new Array<number>(bins).fill(0), counts = new Array<number>(bins).fill(0);
  let total = 0, below = 0, above = 0;
  groups.forEach((g, k) => {
    for (let i = 0; i < g.count; i++) {
      const v = values[g.first + i][col], w = weights[k][i];
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
export interface Cumulative { v: Float64Array; cw: Float64Array }

export function cumulative(values: Float64Array[], col: number, groups: Group[], weights: ArrayLike<number>[]): Cumulative {
  const pairs: [number, number][] = [];
  groups.forEach((g, k) => { for (let i = 0; i < g.count; i++) { const v = values[g.first + i][col]; if (Number.isFinite(v)) pairs.push([v, weights[k][i]]); } });
  pairs.sort((a, b) => a[0] - b[0]);
  const total = pairs.reduce((s, p) => s + p[1], 0) || 1, v = new Float64Array(pairs.length), cw = new Float64Array(pairs.length);
  let acc = 0;
  pairs.forEach((p, i) => { v[i] = p[0]; acc += p[1]; cw[i] = acc / total; });
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
  illuminance: 'Average daylight level, lux, over the evaluated hours. Compare with task targets such as 300 to 500 lx for desk work; a clear day outdoors gives 50,000 lx and more.',
  sunhours: 'Hours in the period when the sun is up and not blocked by any geometry; no weather: the classic solar-access and right-to-light measure. With Transmission on, equivalent full-sun hours: an hour behind a surface transmitting 0.6 counts 0.6; for EN 17037 / BRE window checks set the glazing to Opening, or its mesh to Ignore.',
};
export const SIDE_HELP: Record<string, string> = { front: 'Front side: where the face normal points.', back: 'Back side: opposite the face normal.' };

/** Column name 'radiation_front' -> per-element and area-integrated units. */
export function unitFor(column: string): { value: string; total: string } {
  const [value, total] = UNITS[column.split('_')[0]] ?? ['', ''];
  return { value, total };
}

/** 'radiation_front' -> 'Radiation, front'. */
export const columnLabel = (column: string): string => { const [q, side] = column.split('_'); return `${q[0].toUpperCase()}${q.slice(1)}${side ? `, ${side}` : ''}`; };

/** Compact tabular number: 3 significant digits below 1000, thousands grouped above. */
export function fmtNum(v: number): string {
  if (!Number.isFinite(v)) return '–';
  if (Math.abs(v) >= 1000) return Math.round(v).toLocaleString('en-GB');
  return Number(v.toPrecision(3)).toString();
}
