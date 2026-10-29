// A chart's settings menu (its tune button): the look fields its kind has, then the colours of its quantity, which the 3D
// views and every chart share, then Reset and (a chart of one's own) Remove. Also the colour fields themselves, which the
// Results panel shows over its charts.
import type { Dispatch } from 'react';
import { BUILT_IN, FIELDS, MARKERS, METRICS, isShare, type ChartSpec, type Drawn, type Metric } from '../lib/charts';
import { GRADIENTS, scaleFor, type Scale } from '../lib/gradients';
import { columnLabel, fmtNum, unitFor } from '../lib/result';
import type { Action, Settings } from '../store';
import { ColorQuad, MenuButton, NumberField, ResetButton, Segmented } from '../ui';
import { niceStep } from './axes';
import { METRIC_LABEL } from './Parts';

/** What the CHART action does to a chart: put by id, removed (one's own), its look back to the kind's. */
export type ChartEdit = { spec: ChartSpec } | { id: string; remove: true } | { id: string; reset: true };

export const RANGE_HELP = 'Relative: the colour scale, Min to Max (the data range where they are blank). Absolute: the whole range of the data. Min-Max: a range of its own, in the chart settings.';
const orNull = (v: number) => (Number.isFinite(v) ? v : null);
/** The drawn span widened to round numbers: where Min-Max starts. */
const rounded = ([a, b]: [number, number]): [number, number] => { const s = niceStep(b - a, 20); return [Number((Math.floor(a / s) * s).toFixed(10)), Number((Math.ceil(b / s) * s).toFixed(10))]; };

/**
 * A quantity's colour scale and problem range (VIZ / VIZ_RESET), shared by the 3D views and every chart: in the Results
 * panel and in each chart's menu (ids after `idp`). Min / Max blank: the data's bound, shown as the placeholder.
 */
export function ScaleFields({ idp = '', quantity, scale, viz, many, dispatch }: { idp?: string; quantity: string; scale: Scale; viz: Settings['viz']; many: boolean; dispatch: Dispatch<Action> }) {
  const unit = unitFor(quantity).value, inUnit = unit ? ` (${unit})` : ''; // the unit once per group: the labels stay one short word
  const setViz = (patch: Extract<Action, { type: 'VIZ' }>['patch']) => dispatch({ type: 'VIZ', quantity, patch });
  return (
    // one row of five controls when there is room for them, else two
    <div className="scale-row">
      <fieldset className="field" aria-labelledby={`${idp}lg-scale`}>
        <div className="cluster cluster--between"><legend id={`${idp}lg-scale`}>Colour scale{inUnit}<span className="sr-only">. Min or Max left blank: the range of the data (the placeholder){many ? ', every model\'s' : ''}</span></legend><ResetButton what="the colour scale" onClick={() => dispatch({ type: 'VIZ_RESET', quantity, what: 'scale' })} /></div>
        <div className="scale-row__cols">
          <div className="field">
            <label className="field__label" htmlFor={`${idp}gradient`}>Gradient</label>
            <select className="select" id={`${idp}gradient`} value={scale.gradient.key} onChange={(e) => setViz({ gradient: e.target.value })}>
              {GRADIENTS.map((g) => <option key={g.key} value={g.key}>{g.label}</option>)}
            </select>
          </div>
          <NumberField id={`${idp}scale-min`} label="Min" value={viz.scales[quantity]?.min ?? NaN} placeholder={fmtNum(scale.vmin)} onCommit={(v) => setViz({ min: orNull(v) })} />
          <NumberField id={`${idp}scale-max`} label="Max" value={viz.scales[quantity]?.max ?? NaN} placeholder={fmtNum(scale.vmax)} onCommit={(v) => setViz({ max: orNull(v) })} />
        </div>
      </fieldset>
      <fieldset className="field" aria-labelledby={`${idp}lg-range`}>
        <div className="cluster cluster--between"><legend id={`${idp}lg-range`}>Problem range{inUnit}<span className="sr-only">. Below or Above left blank: no bound</span></legend><ResetButton what="the problem range and its colours" onClick={() => dispatch({ type: 'VIZ_RESET', quantity, what: 'range' })} /></div>
        <div className="scale-row__cols">
          <NumberField
            id={`${idp}range-lo`} label="Below" value={scale.lo ?? NaN} placeholder="none" onCommit={(v) => setViz({ lo: orNull(v) })}
            adorn={<ColorQuad id={`${idp}colour-below`} label="Colour below the range" value={scale.below} onChange={(below) => setViz({ below })} />}
          />
          <NumberField
            id={`${idp}range-hi`} label="Above" value={scale.hi ?? NaN} placeholder="none" onCommit={(v) => setViz({ hi: orNull(v) })}
            adorn={<ColorQuad id={`${idp}colour-above`} label="Colour above the range" value={scale.above} onChange={(above) => setViz({ above })} />}
          />
        </div>
      </fieldset>
    </div>
  );
}

/**
 * The tune button and its menu (`id`; its fields `${id}:bins` and so on, ':' being in no chart id) for chart `spec`, drawn
 * as `d` from `column`. Every change goes to `onChart` as the whole spec (a field left undefined: its default); the
 * colours go to the store (`dispatch`), shared.
 */
export function ChartSettings({ id, title, spec, d, column, viz, many, dispatch, onChart }: {
  id: string; title: string; spec: ChartSpec; d: Drawn; column: string; viz: Settings['viz']; many: boolean; dispatch: Dispatch<Action>; onChart: (e: ChartEdit) => void;
}) {
  const put = (patch: Partial<ChartSpec>) => onChart({ spec: { ...spec, ...patch } });
  const quantity = column.split('_')[0], scale = d.kind === 'empty' ? scaleFor(column, [NaN, NaN], viz) : d.scale;
  const span: [number, number] | null = d.kind === 'histogram' ? [d.edges[0], d.edges[d.edges.length - 1]] : d.kind === 'curve' || d.kind === 'parts' ? d.domain : null;
  const [lo, hi] = Array.isArray(spec.range) ? spec.range : [NaN, NaN];
  const setSpan = (a: number, b: number) => { if (Number.isFinite(a) && Number.isFinite(b)) put({ range: a <= b ? [a, b] : [b, a] }); }; // blank: the bound stays (its placeholder)
  const several = (d.kind === 'histogram' && !!d.series) || (d.kind === 'curve' && !!d.curves), shown = spec.markers ?? MARKERS[spec.kind];
  const field = (f: (typeof FIELDS)[ChartSpec['kind']][number]) => {
    switch (f) {
      case 'range':
        return (
          <div key={f} className="field">
            <span className="field__label">Range</span>
            <Segmented
              name={`${id}:range`} label="Range" title={RANGE_HELP} value={Array.isArray(spec.range) ? 'set' : spec.range ?? 'relative'}
              options={[['relative', 'Relative'], ['absolute', 'Absolute'], ['set', 'Min-Max']] as const}
              onChange={(r) => put({ range: r !== 'set' ? r : span ? rounded(span) : undefined })}
            />
            {Array.isArray(spec.range) && (
              <div className="scale-row__cols">
                <NumberField id={`${id}:lo`} label="Min" value={lo} placeholder={fmtNum(lo)} onCommit={(v) => setSpan(v, hi)} />
                <NumberField id={`${id}:hi`} label="Max" value={hi} placeholder={fmtNum(hi)} onCommit={(v) => setSpan(lo, v)} />
              </div>
            )}
            {spec.kind === 'parts' && isShare(spec.metric ?? 'mean') && <span className="field__help">Shares always span 0 to 100 %</span>}
          </div>
        );
      case 'bins':
        return (
          <NumberField
            key={f} id={`${id}:bins`} label="Bins" value={typeof spec.bins === 'number' ? spec.bins : NaN} step={1} min={4} max={100}
            placeholder={`Auto${d.kind === 'histogram' ? ` (${d.edges.length - 1})` : ''}`} onCommit={(v) => put({ bins: Number.isFinite(v) ? v : undefined })}
          />
        );
      case 'markers':
        return (
          <fieldset key={f} className="field" disabled={several} title={several ? 'Markers show with one model only' : undefined}>
            <legend>Markers</legend>
            <div className="cluster">
              {MARKERS[spec.kind].map((m) => (
                <label key={m}>
                  <input type="checkbox" checked={shown.includes(m)} onChange={(e) => { const next = MARKERS[spec.kind].filter((x) => (x === m ? e.target.checked : shown.includes(x))); put({ markers: next.length === MARKERS[spec.kind].length ? undefined : next }); }} /> {METRIC_LABEL[m]}
                </label>
              ))}
            </div>
          </fieldset>
        );
      case 'grid':
        return <label key={f}><input type="checkbox" checked={spec.grid ?? true} onChange={(e) => put({ grid: e.target.checked ? undefined : false })} /> Grid lines</label>;
      case 'height':
        return (
          <NumberField
            key={f} id={`${id}:height`} label="Height" value={spec.height ?? NaN} step={10} min={100} max={400}
            placeholder={d.kind === 'histogram' || d.kind === 'curve' ? String(d.height) : ''} onCommit={(v) => put({ height: Number.isFinite(v) ? v : undefined })}
          />
        );
      case 'metric':
        return (
          <div key={f} className="field">
            <label className="field__label" htmlFor={`${id}:metric`}>Bars</label>
            <select className="select" id={`${id}:metric`} value={spec.metric ?? 'mean'} onChange={(e) => put({ metric: e.target.value as Metric })}>
              {METRICS.map((m) => <option key={m} value={m}>{METRIC_LABEL[m]}</option>)}
            </select>
          </div>
        );
    }
  };
  return (
    <MenuButton id={id} label={`${title} settings`} icon="tune">
      {(close) => (
        <>
          <div className="stack chart-menu">{FIELDS[spec.kind].map(field)}</div>
          <div className="menu__separator" />
          <div className="menu__section">Colours of {columnLabel(quantity).toLowerCase()}, shared with the 3D views and every chart</div>
          <div className="chart-menu"><ScaleFields idp={`${id}:`} quantity={quantity} scale={scale} viz={viz} many={many} dispatch={dispatch} /></div>
          <div className="menu__footer cluster">
            {!BUILT_IN.some((b) => b.id === spec.id) && <button className="btn btn--danger" type="button" onClick={() => { close(); onChart({ id: spec.id, remove: true }); }}>Remove</button>}
            <button className="btn btn--secondary" type="button" onClick={() => onChart({ id: spec.id, reset: true })}>Reset</button>
          </div>
        </>
      )}
    </MenuButton>
  );
}
