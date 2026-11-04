import { BoxGeometry, Mesh } from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import mcp from '../../../server/mcp.json';
import { noOccludeArgs } from '../lib/args';
import type { Summary } from '../lib/result';
import { NONE, toStage, type Section } from '../lib/section';
import { glyphs } from '../report/spec';
import { defaultSettings, initialState, reducer, type Action, type ObjectRow, type State, type Station } from '../store';
import { exclusive, settled, startBridge, until } from './bridge';
import guide from './guide.md?raw';
import reportGuide from './report.md?raw';
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

describe('the tool list', () => {
  it('every tool of mcp.json has its handler, and only those', () => {
    const names = mcp.tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(Object.keys(HANDLERS).sort()).toEqual([...names].sort());
  });
  it('the instructions and each description stay under 4096 characters', () => {
    expect(mcp.instructions.length).toBeLessThan(4096);
    for (const t of mcp.tools) expect(t.description.length, t.name).toBeLessThan(4096);
  });
  it("screenshot's section is set_display's, or null; a report's view block takes set_display's", () => {
    const shot = schema('screenshot').properties!.section;
    expect(shot.type).toEqual(['object', 'null']);
    expect({ ...shot, type: 'object', description: '' }).toEqual({ ...SECTION, description: '' });
    expect(SECTION).toBe(schema('set_display').properties!.section);
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
    for (const text of [guide, reportGuide]) {
      expect((text.match(/\b(?:app_state|site_info|model_tree|(?:update|open|remove|set|get|edit|find|save|delete|generate|download)_[a-z_]+)\b/g) ?? []).filter((w) => !names.has(w))).toEqual([]);
      expect((text.match(/\b(?:sim|time|weather|viz|site)\.[a-zA-Z]+\b/g) ?? []).filter((d) => { const [g, k] = d.split('.'); return !us[g]?.properties?.[k]; })).toEqual([]);
      expect([...new Set(text)].filter(glyphs)).toEqual([]); // what the report's fonts draw: agents copy it
    }
  });
});

describe('check', () => {
  it('passes what the schema allows, names the field of the rest', () => {
    expect(check(schema('update_settings'), { time: { step: 30, from: { hour: '07:30' } }, viz: { min: null, below: 2 }, charts: [{ id: 'c', kind: 'histogram', range: [0, 8], bins: 'auto' }] })).toBe('');
    expect(check(schema('set_display'), { highlight: null })).toBe('');
    expect(check(schema('update_settings'), { time: { step: 7 } })).toBe('time.step: one of 10, 15, 30, 60');
    expect(check(schema('update_settings'), { time: { from: { hour: '7:30' } } })).toBe("time.from.hour: a time, 'HH:MM'");
    expect(check(schema('update_settings'), { charts: [{ id: 'c', range: 'log' }] })).toBe('charts[0].range: one of relative, absolute');
    expect(check(schema('update_settings'), { charts: [{ id: 'c', range: [1] }] })).toBe('charts[0].range: 2 items');
    expect(check(schema('update_settings'), { weather: { turbidity: 9 } })).toBe('weather.turbidity: 2 to 7');
    expect(check(schema('set_roles'), { role: 'receiver' })).toBe('paths: required');
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
  const values = Array.from({ length: 10 }, (_, f) => Float64Array.of(f)), sides = (r: ReturnType<typeof bySide>) => r.map((g) => `${g.facing} ${g.rows.map((x) => x[0]).join()} ${g.w.join()}`);
  it('faces of a single-mesh model by the side they face, in compass order; north turns them; a back column faces the other way', () => {
    expect(sides(bySide(values, [one], 'faces', 0, false))).toEqual(['N 6,7 7,8', 'E 2,3 3,4', 'S 4,5 5,6', 'W 0,1 1,2', 'up 8,9 9,10']);
    expect(sides(bySide(values, [one], 'faces', 90, false)).map((g) => g.split(' ').slice(0, 2).join(' '))).toEqual(['N 0,1', 'E 6,7', 'S 2,3', 'W 4,5', 'up 8,9']); // north 90: model -X
    expect(sides(bySide(values, [one], 'faces', 0, true)).map((g) => g.split(' ').slice(0, 2).join(' '))).toEqual(['N 4,5', 'E 0,1', 'S 6,7', 'W 2,3', 'down 8,9']);
  });
  it('vertices along their faces\' normals, rows from each mesh\'s first; a degenerate element is left out', () => {
    const wall = { first: 0, count: 4, positions: quads[1].flat(), indices: [0, 1, 2, 0, 2, 3], w: [1, 1, 1, 1] };
    const roof = { first: 4, count: 5, positions: [...quads[4].flat(), 5, 5, 6], indices: [0, 1, 2, 0, 2, 3], w: [2, 2, 2, 2, 2] }; // vertex 4: on no face
    const rows = Array.from({ length: 9 }, (_, i) => Float64Array.of(i));
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
      state: { active: 0, models: [{ slot: 0, name: 'block', objects: [{ id: 'b', path: '/Site/Block' }] }], colourBy: 'plain', bin: null, settings: { sim: { north: 0 } } },
      panes: { 0: { loading: false } }, ui: {}, section: NONE, dispatch: () => {}, setUi: () => {}, viewer: () => ({ el }),
      setSection: (s: Section) => { x = { ...x, section: s }; el.section = toStage(s, 1, 'Z'); },
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
      state, dispatch: (a: Action) => { state = reducer(state, a); }, panes: { 0: { loading: false, meshes: new Map() } }, viewer: () => ({ el }), ui: {}, views: [], reports: null, generation: () => ({}),
      per: state.models.map((m) => ({ m, receivers: m.objects.filter((o) => o.role === 'receiver'), shades: [], key: '' })),
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
