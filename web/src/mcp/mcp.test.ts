import { BoxGeometry, Mesh } from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import mcp from '../../../server/mcp.json';
import { noOccludeArgs } from '../lib/args';
import type { Summary } from '../lib/result';
import { NONE, toStage, type Section } from '../lib/section';
import { glyphs } from '../report/spec';
import { TAGGED, defaultSettings, initialState, reducer, serializeSettings, swapModel, type Action, type ObjectRow, type RunResult, type State, type Station, type Tab, type Tool } from '../store';
import { exclusive, settled, startBridge, until } from './bridge';
import guide from './guide.md?raw';
import reportGuide from './report.md?raw';
import setsGuide from './sets.md?raw';
import viewsGuide from './views.md?raw';
import { SECTION, TOOLS, WORDS, check } from './schema';
import { HANDLERS, bySide, connect, difference, publicSettings, settingsActions, shotSize, stableKey, type Ctl } from './tools';

vi.mock('../viewer/capture', () => ({ capture: async () => new Blob([new Uint8Array(8)], { type: 'image/jpeg' }) })); // no GPU here

const schema = (name: string) => TOOLS.find((t) => t.name === name)!.inputSchema;
/** A call as the bridge makes it: its arguments checked, then its handler; its text, or the refusal. */
const call = async (c: () => Ctl, name: string, args: Record<string, unknown>) => {
  const why = check(schema(name), args);
  if (why) return why;
  try {
    return (await HANDLERS[name](args, c, Date.now() + 5e3)).content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join(' ');
  } catch (e) {
    return (e as Error).message;
  }
};
/** What App adds to the store for the display and app_state: no sun path fit, the field preview off, no variant chosen. */
const LOOK = { sunAround: {}, setSunAround: () => {}, field: { shown: false, scale: 1, density: 'some', around: {} }, setField: () => {}, variants: () => ({}), fileOf: () => undefined };

describe('the tool list', () => {
  it('every tool of mcp.json has its handler, and only those', () => {
    const names = mcp.tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(Object.keys(HANDLERS).sort()).toEqual([...names].sort());
  });
  it('stays short: the instructions under 2000 characters, each description under 1000, the whole list minified at most 62 KB', () => {
    expect(mcp.instructions.length).toBeLessThan(2000);
    for (const t of mcp.tools) expect(t.description.length, t.name).toBeLessThan(1000);
    expect(JSON.stringify(mcp).length).toBeLessThanOrEqual(62e3);
  });
  it("screenshot's look fields are set_display's (the same types, values and items); its section is set_display's form, or null", () => {
    const strip = (v: unknown): unknown => (Array.isArray(v) ? v.map(strip) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'description').map(([k, x]) => [k, strip(x)])) : v);
    const shot = schema('screenshot').properties!, shown = schema('set_display').properties!;
    for (const k of ['analysis', 'id', 'column', 'colourBy', 'labels', 'display', 'sky', 'highlight', 'sunPath', 'sunAround', 'fieldPreview']) expect(strip(shot[k]), k).toEqual(strip(shown[k]));
    expect(shot.section.type).toEqual(['object', 'null']);
    expect(shot.section.properties).toBeUndefined(); // the handler checks it against SECTION
    expect(SECTION).toBe(shown.section);
  });
  it('each inputSchema is a closed object whose fields say what they take', () => {
    const fields = (s: Record<string, unknown>, at: string): string[] => {
      const p = (s.properties ?? {}) as Record<string, Record<string, unknown>>, bad = (s.required as string[] | undefined ?? []).filter((k) => !(k in p)).map((k) => `${at}.${k} required`);
      if (s.properties && s.additionalProperties !== false) bad.push(`${at} open`);
      for (const [k, v] of Object.entries(p)) {
        if (!v.type && !v.enum && !v.anyOf) bad.push(`${at}.${k} untyped`);
        if (!v.description) bad.push(`${at}.${k} undescribed`);
        bad.push(...fields(v, `${at}.${k}`), ...(v.items ? fields(v.items as Record<string, unknown>, `${at}.${k}[]`) : []));
      }
      return bad;
    };
    for (const t of mcp.tools) {
      expect(t.inputSchema.type, t.name).toBe('object');
      expect(t.description.length, t.name).toBeGreaterThan(80);
      expect(fields(t.inputSchema, t.name)).toEqual([]);
    }
  });
});

describe('the guides', () => {
  it('name only tools and update_settings fields that exist, in glyphs the report fonts have', () => {
    const names = new Set(mcp.tools.map((t) => t.name)), us = schema('update_settings').properties as Record<string, { properties?: Record<string, unknown> }>;
    for (const text of [guide, reportGuide, viewsGuide, setsGuide]) {
      expect((text.match(/\b(?:app_state|site_info|model_tree|combined_results|(?:update|open|remove|set|get|edit|find|save|delete|generate|download|run|rename|copy)_[a-z_]+)\b/g) ?? []).filter((w) => !names.has(w))).toEqual([]);
      expect((text.match(/\b(?:sim|time|weather|viz|site|view)\.[a-zA-Z]+\b/g) ?? []).filter((d) => { const [g, k] = d.split('.'); return !us[g]?.properties?.[k]; })).toEqual([]);
      expect([...new Set(text)].filter(glyphs)).toEqual([]); // what the report's fonts draw: agents copy it
    }
  });
});

describe('check', () => {
  it('passes what the schema allows, names the field of the rest', () => {
    expect(check(schema('update_settings'), { time: { step: 30, from: { hour: '07:30' } }, viz: { min: null, lo: 2 }, charts: [{ id: 'c', kind: 'histogram', range: [0, 8], bins: 'auto' }] })).toBe('');
    expect(check(schema('set_display'), { highlight: null })).toBe('');
    expect(check(schema('set_display'), { highlight: [[0, 1], [2, 3]] })).toBe('');
    expect(check(schema('set_display'), { highlight: [[1]] })).toBe('highlight[0]: 2 items');
    expect(check(schema('update_settings'), { viz: { below: 2 } })).toMatch(/^viz\.below: not an argument here/);
    expect(check(schema('update_settings'), { reset: ['nope'] })).toMatch(/^reset\[0\]: one of /);
    expect(check(schema('set_display'), { tab: 'views' })).toMatch(/^tab: not an argument here/);
    expect(check(schema('update_settings'), { time: { step: 7 } })).toBe('time.step: one of 10, 15, 30, 60');
    expect(check(schema('update_settings'), { time: { from: { hour: '7:30' } } })).toBe("time.from.hour: a time, 'HH:MM'");
    expect(check(schema('update_settings'), { charts: [{ id: 'c', range: 'log' }] })).toBe('charts[0].range: one of relative, absolute');
    expect(check(schema('update_settings'), { charts: [{ id: 'c', range: [1] }] })).toBe('charts[0].range: 2 items');
    expect(check(schema('update_settings'), { weather: { turbidity: 9 } })).toBe('weather.turbidity: 2 to 7');
    expect(check(schema('download_result'), {})).toBe('format: required');
    expect(check(schema('set_roles'), { paths: ['Roof'], role: 'receiver' })).toBe('paths[0]: a prim path, starting with /');
    expect(check(schema('app_state'), { verbose: true })).toBe('verbose: not an argument here (none)');
    expect(check(schema('set_geometry'), { subdivision: { level: 4 } })).toBe('subdivision.level: one of -1, 0, 1, 2, 3, model');
    expect(check(schema('update_settings'), { sim: { quantities: [] } })).toBe('sim.quantities: at least 1 item');
    expect(check(schema('update_settings'), { viz: { belowColour: 'blue' } })).toBe("viz.belowColour: a colour, '#rrggbb'");
  });
  it('says every pattern of mcp.json in words', () => {
    const patterns = new Set<string>(), walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (k === 'pattern') patterns.add(x as string); else walk(x); }
    };
    walk(mcp.tools);
    expect([...patterns].filter((p) => !WORDS[p])).toEqual([]);
  });
});

describe('results differences', () => {
  const sum = (mean: number, atLeast: number): Summary => ({ elements: 1, area: 1, min: mean, p10: mean, median: mean, mean, p90: mean, max: mean, total: mean, below: 1 - atLeast, within: atLeast, above: 0, atLeast: [atLeast] });
  it('within float noise of the values 0, shares on a 0.1 percentage-point grid', () => {
    const pick = (d: object) => { const o = d as Record<string, unknown>; return [o.mean, o.below, o.within, (o.thresholds as unknown[])[0]]; };
    expect(pick(difference(sum(2.68, 0.41 + 1e-16), sum(2.68 + 4e-16, 0.41), [3], true))).toEqual([0, 0, 0, { x: 3, below: 0, atOrAbove: 0 }]);
    expect(pick(difference(sum(0.448, 0.2), sum(0.754, 0.3), [3], true))).toEqual([-0.306, 10, -10, { x: 3, below: 10, atOrAbove: -10 }]);
  });
});

describe('settings', () => {
  const stations: Station[] = [
    { title: 'GBR_London.Gatwick', href: 'https://x/gatwick.epw', lat: 51.15, lon: -0.18 },
    { title: 'DEU_Berlin', href: 'https://x/berlin.epw', lat: 52.57, lon: 13.32 },
  ];
  it('app_state\'s copy goes back through update_settings unchanged', () => {
    let s: State = { ...initialState(), stations };
    const changes: Action[] = [
      { type: 'SITE', patch: { lat: 52.52, lon: 13.4, place: 'Berlin' } }, { type: 'WEATHER', patch: { source: 'clear-sky', turbidity: 4.5 } },
      { type: 'TIME', patch: { mode: 'range', from: { date: '2026-03-01', hour: 450 }, to: { date: '2026-03-21', hour: 1080 }, stepMin: 30 } },
      { type: 'SIM', patch: { mode: 'ladybug', quantities: ['sunhours'], north: 30, sides: 'both' } },
      { type: 'VIZ', quantity: 'sunhours', patch: { gradient: 'viridis', lo: 2, hi: null, below: '#112233' } },
      { type: 'CHART', spec: { id: 'parts', kind: 'parts', models: [0, 2], metric: 'below', parts: ['/Site/Block'] } },
    ];
    for (const a of changes) s = reducer(s, a);
    const p = publicSettings(s.settings);
    expect(p.time).toEqual({ mode: 'range', date: s.settings.time.date, hour: '12:00', from: { date: '2026-03-01', hour: '07:30' }, to: { date: '2026-03-21', hour: '18:00' }, step: 30 });
    expect(p.charts[2]).toEqual({ id: 'parts', kind: 'parts', models: ['A', 'C'], parts: ['/Site/Block'], metric: 'below' });
    let t: State = { ...initialState(), stations };
    const apply = (a: Record<string, unknown>) => { for (const x of settingsActions(a, t, null)) t = reducer(t, x); };
    apply({ site: p.site, time: p.time, sim: p.sim, weather: { source: p.weather.source, turbidity: p.weather.turbidity, altitude: p.weather.altitude }, charts: p.charts });
    for (const [quantity, v] of Object.entries(p.viz.quantities)) apply({ viz: { quantity, ...v, belowColour: p.viz.belowColour, aboveColour: p.viz.aboveColour } });
    expect(publicSettings(t.settings)).toEqual(p);
  });
  it('a station by title sets the source; bad values name their field', () => {
    const s: State = { ...initialState(), stations };
    expect(settingsActions({ weather: { station: 'deu berlin' } }, s, null)).toEqual([{ type: 'WEATHER', patch: { source: 'station', station: stations[1] } }]);
    expect(() => settingsActions({ weather: { station: 'Paris' } }, s, null)).toThrow(/^weather\.station: /);
    expect(() => settingsActions({ time: { date: '2026-02-30' } }, s, null)).toThrow(/^time\.date: /);
    expect(() => settingsActions({ time: { to: { hour: '24:30' } } }, s, null)).toThrow(/^time\.to\.hour: /);
    expect(() => settingsActions({ viz: { gradient: 'magma' } }, s, null)).toThrow(/^viz\.quantity: /);
    expect(settingsActions({ viz: { gradient: 'magma', reset: 'range' } }, s, 'illuminance_front')).toEqual([
      { type: 'VIZ_RESET', quantity: 'illuminance', what: 'range' }, { type: 'VIZ', quantity: 'illuminance', patch: { gradient: 'magma' } },
    ]);
  });
  it('charts: an existing one keeps what is not given; built-ins stay; a refusal names the chart and field', () => {
    const s = initialState(defaultSettings());
    const [put] = settingsActions({ charts: [{ id: 'hist', bins: 32 }] }, s, null);
    expect(put).toEqual({ type: 'CHART', spec: { id: 'hist', kind: 'histogram', bins: 32 } });
    expect(() => settingsActions({ charts: [{ id: 'hist', remove: true }] }, s, null)).toThrow(/^charts\[0\]\.remove: /);
    expect(() => settingsActions({ charts: [{ id: 'mine', kind: 'parts' }, { id: 'mine', remove: true }, { id: 'mine', remove: true }] }, s, null)).toThrow(/^charts\[2\]\.id: /);
    expect(() => settingsActions({ charts: [{ id: 'hist', title: 'x' }] }, s, null)).toThrow(/^charts\[0\]\.title: /);
  });
  it('charts: a field of another kind is refused, as in save_report', () => {
    const s = initialState(defaultSettings());
    expect(() => settingsActions({ charts: [{ id: 'h', kind: 'histogram', metric: 'mean' }] }, s, null)).toThrow(/^charts\[0\]\.metric: not a field of a histogram chart /);
    expect(() => settingsActions({ charts: [{ id: 'mine' }] }, s, null)).toThrow(/^charts\[0\]\.kind: /);
    expect(settingsActions({ charts: [{ id: 'p', kind: 'parts', models: ['A'], metric: 'below' }] }, s, null)).toEqual([{ type: 'CHART', spec: { id: 'p', kind: 'parts', models: [0], metric: 'below' } }]);
  });
  it('a mode switch keeps the quantities given with it', () => {
    let s = initialState();
    for (const x of settingsActions({ sim: { mode: 'ladybug', quantities: ['sunhours'] } }, s, null)) s = reducer(s, x);
    expect([s.settings.sim.mode, s.settings.sim.quantities]).toEqual(['ladybug', ['sunhours']]);
  });
});

describe('results by facing', () => {
  // a 10 × 20 × 6 m block as one mesh: quads a b c d, counter-clockwise seen from where they face, two faces each
  const quads = [
    [[0, 0, 0], [0, 0, 6], [0, 20, 6], [0, 20, 0]], // -X
    [[10, 0, 0], [10, 20, 0], [10, 20, 6], [10, 0, 6]], // +X
    [[0, 0, 0], [10, 0, 0], [10, 0, 6], [0, 0, 6]], // -Y
    [[0, 20, 0], [0, 20, 6], [10, 20, 6], [10, 20, 0]], // +Y
    [[0, 0, 6], [10, 0, 6], [10, 20, 6], [0, 20, 6]], // +Z
  ];
  const one = { first: 0, count: 10, positions: quads.flat(2), indices: quads.flatMap((_, k) => [0, 1, 2, 0, 2, 3].map((i) => 4 * k + i)), w: Array.from({ length: 10 }, (_, f) => f + 1) };
  const values = Array.from({ length: 10 }, (_, f) => f), sides = (r: ReturnType<typeof bySide>) => r.map((g) => `${g.facing} ${g.values.join()} ${g.w.join()}`); // face f's value: f
  it('faces of a single-mesh model by the side they face, in compass order; north turns them; a back column faces the other way', () => {
    expect(sides(bySide(values, [one], 'faces', 0, false))).toEqual(['N 6,7 7,8', 'E 2,3 3,4', 'S 4,5 5,6', 'W 0,1 1,2', 'up 8,9 9,10']);
    expect(sides(bySide(values, [one], 'faces', 90, false)).map((g) => g.split(' ').slice(0, 2).join(' '))).toEqual(['N 0,1', 'E 6,7', 'S 2,3', 'W 4,5', 'up 8,9']); // north 90: model -X
    expect(sides(bySide(values, [one], 'faces', 0, true)).map((g) => g.split(' ').slice(0, 2).join(' '))).toEqual(['N 4,5', 'E 0,1', 'S 6,7', 'W 2,3', 'down 8,9']);
  });
  it('face rows of several triangles (faceStart: a quad is one face) face as their triangles do', () => {
    const faces = { ...one, count: 5, faceStart: [0, 2, 4, 6, 8, 10], w: [10, 20, 30, 40, 50] };
    expect(sides(bySide([0, 1, 2, 3, 4], [faces], 'faces', 0, false))).toEqual(['N 3 40', 'E 1 20', 'S 2 30', 'W 0 10', 'up 4 50']);
  });
  it('vertices along their faces\' normals, rows from each mesh\'s first; a degenerate element is left out', () => {
    const wall = { first: 0, count: 4, positions: quads[1].flat(), indices: [0, 1, 2, 0, 2, 3], w: [1, 1, 1, 1] };
    const roof = { first: 4, count: 5, positions: [...quads[4].flat(), 5, 5, 6], indices: [0, 1, 2, 0, 2, 3], w: [2, 2, 2, 2, 2] }; // vertex 4: on no face
    const rows = Array.from({ length: 9 }, (_, i) => i);
    expect(sides(bySide(rows, [wall, roof], 'vertices', 0, false))).toEqual(['E 0,1,2,3 1,1,1,1', 'up 4,5,6,7 2,2,2,2']);
  });
});

describe('screenshot size', () => {
  it('the long side at most 1568 px, the aspect kept unless the short side would fall under 16 px; at most 8 MP asked', () => {
    expect(shotSize(1280, 800)).toEqual({ width: 1280, height: 800, reshaped: false });
    expect(shotSize(2400, 600)).toEqual({ width: 1568, height: 392, reshaped: false });
    expect(shotSize(600, 2400)).toEqual({ width: 392, height: 1568, reshaped: false });
    expect(shotSize(8192, 82)).toEqual({ width: 1568, height: 16, reshaped: false }); // 15.7 rounds to 16
    expect(shotSize(8192, 16)).toEqual({ width: 1568, height: 16, reshaped: true });
    expect(() => shotSize(4000, 2001)).toThrow(/^width: 4000 x 2001 px is over 8 megapixels/);
  });
});

describe('sections', () => {
  /** The app with model A loaded: a 2 x 6 x 4 m block at /Site/Block (drawn in three world, Y up, from a Z-up stage in
   *  metres), the section every view shows (set in the view as App's effect does), and what its view was given (`shown`,
   *  `gizmos`). */
  function app() {
    const block = new Mesh(new BoxGeometry(2, 4, 6)), shown: unknown[] = [], gizmos: unknown[] = [];
    let own: unknown = { on: true, planes: [], boxes: [] }, gizmo: unknown = null;
    const el = {
      stage: { metersPerUnit: 1, upAxis: 'Z' }, view: { eye: [12, 8, 16], target: [0, 0, 0], fov: 45, projection: 'perspective', height: 1 },
      get section() { return own; }, set section(s) { shown.push(s); own = s; },
      get sectionGizmo() { return gizmo; }, set sectionGizmo(g) { gizmos.push(g); gizmo = g; },
      three: { objectsFor: (p: string) => (p === '/Site/Block' ? [block] : []), overlay: { children: [] } },
    };
    let x = {
      ...LOOK, state: { active: 0, models: [{ slot: 0, name: 'block', objects: [{ id: 'b', path: '/Site/Block' }] }], colourBy: 'plain', bin: null, bins: [], settings: { sim: { north: 0 } } },
      panes: { 0: { loading: false } }, ui: { tab: 'daylight' }, section: NONE, dispatch: () => {}, setUi: () => {}, viewer: () => ({ el }),
      setSection: (s: Section) => { x = { ...x, section: s }; el.section = toStage(s, 1, 'Z'); },
      analysis: () => ({ models: x.state.models, column: '', colourBy: 'plain', shown: null, scale: null, dispatch: () => {} }),
    } as unknown as Ctl;
    return { c: () => x, el, shown, gizmos };
  }
  const put = async (c: () => Ctl, section: unknown) => JSON.parse(await call(c, 'set_display', { section })).section;

  it('set_display takes each box form and answers footprints, which it takes back as they are; no planes and boxes clear it', async () => {
    const { c } = app(), plan = { point: [0, 0, 1.2], normal: [0, 0, -1] }, quad = { keep: 'outside', footprint: [[0, 0], [4, 0], [4, 2], [1, 3]], bottom: 0, top: 3 };
    const s = await put(c, {
      planes: [plan],
      boxes: [quad, { keep: 'inside', box: { min: [0, 0, 0], max: [2, 1, 3] }, rotation: 90 }, { keep: 'inside', paths: ['/Site/Block'] }, { keep: 'outside', paths: ['/Site/Block'], margin: 0.5 }],
    });
    expect(s).toEqual({
      on: true, planes: [plan], boxes: [
        quad,
        { keep: 'inside', footprint: [[1.5, -0.5], [1.5, 1.5], [0.5, 1.5], [0.5, -0.5]], bottom: 0, top: 3 }, // turned a quarter about (1, 0.5)
        { keep: 'inside', footprint: [[-1.075, -3.075], [1.075, -3.075], [1.075, 3.075], [-1.075, 3.075]], bottom: -2.075, top: 2.075 }, // 1 % of the diagonal larger
        { keep: 'outside', footprint: [[-1.5, -3.5], [1.5, -3.5], [1.5, 3.5], [-1.5, 3.5]], bottom: -2.5, top: 2.5 },
      ],
    });
    expect(c().section).toEqual(s);
    expect(await put(c, s)).toEqual(s);
    expect(await put(c, { ...s, on: false })).toEqual({ ...s, on: false });
    expect(await put(c, { planes: [], boxes: [] })).toEqual(NONE);
  });

  it('names the path of what is wrong, from the schema or the forms, and applies nothing then', async () => {
    const { c } = app(), say = (section: unknown) => call(c, 'set_display', { section }), unit = [[0, 0], [1, 0], [1, 1], [0, 1]];
    expect(await say({ planes: [{ point: [0, 0], normal: [0, 0, 1] }] })).toBe('section.planes[0].point: 3 items');
    expect(await say({ boxes: [{ footprint: unit, bottom: 0, top: 1 }] })).toBe('section.boxes[0].keep: required');
    expect(await say({ boxes: Array(9).fill({ keep: 'inside', footprint: unit, bottom: 0, top: 1 }) })).toBe('section.boxes: at most 8 items');
    expect(await say({ boxes: [{ keep: 'inside', box: { min: [0, 0, 0], max: [1, 1, 1] }, paths: ['/Site/Block'] }] })).toBe('section.boxes[0]: one of footprint (with bottom and top), box or paths');
    expect(await say({ boxes: [{ keep: 'inside', footprint: unit, bottom: 0, top: 1, rotation: 45 }] })).toBe('section.boxes[0].rotation: not with footprint, which takes bottom and top');
    expect(await say({ boxes: [{ keep: 'inside', box: { min: [0, 0, 0], max: [10, 0, 3] } }] })).toMatch(/^section\.boxes\[0\]\.box: flat, nothing fits in it; give a margin/); // a wall's box
    expect(await say({ boxes: [{ keep: 'inside', paths: ['/Site/Block', '/Nope'] }] })).toBe('section.boxes[0].paths[1]: nothing drawn at or under /Nope in model A, the active one; find prims with model_tree');
    expect(await say({ planes: [{ point: [0, 0, 0], normal: [0, 0, 0] }], boxes: [{ keep: 'inside', footprint: [[0, 0], [1, 1], [1, 0], [0, 1]], bottom: 1, top: 1 }] })).toBe(
      'section.planes[0].normal: not zero: it points to the side the plane keeps; section.boxes[0].footprint: crosses itself or has no area; give the corners in order round the box; section.boxes[0].top: above the bottom (1 m)',
    );
    expect(c().section).toEqual(NONE);
    expect(await put(c, { boxes: [{ keep: 'inside', box: { min: [0, 0, 0], max: [10, 0, 3] }, margin: 0.5 }] })).toEqual({
      on: true, planes: [], boxes: [{ keep: 'inside', footprint: [[-0.5, -0.5], [10.5, -0.5], [10.5, 0.5], [-0.5, 0.5]], bottom: -0.5, top: 3.5 }],
    });
  });

  it("screenshot shows its own section (null: none; left out: the views'), says which, and puts the app's back with the gizmo", async () => {
    const { c, el, shown, gizmos } = app(), said = async (args: Record<string, unknown>) => (await call(c, 'screenshot', args)).replace(/^.*Section: /s, '');
    expect(await said({})).toBe('none.');
    expect(shown).toEqual([]); // the views' own: left as it is
    const plan = { on: true, planes: [{ point: [0, 0, 1.2], normal: [0, 0, -1] }], boxes: [] };
    expect(await said({ section: { planes: plan.planes } })).toBe('horizontal at 1.20 m, keeps below.');
    expect(shown).toEqual([plan, NONE]); // the shot's (a Z-up stage in metres takes it as it is), then the app's
    await put(c, { boxes: [{ keep: 'outside', paths: ['/Site/Block'] }] });
    const live = toStage(c().section, 1, 'Z');
    el.sectionGizmo = { box: 0 };
    expect(await said({})).toBe('1 box cutting out.');
    expect(await said({ section: null })).toBe('none.');
    expect(await said({ section: { planes: plan.planes } })).toBe('horizontal at 1.20 m, keeps below.');
    expect(shown.slice(2)).toEqual([live, NONE, live, plan, live]); // the app's after each shot of its own
    expect(gizmos).toEqual([null, { box: 0 }, null, { box: 0 }, null, { box: 0 }]); // none while a shot's section shows, then back
  });
});

describe('receivers that cast no shade', () => {
  afterEach(() => vi.unstubAllGlobals());
  const row = (path: string, id = path.split('/').pop()!.toLowerCase()): ObjectRow => ({ id, name: id, path, tris: 2, verts: 4, role: 'none' });
  /** Model A loaded: /Room with Grid, Floor and Walls, all ignored; its state through the reducer. */
  function app() {
    const rows = ['/Room/Grid', '/Room/Floor', '/Room/Walls'].map((p) => row(p)), prim = (path: string, hasChildren = false) => ({ path, name: path.split('/').pop(), typeName: hasChildren ? 'Xform' : 'Mesh', hasChildren, visible: true, active: true, hasVariantSets: false });
    const kids: Record<string, unknown[]> = { '/': [prim('/Room', true)], '/Room': rows.map((o) => prim(o.path)) }, el = { usd: { children: async (p: string) => kids[p] ?? [] }, session: { isLocked: () => false } };
    let state = reducer(initialState(), { type: 'LOAD', slot: 0, objects: rows, name: 'room' });
    return () => ({
      ...LOOK, state, dispatch: (a: Action) => { state = reducer(state, a); }, panes: { 0: { loading: false, meshes: new Map() } }, viewer: () => ({ el }), ui: { tab: 'daylight' }, views: [], reports: null, generation: () => ({}),
      per: state.models.map((m) => ({ m, receivers: m.objects.filter((o) => o.role === 'receiver'), shades: [], key: '' })),
      analysis: (tool: Tool) => {
        const models = tool === 'views' ? state.models.map(swapModel) : state.models;
        return { tool, models, per: models.map((m) => ({ m, receivers: m.objects.filter((o) => o.role === 'receiver'), shades: [], key: '' })), materialsReady: true, column: state.column, colourBy: state.colourBy, shown: null, scale: null };
      },
      sets: { saved: [] }, runs: { statusOf: () => [] }, combined: { views: [], models: [] },
    }) as unknown as Ctl;
  }
  const json = async (c: () => Ctl, name: string, args: Record<string, unknown>) => JSON.parse(await call(c, name, args));

  it('set_roles shade false: receivers measure without shade; refused with another role; model_tree and app_state say so', async () => {
    const c = app();
    await call(c, 'set_roles', { paths: ['/Room/Grid', '/Room/Floor'], role: 'receiver' });
    expect(await json(c, 'set_roles', { paths: ['/Room'], role: 'receiver', shade: false }).then((r) => r.meshes)).toEqual({ receiver: 3, shade: 0, none: 0, noShade: 3 });
    const back = await json(c, 'set_roles', { paths: ['/Room/Floor', '/Room/Walls'], role: 'receiver', shade: true });
    expect([back.meshes, back.changed]).toEqual([{ receiver: 3, shade: 0, none: 0, noShade: 1 }, ['/Room/Floor', '/Room/Walls']]);
    expect(await json(c, 'set_roles', { paths: ['/Room/Walls'], role: 'shade' }).then((r) => r.meshes)).toEqual({ receiver: 2, shade: 1, none: 0, noShade: 1 });
    expect(await call(c, 'set_roles', { paths: ['/Room/Walls'], role: 'shade', shade: true })).toBe("shade: only with role 'receiver' (a shade always casts shade; role none leaves a mesh out)");
    expect(await call(c, 'set_roles', { paths: ['/Room/Grid'], role: 'receiver', shade: 'no' })).toBe('shade: boolean');
    const tree = (await json(c, 'model_tree', {})).prims.map((p: Record<string, unknown>) => [p.path, p.role, p.shade]);
    expect(tree).toEqual([['/Room', 'mixed', 'mixed'], ['/Room/Grid', 'receiver', false], ['/Room/Floor', 'receiver', undefined], ['/Room/Walls', 'shade', undefined]]);
    vi.stubGlobal('document', { visibilityState: 'visible' });
    expect((await json(c, 'app_state', {})).models[0].meshes).toEqual({ receiver: 2, shade: 1, none: 0, noShade: 1 });
  });

  it('set_roles reset puts every role back first; edit_material reset alone takes back every edit of the model', async () => {
    const c = app();
    await call(c, 'set_roles', { paths: ['/Room'], role: 'receiver' });
    const r = await json(c, 'set_roles', { reset: true, paths: ['/Room/Grid'], role: 'receiver' });
    expect([r.reset, r.meshes, r.changed]).toEqual([true, { receiver: 1, shade: 0, none: 2 }, ['/Room/Floor', '/Room/Walls']]);
    expect((await json(c, 'set_roles', { reset: true })).meshes).toEqual({ receiver: 0, shade: 0, none: 3 });
    expect(await call(c, 'set_roles', {})).toBe('paths: required (or reset: true alone)');
    expect(await call(c, 'set_roles', { reset: true, role: 'shade' })).toBe('role: goes with paths');
    expect(await call(c, 'set_roles', { paths: ['/Room'] })).toBe('role: required with paths');
    c().dispatch({ type: 'OPTICS_EDIT', slot: 0, key: '/Looks/Brick', edit: { rho: 0.3, tau: 0, kind: 'opaque' } });
    expect(await json(c, 'edit_material', { reset: true })).toEqual({ model: 'A', reset: 1, note: '1 edited row back to the derived or default values' });
    expect(c().state.models[0].optics).toEqual({});
    expect(await call(c, 'edit_material', { rho: 0.5 })).toBe('material: required, unless reset alone resets every edit of the model');
  });

  it('with sim.selfOcclude off, set_roles says the flag waits for it; a run key names the meshes by path, the same after a re-read', async () => {
    const c = app();
    c().dispatch({ type: 'SIM', patch: { selfOcclude: false } });
    expect((await json(c, 'set_roles', { paths: ['/Room/Grid'], role: 'receiver', shade: false })).note).toBe('no receiver casts shade while sim.selfOcclude is off: shade false counts once it is on');
    const sim = defaultSettings().sim, key = (ids: string[]) => {
      const rows = ['/Room/Grid', '/Room/Desk'].map((path, k): ObjectRow => ({ ...row(path, ids[k]), role: 'receiver', shade: false }));
      return stableKey(JSON.stringify([noOccludeArgs(rows, sim), null, ids, []]), rows);
    };
    const a = '00000000-0000-4000-8000-00000000000a', b = '00000000-0000-4000-8000-00000000000b';
    expect(key([a, b])).toBe(JSON.stringify([['--no-occlude', '/Room/Desk;/Room/Grid'], null, ['/Room/Grid', '/Room/Desk'], []]));
    expect(key([b, a])).toBe(key([a, b])); // new ids per re-read, in another order: the same stable key
  });
});

describe('subdivision', () => {
  afterEach(() => vi.unstubAllGlobals());
  /** Model A loaded (/Room/Grid, /Room/Floor); onSubdiv and onRefine as App takes them: the ui's level and override. */
  function app(subdivOverride = false) {
    const rows: ObjectRow[] = ['/Room/Grid', '/Room/Floor'].map((path) => ({ id: path, name: path, path, tris: 2, verts: 4, role: 'none' }));
    const state = reducer(initialState(), { type: 'LOAD', slot: 0, objects: rows, name: 'room' }), ui = { tab: 'daylight', subdiv: 0, subdivOverride };
    const refined: [string[], number | null][] = [];
    const c = () => ({
      ...LOOK, state, dispatch: () => {}, panes: { 0: { loading: false, meshes: new Map(), loadError: null } }, ui,
      onSubdiv: (level: number, override = ui.subdivOverride) => Object.assign(ui, { subdiv: level, subdivOverride: override }),
      onRefine: (_slot: number, paths: string[], level: number | null) => { refined.push([paths, level]); },
    }) as unknown as Ctl;
    return { c, refined };
  }
  const json = async (c: () => Ctl, args: Record<string, unknown>) => JSON.parse(await call(c, 'set_geometry', args));

  it('set_geometry: the override goes for every model, kept until changed; per-mesh levels refuse it, and wait while it is on', async () => {
    const { c, refined } = app();
    expect(await json(c, { subdivision: { level: 2, override: true } })).toMatchObject({ subdivision: 2, subdivisionOverride: true });
    expect(await call(c, 'set_geometry', { subdivision: { level: 1, paths: ['/Room/Grid'] } })).toBe("subdivision.paths: the model's level overrides each mesh's own now; set override false first");
    expect(await json(c, { subdivision: { level: 1 } })).toMatchObject({ subdivision: 1, subdivisionOverride: true }); // the override as it was
    expect(await json(c, { subdivision: { level: 1, override: false } })).toMatchObject({ subdivision: 1, subdivisionOverride: false });
    expect(await call(c, 'set_geometry', { subdivision: { level: 2, paths: ['/Room/Grid'], override: true } })).toBe('subdivision.override: applies to every model; leave paths out');
    await json(c, { subdivision: { level: 2, paths: ['/Room/Grid'] } });
    expect(refined).toEqual([[['/Room/Grid'], 2]]);
    expect(await call(c, 'set_geometry', { subdivision: { level: 0, override: 'yes' } })).toBe('subdivision.override: boolean');
  });

  it("a tab picking up the hidden session takes its level and override; an older session's level keeps the tab's override", async () => {
    const pickup = async (session: { subdiv: number; subdivOverride?: boolean }, tabOverride: boolean) => {
      const { c } = app(tabOverride);
      let ended!: () => void;
      const gone = new Promise<void>((r) => { ended = r; });
      vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/session' && init?.method === 'DELETE') ended();
        if (url === '/session') return init?.method ? new Response(null, { status: 204 }) : new Response(JSON.stringify({ settings: serializeSettings(defaultSettings()), steps: [], ran: false, ...session }), { headers: { 'Content-Type': 'application/json' } });
        return url.includes('wait=25') ? new Response('error: agent routes answer only on this machine\n', { status: 403 }) : new Response(null, { status: 204 });
      }));
      vi.stubGlobal('document', { hasFocus: () => false, visibilityState: 'visible', addEventListener: vi.fn(), removeEventListener: vi.fn() });
      vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
      const stop = connect(c);
      await gone;
      stop();
      return { subdiv: c().ui.subdiv, subdivOverride: c().ui.subdivOverride };
    };
    expect(await pickup({ subdiv: 2, subdivOverride: true }, false)).toEqual({ subdiv: 2, subdivOverride: true });
    expect(await pickup({ subdiv: 1 }, true)).toEqual({ subdiv: 1, subdivOverride: true });
    expect(await pickup({ subdiv: 0, subdivOverride: false }, true)).toEqual({ subdiv: 0, subdivOverride: false });
  });
});

describe('the View analysis (analysis views)', () => {
  afterEach(() => vi.unstubAllGlobals());
  const KEY = JSON.stringify([['--fov', '120,-70,50', '--cell', '2', '--north', '0', '--target', 'park=park'], null, 'facade']);
  const RESULT = {
    columns: ['sky_front', 'park_front', 'distance_min_front'], data: [[0.2, 0.6], [0.1, 0.3], [4, 12]].map((v) => Float32Array.from(v)), weights: Float32Array.from([1, 3]),
    receivers: ['facade'], on: 'faces', key: KEY, elapsed: 2, manifest: { meshes: [{ name: 'facade', first: 0, count: 2 }] },
  } as unknown as RunResult;
  /** Model A: a 10 x 6 m facade facing -Y (two faces, 1 and 3 m²), a park and a block, all ignored; its View analysis'
   *  run lands RESULT (or the problem without a receiver). Also the tabs the app was set to and the downloads. */
  function app() {
    const rows = ['/Site/Facade', '/Site/Park', '/Site/Block'].map((path): ObjectRow => ({ id: path.slice(6).toLowerCase(), name: path.slice(6), path, tris: 2, verts: 4, role: 'none' }));
    let state = reducer(initialState(), { type: 'LOAD', slot: 0, objects: rows, name: 'site' }), ui = {
      tab: 'daylight' as Tab, labels: false, labelScale: 1, labelSpacing: 1, labelLayout: 'grid', labelShow: 'all', labelBox: true, labelColour: '#ffffff', display: 'shaded', sky: 'none',
    };
    let sunAround: Ctl['sunAround'] = {}, field: Ctl['field'] = { shown: false, scale: 1, density: 'some', around: {} };
    const tabs: Tab[] = [], downloads: unknown[] = [], dispatch = (a: Action) => { state = reducer(state, a); };
    const views = (a: Action) => dispatch(TAGGED.has(a.type) ? ({ ...a, tab: 'views' } as Action) : a);
    const el = { stage: { metersPerUnit: 1, upAxis: 'Z' }, view: { eye: [12, -20, 3], target: [5, 0, 3], fov: 45, projection: 'perspective', height: 1 }, three: { objectsFor: () => [], overlay: { children: [] }, scene: { background: {} } } }; // a sky in at once
    const analysis = (tool: Tool) => {
      const v = tool === 'views', models = v ? state.models.map(swapModel) : state.models, column = v ? state.viewAnalysis.column : state.column, first = models.find((m) => m.result)?.result;
      return {
        tool, models, materialsReady: true, per: models.map((m) => ({ m, receivers: m.objects.filter((o) => o.role === 'receiver'), shades: m.objects.filter((o) => o.role === 'shade'), key: KEY })),
        shown: first ? column || first.columns[0] : null, scale: null, colourBy: v ? state.viewAnalysis.colourBy : state.colourBy, column, errors: v ? state.viewAnalysis.errors : state.errors,
        dispatch: v ? views : dispatch, busy: () => false, held: () => false, cancel: () => {},
        onRun: () => { // as useAnalysis: its problems every time, then the job
          const ready = models[0].objects.some((o) => o.role === 'receiver');
          views({ type: 'ERRORS', errors: ready ? {} : { model: 'No receiver mesh.' } });
          if (ready) views({ type: 'RUN', slot: 0, run: { status: 'done', result: RESULT } });
        },
        onDownload: (format: string, mode: string) => downloads.push([tool, format, mode]),
      };
    };
    const c = () => ({
      ...LOOK, sunAround, setSunAround: (s: Ctl['sunAround']) => { sunAround = s; }, field, setField: (p: Partial<Ctl['field']>) => { field = { ...field, ...p }; },
      state, dispatch, ui, setUi: (f: (u: typeof ui) => typeof ui) => { const t = ui.tab; ui = f(ui); if (ui.tab !== t) tabs.push(ui.tab); }, panes: { 0: { loading: false, meshes: new Map() } }, viewer: () => ({ el }), section: NONE,
      views: [], reports: null, generation: () => ({}), exporting: false, analysis, per: analysis('daylight').per, shown: null, sets: { saved: [] }, runs: { statusOf: () => [] }, combined: { views: [], models: [] },
      meshOf: () => ({ positions: [0, 0, 0, 10, 0, 0, 10, 0, 6, 0, 0, 6], indices: [0, 1, 2, 0, 2, 3] }),
    }) as unknown as Ctl;
    return { c, tabs, downloads };
  }
  const json = async (c: () => Ctl, name: string, args: Record<string, unknown>) => JSON.parse(await call(c, name, args));
  /** The facade a receiver, the park a target and the block an obstruction, then run. */
  const ran = async (c: () => Ctl) => {
    for (const [paths, role, group] of [[['/Site/Facade'], 'receiver'], [['/Site/Park'], 'target', 'park'], [['/Site/Block'], 'obstruction']] as const) await call(c, 'set_roles', { analysis: 'views', paths, role, ...(group ? { group } : {}) });
    return json(c, 'run', { analysis: 'views' });
  };

  it("set_roles and app_state: its own roles beside Daylight's, its settings and problems; a role of the other analysis refused", async () => {
    const { c } = app();
    vi.stubGlobal('document', { visibilityState: 'visible' });
    expect((await json(c, 'set_roles', { analysis: 'views', paths: ['/Site/Facade'], role: 'receiver' })).meshes).toEqual({ receiver: 1, obstruction: 0, targets: {}, none: 2 });
    const park = await json(c, 'set_roles', { analysis: 'views', paths: ['/Site/Park'], role: 'target', group: 'park' });
    expect([park.analysis, park.meshes, park.changed]).toEqual(['views', { receiver: 1, obstruction: 0, targets: { park: 1 }, none: 1 }, ['/Site/Park']]);
    expect(await call(c, 'set_roles', { analysis: 'views', paths: ['/Site/Block'], role: 'shade' })).toMatch(/^role: the View analysis' roles are receiver, obstruction, target and none/);
    expect(await call(c, 'set_roles', { paths: ['/Site/Block'], role: 'obstruction' })).toMatch(/^role: obstruction is a View analysis role/);
    expect(await call(c, 'set_roles', { analysis: 'views', paths: ['/Site/Block'], role: 'target' })).toMatch(/^group: a target takes its group/);
    expect(await call(c, 'set_roles', { analysis: 'views', paths: ['/Site/Block'], role: 'target', group: 'a park' })).toBe('group: 1 to 64 letters, digits, _ or -');
    await call(c, 'set_roles', { analysis: 'views', paths: ['/Site/Block'], role: 'obstruction' });
    const s = await json(c, 'app_state', {});
    expect(s.models[0].meshes).toEqual({ receiver: 0, shade: 0, none: 3 }); // Daylight's as they were
    expect(s.viewAnalysis).toEqual({
      settings: defaultSettings().viewSim, field: { grid: '60 x 60', rays: 3600, azimuth: [-60, 60], elevation: [-70, 50], gaze: 'level' }, column: null, colourBy: 'plain', problems: {},
      models: [{ model: 'A', meshes: { receiver: 1, obstruction: 1, targets: { park: 1 }, none: 0 }, run: 'idle', result: null }],
    });
  });

  it("run, results and find_critical act on its result; Daylight's has none", async () => {
    const { c } = app();
    expect(await json(c, 'run', { analysis: 'views' })).toEqual({ status: 'refused', problems: { model: 'No receiver mesh.' }, fix: 'update_settings view, set_roles or edit_material' });
    expect(await ran(c)).toMatchObject({ status: 'done', models: [{ model: 'A', status: 'done', seconds: 2, column: 'sky_front', unit: '', mean: 0.5 }] });
    const r = await json(c, 'results', { analysis: 'views' }), [m] = r.models;
    expect([r.analysis, r.column, r.unit, r.meaning.slice(0, 42), m.result, m.whole.mean, m.rows[0].mesh]).toEqual(['views', 'sky_front', '', 'Share of the field of view that is open sk', 'fresh', 0.5, '/Site/Facade']);
    expect(m.run).toEqual({ elements: 'faces', args: JSON.parse(KEY)[0], seconds: 2 }); // no period or weather
    const d = await json(c, 'results', { analysis: 'views', column: 'distance_min_front' });
    expect([d.unit, d.meaning, d.models[0].whole.mean]).toEqual(['m', 'The nearest thing in view, m (Far when the whole field is open). Front side: where the face normal points.', 10]);
    expect(await call(c, 'results', { analysis: 'views', column: 'sunhours_front' })).toBe("column: model A's result has no sunhours_front (sky_front, park_front, distance_min_front); run with analysis 'views' again");
    expect(await call(c, 'results', {})).toBe('models: no model has a Daylight result yet; run first');
    expect(await call(c, 'results', { analysis: 'views', id: 'score' })).toBe("id: goes with analysis 'combined' (a combined view's results)");
    expect(await call(c, 'results', { wait: 0 })).toBe("wait: goes with analysis 'combined' (a combined view's results)");
    expect(await call(c, 'results', { analysis: 'combined' })).toBe("id: analysis 'combined' quotes a combined view; give its id (app_state combined)");
    expect(await call(c, 'find_critical', { analysis: 'views' })).toMatch(/^lo: the problem range of sky is empty; give lo or hi/);
    expect(await json(c, 'find_critical', { analysis: 'views', lo: 0.5 })).toMatchObject({ model: 'A', column: 'sky_front', lo: 0.5, hi: null, groups: [{ mesh: '/Site/Facade', facing: 'S', elements: 1 }] });
    expect(await call(c, 'find_critical', { lo: 0.5 })).toBe('model: model A has no Daylight result; run first');
    expect(settingsActions({ viz: { lo: 2 } }, c().state, 'distance_min_front')).toEqual([{ type: 'VIZ', quantity: 'distance_min', patch: { lo: 2 } }]); // a view quantity's name holds '_'
    c().dispatch({ type: 'VIZ', quantity: 'sky', patch: { lo: 0.3, hi: 0.55 } });
    expect((await json(c, 'results', { analysis: 'views' })).problemRange).toEqual({ lo: 0.3, hi: 0.55 });
  });

  it('set_display, screenshot and download_result show and save its result, the tab put back after a shot', async () => {
    const { c, tabs, downloads } = app();
    await ran(c);
    const d = await json(c, 'set_display', { analysis: 'views', column: 'park_front', colourBy: 'value' }); // shows that tab, as a click does
    expect([d.analysis, d.column, d.colourBy, c().ui.tab, c().state.viewAnalysis.column, c().state.column]).toEqual(['views', 'park_front', 'value', 'views', 'park_front', '']);
    expect(await call(c, 'set_display', { analysis: 'views', column: 'sunhours_front' })).toBe('column: not in the View analysis result (sky_front, park_front, distance_min_front)');
    expect((await json(c, 'set_display', { analysis: 'daylight' })).analysis).toBe('daylight');
    expect(await call(c, 'set_display', { column: 'sky_front' })).toBe('column: no Daylight result yet; run first');
    const shot = await call(c, 'screenshot', { analysis: 'views', column: 'sky_front' });
    expect(shot).toMatch(/^Model A \(site\): 1280 x 800 px/);
    expect([tabs, c().ui.tab, c().state.viewAnalysis.column]).toEqual([['views', 'daylight', 'views', 'daylight'], 'daylight', 'park_front']); // shown for the shot, then put back
    expect(await call(c, 'screenshot', { analysis: 'views', id: 'score' })).toBe("id: a combined view shows on the Combined tab; give analysis 'combined'");
    expect(await json(c, 'download_result', { analysis: 'views', format: 'glb' })).toMatchObject({ model: 'A', analysis: 'views', format: 'glb', column: 'park_front' });
    expect(downloads).toEqual([['views', 'glb', 'replace']]);
    expect(await call(c, 'download_result', { format: 'glb' })).toBe('model: model A has no Daylight result; run first');
  });

  it('set_display: value ranges merged, the display mode, the sun path round prims, the field preview on receivers; a shot shows its own and puts them back', async () => {
    const { c } = app();
    await ran(c);
    const all = ['/Site/Facade', '/Site/Park', '/Site/Block'];
    const d = await json(c, 'set_display', { highlight: [[0.5, 0.7], [0, 0.2], [0.1, 0.3]], display: 'plain-wire', sky: 'blue-sky', labelScale: 1.5, sunAround: ['/Site'], fieldPreview: { show: true, scale: 2, density: 'many', around: ['/Site'] } });
    expect([d.highlight, c().state.bins, d.display, c().ui.display]).toEqual([[[0, 0.3], [0.5, 0.7]], [[0, 0.3], [0.5, 0.7]], 'plain-wire', 'plain-wire']);
    expect([d.sky, c().ui.sky, d.labelScale, c().ui.labelScale]).toEqual(['blue-sky', 'blue-sky', 1.5, 1.5]);
    expect(await call(c, 'set_display', { labelScale: 3 })).toBe('labelScale: 0.5 to 2');
    const look = await json(c, 'set_display', { labelSpacing: 2, labelLayout: 'staggered', labelShow: 'extremes', labelBox: false, labelColour: '#ff8800' });
    const keys = ['labelSpacing', 'labelLayout', 'labelShow', 'labelBox', 'labelColour'] as const;
    expect(keys.map((k) => look[k])).toEqual([2, 'staggered', 'extremes', false, '#ff8800']);
    expect(keys.map((k) => c().ui[k])).toEqual([2, 'staggered', 'extremes', false, '#ff8800']);
    expect(await call(c, 'set_display', { labelSpacing: 0.5 })).toBe('labelSpacing: 1 to 4');
    expect(await call(c, 'set_display', { labelLayout: 'random' })).toMatch(/^labelLayout: one of grid, staggered, scattered, spot/);
    expect(await call(c, 'set_display', { labelShow: 'top' })).toMatch(/^labelShow: one of all, extremes, problem/);
    expect(await call(c, 'set_display', { labelColour: 'red' })).toBe("labelColour: a colour, '#rrggbb'");
    expect([d.sunAround, c().sunAround]).toEqual([all, { 0: all }]);
    expect(d.fieldPreview).toEqual({ show: true, scale: 2, density: 'many', around: ['/Site/Facade'] }); // the View analysis' receivers under /Site
    expect(await call(c, 'set_display', { highlight: [[1, 1]] })).toBe('highlight[0]: [lo, hi] with lo < hi');
    expect(await call(c, 'set_display', { sunAround: ['/Nope'] })).toBe('sunAround: no mesh at or under /Nope in model A; find prims with model_tree');
    expect(await call(c, 'set_display', { fieldPreview: { around: ['/Site/Park'] } })).toBe('fieldPreview.around: no View analysis receiver at or under /Site/Park in model A; find prims with model_tree');
    expect(await call(c, 'set_display', { fieldPreview: { scale: 9 } })).toMatch(/^fieldPreview\.scale: /);
    expect(await call(c, 'set_display', { display: 'xray' })).toMatch(/^display: one of shaded, /);
    expect(await call(c, 'set_display', { sky: 'night' })).toMatch(/^sky: one of none, blue-sky, sunset/);
    await call(c, 'screenshot', { highlight: null, display: 'wire', sky: 'sunset', sunAround: null, fieldPreview: { show: false } });
    expect([c().state.bins, c().ui.display, c().ui.sky, c().sunAround, c().field.shown]).toEqual([[[0, 0.3], [0.5, 0.7]], 'plain-wire', 'blue-sky', { 0: all }, true]); // the shot's own, then the app's back
    const off = await json(c, 'set_display', { highlight: null, sunAround: null, fieldPreview: { show: false, around: null } });
    expect([off.highlight, off.sunAround, off.fieldPreview.show, off.fieldPreview.around, c().state.bins, c().sunAround]).toEqual([null, null, false, null, [], {}]);
  });

  it('update_settings: reset puts a section back, the gradient library is put, picked and removed, and the reply gives the field in numbers', async () => {
    const { c } = app();
    const r = await json(c, 'update_settings', { view: { fov: [360, -30, 30], cell: 5 }, viz: { library: [{ key: 'mine', label: 'Mine', stops: ['#000000', '#ff0000', '#ffffff'] }], quantity: 'sky', gradient: 'mine' } });
    expect(r.field).toEqual({ grid: '72 x 12', rays: 864, azimuth: [0, 360], elevation: [-30, 30] }); // all round: no gaze
    expect([c().state.settings.viz.library.mine.label, c().state.settings.viz.gradients.sky, r.settings.viz.library]).toEqual(['Mine', 'mine', [expect.objectContaining({ key: 'mine', label: 'Mine' })]]);
    const back = await json(c, 'update_settings', { reset: ['view-field'], viz: { library: [{ key: 'mine', remove: true }] } });
    expect([back.field.grid, c().state.settings.viewSim.fov, c().state.settings.viz.library]).toEqual(['60 x 60', [120, -70, 50], {}]);
    expect(await call(c, 'update_settings', { viz: { library: [{ key: 'x', remove: true, label: 'X' }] } })).toBe('viz.library[0].label: not with remove');
    expect(await call(c, 'update_settings', { viz: { library: [{ key: 'x', stops: ['#000000', '#ffffff'], positions: [0.5, 0.2] }] } })).toBe('viz.library[0].positions: one per stop, ascending within 0 to 1');
    expect(await call(c, 'update_settings', { site: { locate: true, lat: 1 } })).toBe('site.locate: give one of query, locate, or lat and lon');
  });

  it('app_state: per model its file and the variant choices made since it opened; the field each eye traces in numbers', async () => {
    const { c } = app();
    vi.stubGlobal('document', { visibilityState: 'visible' });
    const choices = { '/Site/Block': { height: ['low', 'high'] as const, roof: ['flat', 'flat'] as const } };
    const x = () => ({ ...c(), variants: () => choices, fileOf: () => 'site/site.usda' }) as unknown as Ctl;
    const [m] = (await json(x, 'app_state', {})).models;
    expect([m.file, m.variants]).toEqual(['site/site.usda', { '/Site/Block': { height: 'high' } }]); // the ones changed only
    expect((await json(c, 'app_state', {})).models[0]).not.toHaveProperty('variants');
  });
});

describe('bridge', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('until resolves at once or after a commit, else rejects naming what it waited for', async () => {
    await until(() => true, 10, 'nothing');
    let flag = false;
    const p = until(() => flag, 1000, 'the flag');
    flag = true;
    settled();
    await p;
    await expect(until(() => false, 10, 'the model to load')).rejects.toThrow('timed out after 0 s waiting for the model to load');
  });

  it('exclusive runs one step at a time, in order, past a failure', async () => {
    const order: string[] = [];
    const a = exclusive(async () => { await new Promise((r) => setTimeout(r, 10)); order.push('a'); });
    const b = exclusive(() => { throw new Error('b'); });
    const c = exclusive(() => order.push('c'));
    await expect(b).rejects.toThrow('b');
    await Promise.all([a, c]);
    expect(order).toEqual(['a', 'c']);
  });

  it('polls, answers a call once, polls again on 204, stops on 403', async () => {
    const id = '1b4e28ba-2fa1-41d2-883f-0016d3cca427', body = `{"id": "${id}", "params": {"name": "app_state", "arguments": {}}}`; // as the server writes it
    const polls = [() => new Response(body, { headers: { 'Content-Type': 'application/json' } }), () => new Response(body, { headers: { 'Content-Type': 'application/json' } }), () => new Response(null, { status: 204 }), () => new Response('error: agent routes answer only on this machine\n', { status: 403 })];
    const seen: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      return url.includes('wait=25') ? polls.shift()!() : new Response(null, { status: 204 });
    }));
    vi.stubGlobal('document', { hasFocus: () => true, visibilityState: 'visible', addEventListener: vi.fn(), removeEventListener: vi.fn() });
    const win = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
    vi.stubGlobal('window', win);
    const handle = vi.fn(async () => ({ content: [{ type: 'text' as const, text: '{"ok":true}' }] }));
    startBridge(handle);
    await vi.waitFor(() => expect(polls.length).toBe(0));
    await vi.waitFor(() => expect(seen.some((s) => s.url.includes('/bridge/result/'))).toBe(true));
    await new Promise((r) => setTimeout(r, 20));
    expect(win.removeEventListener).toHaveBeenCalledWith('focus', win.addEventListener.mock.calls[0][1]); // stopped: no more pings either
    expect(handle).toHaveBeenCalledTimes(1); // the repeated id is not answered twice
    expect(handle).toHaveBeenCalledWith('app_state', {});
    const post = seen.find((s) => s.url === `/bridge/result/${id}`)!;
    expect(post.init?.method).toBe('POST');
    expect((post.init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(post.init?.body as string)).toEqual({ content: [{ type: 'text', text: '{"ok":true}' }] });
    const gets = seen.filter((s) => s.url.startsWith('/bridge/next'));
    expect(gets.filter((s) => s.url.includes('wait=25'))).toHaveLength(4); // nothing after the 403
    expect(gets.some((s) => s.url === '/bridge/next?wait=0&focus=1')).toBe(true); // the focused tab says so
    const tabs = new Set(gets.map((s) => (s.init?.headers as Record<string, string>)['X-Client-Id']));
    expect(tabs.size).toBe(1);
    expect([...tabs][0]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('a call waiting for a pickup past its budget answers isError and does not run', async () => {
    vi.useFakeTimers();
    let release!: (r: Response) => void; // GET /session: the pickup, answered at the end
    const posted: unknown[] = [], polls = [
      () => new Response('{"id": "1b4e28ba-2fa1-41d2-883f-0016d3cca428", "params": {"name": "app_state", "arguments": {}}}', { headers: { 'Content-Type': 'application/json' } }),
      () => new Response('error: agent routes answer only on this machine\n', { status: 403 }),
    ];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/session') return init?.method ? new Response(null, { status: 204 }) : new Promise<Response>((r) => { release = r; });
      if (url.startsWith('/bridge/result/')) posted.push(JSON.parse(init?.body as string));
      return url.includes('wait=25') ? polls.shift()!() : new Response(null, { status: 204 });
    }));
    vi.stubGlobal('document', { hasFocus: () => false, visibilityState: 'visible', addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    const ctl = vi.fn(), stop = connect(ctl); // the handler would read the controller
    await vi.advanceTimersByTimeAsync(40e3);
    expect(posted).toEqual([]); // still waiting
    await vi.advanceTimersByTimeAsync(2e3);
    expect(posted).toEqual([{ content: [{ type: 'text', text: 'app_state: the app is still taking over the hidden session; call app_state again in a moment' }], isError: true }]);
    expect(ctl).not.toHaveBeenCalled();
    release(new Response(null, { status: 404 }));
    stop();
  });
});
