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

/** Fixed bins over `range` (default the column's global range); counts[group][bin]; every finite row lands in exactly one bin. */
export function histogram(values: Float64Array[], col: number, groups: Group[], bins = 24, range = globalRange(values, col)): { edges: number[]; counts: number[][] } {
  const [lo, hi] = range, span = hi - lo || 1;
  const edges = Array.from({ length: bins + 1 }, (_, i) => lo + (span * i) / bins);
  const counts = groups.map((g) => {
    const c = new Array<number>(bins).fill(0);
    for (let i = g.first; i < g.first + g.count; i++) {
      const v = values[i][col];
      if (Number.isFinite(v)) c[Math.min(Math.floor(((v - lo) / span) * bins), bins - 1)]++;
    }
    return c;
  });
  return { edges, counts };
}

const UNITS: Record<string, [string, string]> = {
  radiation: ['kWh/m²', 'kWh'], direct: ['kWh/m²', 'kWh'], diffuse: ['kWh/m²', 'kWh'],
  irradiance: ['W/m²', 'W'], illuminance: ['lx', 'lm'], sunhours: ['h', 'h·m²'],
};

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
