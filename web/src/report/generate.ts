// A report's PDF, for generate_report and the Reports menu alike: the stored spec, checked against the app (readiness);
// its view blocks shot per report model on one colour scale; the page laid out by Report.tsx (loaded on first use, so
// react-dom/server and the inlined stylesheet stay out of the app's bundle) and printed by the server. One generation per
// report at a time; whether one is on its way and how the last one ended stay here for app_state, the menu and the call
// after 'generating'.
import { exclusive } from '../mcp/bridge';
import { appView, b64, staged, storedReport, type Ctl } from '../mcp/tools';
import { fmtNum, unionRange } from '../lib/result';
import type { Model } from '../store';
import { capture } from '../viewer/capture';
import { imageSize, readiness, type Report } from './spec';

/** The printed PDF as the server answers POST /reports/{id}/pdf: its path, link, pages, size and fonts (fallback: fonts
 *  that are not kit-ui's). */
export interface Pdf { pdf: string; url: string; pages: number; bytes: number; fonts: string[]; fallback: string[] }

// per report: its generation on its way; how the last one ended (since its last save); one on its way of an older spec
const going = new Map<string, Promise<Pdf>>(), last = new Map<string, { pdf: Pdf } | { error: string }>(), older = new Set<string>();
/** Report `id`: a generation on its way, and why the last one failed (null: it did not, or none ran since a save). */
export const generation = (id: string) => { const l = last.get(id); return { generating: going.has(id), lastError: l && 'error' in l ? l.error : null }; };
/** How report `id`'s last generation since its last save ended: its PDF or why it failed (undefined: none). */
export const outcome = (id: string) => last.get(id);
/** Report `id` was saved or deleted: its last outcome is of an older spec, and so is a generation on its way (the next
 *  generate() makes one of its own once that one has ended). */
export function changed(id: string): void {
  last.delete(id);
  if (going.has(id)) older.add(id);
}

/** Report `id` as a PDF, against the app `c` drives; while one of its current spec is on its way, that one. The report
 *  list is fetched again as it starts and ends (the menus show it). */
export function generate(id: string, c: () => Ctl): Promise<Pdf> {
  const on = going.get(id);
  if (on && !older.has(id)) return on;
  older.delete(id);
  const p = (on ?? Promise.resolve()).catch(() => {}).then(() => build(id, c)); // after one of an older spec: its shots and print first
  going.set(id, p);
  last.delete(id);
  const end = (o: { pdf: Pdf } | { error: string }) => { if (going.get(id) === p && !older.has(id)) last.set(id, o); }; // of the spec stored now
  // a refusal as not ready is no outcome: readiness shows the live state, and a kept one would outlast its cause
  p.then((pdf) => end({ pdf }), (e: Error) => { if (!e.message.startsWith('not ready:')) end({ error: e.message }); }).finally(() => { if (going.get(id) === p) going.delete(id); void c().refreshReports(); });
  void c().refreshReports();
  return p;
}

async function build(id: string, c: () => Ctl): Promise<Pdf> {
  const page = import('./Report'); // loads while the lock is awaited
  const html = await exclusive(async () => {
    const { spec } = await storedReport(id); // under the lock: no save or edit lands between it and the shots
    const no = readiness(spec, appView(c()));
    if (no.length) throw new Error(`not ready: ${no.join('; ')}`);
    const models = spec.models.map((r) => c().state.models.find((m) => m.slot === 'ABCD'.indexOf(r.model))!), images = await shots(spec, models, c);
    const x = c(), { renderReport } = await page;
    return renderReport({
      report: spec, models: models.map((m) => ({ slot: m.slot, name: m.name, file: x.fileOf(m.slot), objects: m.objects, result: m.result! })), settings: x.state.settings,
      weightsFor: x.weightsFor, meshOf: x.meshOf, images, versions: __VERSIONS__, date: new Date(),
    });
  });
  const r = await fetch(`/reports/${id}/pdf`, { method: 'POST', headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: html }).catch(() => null);
  if (!r?.ok) throw new Error(r ? (await r.text()).replace(/^error: /, '').trim() : 'the server cannot be reached');
  return (await r.json()) as Pdf;
}

/** Each view block's images (per report model, data: URLs; [] for the other blocks) at twice their printed size: PNG over
 *  white, the block's column on the report models' range (a blank Min or Max pinned to it) or the models' own colours,
 *  without grid, sun path, bin highlight or selection. */
async function shots(spec: Report, models: Model[], c: () => Ctl): Promise<string[][]> {
  const out: string[][] = [];
  for (const [i, b] of spec.blocks.entries()) {
    if (b.type !== 'view') { out.push([]); continue; }
    const q = b.column?.split('_')[0], scale = q ? c().state.settings.viz.scales[q] : undefined, [lo, hi] = b.column ? unionRange(models.map((m) => m.result!), b.column) : [NaN, NaN];
    const { width, height } = imageSize(models.length, b.aspect ?? 1.6);
    out.push(await staged(c, models.map((m) => m.slot), { column: b.column ?? undefined, colourBy: b.column ? 'value' : 'plain', sunPath: false, grid: false, clean: true, ...(q ? { pin: { quantity: q, min: scale?.min ?? lo, max: scale?.max ?? hi } } : {}) }, async () => {
      const urls: string[] = [];
      for (const m of models) {
        const { el } = c().viewer(m.slot), mpu = el.stage?.metersPerUnit ?? 1;
        const png = await capture(el, { width: Math.round(2 * width), height: Math.round(2 * height), view: b.view, near: b.near === undefined ? undefined : b.near / mpu })
          .catch((e: Error) => { throw new Error(`blocks[${i}]: ${e.message.replace(/less than (\S+) here$/, (_, v: string) => `less than ${fmtNum(Number(v) * mpu)} m here`)}`); });
        urls.push(`data:image/png;base64,${await b64(png)}`);
      }
      return urls;
    }));
  }
  return out;
}
