import { useMemo, type Dispatch } from 'react';
import { Donut } from '../charts/Donut';
import { Histogram } from '../charts/Histogram';
import { columnLabel, columnStats, fmtNum, histogram, unitFor } from '../lib/result';
import type { Action, ObjectRow, Run } from '../store';
import { Alert, Illustration, Segmented, Swatch, knob, pct, rowKeys } from '../ui';

interface Props {
  run: Run; objects: ObjectRow[]; column: number; colourBy: 'mesh' | 'value'; hovered: string | null; selected: Set<string>;
  weightsFor: (id: string, on: 'faces' | 'vertices') => ArrayLike<number> | undefined; dispatch: Dispatch<Action>;
}

const cacheLine = (c?: Record<string, string>) => {
  if (!c) return '';
  if (c.response === 'hit') return ', identical run replayed from the server cache';
  return `, scene ${c.scene === 'reused' ? 'reused' : 'built'}, ${c.weather === 'hit' ? 'weather cached' : c.weather === 'none' ? 'clear sky' : 'weather parsed'}`;
};

export function ResultsPanel({ run, objects, column, colourBy, hovered, selected, weightsFor, dispatch }: Props) {
  const data = useMemo(() => {
    if (run.status !== 'done') return null;
    const r = run.result, col = Math.min(column, r.columns.length - 1);
    const rows = r.receivers.map((id, i) => {
      const o = objects.find((x) => x.id === id), g = r.manifest.meshes[i];
      return { id, name: o?.name ?? g.name, slot: o?.slot, g, stats: columnStats(r.values, col, g, weightsFor(id, r.on) ?? new Float64Array(g.count).fill(1)) };
    });
    const total = rows.reduce((s, x) => s + x.stats.total, 0), area = rows.reduce((s, x) => s + x.stats.area, 0);
    return { r, col, rows, total, area, hist: histogram(r.values, col, rows.map((x) => x.g)), unit: unitFor(r.columns[col]) };
  }, [run, column, objects, weightsFor]);

  return (
    <section className="stack" aria-labelledby="h-results">
      <h2 id="h-results">Results</h2>
      {run.status === 'idle' && (
        <div className="empty-state">
          <div className="empty-state__icon"><Illustration kind="results" /></div>
          <h3>No results yet</h3>
          <p>Mark a receiver mesh, set the site and time, then run the simulation. Totals, shares and the value distribution appear here.</p>
        </div>
      )}
      {run.status === 'running' && (
        <div className="stack" aria-busy="true">
          <div className="grid" style={knob('--grid-min', '7rem')}>
            {[0, 1, 2].map((n) => <div key={n} className="skeleton" aria-hidden="true">&nbsp;<br />&nbsp;<br />&nbsp;</div>)}
          </div>
          <div className="skeleton" aria-hidden="true">&nbsp;<br />&nbsp;<br />&nbsp;<br />&nbsp;<br />&nbsp;<br />&nbsp;</div>
          <p className="text-muted"><span className="spinner" aria-hidden="true" /> Tracing on the GPU</p>
        </div>
      )}
      {run.status === 'error' && <Alert title="Run failed">{run.message}</Alert>}
      {data && (() => {
        const { r, col, rows, total, area, hist, unit } = data;
        const hov = rows.find((x) => x.id === hovered);
        const select = (id: string, additive: boolean) => dispatch({ type: 'SELECT', ids: [id], additive });
        return (
          <div className="stack view-fade">
            <div className="cluster cluster--between">
              {r.columns.length > 1 ? (
                <div className="field">
                  <label className="sr-only" htmlFor="column">Column</label>
                  <select className="select" id="column" value={col} onChange={(e) => dispatch({ type: 'COLUMN', column: Number(e.target.value) })}>
                    {r.columns.map((c, i) => <option key={c} value={i}>{columnLabel(c)}</option>)}
                  </select>
                </div>
              ) : <h3>{columnLabel(r.columns[0])}</h3>}
              <Segmented name="colour-by" label="Colour meshes by" value={colourBy} options={[['mesh', 'Mesh'], ['value', 'Value']] as const} onChange={(v) => dispatch({ type: 'COLOUR_BY', colourBy: v })} />
            </div>
            <p className="text-muted">{r.manifest.run_s !== undefined ? `${r.manifest.run_s.toFixed(2)} s on the GPU` : 'Done'}{cacheLine(r.cache)}. {r.manifest.duration_h} h evaluated, {r.manifest.dirs.sun.toLocaleString('en-GB')} sun directions.</p>
            <div className="grid" style={knob('--grid-min', '7rem')}>
              <div className="stat"><span className="stat__label">Total</span><span className="stat__value">{fmtNum(total)}</span><span className="stat__delta">{unit.total}</span></div>
              <div className="stat"><span className="stat__label">Area-weighted mean</span><span className="stat__value">{fmtNum(area ? total / area : NaN)}</span><span className="stat__delta">{unit.value}</span></div>
              <div className="stat"><span className="stat__label">Elements</span><span className="stat__value">{fmtNum(r.values.length)}</span><span className="stat__delta">{r.on} on {rows.length} {rows.length === 1 ? 'mesh' : 'meshes'}</span></div>
            </div>
            <div className="grid" style={knob('--grid-min', '14rem')}>  {/* one chart per row in the 24rem aside: the histogram needs the width for its labels */}
              <Donut slices={rows.map((x) => ({ id: x.id, name: x.name, slot: x.slot, share: total ? x.stats.total / total : 0 }))} total={total} unit={unit.total} hovered={hovered} dispatch={dispatch} />
              <Histogram edges={hist.edges} counts={hist.counts} series={rows} unit={unit.value} hovered={hovered} dispatch={dispatch} />
            </div>
            {hov && (
              <div className="tooltip" role="status">
                {hov.name}: {fmtNum(hov.stats.mean)} {unit.value} mean, {fmtNum(hov.stats.total)} {unit.total} total, {pct(total ? hov.stats.total / total : 0)} of the total
              </div>
            )}
            <div className="table-wrap">
              <table className="data-table">
                <caption>Per receiver mesh, {columnLabel(r.columns[col])}</caption>
                <thead>
                  <tr>
                    <th scope="col"><span className="sr-only">Colour</span></th>
                    <th scope="col">Mesh</th>
                    <th scope="col" className="num">Elements</th>
                    <th scope="col" className="num">Min <span className="th-unit">{unit.value}</span></th>
                    <th scope="col" className="num">Mean</th>
                    <th scope="col" className="num">Max</th>
                    <th scope="col" className="num">Total <span className="th-unit">{unit.total}</span></th>
                    <th scope="col" className="num">Share</th>
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
                      <td><Swatch slot={x.slot} /></td>
                      <td>{x.name}</td>
                      <td className="num">{x.stats.count.toLocaleString('en-GB')}</td>
                      <td className="num">{fmtNum(x.stats.min)}</td>
                      <td className="num">{fmtNum(x.stats.mean)}</td>
                      <td className="num">{fmtNum(x.stats.max)}</td>
                      <td className="num">{fmtNum(x.stats.total)}</td>
                      <td className="num">{pct(total ? x.stats.total / total : 0)}</td>
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
