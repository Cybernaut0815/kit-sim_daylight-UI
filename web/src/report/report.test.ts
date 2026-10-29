import { describe, expect, it } from 'vitest';
import type { ViewState } from 'usd-viewer';
import { defaultSettings, type ObjectRow, type RunResult } from '../store';
import { renderReport, type ReportInput } from './Report';
import type { Report } from './spec';

// two receivers of two faces each (weights 1: no meshes): Facade_S 0.5 and 1 h, the roof 4 and 5 h
const objects: ObjectRow[] = [
  { id: 'm1', name: 'Facade_S', path: '/Site/Block/Facade_S', tris: 2, verts: 4, role: 'receiver' },
  { id: 'm2', name: 'Roof', path: '/Site/Block/Roof', tris: 2, verts: 4, role: 'receiver' },
];
const args = ['--lat', '51.5074', '--lon', '-0.1278', '--clear-sky', '--quantity', 'sunhours', '--north', '0', '--from', '03-21T08:00', '--to', '03-21T18:00', '--step', '15'];
const result = (slot: number): RunResult => ({
  values: [0.5, 1, 4, 5].map((v) => Float64Array.of(v + slot)), columns: ['sunhours_front'], receivers: ['m1', 'm2'], on: 'faces', elapsed: 0.42,
  manifest: { columns: ['sunhours_front'], duration_h: 10, dirs: { sky: 145, ground: 145, sun: 40 }, meshes: [{ name: 'm1', first: 0, count: 2 }, { name: 'm2', first: 2, count: 2 }], run_s: 0.12, id: `job-${slot}`, started: '2026-10-29T10:00:00Z', finished: '2026-10-29T10:00:01Z' } as RunResult['manifest'],
  key: JSON.stringify([args, null, ['m1', 'm2'], []]),
});
const settings = defaultSettings();
settings.weather.source = 'clear-sky';
settings.viz.ranges.sunhours = { lo: 2, hi: null };
const view: ViewState = { eye: [30, 5, 30], target: [10, 5, 0], fov: 45, projection: 'perspective', height: 10 };
const report = (models: string[], title = 'Sun on <b>21 March</b>'): Report => ({
  id: 'r', title, created: '2026-10-29T10:00:00.000Z', updated: '2026-10-29T10:05:00.000Z',
  models: models.map((model) => ({ model, file: 'building', variants: {}, receivers: ['/Site/Block/Facade_S', '/Site/Block/Roof'], shades: [], runKey: 'k' })),
  stats: [{ label: 'South facade', metric: 'mean', column: 'sunhours_front', model: 'A', path: '/Site/Block/Facade_S' }, { label: 'Under 2 h', metric: 'below', column: 'sunhours_front', model: 'A' }],
  summary: 'First paragraph with **bold**.\n\n- one\n- two <script>alert(1)</script>',
  blocks: [
    { type: 'text', title: 'Context', text: 'Plain words.' },
    { type: 'chart', chart: { id: 'parts', kind: 'parts', column: 'sunhours_front', parts: ['/Site/Block/Facade_S', '/Site/Block/Roof'] }, caption: 'Mean sun hours per part, in h.' },
    { type: 'table', column: 'sunhours_front', parts: ['/Site/Block/Facade_S', '/Site/Block/Roof'], metrics: ['mean', 'area', 'below'], caption: 'Per part.' },
    { type: 'view', name: 'South', view, near: 12, column: 'sunhours_front', caption: 'The south facade, in h.' },
    { type: 'chart', chart: { id: 'spread', kind: 'histogram', column: 'sunhours_front' }, caption: 'Distribution, in h.' },
    { type: 'table', column: 'sunhours_front', by: 'mesh', metrics: ['max'], caption: 'Per mesh.' },
  ],
  notes: 'A note.',
});
const input = (models: string[], title?: string): ReportInput => ({
  report: report(models, title), models: models.map((l) => { const slot = 'ABCD'.indexOf(l); return { slot, name: 'building', objects, result: result(slot) }; }),
  settings, weightsFor: () => undefined, meshOf: () => undefined, images: [[], [], [], models.map(() => 'data:image/png;base64,AAAA'), [], []],
  versions: { app: '0.1.0', kitUi: '0.2.0', core: 'abc1234', viewer: 'def5678' }, date: new Date('2026-10-29T12:00:00Z'),
});

describe('renderReport', () => {
  const html = renderReport(input(['A']));
  it('is the kit-report skeleton', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    for (const s of ['<html lang="en" data-kit="sim" data-theme="light" data-density="compact">', '<main class="report stack" id="main">', '<span class="kit-mark">kit-<span class="kit-mark__name">sim</span></span>',
      '<div class="grid" style="--grid-min:8rem"><div class="stat">', '<span class="badge badge--success"><span class="dot"></span>Run complete</span>', '<section class="section stack page-break"><h2>Appendix</h2>', '<caption>Table A1. Provenance</caption>']) expect(html).toContain(s);
    expect([...html.matchAll(/<h2>([^<]+)<\/h2>/g)].map((m) => m[1])).toEqual(['Summary', 'Inputs', 'Results', 'Method and assumptions', 'Appendix']);
  });
  it('numbers figures and tables in order, units in the headers, the stats from the results', () => {
    expect([...html.matchAll(/(Figure|Table) (\d+)\./g)].map((m) => m[0])).toEqual(['Figure 1.', 'Table 1.', 'Figure 2.', 'Figure 3.', 'Table 2.']);
    expect(html).toContain('Figure 2 colours sun hours (front side) on one scale, Cividis from 0.5 to 5 h. It leaves out geometry within 12 m of the camera');
    expect(html).toContain('Mean <span class="th-unit">(h)</span>');
    expect(html).toContain('Area <span class="th-unit">(m²)</span>');
    expect(html).toContain('Below the range <span class="th-unit">(%)</span>');
    expect(html).toContain('<span class="stat__value">0.75 h</span>'); // Facade_S: (0.5 + 1) / 2
    expect(html).toContain('<span class="stat__value">50 %</span>'); // under 2 h: half the area
    expect(html).toContain('<img src="data:image/png;base64,AAAA" width="631" height="394"');
  });
  it("escapes the agent's text and holds no script", () => {
    const evil = renderReport(input(['A'], '<script>alert(1)</script>'));
    expect(evil).toContain('<title>&lt;script&gt;alert(1)&lt;/script&gt;</title>');
    expect(evil).toContain('<li>two &lt;script&gt;alert(1)&lt;/script&gt;</li>');
    expect(evil).toContain('<p>First paragraph with <strong>bold</strong>.</p>');
    expect(evil.toLowerCase()).not.toContain('<script');
  });
  it("names '/' every receiver, keeps each argument whole, bolds a chart's title, caps a table by mesh at 50 rows", () => {
    const p = input(['A']), r = p.report;
    r.stats = [{ label: 'All', metric: 'mean', column: 'sunhours_front', model: 'A', path: '/' }];
    r.blocks = r.blocks.map((b) => (b.type === 'chart' ? { ...b, chart: { ...b.chart, title: 'Per facade.' } } : b));
    const out = renderReport(p);
    expect(out).toContain('Mean · Sun hours, front · every receiver</span>');
    expect(out).toContain('<span class="arg">--from 03-21T08:00</span> <span class="arg">--to 03-21T18:00</span>');
    expect(out).toContain('Figure 1. <strong>Per facade. </strong>Mean sun hours per part, in h.');
    // 60 receiver meshes of one face each
    const ids = Array.from({ length: 60 }, (_, k) => `m${k}`), many = { ...p, report: { ...r, stats: [], blocks: [r.blocks[5]] }, images: [[]] };
    many.models = [{ ...p.models[0], objects: ids.map((id) => ({ id, name: id, path: `/S/${id}`, tris: 1, verts: 3, role: 'receiver' as const })), result: { ...result(0), values: ids.map((_, k) => Float64Array.of(k)), receivers: ids, manifest: { ...result(0).manifest, meshes: ids.map((name, k) => ({ name, first: k, count: 1 })) } } }];
    const capped = renderReport(many);
    expect(capped).toContain('Per mesh. The 50 largest of 60 receiver meshes.');
    expect(capped.match(/<th scope="row"/g)).toHaveLength(50);
  });
  it('a comparison reads model by model', () => {
    const two = renderReport(input(['A', 'B']));
    expect(two).toContain('Model A building');
    expect(two).toContain('Model B building');
    expect(two).toContain('<th scope="col">Model</th>');
    expect(two).toContain('<td>B building</td>');
    expect(two.match(/<img /g)).toHaveLength(2);
    expect(two).toContain('width="307" height="192"');
  });
});
