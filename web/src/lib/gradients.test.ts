import { describe, expect, it } from 'vitest';
import type { PaintStyle } from 'usd-viewer';
import { addStop, colorAt, defaultScaling, flipped, gradientDef, gradientFor, GRADIENTS, gradientsOf, hexAt, hexToRgb, lin, MAX_STOPS, moveStop, paintOf, place, position, positionsOf, quantileKnots, removeStop, rgbFor, scaleFor, svgColor, type Gradient, type Scale } from './gradients';

const grey: Gradient = { key: 'g', label: 'g', stops: ['#000000', '#ffffff'] };
const scale: Scale = { gradient: grey, vmin: 0, vmax: 10, lo: 2, hi: 8, below: '#0000ff', above: '#ff0000', scaling: 'linear', knots: null };
const VIZ = { gradients: {}, scales: {}, ranges: {}, colors: { below: '#0000ff', above: '#ff0000' }, scalings: {}, library: {} };

describe('gradients', () => {
  it('interpolates between stops and formats hex', () => {
    expect(colorAt(grey, 0)).toEqual([0, 0, 0]);
    expect(colorAt(grey, 1)).toEqual([1, 1, 1]);
    expect(hexAt(grey, 0.5)).toBe('#808080');
    expect(colorAt(grey, 2)).toEqual([1, 1, 1]); // clamped
    expect(hexAt(gradientFor('radiation'), 0)).toBe('#000004'); // inferno by default
    expect(gradientFor('radiation', 'viridis').key).toBe('viridis');
    expect(gradientFor('radiation', 'nope').key).toBe('inferno'); // a gradient that is gone: the quantity's default
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
});

describe('the defaults per result', () => {
  it('every view result has a gradient of its own kind; any other name is a target group', () => {
    const key = (q: string) => gradientFor(q).key;
    expect(['sky', 'ground', 'obstruction', 'obstruction_total', 'glazing', 'volume', 'area', 'distance', 'distance_min', 'water_distance', 'reach_20', 'water', 'green_park'].map(key))
      .toEqual(['blues', 'oranges', 'greys', 'greys', 'purples', 'plasma', 'plasma', 'viridis', 'viridis', 'viridis', 'cividis', 'greens', 'greens']);
    expect(['radiation', 'sunhours', 'illuminance'].map(key)).toEqual(['inferno', 'cividis', 'viridis']);
    expect(['distance', 'water_distance_min', 'sky', 'radiation'].map(defaultScaling)).toEqual(['log', 'log', 'linear', 'linear']);
  });
  it('the one-hue ramps run from light to dark, step by step', () => {
    const luma = (hex: string) => { const [r, g, b] = hexToRgb(hex).map(lin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    for (const k of ['blues', 'greens', 'oranges', 'purples', 'greys']) {
      const l = GRADIENTS.find((g) => g.key === k)!.stops.map(luma);
      expect(l.every((v, i) => !i || v < l[i - 1]), k).toBe(true);
    }
  });
});

describe('the library: the gradients the user made or changed', () => {
  const mine = { label: 'Mine', stops: ['#ff0000', '#00ff00', '#0000ff'], positions: [0, 0.2, 1] };
  it('a preset key holds that preset as changed; other keys come after the presets', () => {
    const all = gradientsOf({ viridis: { label: 'Viridis', stops: ['#000000', '#ffffff'] }, 'custom-1': mine });
    expect([all.length, all[3].stops, all.at(-1)!.key]).toEqual([GRADIENTS.length + 1, ['#000000', '#ffffff'], 'custom-1']);
    expect(gradientFor('sky', 'custom-1', { 'custom-1': mine }).label).toBe('Mine');
    expect(gradientFor('illuminance', undefined, { viridis: { label: 'V', stops: ['#000000', '#ffffff'] } }).stops).toEqual(['#000000', '#ffffff']);
  });
  it('gradientDef keeps what is a gradient: 2 to 16 hex stops, positions ascending within 0 to 1 (even ones are dropped)', () => {
    expect(gradientDef(mine)).toEqual(mine);
    expect(gradientDef({ ...mine, positions: [0.2, 0.5, 0.8] })?.positions).toEqual([0.2, 0.5, 0.8]); // the ends moved inward
    expect(gradientDef({ ...mine, positions: [0, 0.5, 1.2] })).toEqual({ label: 'Mine', stops: mine.stops }); // outside 0 to 1
    expect(gradientDef({ ...mine, positions: [0, 0.5, 1] })).toEqual({ label: 'Mine', stops: mine.stops }); // even: as none
    expect(gradientDef({ ...mine, positions: [0, 0.9, 0.5] })).toEqual({ label: 'Mine', stops: mine.stops }); // not ascending to 1
    expect(gradientDef({ label: '', stops: ['#FF0000', '#00ff00'] })).toEqual({ label: 'Gradient', stops: ['#ff0000', '#00ff00'] });
    for (const bad of [null, {}, { stops: ['#ff0000'] }, { stops: ['red', 'blue'] }, { stops: Array(17).fill('#000000') }]) expect(gradientDef(bad)).toBeNull();
  });
  it('moved stops: the colour between two stops by where they sit; flipped turns colours and positions round', () => {
    const g: Gradient = { key: 'm', ...mine };
    expect(colorAt(g, 0.1)).toEqual([0.5, 0.5, 0]); // half way to the stop at 0.2
    expect(colorAt(g, 0.6)).toEqual([0, 0.5, 0.5]);
    expect(colorAt(g, 0.2)).toEqual([0, 1, 0]);
    const f = flipped(mine);
    expect([f.stops, f.positions!.map((p) => +p.toFixed(6))]).toEqual([['#0000ff', '#00ff00', '#ff0000'], [0, 0.8, 1]]);
    expect(colorAt({ key: 'f', ...f }, 0.9)).toEqual(colorAt(g, 0.1).map((c) => expect.closeTo(c, 9)));
  });
  it('the editor\'s steps: a stop moved between its neighbours, added in the colour there, removed (two stay)', () => {
    const even = { label: 'E', stops: ['#000000', '#808080', '#ffffff'] };
    expect(moveStop(even, 1, 0.25).positions).toEqual([0, 0.25, 1]);
    expect(moveStop(even, 1, 7).positions).toEqual([0, 1, 1]); // not past its neighbour
    expect(moveStop(even, 0, 0.3).positions).toEqual([0.3, 0.5, 1]); // an end stop moves too
    expect(moveStop(even, 2, -1).positions).toEqual([0, 0.5, 0.5]);
    const added = addStop(mine, 0.6)!;
    expect([added.index, added.gradient.stops, added.gradient.positions]).toEqual([2, ['#ff0000', '#00ff00', '#008080', '#0000ff'], [0, 0.2, 0.6, 1]]); // half way from green to blue
    expect(addStop({ label: 'F', stops: Array<string>(MAX_STOPS).fill('#000000') }, 0.5)).toBeNull();
    expect(removeStop(mine, 0)).toEqual({ label: 'Mine', stops: ['#00ff00', '#0000ff'], positions: [0.2, 1] });
    expect(removeStop({ label: 'T', stops: ['#000000', '#ffffff'] }, 0).stops).toHaveLength(2);
    expect(positionsOf(even)).toEqual([0, 0.5, 1]);
  });
  it('end stops moved inward: their colours hold to the edges', () => {
    const g: Gradient = { key: 'i', label: 'i', stops: ['#ff0000', '#0000ff'], positions: [0.25, 0.75] };
    expect([colorAt(g, 0), colorAt(g, 0.25), colorAt(g, 0.5), colorAt(g, 0.9)]).toEqual([[1, 0, 0], [1, 0, 0], [0.5, 0, 0.5], [0, 0, 1]]);
  });
});

describe('scalings: where a value sits between Min and Max', () => {
  const of = (scaling: Scale['scaling'], more: Partial<Scale> = {}): Scale => ({ ...scale, lo: null, hi: null, scaling, ...more });
  it('log: equal ratios, equal steps; zero and negative values stay finite, in order, at the low end', () => {
    const s = of('log', { vmin: 0.1, vmax: 1000 });
    expect([0.1, 1, 10, 100, 1000].map((v) => +position(s, v).toFixed(9))).toEqual([0, 0.25, 0.5, 0.75, 1]);
    const p = [-5, 0, 0.05, 0.1].map((v) => position(s, v));
    expect(p.every(Number.isFinite) && p.every((v, i) => !i || v > p[i - 1])).toBe(true);
    expect(place(s, 0)).toBe(0);
    const z = of('log', { vmin: 0, vmax: 1 }); // a share from 0: three decades under Max
    expect([position(z, 0.001), position(z, 1)].map((v) => +v.toFixed(9))).toEqual([0, 1]);
    expect(place(z, 0)).toBe(0);
    expect(position(of('log', { vmin: -3, vmax: 0 }), -1.5)).toBe(0.5); // nothing positive: as linear
  });
  it('sqrt stretches the low end, square the high end; both keep 0, 1 and the order outside', () => {
    expect([0, 2.5, 10, 40].map((v) => position(of('sqrt'), v))).toEqual([0, 0.5, 1, 2]);
    expect([0, 5, 10, -10].map((v) => position(of('square'), v))).toEqual([0, 0.25, 1, -1]);
  });
  it('equalised: the share of the shown values above the lowest that lie under a value', () => {
    const data = Float32Array.from({ length: 1000 }, (_, i) => (i < 500 ? 0 : i < 900 ? 1 + (i - 500) / 400 : 100)); // half 0, 40 % from 1 to 2, a tenth at 100
    const knots = quantileKnots([{ data: [data], columns: ['x'] }], 'x', 0, 100)!, s = of('equalised', { vmax: 100, knots });
    expect(position(s, 0)).toBe(0); // the half at 0: the low end, one colour
    expect(position(s, 1)).toBeCloseTo(0, 2); // the lowest of the rest
    expect(position(s, 2)).toBeCloseTo(0.8, 2); // 400 of the 500 above 0 lie under 2
    expect(position(s, 100)).toBe(1);
    expect(quantileKnots([{ data: [Float32Array.of(3, 3, 3)], columns: ['x'] }], 'x', 0, 10)).toBeNull(); // one value: nothing to spread
    expect(position(s, 1.5)).toBeGreaterThan(position(s, 1.25));
    expect(scaleFor('x', [0, 100], { ...VIZ, scalings: { x: 'equalised' } }, [{ data: [data], columns: ['x'] }]).knots).toEqual(knots);
    expect(position(of('equalised'), 5)).toBe(0.5); // no knots (no data given): as linear
  });
  it('a column with _ in its quantity keys its own scale (distance_min apart from distance)', () => {
    const viz = { ...VIZ, scales: { distance: { min: 1, max: 2 }, distance_min: { min: 5, max: 6 } }, scalings: { sky: 'sqrt' as const } };
    expect([scaleFor('distance_min_front', [0, 9], viz).vmin, scaleFor('distance_front', [0, 9], viz).vmin, scaleFor('sky_front', [0, 1], viz).vmin]).toEqual([5, 1, 0]);
    expect([scaleFor('distance_front', [0, 9], viz).scaling, scaleFor('sky_front', [0, 1], viz).scaling, scaleFor('ground_front', [0, 1], viz).scaling]).toEqual(['log', 'sqrt', 'linear']);
  });
});

describe('the 3D view paints as the legend draws', () => {
  // USD_WebViewer materials.ts paintLook's shader, in JS (its e2e test checks the GPU against the same legend)
  const shade = (p: PaintStyle, v: number) => {
    const s = p.stops.map(hexToRgb), last = s.length - 1, span = p.max - p.min;
    const u = (span > 0 ? Math.min(Math.max((v - p.min) / span, 0), 1) : 0) * last, k = Math.min(Math.floor(u), last - 1);
    const c = !Number.isFinite(v) ? [0.5, 0.5, 0.5] : p.below && v < p.below.value ? hexToRgb(p.below.color) : p.above && v > p.above.value ? hexToRgb(p.above.color)
      : s[k].map((x, j) => x + (u - k) * (s[k + 1][j] - x));
    const bands = !p.band ? null : Array.isArray(p.band[0]) ? (p.band as [number, number][]) : [p.band as [number, number]]; // one range or several
    return bands && !bands.some((b) => v >= b[0] && v < b[1]) ? c.map((x) => 0.15 * x + 0.51) : c;
  };
  const values = [-1, 0, 0.004, 1.9, 2, 3.3, 5, 7.7, 8, 8.1, 10, 11, NaN];
  const moved: Gradient = { key: 'm', label: 'm', stops: ['#ff0000', '#00ff00', '#0000ff', '#ffffff'], positions: [0, 0.1, 0.7, 1] };
  const knots = quantileKnots([{ data: [Float32Array.from({ length: 400 }, (_, i) => (i % 7) * (i % 5) * 0.4)], columns: ['x'] }], 'x', 0, 10);
  const scales: [string, Scale][] = [
    ['linear', scale], ['inferno, no problem range', { ...scale, gradient: GRADIENTS[0], lo: null, hi: null }], ['no span', { ...scale, vmax: 0 }],
    ['log', { ...scale, scaling: 'log' }], ['log from 0.5', { ...scale, scaling: 'log', vmin: 0.5 }], ['sqrt', { ...scale, scaling: 'sqrt', gradient: GRADIENTS[3] }], ['square', { ...scale, scaling: 'square' }],
    ['equalised', { ...scale, scaling: 'equalised', knots }], ['moved stops', { ...scale, gradient: moved }], ['moved stops, log', { ...scale, gradient: moved, scaling: 'log' }],
    ['end stops moved inward', { ...scale, gradient: { ...moved, positions: [0.2, 0.3, 0.7, 0.9] } }],
  ];
  it.each(scales)('%s: the paint style and map colour as rgbFor does, also with a bin hovered', (_name, s) => {
    const paint = paintOf(s);
    for (const dim of [null, [3, 6]] as const) {
      const want = rgbFor(s, values, dim ? [...dim] : null), style = paint.style(dim ? [[...dim]] : null);
      values.forEach((v, i) => shade(style, paint.map ? paint.map(v) : v).forEach((c, j) => expect(c, `value ${v}`).toBeCloseTo(want[3 * i + j], 6)));
    }
  });
  it('a linear scale with even stops needs no map (uniforms only); any other names its map, so the values paint again', () => {
    expect([paintOf(scale).map, paintOf(scale).key]).toEqual([null, '']);
    const log = paintOf({ ...scale, scaling: 'log' });
    expect(log.map).not.toBeNull();
    expect(log.key).not.toBe(paintOf({ ...scale, scaling: 'log', vmax: 20 }).key);
    expect(paintOf({ ...scale, gradient: moved }).key).not.toBe('');
    expect(paintOf({ ...scale, scaling: 'log' }).style(null)).toMatchObject({ min: 0, max: 1, band: null });
    // several ranges kept bright (bars selected apart): each through the map, in order
    expect(paintOf(scale).style([[1, 2], [5, 6]]).band).toEqual([[1, 2], [5, 6]]);
    const bands = paintOf({ ...scale, scaling: 'sqrt' }).style([[0, 2.5], [2.5, 10]]).band as [number, number][];
    expect(bands.map((b) => b.map((v) => +v.toFixed(9)))).toEqual([[0, 0.5], [0.5, 1]]);
    expect(paintOf(scale).style([]).band).toBeNull();
  });
});
