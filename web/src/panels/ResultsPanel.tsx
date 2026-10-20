// Results: what the column means, run summary, colour scale and problem range (with resets), legend / histogram /
// cumulative area curve in the result colours, the cursor readout, the range split, and the per-mesh table. Every
// region keeps its size whatever the data or the hover state, so the panel does not jump.
import { memo, useMemo, useState, type Dispatch } from 'react';
import { AreaCurve } from '../charts/AreaCurve';
import { Donut } from '../charts/Donut';
import { Histogram } from '../charts/Histogram';
import { Legend } from '../charts/Legend';
import { GRADIENTS, hexAt, type Scale } from '../lib/gradients';
import { QUANTITY_HELP, SIDE_HELP, columnLabel, columnStats, cumulative, fmtNum, globalRange, histogram, percentile, rangeShares, shareBelow, unitFor } from '../lib/result';
import type { Action, ObjectRow, Probe, Run, RunResult, Settings } from '../store';
import { Alert, ColorQuad, Illustration, NumberField, ResetButton, Segmented, Swatch, pct, rowKeys } from '../ui';

interface Props {
  result: RunResult | null; run: Run; error: string | null; stale: boolean; auto: boolean; // result: the last finished run, kept while the next one runs
  objects: ObjectRow[]; column: number; colourBy: 'plain' | 'value'; hovered: string | null; selected: Set<string>;
  probe: Probe | null; bin: [number, number] | null; scale: Scale | null; viz: Settings['viz'];
  weightsFor: (id: string, on: 'faces' | 'vertices') => ArrayLike<number> | undefined; dispatch: Dispatch<Action>;
}


const cacheLine = (c: Record<string, string> | undefined) =>
  !c ? '' : c.response === 'hit' ? 'Identical run, replayed from the server cache.'
    : `Scene ${c.scene === 'reused' ? 'reused' : 'built'}, ${c.weather === 'hit' ? 'weather cached' : c.weather === 'none' ? 'clear sky' : 'weather parsed'}.`;

const orNull = (v: number) => (Number.isFinite(v) ? v : null);

type ChartRange = 'absolute' | 'relative';
const RANGE_OPTIONS = [['absolute', 'Absolute'], ['relative', 'Relative']] as const;
const RANGE_HELP = 'Absolute: the whole range of the data. Relative: the colour scale, Min to Max (the data range where they are blank).';

export const ResultsPanel = memo(function ResultsPanel({ result, run, error, stale, auto, objects, column, colourBy, hovered, selected, probe, bin, scale, viz, weightsFor, dispatch }: Props) {
  const data = useMemo(() => {
    if (!result) return null;
    const r = result, col = Math.min(column, r.columns.length - 1), [quantity, side] = r.columns[col].split('_');
    const groups = r.manifest.meshes, weights = r.receivers.map((id, i) => weightsFor(id, r.on) ?? new Float64Array(groups[i].count).fill(1));
    const rows = r.receivers.map((id, i) => {
      const o = objects.find((x) => x.id === id), g = groups[i];
      return { id, name: o?.name ?? g.name, g, w: weights[i], stats: columnStats(r.values, col, g, weights[i]) };
    });
    const total = rows.reduce((s, x) => s + x.stats.total, 0), area = rows.reduce((s, x) => s + x.stats.area, 0);
    const cum = cumulative(r.values, col, groups, weights), domain = globalRange(r.values, col);
    const bins = Math.min(64, Math.max(12, Math.round(1.5 * Math.sqrt(cum.v.length)))); // more detail with more elements
    const markers = { mean: area ? total / area : NaN, median: percentile(cum, 0.5), p10: percentile(cum, 0.1), p90: percentile(cum, 0.9) };
    return { r, col, quantity, side, rows, total, cum, domain, markers, bins, unit: unitFor(r.columns[col]) };
  }, [result, column, objects, weightsFor]);
  // the Distribution and Cumulative area charts, each: relative = the colour scale (Min / Max when set), absolute = the
  // data range
  const [ranges, setRanges] = useState<Record<'hist' | 'curve', ChartRange>>({ hist: 'relative', curve: 'relative' });
  const [vmin, vmax] = scale && scale.vmax > scale.vmin ? [scale.vmin, scale.vmax] : [NaN, NaN];
  const rangeOf = (chart: 'hist' | 'curve', domain: [number, number]): [number, number] => (ranges[chart] === 'relative' && vmax > vmin ? [vmin, vmax] : domain);
  const [hlo, hhi] = data ? rangeOf('hist', data.domain) : [NaN, NaN];
  const hist = useMemo(() => (data ? histogram(data.r.values, data.col, data.rows.map((x) => x.g), data.rows.map((x) => x.w), data.bins, [hlo, hhi]) : null), [data, hlo, hhi]);
  const running = run.status === 'running' || run.status === 'queued';
  // While a run is on its way the last result stays; the run line says so for a click (Auto runs refresh silently,
  // many times a second while dragging), and always when other users' jobs are ahead.
  const ahead = run.status === 'queued' ? run.position : 0;
  const status = ahead ? `Waiting for the GPU, ${ahead} job${ahead > 1 ? 's' : ''} ahead` : running && !auto ? 'Running with the new inputs' : null;

  return (
    <section className="stack" aria-labelledby="h-results" aria-busy={running}>
      <h2 id="h-results">Results</h2>
      {!result && run.status === 'idle' && (
        <div className="empty-state">
          <div className="empty-state__icon"><Illustration kind="results" /></div>
          <h3>No results yet</h3>
          <p>Mark a receiver mesh, set the site and time, then run the simulation. The values appear on the meshes and in the distribution charts here.</p>
        </div>
      )}
      {!result && running && (
        <div className="stack">
          <div className="skeleton" aria-hidden="true">&nbsp;<br />&nbsp;</div>
          <div className="skeleton chart-ph" aria-hidden="true" />
          <p className="text-muted"><span className="spinner" aria-hidden="true" /> {run.status === 'queued' ? `Waiting for the GPU${run.position ? `, ${run.position} job${run.position > 1 ? 's' : ''} ahead` : ''}` : 'Tracing on the GPU'}</p>
        </div>
      )}
      {error && <Alert title="Run failed">{error}</Alert>}
      {data && hist && scale && (() => {
        const { r, col, quantity, side, rows, total, cum, domain, markers, unit } = data;
        const hov = rows.find((x) => x.id === hovered), probeRow = probe ? rows.find((x) => x.id === probe.id) : undefined;
        const hasRange = scale.lo !== null || scale.hi !== null, split = rangeShares(cum, scale.lo, scale.hi);
        const withinShare = (x: (typeof rows)[number]) => {
          if (!hasRange) return 1;
          let w = 0;
          for (let i = 0; i < x.g.count; i++) { const v = r.values[x.g.first + i][col]; if (Number.isFinite(v) && (scale.lo === null || v >= scale.lo) && (scale.hi === null || v <= scale.hi)) w += x.w[i]; }
          return x.stats.area ? w / x.stats.area : 0;
        };
        const what = `${r.manifest.duration_h} h evaluated, ${r.manifest.dirs.sun.toLocaleString('en-GB')} sun directions, ${fmtNum(r.values.length)} ${r.on} on ${rows.length} ${rows.length === 1 ? 'mesh' : 'meshes'}.`;
        const select = (id: string, additive: boolean) => dispatch({ type: 'SELECT', ids: [id], additive });
        const inUnit = unit.value ? ` (${unit.value})` : ''; // the unit once per group: the labels stay one short word
        const setViz = (patch: Extract<Action, { type: 'VIZ' }>['patch']) => dispatch({ type: 'VIZ', quantity, patch });
        const readout = probe && probeRow
          ? `${probeRow.name}, ${r.on === 'faces' ? 'face' : 'vertex'} ${probe.element + 1}: ${fmtNum(probe.value)} ${unit.value}. ${pct(shareBelow(cum, probe.value))} of the area gets less.`
          : bin
            ? `Bin ${fmtNum(bin[0])} to ${Number.isFinite(bin[1]) ? fmtNum(bin[1]) : fmtNum(domain[1])} ${unit.value}: the rest of the model is faded.`
            : hov
              ? `${hov.name}: ${fmtNum(hov.stats.mean)} ${unit.value} mean, ${fmtNum(hov.stats.min)} to ${fmtNum(hov.stats.max)}, ${pct(total ? hov.stats.total / total : 0)} of the total.`
              : '';
        return (
          <div className="stack view-fade">
            <div className="row-fill">
              <div className="field">
                <label className="sr-only" htmlFor="column">Result</label>
                <select className="select" id="column" value={col} disabled={r.columns.length < 2} onChange={(e) => dispatch({ type: 'COLUMN', column: Number(e.target.value) })}>
                  {r.columns.map((c, i) => <option key={c} value={i}>{columnLabel(c)}</option>)}
                </select>
              </div>
              <Segmented name="colour-by" label="Colour the meshes" value={colourBy} options={[['value', 'Values'], ['plain', 'Plain']] as const} onChange={(v) => dispatch({ type: 'COLOUR_BY', colourBy: v })} />
            </div>
            <p className="text-muted lines-5">{QUANTITY_HELP[quantity]} {SIDE_HELP[side]}</p>
            {/* three fixed lines whatever the run, the cache or the panel width: nothing below them moves */}
            <div className="text-muted">
              <div className="line">
                {status ? <><span className="spinner" aria-hidden="true" /> {status}</>
                  : `${r.manifest.run_s !== undefined && r.cache?.response !== 'hit' ? `${r.manifest.run_s.toFixed(2)} s compute, ` : ''}${r.elapsed.toFixed(2)} s round trip`}
              </div>
              <div className="line">{stale ? 'Inputs changed since this run.' : cacheLine(r.cache)}</div>
              <div className="line" title={what}>{what}</div>
            </div>
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
                <tr><td className="num">{fmtNum(total)}</td><td className="num">{fmtNum(markers.mean)}</td><td className="num">{fmtNum(markers.p10)}</td><td className="num">{fmtNum(markers.p90)}</td></tr>
              </tbody>
            </table>
            <Legend scale={scale} unit={unit.value} probe={probe?.value ?? null} />
            <div className="readout" role="status" aria-live="polite">{readout}</div>
            {/* the colour scale and the problem range: one row of five controls when the panel is wide enough, else two */}
            <div className="scale-row">
              <fieldset className="field" aria-labelledby="lg-scale">
                <div className="cluster cluster--between"><legend id="lg-scale">Colour scale{inUnit}<span className="sr-only">. Min or Max left blank: the range of the data (the placeholder)</span></legend><ResetButton what="the colour scale" onClick={() => dispatch({ type: 'VIZ_RESET', quantity, what: 'scale' })} /></div>
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
              <Segmented name="hist-range" label="Distribution range" title={RANGE_HELP} value={ranges.hist} options={RANGE_OPTIONS} onChange={(hist) => setRanges((x) => ({ ...x, hist }))} />
            </div>
            <Histogram edges={hist.edges} shares={hist.shares} counts={hist.counts} below={hist.below} above={hist.above} scale={scale} unit={unit.value} probe={probe?.value ?? null} bin={bin} markers={markers} dispatch={dispatch} />
            <div className="cluster cluster--between">
              <h3>Cumulative area</h3>
              <Segmented name="curve-range" label="Cumulative area range" title={RANGE_HELP} value={ranges.curve} options={RANGE_OPTIONS} onChange={(curve) => setRanges((x) => ({ ...x, curve }))} />
            </div>
            <AreaCurve cum={cum} domain={rangeOf('curve', domain)} scale={scale} unit={unit.value} probe={probe?.value ?? null} />
            <h3>Problem range split</h3>
            <div className="cluster">
              <Donut
                slices={[
                  { key: 'below', name: 'below the range', color: scale.below, share: split.below },
                  { key: 'within', name: 'within the range', color: hexAt(scale.gradient, 0.5), share: split.within },
                  { key: 'above', name: 'above the range', color: scale.above, share: split.above },
                ]}
                label={pct(split.within)} sub="within"
              />
              <div className="stack stack--tight">
                <span><Swatch color={scale.below} /> {pct(split.below)} below {scale.lo !== null ? `${fmtNum(scale.lo)} ${unit.value}` : '(no bound)'}</span>
                <span><Swatch color={hexAt(scale.gradient, 0.5)} /> {pct(split.within)} within</span>
                <span><Swatch color={scale.above} /> {pct(split.above)} above {scale.hi !== null ? `${fmtNum(scale.hi)} ${unit.value}` : '(no bound)'}</span>
              </div>
            </div>
            <div className="table-box">
              <table className="data-table">
                <caption>Per receiver mesh, {columnLabel(r.columns[col])}</caption>
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
                <tbody>
                  {rows.map((x) => (
                    <tr
                      key={x.id} tabIndex={0} aria-selected={selected.has(x.id)}
                      onClick={(e) => select(x.id, e.shiftKey || e.ctrlKey)} onKeyDown={rowKeys(() => select(x.id, true))}
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
                      <td className="num">{pct(withinShare(x))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })()}
    </section>
  );
});
