// A report as one HTML page in the kit-ui kit-report format (A4, light paper, page numbers; skills/kit-report), drawn
// from the app's results at generation: the lockup and title, a status line, the stats, the agent's summary, the inputs
// (the app's own words), the blocks in order (text; charts, views and tables computed here, so they always match the
// results), the method and assumptions per column, and the provenance. One JSX tree rendered to static markup: React
// escapes every text the agent wrote, and useId keeps the legends' gradients apart. No script.
import { Fragment, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ObjMesh } from 'daylight-mesh';
import { DASH } from '../charts/axes';
import { Chart } from '../charts/Chart';
import { Legend } from '../charts/Legend';
import { chartData, type WeightsFor } from '../lib/charts';
import { haversineKm } from '../lib/geo';
import { scaleFor } from '../lib/gradients';
import { runSwitches } from '../lib/optics';
import { SIDE_HELP, columnLabel, fmtNum, roundPct, unionRange, unitFor, type Summary } from '../lib/result';
import { fmtClock, fmtDay } from '../lib/time';
import { rowNames } from '../lib/tree';
import { fmtOffset, zoneAt } from '../lib/zone';
import { provenance, summaries } from '../mcp/tools';
import type { ObjectRow, RunResult, Settings } from '../store';
import { LETTERS, cat, knob } from '../ui';
import { KIT_CSS } from './kitcss';
import { chartSpec, imageSize, type Metric, type Report } from './spec';

/** What a report page is drawn from: the stored spec; its models (in its order) with their results; the settings they
 *  ran with; element areas and meshes; per block the view images (one per model, data: URLs; [] for other blocks). */
export interface ReportInput {
  report: Report; models: { slot: number; name: string; file?: string; objects: ObjectRow[]; result: RunResult }[]; settings: Settings;
  weightsFor: WeightsFor; meshOf: (id: string) => ObjMesh | undefined; images: string[][];
  versions: { app: string; kitUi: string; core: string; viewer: string }; date: Date;
}
type Model = ReportInput['models'][number];

/** The page as an HTML document. */
export const renderReport = (p: ReportInput): string =>
  `<!doctype html>\n<!-- A Daylight report on kit-ui (kit-report). The result colours of the images, legends and histogram bars are hex values from the app's gradients: the documented exception to kit-ui's no-hex rule. -->\n${renderToStaticMarkup(<Page {...p} />)}`;

const W = 520; // the charts' viewBox width: a figure card (631 px) draws their 9-unit text at about 11 px
const MESH_ROWS = 50; // a table by mesh: its largest meshes, as many as results gives by default
// the figures' own rules: a legend at the charts' text size; a table kept on one page while it fits one (its caption and
// header never left at a page foot); the provenance's arguments kept whole, a long one broken anywhere
const FIGURES = '.legend-box { max-inline-size: 25rem; } @media print { .report .table-wrap { break-inside: avoid; } } .report td code { overflow-wrap: anywhere; } .report td code .arg { white-space: nowrap; }';
// what each quantity measures, in the report's words (the app's help without its hints on controls), with the clauses
// of Transmission (tx) and Reflections (rx) only when the run had them on
const MEASURES: Record<string, (tx: boolean, rx: boolean) => string> = {
  radiation: (tx, rx) => `Solar energy received over the period: sun, sky and ground light weighted by their angle on the surface, less what the scene blocks${tx ? ' (glass, screens and trees let their share through)' : ''}${rx ? ', plus what the scene reflects' : ''}.`,
  direct: (tx) => `Only the beam from the sun disc over the period${tx ? ', times the transmittance of the glass, screens and trees it crosses' : ''}; zero whenever the sun is down or behind solid geometry, so it shows where shading works.`,
  diffuse: (_, rx) => `Only the light from the sky and the ground over the period${rx ? ', plus the light the scene reflects' : ''}; smooth and hardly changed by small obstructions.`,
  irradiance: () => 'The average power received over the evaluated hours (for one instant, the value at that moment).',
  illuminance: () => 'The average daylight level over the evaluated hours, nights included: not comparable with task targets such as 300 to 500 lx, which hold for an instant or for occupied hours.',
  sunhours: (tx) => `The hours in the period when the sun is up and not blocked by any geometry${tx ? '; with transmission, equivalent full-sun hours (an hour behind a surface transmitting 0.6 counts 0.6)' : ''}.`,
};
const quantityName = (q: string) => (q === 'sunhours' ? 'sun hours' : q);
const HEAD: Record<Metric, string> = {
  mean: 'Mean', median: 'Median', p10: 'P10', p90: 'P90', min: 'Min', max: 'Max', below: 'Below the range', within: 'Within the range', above: 'Above the range',
  area: 'Area', total: 'Total', elements: 'Elements',
};
const PATCHES: Record<number, number> = { 1: 145, 2: 577, 4: 2305 };
const share = (m: Metric) => m === 'below' || m === 'within' || m === 'above';
/** A metric's unit in a column: the value's, the total's, m², % or none. */
const unitOf = (m: Metric, column: string) => (m === 'elements' ? '' : share(m) ? '%' : m === 'area' ? 'm²' : m === 'total' ? unitFor(column).total : unitFor(column).value);
/** A summary's metric as the results tool rounds it (shares in %). */
const show = (u: Summary, m: Metric) => (m === 'elements' ? u.elements.toLocaleString('en-GB') : share(m) ? (Number.isFinite(u[m]) ? fmtNum(roundPct(u[m])) : '–') : fmtNum(u[m]));
const label = (m: Pick<Model, 'slot' | 'name'>) => `${LETTERS[m.slot]} ${m.name}`;
/** A prim path as a stat or a table row names it ('/': every receiver). */
const place = (path: string, name: string) => (path === '/' ? 'every receiver' : name || path);
const few = (ps: readonly string[]) => (ps.length ? `${ps.slice(0, 6).join(', ')}${ps.length > 6 ? ` and ${ps.length - 6} more` : ''}` : 'none');
/** Run arguments as flag-value pairs ('--from 2026-03-21T08:00'). */
const pairs = (args: readonly string[]) => args.reduce<string[]>((out, t) => (t.startsWith('--') || !out.length ? [...out, t] : [...out.slice(0, -1), `${out[out.length - 1]} ${t}`]), []);
const utc = (iso?: string) => (iso ? iso.replace('T', ' ').replace('Z', ' UTC') : '–');
const deg = (v: number, pos: string, neg: string) => `${Math.abs(v).toFixed(4)}° ${v < 0 ? neg : pos}`;

const bold = (s: string) => s.split(/\*\*(.+?)\*\*/).map((t, i) => (i % 2 ? <strong key={i}>{t}</strong> : t));
/** The agent's text: paragraphs between blank lines, '- ' lines as lists, **bold**. */
function Prose({ text }: { text: string }) {
  const out: ReactNode[] = [];
  for (const para of text.split(/\n\s*\n/)) {
    let run: string[] = [], list = false;
    const flush = () => { if (run.length) out.push(list ? <ul key={out.length}>{run.map((l, i) => <li key={i}>{bold(l)}</li>)}</ul> : <p key={out.length}>{bold(run.join(' '))}</p>); run = []; };
    for (const line of para.split('\n').map((l) => l.trim()).filter(Boolean)) {
      const item = line.startsWith('- ');
      if (item !== list) { flush(); list = item; }
      run.push(item ? line.slice(2) : line);
    }
    flush();
  }
  return <div className="prose">{out}</div>;
}

/** A comparison chart's key: each model's line (colour and dash, as its series draws it), letter and name. */
const Key = ({ ms }: { ms: readonly Model[] }) => (
  <svg viewBox={`0 0 ${W} 14`} width="100%" role="img" aria-label={`Models: ${ms.map(label).join(', ')}`}>
    {ms.map((m, k) => (
      <g key={m.slot}>
        <line x1={k * 130} x2={k * 130 + 14} y1={7} y2={7} stroke={cat(m.slot)} strokeWidth={2} strokeDasharray={DASH[k]} />
        <text x={k * 130 + 18} y={10.5} fontSize={9} fill="var(--chart-text)">{label(m).slice(0, 24)}</text>
      </g>
    ))}
  </svg>
);

/** A key / value table of the inputs. */
const Pairs = ({ caption, rows }: { caption: string; rows: [string, ReactNode][] }) => (
  <div className="table-wrap">
    <table className="data-table data-table--wrap">
      <caption>{caption}</caption>
      <thead><tr><th scope="col">Parameter</th><th scope="col">Value</th></tr></thead>
      <tbody>{rows.map(([k, v]) => <tr key={k}><td className="text-muted">{k}</td><td>{v}</td></tr>)}</tbody>
    </table>
  </div>
);

function Page(p: ReportInput) {
  const { report: r, models, settings: s } = p, many = models.length > 1, first = models[0].result, { sim, time: t, weather: w, site } = s;
  const byLetter = (l: string) => models.find((m) => LETTERS[m.slot] === l)!;
  const range = (column: string) => s.viz.ranges[column.split('_')[0]] ?? { lo: null, hi: null };
  const summary = (m: Model, column: string, by: 'parts' | 'mesh' | 'facing', paths?: readonly string[]) => summaries(p, m, column, by, paths, range(column).lo ?? null, range(column).hi ?? null);
  const scaleOf = (column: string) => scaleFor(column, unionRange(models.map((m) => m.result), column), s.viz); // the report models' scale: the images' (generate.ts pins it)
  let figures = 0, tables = 0;
  const numbers = r.blocks.map((b) => (b.type === 'chart' || b.type === 'view' ? ++figures : b.type === 'table' ? ++tables : 0));
  const columns = [...new Set([...(r.stats ?? []).map((x) => x.column), ...r.blocks.flatMap((b) => (b.type === 'chart' ? [b.chart.column!] : b.type === 'view' ? (b.column ? [b.column] : []) : b.type === 'table' ? [b.column] : []))])];
  const zone = zoneAt(site.lat, site.lon), quantities = [...new Set(columns.map((c) => c.split('_')[0]))], switches = runSwitches(sim), physical = sim.mode === 'physical';
  const period = t.mode === 'annual' ? 'Every hour of the weather year' : t.mode === 'instant' ? `${fmtDay(t.date)}, ${fmtClock(t.hour)}`
    : t.from.date === t.to.date ? `${fmtDay(t.from.date)}, ${fmtClock(t.from.hour)} to ${fmtClock(t.to.hour)}, every ${t.stepMin} min`
      : `${fmtDay(t.from.date)} to ${fmtDay(t.to.date)}, each day ${fmtClock(t.from.hour)} to ${fmtClock(t.to.hour)}, every ${t.stepMin} min`;
  const weather = w.source === 'clear-sky' ? `Clear sky (Ineichen-Perez), Linke turbidity ${w.turbidity}, site altitude ${w.altitude} m`
    : `${w.source === 'station' ? `EPW of the station ${w.station?.title ?? ''}` : w.source === 'pvgis' ? 'PVGIS typical year at the site' : `EPW file ${w.file?.name ?? ''}`}${s.epwMeta ? ` (${s.epwMeta.name}, ${deg(s.epwMeta.lat, 'N', 'S')} ${deg(s.epwMeta.lon, 'E', 'W')}, ${fmtNum(haversineKm(site.lat, site.lon, s.epwMeta.lat, s.epwMeta.lon))} km from the site)` : ''}`;
  const job = (m: Model) => m.result.manifest as typeof m.result.manifest & { id?: string; started?: string; finished?: string };
  const cache = (c?: Record<string, string>) => (!c ? '' : c.response === 'hit' ? 'an identical run, replayed from the server cache' : `scene ${c.scene === 'reused' ? 'reused' : 'built'}, ${c.weather === 'hit' ? 'weather cached' : c.weather === 'none' ? 'clear sky' : 'weather parsed'}`);
  const when = p.date.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  return (
    <html lang="en" data-kit="sim" data-theme="light" data-density="compact">
      <head>
        <meta charSet="utf-8" />
        <title>{r.title}</title>
        <style>{`${KIT_CSS}\n${FIGURES}`}</style>
      </head>
      <body>
        <main className="report stack" id="main">
          <header className="page-header">
            <div className="stack stack--tight">
              <span className="kit-mark">kit-<span className="kit-mark__name">sim</span></span>
              <h1 className="page-header__title">{r.title}</h1>
            </div>
          </header>
          <div className="cluster">
            <span className="badge badge--success"><span className="dot" />Run complete</span>
            <span className="text-muted">
              {`${many ? `${models.map(label).join(', ')} (${label(models[0])} the reference)` : `Model ${label(models[0])}`} · Generated ${when} · Run ${models.map((m) => `${many ? `${LETTERS[m.slot]} ` : ''}${job(m).id?.slice(0, 8) ?? '–'}`).join(', ')} · Daylight ${p.versions.app} · kit-ui ${p.versions.kitUi}`}
            </span>
          </div>

          {!!r.stats?.length && (
            <div className="grid" style={knob('--grid-min', '8rem')}>
              {r.stats.map((x, i) => {
                const m = byLetter(x.model), u = x.path ? summary(m, x.column, 'parts', [x.path]).rows[0].u : summary(m, x.column, 'parts', []).whole, unit = unitOf(x.metric, x.column);
                return (
                  <div key={i} className="stat">
                    <span className="stat__label">{x.label}</span>
                    <span className="stat__value">{show(u, x.metric)}{unit ? ` ${unit}` : ''}</span>
                    <span className="stat__delta">{`${HEAD[x.metric]} · ${columnLabel(x.column)} · ${x.path ? place(x.path, rowNames([x.path])[0]) : 'every receiver'}${many ? ` · model ${label(m)}` : ''}`}</span>
                  </div>
                );
              })}
            </div>
          )}

          <section className="section stack">
            <h2>Summary</h2>
            <Prose text={r.summary} />
          </section>

          <section className="section stack">
            <h2>Inputs</h2>
            <div className="grid">
              <Pairs caption="Site and weather" rows={[
                ['Location', site.place],
                ['Coordinates', `${deg(site.lat, 'N', 'S')}, ${deg(site.lon, 'E', 'W')}`],
                ['Time zone', `${zone.name ? `${zone.name}, ` : ''}${fmtOffset(zone.std)}; every time is local standard time, all year`],
                ['North', sim.north ? `True north ${sim.north}° counter-clockwise from the model's +Y axis` : "True north along the model's +Y axis"],
                ['Weather', weather],
              ]} />
              <Pairs caption="Simulation" rows={[
                ['Period', `${period} (${first.manifest.duration_h} h evaluated)`],
                ['Results', first.columns.map(columnLabel).join('; ')],
                ['Mode', sim.mode === 'physical' ? `Physical: Perez sky in ${PATCHES[sim.skyDensity] ?? sim.skyDensity} patches, the sun exact per step` : `Ladybug emulation, ${PATCHES[sim.skyDensity] ?? sim.skyDensity} sky patches`],
                ['Surfaces', `${switches || 'Every surface opaque and black'}; virtual ground reflectance ${sim.ground}${sim.selfOcclude ? '' : '; receivers cast no shade'}${sim.cullBackfaces ? '; back faces let light through' : ''}`],
                ['Sensors', `One per ${sim.on === 'faces' ? 'triangle' : 'vertex'} of the receivers, ${sim.sides === 'both' ? 'front and back' : sim.sides} side${sim.sides === 'both' ? 's' : ''}, ${sim.offset} m off the surface`],
              ]} />
            </div>
            <div className="table-wrap">
              <table className="data-table data-table--wrap">
                <caption>Models</caption>
                <thead><tr><th scope="col">Model</th><th scope="col">Variants chosen</th><th scope="col">Receivers</th><th scope="col">Shades</th></tr></thead>
                <tbody>
                  {models.map((m) => {
                    const ref = r.models.find((x) => x.model === LETTERS[m.slot])!, vs = Object.entries(ref.variants).flatMap(([path, sets]) => Object.entries(sets).map(([k, v]) => `${k} = ${v} on ${path}`));
                    return (
                      <tr key={m.slot}>
                        <td>{label(m)}{many && m === models[0] ? ' (reference)' : ''}</td>
                        <td>{vs.length ? vs.join('; ') : "The file's own"}</td>
                        <td>{`${ref.receivers.length}: ${few(ref.receivers)}`}</td>
                        <td>{`${ref.shades.length}: ${few(ref.shades)}`}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <section className="section stack">
            <h2>Results</h2>
            {r.blocks.map((b, i) => {
              if (b.type === 'text') return <div key={i} className="stack stack--tight">{b.title && <h3>{b.title}</h3>}<Prose text={b.text} /></div>;
              if (b.type === 'chart') {
                const spec = chartSpec(b.chart, r), d = chartData(spec, { models, column: b.chart.column!, viz: s.viz, weightsFor: p.weightsFor }), ms = models.filter((m) => spec.models!.includes(m.slot));
                return (
                  <figure key={i} className="card stack stack--tight">
                    <Chart d={d} width={W} />
                    {/* in the series' order (the reference first); a parts chart keys its bars itself */}
                    {ms.length > 1 && d.kind !== 'parts' && <Key ms={ms} />}
                    <figcaption className="text-muted">{`Figure ${numbers[i]}. `}{b.chart.title && <strong>{`${b.chart.title.replace(/[\s.]+$/, '')}. `}</strong>}{b.caption}</figcaption>
                  </figure>
                );
              }
              if (b.type === 'view') {
                const { width, height } = imageSize(models.length, b.aspect ?? 1.6), unit = b.column ? unitFor(b.column).value : '';
                return (
                  <figure key={i} className="card stack stack--tight">
                    <div className={many ? 'grid' : 'stack'}>
                      {models.map((m, k) => (
                        <div key={m.slot} className="stack stack--tight">
                          <img src={p.images[i][k]} width={Math.round(width)} height={Math.round(height)} alt={`${b.name}, model ${label(m)}${b.column ? `, ${columnLabel(b.column)} in ${unit}` : ''}`} />
                          <span className="text-muted">{`Model ${label(m)}`}</span>
                        </div>
                      ))}
                    </div>
                    {b.column && <div className="legend-box"><Legend scale={scaleOf(b.column)} unit={unit} probe={null} /></div>}
                    <figcaption className="text-muted">{`Figure ${numbers[i]}. ${b.caption}`}</figcaption>
                  </figure>
                );
              }
              const by = b.by ?? 'parts', per = models.map((m) => summary(m, b.column, by, b.parts).rows), all = [...new Set(per.flatMap((rows) => rows.map((x) => x.key)))];
              const keys = by === 'mesh' ? all.slice(0, MESH_ROWS) : all, names = by === 'facing' ? keys : rowNames(keys).map((n, j) => place(keys[j], n)); // meshes: the largest first
              return (
                <div key={i} className="table-wrap">
                  <table className="data-table">
                    <caption>{`Table ${numbers[i]}. ${b.caption}${keys.length < all.length ? ` The ${keys.length} largest of ${all.length} receiver meshes.` : ''}`}</caption>
                    <thead>
                      <tr>
                        <th scope="col">{by === 'facing' ? 'Facing' : by === 'mesh' ? 'Mesh' : 'Part'}</th>
                        {many && <th scope="col">Model</th>}
                        {b.metrics.map((x) => { const unit = unitOf(x, b.column); return <th key={x} scope="col" className="num">{HEAD[x]}{unit && <> <span className="th-unit">({unit})</span></>}</th>; })}
                      </tr>
                    </thead>
                    {keys.map((key, j) => (
                      <tbody key={key}>
                        {models.map((m, k) => {
                          const u = per[k].find((x) => x.key === key)?.u;
                          return (
                            <tr key={m.slot}>
                              {k === 0 && <th scope="row" rowSpan={many ? models.length : undefined}>{names[j]}</th>}
                              {many && <td>{label(m)}</td>}
                              {b.metrics.map((x) => <td key={x} className="num">{u ? show(u, x) : '–'}</td>)}
                            </tr>
                          );
                        })}
                      </tbody>
                    ))}
                  </table>
                </div>
              );
            })}
          </section>

          <section className="section stack">
            <h2>Method and assumptions</h2>
            <div className="prose">
              {columns.map((c) => { const [q, side] = c.split('_'); return <p key={c}><strong>{`${columnLabel(c)} (${unitFor(c).value}).`}</strong>{` ${MEASURES[q](physical && sim.transmission, physical && sim.bounces > 0)} ${SIDE_HELP[side]}`}</p>; })}
              <p>
                {sim.mode === 'physical'
                  ? `The sky is a Perez all-weather sky per time step from the weather's direct normal and diffuse horizontal irradiance, in ${PATCHES[sim.skyDensity] ?? sim.skyDensity} patches; the sun is one exact direction per step (its NOAA position with refraction), so shadows are sharp.`
                  : `Ladybug mode emulates Ladybug Tools' radiation and direct-sun studies: the sky in ${PATCHES[sim.skyDensity] ?? sim.skyDensity} patches and the sun spread over the four nearest, so its shadows are blurred.`}
                {w.source === 'clear-sky'
                  ? ` The weather is the Ineichen-Perez clear sky (Linke turbidity ${w.turbidity}): cloudless, an upper bound that suits comparing options better than absolute values.`
                  : ' The weather is the hourly record named in the inputs, interpolated between its rows for instants and steps under an hour.'}
                {quantities.includes('sunhours') ? ' Sun hours are geometric: the time the sun is up, in front of a surface and not blocked; clouds do not count.' : ''}
                {` Every time is local standard time (${fmtOffset(zone.std)}), without daylight saving.`}
              </p>
              <p>
                {switches
                  ? `Surfaces: ${switches}, with each material's reflectance and transmittance as the Materials table gives them; the virtual ground below the horizon reflects ${sim.ground} and is never shaded.`
                  : `Every surface is opaque and black: glass blocks like a wall and nothing reflects, except the virtual ground below the horizon, which reflects ${sim.ground} and is never shaded.`}
                {' Geometry set to none, or not modelled, casts no shade.'}
              </p>
              <p>
                {`Every value belongs to an element of the receiver meshes (one per ${sim.on === 'faces' ? 'triangle' : 'vertex'}) and is weighted by its area: means are area-weighted, P10 and P90 are area percentiles (10 % of the area gets less, or more), shares are shares of the receiver area.`}
                {quantities.map((q) => { const g = s.viz.ranges[q], u = unitFor(q).value; return g && (g.lo !== null || g.hi !== null) ? ` The problem range of ${quantityName(q)}: ${[g.lo !== null ? `below ${fmtNum(g.lo)} ${u}` : '', g.hi !== null ? `above ${fmtNum(g.hi)} ${u}` : ''].filter(Boolean).join(' and ')} counts as out of range.` : ''; }).join('')}
              </p>
              {r.blocks.map((b, i) => {
                if (b.type !== 'view' || (!b.column && b.near === undefined)) return null;
                const sc = b.column && scaleOf(b.column);
                return (
                  <p key={i}>
                    {sc ? `Figure ${numbers[i]} colours ${quantityName(b.column!.split('_')[0])} (${b.column!.split('_')[1]} side) on one scale${many ? ' for every model' : ''}, ${sc.gradient.label} from ${fmtNum(sc.vmin)} to ${fmtNum(sc.vmax)} ${unitFor(b.column!).value}.` : ''}
                    {b.near !== undefined ? `${sc ? ' ' : ''}It leaves out geometry within ${fmtNum(b.near)} m of the camera, so that what stands in front does not hide what it shows.` : ''}
                  </p>
                );
              })}
            </div>
            {r.notes && <Prose text={r.notes} />}
          </section>

          <section className="section stack page-break">
            <h2>Appendix</h2>
            <div className="table-wrap">
              <table className="data-table data-table--wrap">
                <caption>Table A1. Provenance</caption>
                <thead><tr><th scope="col">Item</th><th scope="col">Value</th></tr></thead>
                <tbody>
                  <tr><td className="text-muted">Report</td><td>{`${r.id}: created ${utc(r.created.replace(/\.\d+Z$/, 'Z'))}, updated ${utc(r.updated.replace(/\.\d+Z$/, 'Z'))}, generated ${utc(p.date.toISOString().replace(/\.\d+Z$/, 'Z'))}`}</td></tr>
                  {models.flatMap((m) => {
                    const j = job(m), v = provenance(m.result, m.objects), L = LETTERS[m.slot];
                    return [
                      <tr key={`${L} file`}><td className="text-muted">{`File, model ${L}`}</td><td>{m.file ?? m.name}</td></tr>,
                      <tr key={`${L} run`}><td className="text-muted">{`Run, model ${L}`}</td><td>{`Job ${j.id ?? '–'}, started ${utc(j.started)}, finished ${utc(j.finished)}; ${v.compute !== undefined ? `${fmtNum(v.compute)} s compute, ` : ''}${fmtNum(v.seconds)} s round trip${m.result.cache ? `; ${cache(m.result.cache)}` : ''}`}</td></tr>,
                      <tr key={`${L} args`}><td className="text-muted">{`Arguments, model ${L}`}</td><td><code>{pairs(v.args).map((a, k) => <Fragment key={k}>{k ? ' ' : ''}<span className={a.length > 40 ? undefined : 'arg'}>{a}</span></Fragment>)}</code></td></tr>,
                      <tr key={`${L} weather`}><td className="text-muted">{`Weather, model ${L}`}</td><td>{v.weather === 'none' ? 'None: the clear sky' : v.weather}</td></tr>,
                    ];
                  })}
                  <tr><td className="text-muted">Versions</td><td>{`Daylight app ${p.versions.app}, kit-ui ${p.versions.kitUi}, core ${p.versions.core}, USD viewer ${p.versions.viewer}`}</td></tr>
                </tbody>
              </table>
            </div>
          </section>
        </main>
      </body>
    </html>
  );
}
