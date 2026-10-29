// Results: what the column means, run summary, colour scale and problem range (with resets), legend, the charts in the
// result colours (Distribution, Cumulative area, then one's own; each with its settings menu), the cursor readout, the
// range split, the per-mesh table, then each report's charts (drawn from its models' results now; their settings change
// the stored report). With several models every output compares them: a run line, a column and a group of rows per
// model, a series per model in its colour, and each value's difference to the first model. Every region keeps its size
// whatever the data or the hover state, and a model keeps its place before its result lands, so the panel does not jump.
import { Fragment, memo, useMemo, type Dispatch } from 'react';
import { Chart, chartTitle } from '../charts/Chart';
import { ChartSettings, RANGE_HELP, ScaleFields, type ChartEdit } from '../charts/ChartSettings';
import { Donut } from '../charts/Donut';
import { Legend } from '../charts/Legend';
import { BUILT_IN, chartData, dataOf, type ChartSpec, type Data, type Row, type WeightsFor } from '../lib/charts';
import { hexAt, type Scale } from '../lib/gradients';
import { QUANTITY_HELP, SIDE_HELP, columnLabel, fmtDiff, fmtNum, rangeShares, shareBelow, unitFor } from '../lib/result';
import { chartSpec, type Stored } from '../report/spec';
import { inFlight, type Action, type Model, type Probe, type RunResult, type Settings } from '../store';
import { Alert, Illustration, LETTERS, Segmented, Swatch, Tag, pct, rowKeys } from '../ui';

/** A model as the panel compares it: its result's column for the one shown (by name; -1: none) and whether that result
 *  is out of date. */
export type Compared = Model & { col: number; stale: boolean };

interface Props {
  models: Compared[]; column: number; colourBy: 'plain' | 'value'; hovered: string | null; probe: Probe | null; bin: [number, number] | null;
  scale: Scale | null; domain: [number, number]; viz: Settings['viz']; charts: Settings['charts']; auto: boolean; // domain: the data range, every model's
  weightsFor: WeightsFor; dispatch: Dispatch<Action>;
  reports: Stored[] | null; onReportChart: (id: string, e: ChartEdit) => void; // the stored reports; a report chart's settings changed
  reportError: { id?: string; title: string; message: string } | null; // a report change that failed: shown under that report's charts
}

const cacheLine = (c: Record<string, string> | undefined) =>
  !c ? '' : c.response === 'hit' ? 'Identical run, replayed from the server cache.'
    : `Scene ${c.scene === 'reused' ? 'reused' : 'built'}, ${c.weather === 'hit' ? 'weather cached' : c.weather === 'none' ? 'clear sky' : 'weather parsed'}.`;
const timingOf = (r: RunResult) => `${r.manifest.run_s !== undefined && r.cache?.response !== 'hit' ? `${r.manifest.run_s.toFixed(2)} s compute, ` : ''}${r.elapsed.toFixed(2)} s round trip`;

const points = (v: number) => `${fmtNum(100 * v)} pts`; // a difference of shares: percentage points

const RANGE_OPTIONS = [['absolute', 'Absolute'], ['relative', 'Relative']] as const;

export const ResultsPanel = memo(function ResultsPanel({ models, column, colourBy, hovered, probe, bin, scale, domain, viz, charts, auto, weightsFor, dispatch, reports, onReportChart, reportError }: Props) {
  // what the tables and charts read of each model, kept across a selection or a run's status (each makes new models)
  const inputs = [0, 1, 2, 3].flatMap((k) => { const m = models.find((x) => x.slot === k); return [m?.objects, m?.result, m?.col]; }); // fixed length: memo deps
  const runs = useMemo(() => models.map(({ slot, objects, result, col }) => ({ slot, objects, result, col })), inputs); // eslint-disable-line react-hooks/exhaustive-deps
  const datas = useMemo(() => runs.map((m) => (m.result && m.col >= 0 ? dataOf(m.result, m.col, m.objects, weightsFor) : null)), [runs, weightsFor]);
  const many = models.length > 1;
  const lo = scale?.lo ?? null, hi = scale?.hi ?? null;
  const within = useMemo(() => datas.map((d) => d && d.rows.map((x) => { // each mesh's share of its area inside the problem range
    if (lo === null && hi === null) return 1;
    let w = 0;
    for (let i = 0; i < x.g.count; i++) { const v = d.r.values[x.g.first + i][d.col]; if (Number.isFinite(v) && (lo === null || v >= lo) && (hi === null || v <= hi)) w += x.w[i]; }
    return x.stats.area ? w / x.stats.area : 0;
  })), [datas, lo, hi]);
  const k0 = datas.findIndex(Boolean), ref = k0 < 0 ? null : datas[k0]!; // the first result: the column list, quantity and unit
  const shown = ref ? ref.r.columns[ref.col] : null;
  // the reports with chart blocks, their charts as drawn (models as slots), each on the colour scale of its models' data,
  // with its figure number in the PDF (charts and views count)
  const groups = useMemo(() => (reports ?? []).flatMap(({ id, spec: r }) => {
    const specs: ChartSpec[] = [], fig = new Map<string, number>(), slots = r.models.map((m) => LETTERS.indexOf(m.model));
    r.blocks.filter((b) => b.type === 'chart' || b.type === 'view').forEach((b, k) => { if (b.type === 'chart') { specs.push(chartSpec(b.chart, r)); fig.set(b.chart.id, k + 1); } });
    return specs.length ? [{ id, title: r.title, specs, slots, fig }] : [];
  }), [reports]);
  // every chart's numbers, once per result, column, colour scale or chart: never per hover or cursor move
  const drawn = useMemo(() => new Map(shown ? [
    ...charts.map((c) => [c, chartData(c, { models: runs, column: shown, viz, weightsFor })] as const),
    ...groups.flatMap((g) => g.specs.map((c) => [c, chartData(c, { models: runs.filter((m) => g.slots.includes(m.slot)), column: shown, viz, weightsFor })] as const)),
  ] : []), [charts, groups, runs, shown, viz, weightsFor]);
  const running = models.some((m) => inFlight(m.run)), failed = models.filter((m) => m.error);
  const one = models[0];
  /** A model's run line: a job on its way (an Auto run refreshes silently, unless other users' jobs are ahead), else what it holds. */
  const lineOf = (m: Compared, d: Data | null): { busy: boolean; text: string } => {
    const ahead = m.run.status === 'queued' ? m.run.position : 0;
    if (ahead) return { busy: true, text: `Waiting for the GPU, ${ahead} job${ahead > 1 ? 's' : ''} ahead` };
    if (inFlight(m.run) && !auto) return { busy: true, text: m.run.status === 'queued' && many ? 'Waiting for its turn' : 'Running with the new inputs' };
    if (!many) return { busy: false, text: d ? timingOf(d.r) : '' };
    if (!m.objects.length) return { busy: false, text: 'No model yet' };
    if (!m.objects.some((o) => o.role === 'receiver')) return { busy: false, text: 'No receiver mesh: not run' };
    if (d) return { busy: false, text: `${timingOf(d.r)}. ${m.stale ? 'Inputs changed since this run.' : cacheLine(d.r.cache)}` };
    if (m.result) return { busy: false, text: 'No result for this column (an earlier run): run again' };
    return { busy: false, text: m.error ? 'Run failed, see above' : 'Not run yet' };
  };

  return (
    <section className="stack" aria-labelledby="h-results" aria-busy={running}>
      <h2 id="h-results">Results</h2>
      {!ref && models.every((m) => m.run.status === 'idle') && (
        <div className="empty-state">
          <div className="empty-state__icon"><Illustration kind="results" /></div>
          <h3>No results yet</h3>
          <p>Mark a receiver mesh, set the site and time, then run the simulation. The values appear on the meshes and in the distribution charts here.</p>
        </div>
      )}
      {!ref && running && (() => {
        const run = models.find((m) => inFlight(m.run))!.run, ahead = models.reduce((n, m) => Math.max(n, m.run.status === 'queued' ? m.run.position : 0), 0);
        return (
          <div className="stack">
            <div className="skeleton" aria-hidden="true">&nbsp;<br />&nbsp;</div>
            <div className="skeleton chart-ph" aria-hidden="true" />
            <p className="text-muted"><span className="spinner" aria-hidden="true" /> {run.status === 'queued' || ahead ? `Waiting for the GPU${ahead ? `, ${ahead} job${ahead > 1 ? 's' : ''} ahead` : ''}` : 'Tracing on the GPU'}</p>
          </div>
        );
      })()}
      {failed.length > 0 && (
        <Alert title="Run failed">{many ? failed.map((m) => <div key={m.slot}><Tag slot={m.slot} /> {m.error}</div>) : failed[0].error}</Alert>
      )}
      {ref && shown && scale && (() => {
        const { r, col } = ref, [quantity, side] = shown.split('_'), unit = unitFor(shown);
        const A = datas[0]; // the differences: to the first model (A, or the first left after a removal)
        const owner = (id: string | null) => (id === null ? -1 : datas.findIndex((d) => d?.rows.some((x) => x.id === id)));
        const kp = probe ? owner(probe.id) : -1, kh = owner(hovered);
        const probeRow = kp >= 0 ? datas[kp]!.rows.find((x) => x.id === probe!.id) : undefined, hov = kh >= 0 ? datas[kh]!.rows.find((x) => x.id === hovered) : undefined;
        const letter = (k: number) => (many ? `${LETTERS[models[k].slot]} ` : '');
        const readout = probe && probeRow
          ? `${letter(kp)}${probeRow.name}, ${datas[kp]!.r.on === 'faces' ? 'face' : 'vertex'} ${probe.element + 1}: ${fmtNum(probe.value)} ${unit.value}. ${many
            ? `Area getting less: ${models.flatMap((m, j) => (datas[j] ? [`${LETTERS[m.slot]} ${pct(shareBelow(datas[j]!.cum, probe.value))}`] : [])).join(', ')}.`
            : `${pct(shareBelow(ref.cum, probe.value))} of the area gets less.`}`
          : bin
            ? `Bin ${fmtNum(bin[0])} to ${Number.isFinite(bin[1]) ? fmtNum(bin[1]) : fmtNum(domain[1])} ${unit.value}: the rest of ${many ? 'every' : 'the'} model is faded.`
            : hov
              ? `${letter(kh)}${hov.name}: ${fmtNum(hov.stats.mean)} ${unit.value} mean, ${fmtNum(hov.stats.min)} to ${fmtNum(hov.stats.max)}, ${pct(datas[kh]!.total ? hov.stats.total / datas[kh]!.total : 0)} of ${many ? `model ${LETTERS[models[kh].slot]}'s` : 'the'} total.`
              : '';
        const select = (slot: number, id: string, additive: boolean) => dispatch({ type: 'SELECT', slot, ids: [id], additive });
        const splits = datas.map((d) => d && rangeShares(d.cum, scale.lo, scale.hi));
        /** A comparison cell: the value, then (under it) its difference to the first model; '–' where there is none. */
        const cell = (k: number, get: (d: Data, k: number) => number, fmt: (v: number) => string = fmtNum, diff: (v: number) => string = fmtNum) => {
          const d = datas[k], v = d ? get(d, k) : NaN;
          return (
            <td key={models[k].slot} className="num">
              {d ? fmt(v) : '–'}<br /><span className="text-muted">{k > 0 && d && A ? fmtDiff(v - get(A, 0), diff) || '–' : '–'}</span>
            </td>
          );
        };
        const heads = models.map((m) => <th key={m.slot} scope="col" className="num" title={`Model ${LETTERS[m.slot]}: ${m.name || 'no model open yet'}`}><Tag slot={m.slot} /></th>);
        /** A comparison chart's key: its models that are open, with a result or not. */
        const keyOf = (c: ChartSpec) => <div className="cluster text-muted">{models.filter((m) => !c.models || c.models.includes(m.slot)).map((m) => <span key={m.slot} title={`Model ${LETTERS[m.slot]}: ${m.name || 'no model open yet'}`}><Tag slot={m.slot} /></span>)}</div>;
        /**
         * Charts, each under its heading (`H`) with its settings menu (ids `${idp}:${id}`, ':' being in no chart id): the
         * panel's own (CHART), and each report's group, headed "Report: TITLE" with its own `onChart` and each chart's
         * figure number (`fig`). A chart of the shown column takes the cursor and bin hover as the views do; the built-ins
         * keep their Absolute / Relative switch.
         */
        const group = (specs: readonly ChartSpec[], onChart: (e: ChartEdit) => void, idp = 'chart', H: 'h3' | 'h4' = 'h3', fig?: ReadonlyMap<string, number>) => specs.map((c) => {
          const d = drawn.get(c)!, at = c.column ?? shown, live = at === shown, title = `${fig ? `Figure ${fig.get(c.id)}. ` : ''}${chartTitle(c, at)}`, built = BUILT_IN.some((b) => b.id === c.id);
          return (
            <Fragment key={c.id}>
              {/* a built-in's short title and its range switch wrap in a narrow panel; another chart's long title wraps
                  beside its settings button (chart-head) */}
              <div className={`cluster cluster--between${built ? '' : ' chart-head'}`}>
                <H>{title}</H>
                <div className="cluster">
                  {built && <Segmented name={`${c.id}-range`} label={`${title} range`} title={RANGE_HELP} value={Array.isArray(c.range) ? null : c.range ?? 'relative'} options={RANGE_OPTIONS} onChange={(range) => onChart({ spec: { ...c, range } })} />}
                  <ChartSettings id={`${idp}:${c.id}`} title={title} spec={c} d={d} column={at} viz={viz} many={many} dispatch={dispatch} onChart={onChart} />
                </div>
              </div>
              <Chart d={d} probe={live ? probe?.value ?? null : null} bin={live ? bin : null} dispatch={live ? dispatch : undefined} />
              {((d.kind === 'histogram' && d.series) || (d.kind === 'curve' && d.curves)) && keyOf(c)}
            </Fragment>
          );
        });
        const meshRow = (slot: number, selected: Set<string>, x: Row, w: number, total: number) => (
          <tr
            key={x.id} tabIndex={0} aria-selected={selected.has(x.id)}
            onClick={(e) => select(slot, x.id, e.shiftKey || e.ctrlKey)} onKeyDown={rowKeys(() => select(slot, x.id, true))}
            onPointerEnter={() => dispatch({ type: 'HOVER', id: x.id })} onPointerLeave={() => dispatch({ type: 'HOVER', id: null })}
            onFocus={() => dispatch({ type: 'HOVER', id: x.id })} onBlur={() => dispatch({ type: 'HOVER', id: null })}
          >
            <td>{x.name}</td>
            <td className="num">{x.stats.count.toLocaleString('en-GB')}</td>
            <td className="num">{fmtNum(x.stats.min)}</td>
            <td className="num">{fmtNum(x.stats.mean)}</td>
            <td className="num">{fmtNum(x.stats.max)}</td>
            <td className="num">{fmtNum(x.stats.total)}</td>
            <td className="num">{pct(total ? x.stats.total / total : 0)}</td>
            <td className="num">{pct(w)}</td>
          </tr>
        );
        const runLine = (m: Compared, d: Data | null) => {
          const t = lineOf(m, d);
          return <div key={m.slot} className="line" title={`Model ${LETTERS[m.slot]}${m.name ? `, ${m.name}` : ''}: ${t.text}`}><Tag slot={m.slot} /> {t.busy && <span className="spinner" aria-hidden="true" />} {t.text}</div>;
        };
        const status = lineOf(one, ref), what = `${r.manifest.duration_h} h evaluated, ${r.manifest.dirs.sun.toLocaleString('en-GB')} sun directions${many ? '.' : `, ${fmtNum(r.values.length)} ${r.on} on ${ref.rows.length} ${ref.rows.length === 1 ? 'mesh' : 'meshes'}.`}`;
        return (
          <div className="stack view-fade">
            <div className="row-fill">
              <div className="field">
                <label className="sr-only" htmlFor="column">Result</label>
                <select className="select" id="column" value={column} disabled={r.columns.length < 2} onChange={(e) => dispatch({ type: 'COLUMN', column: Number(e.target.value) })}>
                  {r.columns.map((c, i) => <option key={c} value={i}>{columnLabel(c)}</option>)}
                </select>
              </div>
              <Segmented name="colour-by" label="Colour the meshes" value={colourBy} options={[['value', 'Values'], ['plain', 'Plain']] as const} onChange={(v) => dispatch({ type: 'COLOUR_BY', colourBy: v })} />
            </div>
            {/* six lines high at any panel width (a narrow panel scrolls them): a column switch never moves what is below */}
            <p className="text-muted box-6">{QUANTITY_HELP[quantity]} {SIDE_HELP[side]}</p>
            {/* fixed lines whatever the runs, the cache or the panel width (four; with several models one per model and two
                shared): nothing below them moves; the last names the optics switches the run used, empty for the defaults */}
            {many ? (
              <div className="text-muted">
                {models.map((m, k) => runLine(m, datas[k]))}
                <div className="line" title={what}>{what}</div>
                <div className="line" title={r.switches || undefined}>{r.switches}</div>
              </div>
            ) : (
              <div className="text-muted">
                <div className="line" title={status.busy ? undefined : status.text}>
                  {status.busy ? <><span className="spinner" aria-hidden="true" /> {status.text}</> : status.text}
                </div>
                <div className="line">{one.stale ? 'Inputs changed since this run.' : cacheLine(r.cache)}</div>
                <div className="line" title={what}>{what}</div>
                <div className="line" title={r.switches || undefined}>{r.switches}</div>
              </div>
            )}
            {many ? (
              <div className="table-wrap">
                <table className="data-table">
                  <caption className="text-muted">Per model; under each value its difference to model {LETTERS[models[0].slot]}</caption>
                  <thead><tr><th scope="col"><span className="sr-only">Over every receiver</span></th>{heads}</tr></thead>
                  <tbody>
                    <tr><th scope="row" title="Over every receiver">Total <span className="th-unit">{unit.total}</span></th>{models.map((_, k) => cell(k, (d) => d.total))}</tr>
                    <tr><th scope="row" title="Area-weighted">Mean <span className="th-unit">{unit.value}</span></th>{models.map((_, k) => cell(k, (d) => d.markers.mean))}</tr>
                    <tr><th scope="row" title="Half of the area gets less">Median</th>{models.map((_, k) => cell(k, (d) => d.markers.median))}</tr>
                    <tr><th scope="row" title="10 % of the area gets less">P10</th>{models.map((_, k) => cell(k, (d) => d.markers.p10))}</tr>
                    <tr><th scope="row" title="10 % of the area gets more">P90</th>{models.map((_, k) => cell(k, (d) => d.markers.p90))}</tr>
                  </tbody>
                </table>
              </div>
            ) : (
              <table className="data-table">
                <caption className="sr-only">Summary over every receiver</caption>
                <thead>
                  <tr>
                    <th scope="col" className="num" title="Over every receiver">Total <span className="th-unit">{unit.total}</span></th>
                    <th scope="col" className="num" title="Area-weighted">Mean <span className="th-unit">{unit.value}</span></th>
                    <th scope="col" className="num" title="10 % of the area gets less">P10</th>
                    <th scope="col" className="num" title="10 % of the area gets more">P90</th>
                  </tr>
                </thead>
                <tbody>
                  <tr><td className="num">{fmtNum(ref.total)}</td><td className="num">{fmtNum(ref.markers.mean)}</td><td className="num">{fmtNum(ref.markers.p10)}</td><td className="num">{fmtNum(ref.markers.p90)}</td></tr>
                </tbody>
              </table>
            )}
            <Legend scale={scale} unit={unit.value} probe={probe?.value ?? null} />
            <div className="readout" role="status" aria-live="polite">{readout}</div>
            <ScaleFields quantity={quantity} scale={scale} viz={viz} many={many} dispatch={dispatch} />
            {/* the settings' charts in order: Distribution and Cumulative area, then one's own */}
            {group(charts, (e) => dispatch({ type: 'CHART', ...e }))}
            <h3>Problem range split</h3>
            {many ? (
              <div className="table-wrap">
                <table className="data-table">
                  <caption className="sr-only">Each model&apos;s share of its area below, within and above the problem range; under each share its difference to model {LETTERS[models[0].slot]}, in percentage points</caption>
                  <thead><tr><th scope="col">Range</th>{heads}</tr></thead>
                  <tbody>
                    <tr><th scope="row"><Swatch color={scale.below} /> below {scale.lo !== null ? `${fmtNum(scale.lo)} ${unit.value}` : '(no bound)'}</th>{models.map((_, k) => cell(k, (_d, j) => splits[j]!.below, pct, points))}</tr>
                    <tr><th scope="row"><Swatch color={hexAt(scale.gradient, 0.5)} /> within</th>{models.map((_, k) => cell(k, (_d, j) => splits[j]!.within, pct, points))}</tr>
                    <tr><th scope="row"><Swatch color={scale.above} /> above {scale.hi !== null ? `${fmtNum(scale.hi)} ${unit.value}` : '(no bound)'}</th>{models.map((_, k) => cell(k, (_d, j) => splits[j]!.above, pct, points))}</tr>
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="cluster">
                <Donut
                  slices={[
                    { key: 'below', name: 'below the range', color: scale.below, share: splits[k0]!.below },
                    { key: 'within', name: 'within the range', color: hexAt(scale.gradient, 0.5), share: splits[k0]!.within },
                    { key: 'above', name: 'above the range', color: scale.above, share: splits[k0]!.above },
                  ]}
                  label={pct(splits[k0]!.within)} sub="within"
                />
                <div className="stack stack--tight">
                  <span><Swatch color={scale.below} /> {pct(splits[k0]!.below)} below {scale.lo !== null ? `${fmtNum(scale.lo)} ${unit.value}` : '(no bound)'}</span>
                  <span><Swatch color={hexAt(scale.gradient, 0.5)} /> {pct(splits[k0]!.within)} within</span>
                  <span><Swatch color={scale.above} /> {pct(splits[k0]!.above)} above {scale.hi !== null ? `${fmtNum(scale.hi)} ${unit.value}` : '(no bound)'}</span>
                </div>
              </div>
            )}
            <div className="table-box">
              <table className="data-table">
                <caption>Per receiver mesh{many ? ' and model' : ''}, {columnLabel(r.columns[col])}</caption>
                <thead>
                  <tr>
                    <th scope="col">Mesh</th>
                    <th scope="col" className="num">Elements</th>
                    <th scope="col" className="num">Min <span className="th-unit">{unit.value}</span></th>
                    <th scope="col" className="num">Mean</th>
                    <th scope="col" className="num">Max</th>
                    <th scope="col" className="num">Total <span className="th-unit">{unit.total}</span></th>
                    <th scope="col" className="num">Share</th>
                    <th scope="col" className="num">Within</th>
                  </tr>
                </thead>
                {many ? models.map((m, k) => {
                  const d = datas[k];
                  return (
                    <tbody key={m.slot}>
                      <tr><th scope="rowgroup" colSpan={8}><Tag slot={m.slot} name={m.name} /></th></tr>
                      {d
                        ? d.rows.map((x, i) => meshRow(m.slot, m.selected, x, within[k]![i], d.total))
                        : m.objects.filter((o) => o.role === 'receiver').map((o) => <tr key={o.id}><td>{o.name}</td>{Array.from({ length: 7 }, (_, j) => <td key={j} className="num">–</td>)}</tr>)}
                    </tbody>
                  );
                }) : (
                  <tbody>
                    {ref.rows.map((x, i) => meshRow(one.slot, one.selected, x, within[k0]![i], ref.total))}
                  </tbody>
                )}
              </table>
            </div>
            {groups.map((g) => (
              <section key={g.id} className="stack" aria-labelledby={`h-report-${g.id}`}>
                <h3 id={`h-report-${g.id}`}>Report: {g.title}</h3>
                {reportError?.id === g.id && <Alert title={reportError.title}>{reportError.message}</Alert>}
                {group(g.specs, (e) => onReportChart(g.id, e), `report-${g.id}`, 'h4', g.fig)}
              </section>
            ))}
          </div>
        );
      })()}
    </section>
  );
});
