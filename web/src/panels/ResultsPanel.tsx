// Results: what the column means, run summary, colour scale and problem range (with resets), legend / histogram /
// cumulative area curve in the result colours, the cursor readout, the range split, and the per-mesh table. With
// several models every output compares them: a run line, a column and a group of rows per model, a series per model in
// its colour, and each value's difference to the first model. Every region keeps its size whatever the data or the
// hover state, and a model keeps its place before its result lands, so the panel does not jump.
import { memo, useMemo, useState, type Dispatch } from 'react';
import { AreaCurve } from '../charts/AreaCurve';
import { Donut } from '../charts/Donut';
import { Histogram, type Markers } from '../charts/Histogram';
import { Legend } from '../charts/Legend';
import { GRADIENTS, hexAt, type Scale } from '../lib/gradients';
import { QUANTITY_HELP, SIDE_HELP, columnLabel, columnStats, cumulative, fmtDiff, fmtNum, histogram, percentile, rangeShares, shareBelow, unitFor, type Cumulative } from '../lib/result';
import { inFlight, type Action, type Model, type ObjectRow, type Probe, type RunResult, type Settings } from '../store';
import { Alert, ColorQuad, Illustration, LETTERS, NumberField, ResetButton, Segmented, Swatch, Tag, cat, pct, rowKeys } from '../ui';

/** A model as the panel compares it: its result's column for the one shown (by name; -1: none) and whether that result
 *  is out of date. */
export type Compared = Model & { col: number; stale: boolean };

interface Props {
  models: Compared[]; column: number; colourBy: 'plain' | 'value'; hovered: string | null; probe: Probe | null; bin: [number, number] | null;
  scale: Scale | null; domain: [number, number]; viz: Settings['viz']; auto: boolean; // domain: the data range, every model's
  weightsFor: (id: string, on: 'faces' | 'vertices') => ArrayLike<number> | undefined; dispatch: Dispatch<Action>;
}

const cacheLine = (c: Record<string, string> | undefined) =>
  !c ? '' : c.response === 'hit' ? 'Identical run, replayed from the server cache.'
    : `Scene ${c.scene === 'reused' ? 'reused' : 'built'}, ${c.weather === 'hit' ? 'weather cached' : c.weather === 'none' ? 'clear sky' : 'weather parsed'}.`;
const timingOf = (r: RunResult) => `${r.manifest.run_s !== undefined && r.cache?.response !== 'hit' ? `${r.manifest.run_s.toFixed(2)} s compute, ` : ''}${r.elapsed.toFixed(2)} s round trip`;

const orNull = (v: number) => (Number.isFinite(v) ? v : null);
const points = (v: number) => `${fmtNum(100 * v)} pts`; // a difference of shares: percentage points

type ChartRange = 'absolute' | 'relative';
const RANGE_OPTIONS = [['absolute', 'Absolute'], ['relative', 'Relative']] as const;
const RANGE_HELP = 'Absolute: the whole range of the data. Relative: the colour scale, Min to Max (the data range where they are blank).';

interface Row { id: string; name: string; g: RunResult['manifest']['meshes'][number]; w: ArrayLike<number>; stats: ReturnType<typeof columnStats> }
interface Data { r: RunResult; col: number; rows: Row[]; total: number; cum: Cumulative; markers: Markers; bins: number }

// One per result: cumulative() sorts every element, and a selection or a run status re-renders the panel; a result's
// rows never change while it lives (a load, a re-read or a role change drops it).
const cache = new WeakMap<RunResult, { col: number; d: Data }>();
function dataOf(r: RunResult, col: number, objects: ObjectRow[], weightsFor: Props['weightsFor']): Data {
  const hit = cache.get(r);
  if (hit?.col === col) return hit.d;
  const groups = r.manifest.meshes, weights = r.receivers.map((id, i) => weightsFor(id, r.on) ?? new Float64Array(groups[i].count).fill(1));
  const rows = r.receivers.map((id, i) => {
    const o = objects.find((x) => x.id === id), g = groups[i];
    return { id, name: o?.name ?? g.name, g, w: weights[i], stats: columnStats(r.values, col, g, weights[i]) };
  });
  const total = rows.reduce((s, x) => s + x.stats.total, 0), area = rows.reduce((s, x) => s + x.stats.area, 0);
  const cum = cumulative(r.values, col, groups, weights);
  const bins = Math.min(64, Math.max(12, Math.round(1.5 * Math.sqrt(cum.v.length)))); // more detail with more elements
  const markers = { mean: area ? total / area : NaN, median: percentile(cum, 0.5), p10: percentile(cum, 0.1), p90: percentile(cum, 0.9) };
  const d = { r, col, rows, total, cum, markers, bins };
  cache.set(r, { col, d });
  return d;
}

export const ResultsPanel = memo(function ResultsPanel({ models, column, colourBy, hovered, probe, bin, scale, domain, viz, auto, weightsFor, dispatch }: Props) {
  const datas = useMemo(() => models.map((m) => (m.result && m.col >= 0 ? dataOf(m.result, m.col, m.objects, weightsFor) : null)), [models, weightsFor]);
  const many = models.length > 1;
  // the Distribution and Cumulative area charts, each: relative = the colour scale (Min / Max when set), absolute = the
  // data range (every model's)
  const [ranges, setRanges] = useState<Record<'hist' | 'curve', ChartRange>>({ hist: 'relative', curve: 'relative' });
  const [vmin, vmax] = scale && scale.vmax > scale.vmin ? [scale.vmin, scale.vmax] : [NaN, NaN];
  const rangeOf = (chart: 'hist' | 'curve'): [number, number] => (ranges[chart] === 'relative' && vmax > vmin ? [vmin, vmax] : domain);
  const [hlo, hhi] = rangeOf('hist');
  const bins = Math.min(...datas.map((d) => d?.bins ?? Infinity)); // the same bins for every model: a hovered bin lines up
  const hists = useMemo(() => datas.map((d) => d && histogram(d.r.values, d.col, d.rows.map((x) => x.g), d.rows.map((x) => x.w), bins, [hlo, hhi])), [datas, bins, hlo, hhi]);
  const lo = scale?.lo ?? null, hi = scale?.hi ?? null;
  const within = useMemo(() => datas.map((d) => d && d.rows.map((x) => { // each mesh's share of its area inside the problem range
    if (lo === null && hi === null) return 1;
    let w = 0;
    for (let i = 0; i < x.g.count; i++) { const v = d.r.values[x.g.first + i][d.col]; if (Number.isFinite(v) && (lo === null || v >= lo) && (hi === null || v <= hi)) w += x.w[i]; }
    return x.stats.area ? w / x.stats.area : 0;
  })), [datas, lo, hi]);
  const k0 = datas.findIndex(Boolean), ref = k0 < 0 ? null : datas[k0]!, hist = k0 < 0 ? null : hists[k0]!; // the first result: the column list, quantity and unit
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
      {ref && hist && scale && (() => {
        const { r, col } = ref, [quantity, side] = r.columns[col].split('_'), unit = unitFor(r.columns[col]);
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
        const inUnit = unit.value ? ` (${unit.value})` : ''; // the unit once per group: the labels stay one short word
        const setViz = (patch: Extract<Action, { type: 'VIZ' }>['patch']) => dispatch({ type: 'VIZ', quantity, patch });
        const splits = datas.map((d) => d && rangeShares(d.cum, scale.lo, scale.hi));
        /** A comparison cell: the value, then (under it) its difference to the first model; '–' where there is none. */
        const cell = (k: number, get: (d: Data, k: number) => number, fmt: (v: number) => string = fmtNum, diff: (v: number) => string = fmtNum) => {
          const d = datas[k], v = d ? get(d, k) : NaN;
          return (
            <td key={models[k].slot} className="num">
              {fmt(v)}<br /><span className="text-muted">{k > 0 && d && A ? fmtDiff(v - get(A, 0), diff) || '–' : '–'}</span>
            </td>
          );
        };
        const heads = models.map((m) => <th key={m.slot} scope="col" className="num" title={`Model ${LETTERS[m.slot]}: ${m.name || 'no model open yet'}`}><Tag slot={m.slot} /></th>);
        const keyOf = <div className="cluster text-muted">{models.map((m) => <span key={m.slot} title={`Model ${LETTERS[m.slot]}: ${m.name || 'no model open yet'}`}><Tag slot={m.slot} /></span>)}</div>;
        const series = models.flatMap((m, k) => (hists[k] ? [{ color: cat(m.slot), label: LETTERS[m.slot], shares: hists[k]!.shares }] : []));
        const curves = models.flatMap((m, k) => (datas[k] ? [{ color: cat(m.slot), cum: datas[k]!.cum }] : []));
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
            {/* the colour scale and the problem range: one row of five controls when the panel is wide enough, else two */}
            <div className="scale-row">
              <fieldset className="field" aria-labelledby="lg-scale">
                <div className="cluster cluster--between"><legend id="lg-scale">Colour scale{inUnit}<span className="sr-only">. Min or Max left blank: the range of the data (the placeholder){many ? ', every model\'s' : ''}</span></legend><ResetButton what="the colour scale" onClick={() => dispatch({ type: 'VIZ_RESET', quantity, what: 'scale' })} /></div>
                <div className="scale-row__cols">
                  <div className="field">
                    <label className="field__label" htmlFor="gradient">Gradient</label>
                    <select className="select" id="gradient" value={scale.gradient.key} onChange={(e) => setViz({ gradient: e.target.value })}>
                      {GRADIENTS.map((g) => <option key={g.key} value={g.key}>{g.label}</option>)}
                    </select>
                  </div>
                  {/* blank: the data's own bound, shown as the placeholder */}
                  <NumberField id="scale-min" label="Min" value={viz.scales[quantity]?.min ?? NaN} placeholder={fmtNum(domain[0])} onCommit={(v) => setViz({ min: orNull(v) })} />
                  <NumberField id="scale-max" label="Max" value={viz.scales[quantity]?.max ?? NaN} placeholder={fmtNum(domain[1])} onCommit={(v) => setViz({ max: orNull(v) })} />
                </div>
              </fieldset>
              <fieldset className="field" aria-labelledby="lg-range">
                <div className="cluster cluster--between"><legend id="lg-range">Problem range{inUnit}<span className="sr-only">. Below or Above left blank: no bound</span></legend><ResetButton what="the problem range and its colours" onClick={() => dispatch({ type: 'VIZ_RESET', quantity, what: 'range' })} /></div>
                <div className="scale-row__cols">
                  <NumberField
                    id="range-lo" label="Below" value={scale.lo ?? NaN} placeholder="none" onCommit={(v) => setViz({ lo: orNull(v) })}
                    adorn={<ColorQuad id="colour-below" label="Colour below the range" value={scale.below} onChange={(below) => setViz({ below })} />}
                  />
                  <NumberField
                    id="range-hi" label="Above" value={scale.hi ?? NaN} placeholder="none" onCommit={(v) => setViz({ hi: orNull(v) })}
                    adorn={<ColorQuad id="colour-above" label="Colour above the range" value={scale.above} onChange={(above) => setViz({ above })} />}
                  />
                </div>
              </fieldset>
            </div>
            <div className="cluster cluster--between">
              <h3>Distribution</h3>
              <Segmented name="hist-range" label="Distribution range" title={RANGE_HELP} value={ranges.hist} options={RANGE_OPTIONS} onChange={(h) => setRanges((x) => ({ ...x, hist: h }))} />
            </div>
            <Histogram
              edges={hist.edges} shares={hist.shares} counts={hist.counts} below={hist.below} above={many ? Math.max(...hists.map((h) => h?.above ?? 0)) : hist.above} scale={scale} unit={unit.value}
              probe={probe?.value ?? null} bin={bin} markers={ref.markers} series={many ? series : undefined} dispatch={dispatch}
            />
            {many && keyOf}
            <div className="cluster cluster--between">
              <h3>Cumulative area</h3>
              <Segmented name="curve-range" label="Cumulative area range" title={RANGE_HELP} value={ranges.curve} options={RANGE_OPTIONS} onChange={(curve) => setRanges((x) => ({ ...x, curve }))} />
            </div>
            <AreaCurve cum={ref.cum} domain={rangeOf('curve')} scale={scale} unit={unit.value} probe={probe?.value ?? null} curves={many ? curves : undefined} />
            {many && keyOf}
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
          </div>
        );
      })()}
    </section>
  );
});
