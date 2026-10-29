// A chart drawn from its data (lib/charts chartData): the Results panel's built-ins and extras, and a report's.
import type { Dispatch } from 'react';
import { BUILT_IN, type ChartSpec, type Drawn } from '../lib/charts';
import { columnLabel } from '../lib/result';
import type { Action } from '../store';
import { LETTERS, cat } from '../ui';
import { AreaCurve } from './AreaCurve';
import { Histogram } from './Histogram';
import { Parts } from './Parts';

const KIND_TITLE = { histogram: 'Distribution', curve: 'Cumulative area', parts: 'Per part' };
/** A chart's heading: its title, a built-in's name, else its kind and column. */
export const chartTitle = (c: ChartSpec, column: string) =>
  c.title ?? (BUILT_IN.some((b) => b.id === c.id) ? KIND_TITLE[c.kind] : `${KIND_TITLE[c.kind]}, ${columnLabel(column)}`);

/** `width`: the viewBox's (320 = the panel's charts). `probe`, `bin`, `dispatch`: the cursor value, the hovered bin and
 *  bin hover, for a chart of the column the views show. */
export function Chart({ d, width, probe = null, bin = null, dispatch }: { d: Drawn; width?: number; probe?: number | null; bin?: [number, number] | null; dispatch?: Dispatch<Action> }) {
  switch (d.kind) {
    case 'histogram':
      return (
        <Histogram
          edges={d.edges} shares={d.shares} counts={d.counts} below={d.below} above={d.above} scale={d.scale} unit={d.unit} probe={probe} bin={bin} markers={d.markers}
          series={d.series?.map((s) => ({ color: cat(s.slot), label: LETTERS[s.slot], shares: s.shares }))} show={d.show} grid={d.grid} width={width} height={d.height} dispatch={dispatch}
        />
      );
    case 'curve':
      return <AreaCurve cum={d.cum} domain={d.domain} scale={d.scale} unit={d.unit} probe={probe} curves={d.curves?.map((c) => ({ color: cat(c.slot), cum: c.cum }))} show={d.show} grid={d.grid} width={width} height={d.height} />;
    case 'parts':
      return <Parts d={d} width={width} />;
    default:
      return <p className="text-muted">{d.reason}</p>;
  }
}
