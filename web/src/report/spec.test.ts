import { describe, expect, it } from 'vitest';
import mcp from '../../../server/mcp.json';
import guide from '../mcp/report.md?raw';
import { chartSpec, chosenOf, editChart, glyphs, imageSize, inApp, parseReports, readiness, validateSpec, type AppModel, type AppView, type Block, type Draft, type Report } from './spec';

const BLOCK = ['/Site/Block/Facade_N', '/Site/Block/Facade_E', '/Site/Block/Facade_S', '/Site/Block/Facade_W', '/Site/Block/Roof'];
// a run's settings as appView gives them: [args, weather]
const run = (from: string, weather: unknown = null) => JSON.stringify([['--clear-sky', '--from', from, '--to', '2026-03-21T18:00', '--step', '15'], weather]);
const MARCH = run('2026-03-21T08:00'), JUNE = run('2026-06-21T08:00');
const model = (L: string, o: Partial<AppModel> = {}): AppModel => ({
  model: L, file: 'building', loading: false, choices: {}, receivers: BLOCK, shades: ['/Site/Neighbour'], result: 'fresh', key: MARCH, inputs: MARCH, columns: ['sunhours_front'], ...o,
});
// the fixture as A (base) and B (overhang, the overhang a shade), run with the problem range below 2 h
const B = { choices: { '/Site/Block': { option: ['base', 'overhang'] as const } }, shades: ['/Site/Block/Overhang', '/Site/Neighbour'] };
const app = (...ms: AppModel[]): AppView => ({ models: ms, shown: 'sunhours_front', ranges: { sunhours: { lo: 2, hi: null } } });
const examples = [...guide.matchAll(/```json\r?\n([\s\S]*?)\r?\n```/g)].map((m) => JSON.parse(m[1])); // a CRLF checkout too
const stamp = (d: Draft | string[]): Report => ({ ...(d as Draft), created: '2026-10-29T10:00:00.000Z', updated: '2026-10-29T10:00:00.000Z' });

describe('validateSpec', () => {
  it("accepts the guide's two examples, each model stored with its run, the ranges it shows with theirs", () => {
    expect(examples).toHaveLength(2);
    const single = validateSpec(examples[0], app(model('A', { open: ['F:\\models\\building.usda'] }))), both = validateSpec(examples[1], app(model('A'), model('B', B)));
    expect(single).not.toBeInstanceOf(Array);
    expect(both).not.toBeInstanceOf(Array);
    expect((single as Draft).models).toEqual([{ model: 'A', file: 'building', open: ['F:\\models\\building.usda'], variants: {}, receivers: BLOCK, shades: ['/Site/Neighbour'], runKey: MARCH }]);
    expect((single as Draft).ranges).toEqual({ sunhours: { lo: 2, hi: null } });
    expect((both as Draft).models[1]).toEqual({ model: 'B', file: 'building', variants: { '/Site/Block': { option: 'overhang' } }, receivers: BLOCK, shades: ['/Site/Block/Overhang', '/Site/Neighbour'], runKey: MARCH });
    const chart = { id: 'spread-ab', kind: 'curve', column: 'sunhours_front' };
    expect((both as Draft).blocks[1]).toEqual({ type: 'chart', chart, caption: examples[1].blocks[1].caption, saved: chart });
  });

  it('names every problem by its path', () => {
    const spec = {
      ...examples[0], id: 'Block 4', title: 'Sun ≥ 2 h', summary: 'One\u2011two', models: ['A', 'C'],
      stats: [{ label: 'x', metric: 'average', column: 'sunhours_front', model: 'A' }],
      blocks: [
        { type: 'text', text: '' },
        { type: 'chart', chart: { id: 'hist', kind: 'histogram' }, caption: 'c' },
        { type: 'chart', chart: { id: 'p', kind: 'parts', range: 'log', metric: 'mean' }, caption: 'c' },
        { type: 'view', name: 'v', view: { eye: [0, 0], target: [0, 0, 0], fov: 45, projection: 'perspective', height: 1 }, column: null, aspect: 9, caption: 'c' },
        { type: 'table', column: 'radiation_front', metrics: ['mean'], caption: '' },
        { type: 'map', caption: 'c' },
        { type: 'chart', chart: { id: 'h', kind: 'histogram', metric: 'p10', bin: 16 }, caption: 'Bell\u0007' },
      ],
      colour: 'red',
    };
    expect(validateSpec(spec, app(model('A'), model('C', { result: 'stale' })))).toEqual([
      'colour: not a field of a ReportSpec (id, title, created, updated, models, stats, summary, blocks, notes)',
      'id: 1 to 64 lowercase letters, digits or -',
      "title: '≥' (U+2265) is not in the report fonts; write '>='",
      "summary: '\u2011' (U+2011) is not in the report fonts; write '-'",
      "models[1]: model C's result is stale (inputs changed since it ran); run first",
      'stats[0].metric: one of mean, median, p10, p90, min, max, below, within, above, area, total, elements',
      'blocks[0].text: empty',
      "blocks[1].chart.id: 'hist' is a Results panel chart of its own; give the report's chart another id",
      "blocks[2].chart.range: 'relative', 'absolute' or [min, max] with min < max, max - min finite and over 1e-9 of their size",
      'blocks[3].view: a camera {eye, target, fov, projection, height} as find_critical, set_camera or app_state give it',
      'blocks[3].aspect: width / height, 0.25 to 4',
      'blocks[4].caption: empty',
      "blocks[4].parts: by 'parts' takes the prim paths, one row each (model_tree); or by 'mesh' or 'facing'",
      "blocks[4].column: not in model A's result (sunhours_front)",
      'blocks[5].type: one of text, chart, view, table',
      'blocks[6].caption: U+0007 is a control character; remove it',
      'blocks[6].chart.metric: not a field of a histogram chart (id, kind, title, column, models, parts, range, bins, markers, grid, height)',
      'blocks[6].chart.bin: not a field of a histogram chart (id, kind, title, column, models, parts, range, bins, markers, grid, height)',
    ]);
    expect(validateSpec({ ...examples[0], id: 'nul' }, app(model('A')))).toEqual(['id: a name Windows keeps for a device; choose another id']);
  });

  it('refuses a model without a result, a share without a problem range, a chart id twice', () => {
    expect(validateSpec({ ...examples[0], models: ['A'] }, app(model('A', { result: null })))).toEqual(['models[0]: model A has no result; run first']);
    expect(validateSpec(examples[0], { ...app(model('A')), ranges: {} })).toEqual([
      "stats[2].metric: below is a share of the problem range, and sunhours has none; set it (update_settings viz {quantity: 'sunhours', below / above}) or use another metric",
      "blocks[2]: below is a share of the problem range, and sunhours has none; set it (update_settings viz {quantity: 'sunhours', below / above}) or use another metric",
    ]);
    const twice = { ...examples[0], blocks: [examples[0].blocks[0], examples[0].blocks[0]] };
    expect(validateSpec(twice, app(model('A')))).toEqual(["blocks[1].chart.id: 'facades' is taken by blocks[0]"]);
  });
});

describe('readiness', () => {
  const both = stamp(validateSpec(examples[1], app(model('A'), model('B', B))));
  it('is ready as saved; names what differs and how to restore it', () => {
    expect(readiness(both, app(model('A'), model('B', B)))).toEqual([]);
    expect(readiness(both, app(model('A'), model('B', { ...B, choices: { '/Site/Block': { option: ['base', 'base'] } }, shades: ['/Site/Neighbour'] })))).toEqual([
      "model B: not as at save: set_geometry variant option of /Site/Block to overhang (now the file's own); set_roles shade for /Site/Block/Overhang; then run",
    ]);
    expect(readiness(both, app(model('A', { result: 'stale', inputs: JUNE }), model('B', { ...B, key: JUNE, inputs: JUNE })), true)).toEqual([
      'model A: the inputs changed since the run this report is on (--from 2026-03-21T08:00 at save, 2026-06-21T08:00 now); set them back',
      'model B: the settings differ from save time (--from 2026-03-21T08:00 at save, 2026-06-21T08:00 now); set them back and run, or save the report again',
      'generating: a PDF of this report is being made; call generate_report for it',
    ]);
    // a stale result of other inputs: running brings the report's back; with the inputs not the report's, it says which
    expect(readiness(both, app(model('A', { result: 'stale', key: JUNE }), model('B', { ...B, result: null, inputs: run('2026-03-21T08:00', ['x.epw', 5, 1]) })))).toEqual([
      'model A: its result is stale (inputs changed since it ran); run',
      'model B: the settings differ from save time (weather clear sky at save, x.epw now); set them back and run, or run and save the report again',
    ]);
    expect(readiness(both, app(model('A', { file: 'other' })))).toEqual([
      'model A: other is open, the report is on building; open_model building into A', 'model B: not open; open_model building into B',
    ]);
    const opened = stamp(validateSpec(examples[0], app(model('A', { open: ['F:\\models\\building.usda'] }))));
    expect(readiness(opened, app())).toEqual(['model A: not open; open_model F:\\models\\building.usda into A']);
  });

  it('needs the problem range of save time', () => {
    expect(readiness(both, { ...app(model('A'), model('B', B)), ranges: { sunhours: { lo: 3, hi: null } } })).toEqual([
      "the problem range of sunhours is below 3 h now, below 2 h at save; set it back (update_settings viz {quantity: 'sunhours', below: 2, above: null}) or save the report again",
    ]);
  });

  it("says the same in the app's words, naming no tool", () => {
    const off = [
      ...readiness(both, app(model('A', { file: 'other' }), model('B', { ...B, choices: { '/Site/Block': { option: ['base', 'base'] } }, shades: [], loading: true }))),
      ...readiness(both, app(model('A', { result: 'running', shades: [] }), model('B', { ...B, key: JUNE, inputs: JUNE })), true),
      ...readiness(both, { ...app(model('A'), model('B', { ...B, choices: { '/Site/Block': { option: ['base', 'base'] } }, shades: ['/Site/Neighbour', '/Site/Block/Overhang', '/x'] })), ranges: {} }),
    ].map(inApp);
    expect(off).toEqual([
      'model A: other is open, the report is on building; open building as model A', 'model B: loading',
      'model A: not as at save: /Site/Neighbour back to shade; then run', 'model B: the settings differ from save time (from 2026-03-21T08:00 at save, 2026-06-21T08:00 now); set them back and run',
      'generating: a PDF of this report is being made',
      "model B: not as at save: variant option of /Site/Block back to overhang (now the file's own); /x back to ignored; then run",
      'the problem range of sun hours is none now, below 2 h at save; set it back in Results', // its shares: no line of their own
    ]);
    // a report stored without its ranges (before they were kept): its shares without a range, one cause in the app's words
    const { ranges: _r, ...older } = both;
    expect([...new Set(readiness(older, { ...app(model('A'), model('B', B)), ranges: {} }).map(inApp))]).toEqual(['the report shows shares of the problem range of sun hours, which has none now; set one in Results']);
    for (const t of mcp.tools.filter((x) => x.name.includes('_'))) expect(off.join('\n')).not.toContain(t.name);
  });
});

describe('editChart', () => {
  const single = stamp(validateSpec(examples[0], app(model('A')))), spec = chartSpec((single.blocks[0] as Extract<Block, { type: 'chart' }>).chart, single);
  const chart = (r: Report | null, i = 0) => (r?.blocks[i] as Extract<Block, { type: 'chart' }>).chart;
  it('puts the look as the settings menu gives it, letters kept; resets it to the saved chart; removes the block', () => {
    expect(spec.models).toEqual([0]);
    const set = editChart(single, { spec: { ...spec, bins: 500, metric: 'p10', range: [0, 6] } });
    expect(chart(set)).toEqual({ id: 'facades', kind: 'parts', column: 'sunhours_front', parts: spec.parts, range: [0, 6], metric: 'p10' }); // a parts chart has no bins
    expect(chart(editChart(set!, { id: 'facades', reset: true }))).toEqual(chart(single)); // the agent's metric and 'absolute' back
    const both = stamp(validateSpec(examples[1], app(model('A'), model('B', B)))), two = { ...both, blocks: both.blocks.with(1, { ...both.blocks[1], chart: { ...chart(both, 1), models: ['B'] } } as Block) };
    const curve = editChart(two, { spec: { ...chartSpec(chart(two, 1), two), height: 1000, grid: false } });
    expect(chart(curve, 1)).toEqual({ id: 'spread-ab', kind: 'curve', column: 'sunhours_front', height: 400, grid: false, models: ['B'] });
    expect(editChart(single, { id: 'facades', remove: true })?.blocks.map((b) => b.type)).toEqual(['view', 'table', 'text']);
    expect(editChart(single, { id: 'nope', reset: true })).toBeNull();
    expect(editChart(single, { spec: { ...spec, range: [2, 2] } })).toBeNull();
  });
});

describe('parseReports', () => {
  it('leaves out a stored spec the app cannot read, keeps the rest', () => {
    const good = stamp(validateSpec(examples[0], app(model('A')))), entry = (id: string, spec: unknown) => ({ id, pdf: false, spec: JSON.stringify(spec) });
    const list = parseReports([
      entry(good.id, good), entry('x', { title: 'x' }), { id: 'y', pdf: true, spec: '{' }, entry('other-id', good),
      entry(good.id, { ...good, blocks: [{ type: 'chart', chart: { id: 'c', kind: 'pie', column: 'sunhours_front' }, caption: 'c' }] }),
      entry(good.id, { ...good, models: [{ model: 'A' }] }), entry(good.id, { ...good, stats: [{ label: 'x', metric: 'average', column: 'c', model: 'A' }] }),
    ]);
    expect(list.map((e) => e.id)).toEqual([good.id]);
  });
});

describe('helpers', () => {
  it("variant choices back at the file's own drop out; images keep to the figure card and one page", () => {
    expect(chosenOf({ '/a': { x: ['1', '2'], y: ['1', '1'] }, '/b': { z: ['k', 'k'] } })).toEqual({ '/a': { x: '2' } });
    expect(imageSize(1, 1.6).width).toBeCloseTo(630.76, 1);
    expect(imageSize(2, 1.6).width).toBeCloseTo(307.38, 1);
    expect(imageSize(4, 0.5)).toEqual({ width: 150, height: 300 });
  });
  it('lets through what the report fonts draw', () => {
    expect(glyphs('Façade Ŝ ő ș ə – — “ ” ‘ ’ … • † ′ ″ ‹ › € − ² × · ±\n\tok')).toBe('');
    expect(glyphs('a\u202fb')).toBe('U+202F is a special space; write a plain space');
    expect(glyphs('a\u00adb')).toBe('U+00AD is an invisible character; remove it');
    expect(glyphs('ſ')).toBe("'ſ' (U+017F) is not in the report fonts; write it in Latin letters");
  });
});
