// Results: what the column means, run summary, colour scale and problem range (with resets), legend / histogram /
// cumulative area curve in the result colours, the cursor readout, the range split, and the per-mesh table. Every
// region keeps its size whatever the data or the hover state, so the panel does not jump.
import { useMemo, type Dispatch } from 'react';
import { AreaCurve } from '../charts/AreaCurve';
import { Donut } from '../charts/Donut';
import { Histogram } from '../charts/Histogram';
import { Legend } from '../charts/Legend';
import { GRADIENTS, hexAt, type Scale } from '../lib/gradients';
import { QUANTITY_HELP, SIDE_HELP, columnLabel, columnStats, cumulative, fmtNum, globalRange, histogram, percentile, rangeShares, shareBelow, unitFor } from '../lib/result';
import type { Action, ObjectRow, Probe, Run, Settings } from '../store';
import { Alert, ColorQuad, Illustration, NumberField, ResetButton, Segmented, Swatch, knob, pct, rowKeys } from '../ui';

interface Props {
  run: Run; objects: ObjectRow[]; column: number; colourBy: 'plain' | 'value'; hovered: string | null; selected: Set<string>;
  probe: Probe | null; bin: [number, number] | null; scale: Scale | null; viz: Settings['viz'];
  weightsFor: (id: string, on: 'faces' | 'vertices') => ArrayLike<number> | undefined; dispatch: Dispatch<Action>;
}

const cacheLine = (c?: Record<string, string>) => {
  if (!c) return '';
  if (c.response === 'hit') return ', identical run replayed from the server cache';
  return `, scene ${c.scene === 'reused' ? 'reused' : 'built'}, ${c.weather === 'hit' ? 'weather cached' : c.weather === 'none' ? 'clear sky' : 'weather parsed'}`;
};

const orNull = (v: number) => (Number.isFinite(v) ? v : null);

export function ResultsPanel({ run, objects, column, colourBy, hovered, selected, probe, bin, scale, viz, weightsFor, dispatch }: Props) {
  const data = useMemo(() => {
    if (run.status !== 'done') return null;
    const r = run.result, col = Math.min(column, r.columns.length - 1), [quantity, side] = r.columns[col].split('_');
    const groups = r.manifest.meshes, weights = r.receivers.map((id, i) => weightsFor(id, r.on) ?? new Float64Array(groups[i].count).fill(1));
    const rows = r.receivers.map((id, i) => {
      const o = objects.find((x) => x.id === id), g = groups[i];
      return { id, name: o?.name ?? g.name, g, w: weights[i], stats: columnStats(r.values, col, g, weights[i]) };
    });
    const total = rows.reduce((s, x) => s + x.stats.total, 0), area = rows.reduce((s, x) => s + x.stats.area, 0);
    const cum = cumulative(r.values, col, groups, weights), domain = globalRange(r.values, col);
    const bins = Math.min(64, Math.max(12, Math.round(1.5 * Math.sqrt(cum.v.length)))); // more detail with more elements
    const markers = { mean: area ? total / area : NaN, median: percentile(cum, 0.5), p10: percentile(cum, 0.1), p90: percentile(cum, 0.9) };
    return { r, col, quantity, side, rows, total, cum, domain, markers, hist: histogram(r.values, col, groups, weights, bins, domain), unit: unitFor(r.columns[col]) };
  }, [run, column, objects, weightsFor]);

  return (
    <section className="stack" aria-labelledby="h-results">
      <h2 id="h-results">Results</h2>
      {run.status === 'idle' && (
        <div className="empty-state">
          <div className="empty-state__icon"><Illustration kind="results" /></div>
          <h3>No results yet</h3>
          <p>Mark a receiver mesh, set the site and time, then run the simulation. The values appear on the meshes and in the distribution charts here.</p>
        </div>
      )}
      {run.status === 'running' && (
        <div className="stack" aria-busy="true">
          <div className="grid" style={knob('--grid-min', '8rem')}>
            {[0, 1, 2, 3].map((n) => <div key={n} className="skeleton" aria-hidden="true">&nbsp;<br />&nbsp;<br />&nbsp;</div>)}
          </div>
          <div className="skeleton chart-ph" aria-hidden="true" />
          <p className="text-muted"><span className="spinner" aria-hidden="true" /> Tracing on the GPU</p>
        </div>
      )}
      {run.status === 'error' && <Alert title="Run failed">{run.message}</Alert>}
      {data && scale && (() => {
        const { r, col, quantity, side, rows, total, cum, domain, markers, hist, unit } = data;
        const hov = rows.find((x) => x.id === hovered), probeRow = probe ? rows.find((x) => x.id === probe.id) : undefined;
        const hasRange = scale.lo !== null || scale.hi !== null, split = rangeShares(cum, scale.lo, scale.hi);
        const withinShare = (x: (typeof rows)[number]) => {
          if (!hasRange) return 1;
          let w = 0;
          for (let i = 0; i < x.g.count; i++) { const v = r.values[x.g.first + i][col]; if (Number.isFinite(v) && (scale.lo === null || v >= scale.lo) && (scale.hi === null || v <= scale.hi)) w += x.w[i]; }
          return x.stats.area ? w / x.stats.area : 0;
        };
        const select = (id: string, additive: boolean) => dispatch({ type: 'SELECT', ids: [id], additive });
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
            <p className="text-muted lines-2">{r.manifest.run_s !== undefined ? `${r.manifest.run_s.toFixed(2)} s on the GPU` : 'Done'}{cacheLine(r.cache)}. {r.manifest.duration_h} h evaluated, {r.manifest.dirs.sun.toLocaleString('en-GB')} sun directions, {fmtNum(r.values.length)} {r.on} on {rows.length} {rows.length === 1 ? 'mesh' : 'meshes'}.</p>
            <div className="cols-2">
              <div className="stat"><span className="stat__label">Total</span><span className="stat__value">{fmtNum(total)}</span><span className="stat__delta">{unit.total}</span></div>
              <div className="stat"><span className="stat__label">Mean</span><span className="stat__value">{fmtNum(markers.mean)}</span><span className="stat__delta">{unit.value}, area-weighted</span></div>
              <div className="stat"><span className="stat__label">P10</span><span className="stat__value">{fmtNum(markers.p10)}</span><span className="stat__delta">10 % of the area gets less</span></div>
              <div className="stat"><span className="stat__label">P90</span><span className="stat__value">{fmtNum(markers.p90)}</span><span className="stat__delta">10 % of the area gets more</span></div>
            </div>
            <Legend scale={scale} unit={unit.value} probe={probe?.value ?? null} />
            <div className="readout" role="status" aria-live="polite">{readout}</div>
            <fieldset className="field">
              <div className="cluster cluster--between"><legend>Colour scale</legend><ResetButton what="the colour scale" onClick={() => dispatch({ type: 'VIZ_RESET', quantity, what: 'scale' })} /></div>
              <div className="field">
                <label className="field__label" htmlFor="gradient">Gradient</label>
                <select className="select" id="gradient" value={scale.gradient.key} onChange={(e) => setViz({ gradient: e.target.value })}>
                  {GRADIENTS.map((g) => <option key={g.key} value={g.key}>{g.label}</option>)}
                </select>
              </div>
              <div className="cols-2">
                <NumberField id="scale-min" label={`Min ${unit.value}`} value={viz.scales[quantity]?.min ?? NaN} help={`Blank: ${fmtNum(domain[0])}`} onCommit={(v) => setViz({ min: orNull(v) })} />
                <NumberField id="scale-max" label={`Max ${unit.value}`} value={viz.scales[quantity]?.max ?? NaN} help={`Blank: ${fmtNum(domain[1])}`} onCommit={(v) => setViz({ max: orNull(v) })} />
              </div>
            </fieldset>
            <fieldset className="field">
              <div className="cluster cluster--between"><legend>Problem range</legend><ResetButton what="the problem range and its colours" onClick={() => dispatch({ type: 'VIZ_RESET', quantity, what: 'range' })} /></div>
              <div className="cols-2">
                <NumberField
                  id="range-lo" label={`Below ${unit.value}`} value={scale.lo ?? NaN} help="Blank: no lower bound" onCommit={(v) => setViz({ lo: orNull(v) })}
                  adorn={<ColorQuad id="colour-below" label="Colour below the range" value={scale.below} onChange={(below) => setViz({ below })} />}
                />
                <NumberField
                  id="range-hi" label={`Above ${unit.value}`} value={scale.hi ?? NaN} help="Blank: no upper bound" onCommit={(v) => setViz({ hi: orNull(v) })}
                  adorn={<ColorQuad id="colour-above" label="Colour above the range" value={scale.above} onChange={(above) => setViz({ above })} />}
                />
              </div>
            </fieldset>
            <h3>Distribution</h3>
            <Histogram edges={hist.edges} shares={hist.shares} counts={hist.counts} scale={scale} unit={unit.value} probe={probe?.value ?? null} bin={bin} markers={markers} dispatch={dispatch} />
            <h3>Cumulative area</h3>
            <AreaCurve cum={cum} domain={domain} scale={scale} unit={unit.value} probe={probe?.value ?? null} />
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
}
