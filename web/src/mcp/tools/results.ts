// The run and result tools: an analysis run (its Run button), results in numbers from any source (an analysis' last
// runs, a saved set's kept results, a combined view), the worst areas of a result (find_critical) and a result saved as a
// file (the Download menu).
import { flushSync } from 'react-dom';
import { dataOf } from '../../lib/charts';
import { findCritical, type Vec3 } from '../../lib/frame';
import { roundNum, roundPct, splitColumn, unitFor } from '../../lib/result';
import { inFlight } from '../../store';
import type { ExportMode } from '../../viewer/download';
import { exclusive, fail } from '../bridge';
import { combinedResults, setResults } from '../sets';
import { analysisOf, done, freshness, inAnalysis, letter, loadedOf, modelOf, nameOf, ok, runCall, weightsOf, type AnalysisCtl, type Handler } from './common';
import { cm } from './display';
import { columnFacts, compared, provenance, rowArgs, summaries, viewProvenance } from './stats';

/** run's lines: per model its status, run time and the shown column's mean, P10 and P90. */
function runLines(y: Pick<AnalysisCtl, 'models' | 'per' | 'shown'>) {
  return y.models.map((m, i) => {
    const r = m.result, f = freshness(y, i), col = r && y.shown ? r.columns.indexOf(y.shown) : -1, sum = r && col >= 0 ? dataOf(r, col, m.objects).markers : null;
    const status = m.run.status === 'error' ? 'failed' : inFlight(m.run) ? m.run.status : !y.per[i].receivers.length ? 'no receiver' : f === 'fresh' ? 'done' : f ?? 'not run';
    return {
      model: letter(m.slot), status, ...(m.error ? { error: m.error } : {}),
      ...(r ? { seconds: roundNum(r.elapsed), ...(r.manifest.run_s !== undefined ? { compute: roundNum(r.manifest.run_s) } : {}) } : {}),
      ...(sum ? { column: y.shown, unit: unitFor(y.shown!).value, mean: roundNum(sum.mean), p10: roundNum(sum.p10), p90: roundNum(sum.p90) } : {}),
    };
  });
}

export const RESULT_HANDLERS: Record<string, Handler> = {
  async run(a, c, end) {
    const y = () => analysisOf(c(), a), going = () => { const z = y(); return z.busy() || z.held() || z.models.some((m) => inFlight(m.run)); };
    if (a.cancel) {
      if (y().busy()) { y().cancel(); await done(() => !y().busy(), end, 'the cancel'); }
      return ok({ status: y().busy() ? 'cancelling' : 'stopped', models: runLines(y()) });
    }
    const started = await exclusive(() => {
      if (going()) return false; // join the batch on its way
      flushSync(() => void y().onRun());
      return true;
    });
    const refused = started ? Object.entries(y().errors).filter(([k]) => k !== 'materials') : []; // materials: held until they are read
    if (refused.length) return fail(JSON.stringify({ status: 'refused', problems: Object.fromEntries(refused), fix: `update_settings${a.analysis === 'views' ? ' view' : ''}, set_roles or edit_material` }));
    const finished = await done(() => !going(), Math.min(end, Date.now() + 1000 * (a.wait ?? 40)), 'the run');
    return ok({ status: finished ? 'done' : 'running', models: runLines(y()) });
  },

  // one quoting for every source: a saved set's kept results (set), a combined view (analysis combined), else an
  // analysis' last runs
  async results(a, c, end) {
    if (a.analysis === 'combined') {
      if (a.set !== undefined) throw new Error("set: quotes a saved set's kept results; leave analysis 'combined' out, or give id instead");
      return combinedResults(a, c, end);
    }
    const extra = ['id', 'wait'].find((k) => a[k] !== undefined);
    if (extra) throw new Error(`${extra}: goes with analysis 'combined' (a combined view's results)`);
    if (a.set !== undefined) return setResults(a, c);
    return exclusive(() => {
      const x = c(), y = analysisOf(x, a), named: string[] | undefined = a.models, run = runCall(y.tool);
      const ms = named ? named.map((l, i) => { const m = inAnalysis(y, modelOf(x, l, `models[${i}]`)); if (!m.result) throw new Error(`models[${i}]: model ${l} has no ${nameOf(y.tool)} result; ${run} first`); return m; }) : y.models.filter((m) => m.result);
      if (!ms.length) throw new Error(`models: no model has a ${nameOf(y.tool)} result yet; ${run} first`);
      const column: string = a.column ?? y.shown ?? ms[0].result!.columns[0], lacks = ms.find((m) => !m.result!.columns.includes(column));
      if (lacks) throw new Error(`column: model ${letter(lacks.slot)}'s result has no ${column} (${lacks.result!.columns.join(', ')}); ${run} again`);
      const { paths, by, th, limit } = rowArgs(a), { lo = null, hi = null } = x.state.settings.viz.ranges[splitColumn(column)[0]] ?? {};
      const each = ms.map((m) => ({
        head: { model: letter(m.slot), name: m.name, result: freshness(y, y.models.indexOf(m)), run: y.tool === 'views' ? viewProvenance(m.result!, m.objects) : provenance(m.result!, m.objects) },
        sums: summaries(x, m, column, by, paths, lo, hi, th),
      }));
      return ok({ analysis: y.tool, ...columnFacts(column), problemRange: { lo, hi }, by, models: compared(each, th, lo !== null || hi !== null, limit) });
    });
  },

  async find_critical(a, c) {
    return exclusive(() => {
      const x = c(), y = analysisOf(x, a), m = inAnalysis(y, loadedOf(x, a.model)), L = letter(m.slot), r = m.result, f = freshness(y, y.models.indexOf(m)), run = runCall(y.tool);
      if (!r) throw new Error(`model: model ${L} has no ${nameOf(y.tool)} result; ${run} first`);
      if (f !== 'fresh') throw new Error(`model: model ${L}'s result is ${f === 'running' ? `being replaced by a run on its way; call ${run} to wait for it` : `stale (inputs changed since it ran); ${run} first`}`);
      const column: string = a.column ?? y.shown!, col = r.columns.indexOf(column), q = splitColumn(column)[0], range = x.state.settings.viz.ranges[q];
      if (col < 0) throw new Error(`column: not in model ${L}'s result (${r.columns.join(', ')})`);
      const given = a.lo !== undefined || a.hi !== undefined, lo: number | undefined = given ? a.lo : range?.lo ?? undefined, hi: number | undefined = given ? a.hi : range?.hi ?? undefined;
      if (lo === undefined && hi === undefined) throw new Error(`lo: the problem range of ${q} is empty; give lo or hi (${unitFor(column).value}), or set the range with update_settings viz`);
      const mpu = x.viewer(m.slot).el.stage?.metersPerUnit ?? 1, w = weightsOf(r), rows = new Map(m.objects.map((o) => [o.id, o]));
      const meshes = (function* () { // one built at a time (meshOf builds per call)
        for (const [k, id] of r.receivers.entries()) {
          const o = x.meshOf(id, r), row = rows.get(id), g = r.manifest.meshes[k];
          if (o && row) yield { id, name: row.name, path: row.path, first: g.first, count: g.count, positions: o.positions, indices: o.indices, faceStart: o.faceStart, w: w[k] };
        }
      })();
      const out = findCritical({ values: r.data[col], column, on: r.on, meshes, north: x.state.settings.sim.north, mpu, below: lo, above: hi, limit: a.limit ?? 8 }), xyz = (v: Vec3) => v.map(cm);
      return ok({
        model: L, column, unit: unitFor(column).value, lo: lo ?? null, hi: hi ?? null, problemArea: roundNum(out.problemArea), problemShare: roundPct(out.problemShare),
        groups: out.clusters.map((g) => ({
          mesh: g.path, facing: g.facing, side: g.side, elements: g.elements, area: roundNum(g.area), share: roundPct(g.share), mean: roundNum(g.mean), worst: roundNum(g.worst),
          centre: xyz(g.centroid), box: { min: xyz(g.box.min), max: xyz(g.box.max) }, normal: g.normal.map((v) => Math.round(1000 * v) / 1000), view: g.view, near: roundNum(g.near * mpu),
        })),
      });
    });
  },

  async download_result(a, c, end) {
    return exclusive(async () => {
      const x = c(), y = analysisOf(x, a), m = inAnalysis(y, loadedOf(x, a.model)), L = letter(m.slot), mode: ExportMode = a.mode ?? 'replace', run = runCall(y.tool);
      // one at a time, as the Download menu: a second export would write the same file, and the first one's end would
      // say it was saved
      if (x.exporting) throw new Error('format: a download is still being written; it lands in the downloads folder by itself, do not download it again');
      if (!m.result) throw new Error(`model: model ${L} has no ${nameOf(y.tool)} result; ${run} first`);
      if (!y.shown || !m.result.columns.includes(y.shown)) throw new Error(`model: model ${L}'s result has no ${y.shown} column; ${run} again`);
      flushSync(() => x.dispatch({ type: 'ACTIVE', slot: m.slot })); // the Download menu acts on the active model
      flushSync(() => void analysisOf(c(), a).onDownload(a.format, mode));
      if (!(await done(() => !c().exporting, end, 'the download'))) return ok({ model: L, status: 'running', note: 'still writing the file; it lands in the downloads folder by itself: do not call download_result again for it' });
      const e = c().exportError;
      if (e && e.key === m.result.key) return fail(`download failed: ${e.message}`);
      return ok({
        model: L, analysis: y.tool, format: a.format, ...(a.format.startsWith('usd') ? { mode } : {}), column: y.shown, saved: "the browser's downloads folder",
        note: "several downloads from a background tab can trigger the browser's 'automatic downloads' prompt, after which it blocks them",
      });
    });
  },
};
