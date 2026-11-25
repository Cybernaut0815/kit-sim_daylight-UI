// The report tools: reports stored on the server (GET/PUT/DELETE /reports), read back as save_report takes them, saved
// with the Daylight setup now, deleted, and their PDF generated in this tab (report/generate.ts).
import { changed, outcome } from '../../report/generate';
import { parseReports, readiness, validateSpec, type Draft, type Report, type Stored } from '../../report/spec';
import { captureSet } from '../../sets/model';
import { exclusive, fail } from '../bridge';
import { appView, isJson, ok, said, type Handler } from './common';
import { boundsIn } from './display';

/** The stored reports (GET /reports), each spec parsed. */
export async function storedReports(): Promise<Stored[]> {
  const r = await fetch('/reports').catch(() => null);
  if (!r?.ok || !isJson(r)) throw new Error(`reports: ${r ? await said(r) : 'the server cannot be reached'}`);
  return parseReports(await r.json());
}
/** Stored report `id`; its refusal names the ids there are. */
export async function storedReport(id: string): Promise<Stored> {
  const all = await storedReports(), e = all.find((s) => s.id === id);
  if (!e) throw new Error(`id: no report ${id}${all.length ? ` (${all.map((s) => s.id).join(', ')})` : ''}`);
  return e;
}
/** A report stored (PUT /reports/{id}), created kept from the one it replaces (`old`), updated now and after old's: every
 *  save of a report, also an edit in the app (`d` the edited report: its own stamps give way), goes through here. */
export async function putReport(d: Draft & Partial<Pick<Report, 'created' | 'updated'>>, old?: Report): Promise<Report> {
  const now = new Date(Math.max(Date.now(), (Date.parse(old?.updated ?? '') || 0) + 1)).toISOString();
  const { id, title, created: _c, updated: _u, ...rest } = d, r: Report = { id, title, created: old?.created ?? now, updated: now, ...rest };
  const res = await fetch(`/reports/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(r) }).catch(() => null);
  if (!res?.ok) throw new Error(`spec: not stored (${res ? await said(res) : 'the server cannot be reached'})`);
  changed(id);
  return r;
}
const waiting = new Set<string>(); // the reports generate_report answered 'generating' for: the next call gets that generation

export const REPORT_HANDLERS: Record<string, Handler> = {
  async get_report(a, c) {
    const e = await storedReport(a.id), problems = readiness(e.spec, appView(c()), c().generation(a.id).generating);
    const { ranges: _r, setup, blocks, ...spec } = e.spec; // the spec as save_report takes it: what the save adds left out
    return ok({
      spec: { ...spec, blocks: blocks.map((b) => (b.type === 'chart' ? { type: b.type, chart: b.chart, caption: b.caption } : b)) },
      // what Generate opens first: per report model its roles' counts, the settings, the column shown
      ...(setup ? {
        setup: {
          models: setup.models.map((m) => ({ model: m.model, file: m.file, receivers: m.roles.filter((r) => r.role === 'receiver').length, shades: m.roles.filter((r) => r.role === 'shade').length })),
          settings: setup.settings, column: setup.column,
        },
      } : {}),
      pdf: e.pdf, ready: !problems.length, problems,
    });
  },

  async save_report(a, c) {
    return exclusive(async () => {
      // the Daylight setup now goes with it (the name a set's: a title may be longer than a set's name takes)
      const d = validateSpec(a.spec, appView(c()), boundsIn(c()), captureSet(c().state, 'daylight', 'Report setup', { shown: c().shown, subdiv: c().ui.subdiv }));
      if (Array.isArray(d)) return fail(`spec: ${d.length} problem${d.length > 1 ? 's' : ''}; fix ${d.length > 1 ? 'them' : 'it'} and save again:\n${d.join('\n')}`);
      const old = (await storedReports()).find((e) => e.id === d.id)?.spec, since: unknown = a.updated ?? a.spec.updated; // get_report's spec carries its updated
      if (old && since !== old.updated) {
        throw new Error(since === undefined ? `updated: report ${d.id} exists (updated ${old.updated}); to replace it, call get_report, merge, and save with its updated, or save under another id`
          : `updated: report ${d.id} changed in the app since (${since}), last at ${old.updated}: call get_report, merge, and save again`);
      }
      if (!old && a.updated !== undefined) throw new Error(`updated: there is no report ${d.id} to replace; leave updated out to create it`);
      const r = await putReport(d, old);
      await c().refreshReports();
      const problems = readiness(r, appView(c()), c().generation(r.id).generating);
      return ok({ id: r.id, updated: r.updated, ready: !problems.length, problems });
    });
  },

  async delete_report(a, c) {
    if (c().generation(a.id).generating) return fail(`id: a PDF of ${a.id} is being generated; call generate_report until it answers, then delete`);
    const r = await fetch(`/reports/${a.id}`, { method: 'DELETE' }).catch(() => null);
    if (r?.status === 404) return fail(`id: no report ${a.id}`);
    if (r?.status === 409) return fail('the PDF is open in another program: close it and delete again');
    if (!r?.ok) return fail(`id: not deleted (${r ? await said(r) : 'the server cannot be reached'})`);
    changed(a.id);
    await c().refreshReports();
    return ok({ deleted: a.id, reports: (c().reports ?? []).map((e) => e.id) });
  },

  async generate_report(a, c, end) {
    // a call after 'generating': that generation's PDF or error once it has ended (unless the report was saved since)
    const kept = waiting.delete(a.id) && !c().generation(a.id).generating ? outcome(a.id) : undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pdf = kept ? Promise.resolve('pdf' in kept ? { p: kept.pdf } : { e: new Error(kept.error) })
      : c().generate(a.id).then((p) => ({ p }), (e: Error) => ({ e })); // a second call meanwhile gets the same generation
    const r = await Promise.race([pdf, new Promise<null>((done) => { timer = setTimeout(done, Math.max(0, Math.min(40e3, end - Date.now())), null); })]);
    clearTimeout(timer);
    if (!r) {
      waiting.add(a.id);
      return ok({ id: a.id, status: 'generating', note: 'call generate_report again for the result' });
    }
    if ('e' in r) return fail(/^(?:id|blocks\[\d+\]): /.test(r.e.message) ? r.e.message : `${a.id}: ${r.e.message}`); // a field it names, else the report
    return ok({ id: a.id, ...r.p });
  },
};
