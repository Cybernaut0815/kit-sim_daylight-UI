// The agent's tools (server/mcp.json: their names, arguments and what each does), run in the app tab against App's
// controller. A call's arguments are checked against its tool's inputSchema; its handler then reads the controller again
// after every await (c()), applies a change with flushSync (one commit, after which c() is current) and waits for App's
// async work (a load, a re-read, a run, a download) with until(), answering 'running' when that outlasts the call's
// budget (the work goes on). A thrown 'field: what to do' answers isError. Replies are compact JSON, numbers rounded as
// the app shows them (NaN -> null). The hidden instance keeps a record of its session on the server (PUT /session); a UI
// tab picks it up as its bridge starts (pickup), and calls wait until it has (within their budget).
//
// The handlers live by area in tools/: settings (site_info, update_settings), model (open_model .. edit_material),
// results (run, results, find_critical, download_result), display (set_display, set_camera, save_view, screenshot),
// reports (get/save/delete/generate_report); sets.ts has the sets and combined views. This module adds app_state and
// guide, runs a call, and keeps the hidden instance's session.
import { flushSync } from 'react-dom';
import { chosenOf } from '../report/spec';
import { needsLevel } from '../sets/model';
import { QUANTITIES, inFlight, parseSettings, serializeSettings } from '../store';
import guide from './guide.md?raw';
import reportGuide from './report.md?raw';
import setsGuide from './sets.md?raw';
import viewsGuide from './views.md?raw';
import { HEADLESS, exclusive, fail, startBridge, type CallToolResult } from './bridge';
import { SET_HANDLERS, combinedOf, setsOf } from './sets';
import { TOOLS, check } from './schema';
import { done, freshness, isJson, letter, ok, problems, roles, viewProblems, viewRoles, type Args, type Ctl, type Handler } from './tools/common';
import { DISPLAY_HANDLERS, display } from './tools/display';
import { MODEL_HANDLERS } from './tools/model';
import { REPORT_HANDLERS } from './tools/reports';
import { RESULT_HANDLERS } from './tools/results';
import { SETTINGS_HANDLERS, epwFile, fieldOf, pathOf, publicSettings, simMode } from './tools/settings';

export { UUID, appView, b64, done, stableKey, type AnalysisCtl, type Ctl } from './tools/common';
export { inShot, isStaging, shotSize, staged } from './tools/display';
export { roleActions } from './tools/model';
export { putReport, storedReport } from './tools/reports';
export { publicSettings, settingsActions } from './tools/settings';
export { bySide, difference, provenance, summaries } from './tools/stats';

// kit-ui's skills as its package ships them (from v0.2.1; none in an older one): the 'report' and 'kit-ui' topics
const SKILLS = import.meta.glob<string>('/node_modules/kit-ui/skills/*/*.md', { query: '?raw', import: 'default', eager: true, exhaustive: true });
const skill = (file: string) => Object.entries(SKILLS).find(([k]) => k.endsWith(`/skills/${file}`))?.[1];
const BUDGET = 42e3; // ms per call for App's async work; the bridge answers by 45 s whatever happens

/** One tool call, its budget ending at `end`: an unknown tool, bad arguments and a thrown error answer isError. */
async function invoke(name: string, args: Record<string, unknown>, c: () => Ctl, end: number): Promise<CallToolResult> {
  const tool = TOOLS.find((t) => t.name === name), handler = HANDLERS[name];
  if (!tool || !handler) return fail(`${name}: ${tool ? 'not available in this build yet' : `no such tool (${TOOLS.map((t) => t.name).join(', ')})`}`);
  const why = check(tool.inputSchema, args);
  if (why) return fail(why);
  try {
    return await handler(args, c, end);
  } catch (e) {
    return fail((e as Error).message);
  }
}

let gate: Promise<unknown> = Promise.resolve(); // a pickup on its way: calls wait for it
// said once, at the start of the next reply the agent gets: where it now works
let note = HEADLESS ? `Working in a hidden app instance; opening ${location.origin}/ in a browser shows this session. It started empty: the models, roles and results of an app tab closed earlier do not carry over, and its settings are its own (see app_state). ` : '';
/** One tool call from the bridge, once a pickup has ended (a pickup that outlasts the call's budget answers isError, and
 *  the call does not run); in the hidden instance a change is added to its session. */
async function call(name: string, args: Record<string, unknown>, c: () => Ctl): Promise<CallToolResult> {
  const end = Date.now() + BUDGET; // from receipt: the bridge's 45 s run from here too
  let timer: ReturnType<typeof setTimeout> | undefined;
  const picked = await Promise.race([gate.then(() => true), new Promise<boolean>((r) => { timer = setTimeout(() => r(false), end - 1e3 - Date.now()); })]);
  clearTimeout(timer);
  if (!picked) return fail(`${name}: the app is still taking over the hidden session; call app_state again in a moment`);
  const active = c().state.active, res = await invoke(name, args, c, end);
  if (HEADLESS) await record(name, args, res, active, c);
  if (!note || Date.now() > end + 2e3) return res; // past the bridge's 45 s nobody reads this reply: the next one says it
  const [first, ...rest] = res.content, said = note;
  note = '';
  return { ...res, content: first?.type === 'text' ? [{ type: 'text', text: said + first.text }, ...rest] : [{ type: 'text', text: said.trim() }, ...res.content] };
}
/** The tab's bridge, for App to start once: calls answered against its controller; a UI tab first picks up the hidden
 *  instance's session. */
export function connect(c: () => Ctl): () => void {
  if (!HEADLESS) pickup(c);
  return startBridge((name, args) => call(name, args, c));
}

/** app_state's viewAnalysis: its settings with the field each eye traces in numbers, per model its roles, run and
 *  result, the column and colouring, its problems. */
function viewState(x: Ctl) {
  const y = x.analysis('views');
  return {
    settings: x.state.settings.viewSim, field: fieldOf(x.state.settings.viewSim), column: y.shown, colourBy: y.colourBy, problems: viewProblems(x),
    models: y.models.map((m, i) => ({ model: letter(m.slot), meshes: viewRoles(m), run: m.run.status === 'error' ? 'failed' : m.run.status, ...(m.error ? { error: m.error } : {}), result: freshness(y, i) })),
  };
}

// ---------------------------------------------------------------------------------------------- the tools
// Read-only tools run at once, except that those reading the display (app_state, results, find_critical) wait their turn
// under exclusive(): a shot or a report's figures show a look of their own meanwhile (staged), and a client runs
// read-only tools in parallel. The others change state under exclusive(), and wait for App outside it.
export const HANDLERS: Record<string, Handler> = {
  async app_state(_a, c) {
    return exclusive(() => {
      const x = c(), s = x.state;
      return ok({
        tab: { kind: HEADLESS ? 'hidden' : 'UI', visible: document.visibilityState === 'visible', discarded: (document as Document & { wasDiscarded?: boolean }).wasDiscarded === true },
        models: s.models.map((m, i) => {
          const variants = chosenOf(x.variants(m.slot)); // the variant choices made since the file opened
          return {
            model: letter(m.slot), name: m.name || null, file: x.fileOf(m.slot) ?? null, ...(Object.keys(variants).length ? { variants } : {}),
            loading: !!x.panes[m.slot]?.loading, problems: x.panes[m.slot]?.loadError ?? null,
            meshes: roles(m), faces: m.objects.reduce((n, o) => n + o.tris, 0), run: m.run.status === 'error' ? 'failed' : m.run.status, ...(m.error ? { error: m.error } : {}), result: freshness(x, i),
            ...(x.panes[m.slot]?.meshes.size ? { view: x.viewer(m.slot).el.view } : {}), // its camera now, exact
          };
        }),
        display: display(x), subdivision: x.ui.subdiv, subdivisionOverride: x.ui.subdivOverride, settings: publicSettings(s.settings), problems: problems(x), views: x.views.map(({ name, view }) => ({ name, view })),
        reports: (x.reports ?? []).map((e) => ({ id: e.id, title: e.spec.title, models: e.spec.models.map((m) => m.model), updated: e.spec.updated, pdf: e.pdf, ...x.generation(e.id) })),
        viewAnalysis: viewState(x), sets: setsOf(x), combined: combinedOf(x),
      });
    });
  },

  async guide(a) {
    const ui = [skill('kit-ui/SKILL.md'), skill('kit-ui/reference.md')].filter(Boolean).join('\n\n---\n\n'), kr = skill('kit-report/SKILL.md');
    const text = a.topic === 'daylight' ? guide : a.topic === 'views' ? viewsGuide : a.topic === 'sets' ? setsGuide : a.topic === 'kit-ui' ? ui : kr
      ? `${reportGuide}\n\n---\n\nThe kit-ui kit-report skill, for reference: the app lays the report out and prints it (its sections 1, 3 and 4); its data rules (2) and read-back (5) apply to what you write.\n\n${kr}`
      : reportGuide;
    return text ? { content: [{ type: 'text', text }] } : fail("topic: 'kit-ui' is not in this build (its kit-ui package ships no skills); read 'daylight' or 'report'");
  },

  ...SETTINGS_HANDLERS,
  ...MODEL_HANDLERS,
  ...RESULT_HANDLERS,
  ...DISPLAY_HANDLERS,
  ...REPORT_HANDLERS,
  ...SET_HANDLERS,
};

// ---------------------------------------------------------------------------------------------- the hidden instance's session
/** What the hidden instance did, for a UI tab to pick up: its settings (serializeSettings; `epw`: the path of a weather
 *  file opened by path), its subdivision level and override (view preferences of its own browser profile that shape the
 *  meshes run), its state-changing calls in order, and whether a model had a result (or a run on its way), of each
 *  analysis. */
interface Session { settings: string; subdiv: number; subdivOverride?: boolean; epw?: string; steps: { name: string; arguments: Args }[]; ran: boolean; ranViews?: boolean }
const STEPS = new Set(['open_model', 'remove_model', 'set_roles', 'set_geometry', 'edit_material', 'set_visibility', 'set_display', 'set_camera', 'save_view', 'open_set']);
const steps: Session['steps'] = [];
const textOf = (r: CallToolResult) => r.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join(' ');

/** The hidden instance, after a call that changed something: a step kept so that it replays alike (the model it acted on
 *  named, as the active one may differ then; set_camera as the view it gave, as a frame fits this page's view and the
 *  app's has another shape; set_display's section as it gave it, boxes round prims as footprints), and the session sent
 *  (PUT /session) before the reply. */
async function record(name: string, args: Args, res: CallToolResult, active: number, c: () => Ctl): Promise<void> {
  const tool = TOOLS.find((t) => t.name === name);
  if (res.isError || !tool || tool.annotations?.readOnlyHint) return;
  if (name === 'copy_set') steps.push({ name: 'open_set', arguments: { id: (JSON.parse(textOf(res)) as { saved: { id: string } }).saved.id } }); // the copy is saved: the tab opens it, never copies it again
  else if (STEPS.has(name)) {
    const reply = JSON.parse(textOf(res)) as { model?: string; view?: unknown; section?: unknown };
    const model: string | undefined = name === 'open_model' ? reply.model : args.model ?? (tool.inputSchema.properties?.model ? letter(active) : undefined);
    steps.push({ name, arguments: { ...(name === 'set_camera' ? { view: reply.view } : args.section ? { ...args, section: reply.section } : args), ...(model ? { model } : {}) } });
  }
  const s = c().state, w = s.settings.weather, epw = w.source === 'upload' && w.file ? pathOf.get(w.file) : undefined, ran = (ms: typeof s.models) => ms.some((m) => m.result || inFlight(m.run));
  const session: Session = { settings: serializeSettings(s.settings), subdiv: c().ui.subdiv, subdivOverride: c().ui.subdivOverride, ...(epw ? { epw } : {}), steps, ran: ran(s.models), ranViews: ran(c().analysis('views').models) };
  await fetch('/session', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(session) }).catch(() => {});
}

/**
 * A UI tab, as its bridge starts: the hidden instance's session (GET /session), if there is one, done again here: its
 * settings (the View analysis' and the gradient library included) and subdivision level, its steps through the same
 * handlers (a failure skipped and noted), a run of each analysis that had results, and after that the column, colouring
 * and highlight its set_display steps gave, on the tab they gave them for (a run resets them; without a result the
 * colouring alone), then the tab it ended on. Then DELETE /session, also when there was none: it ends the hidden
 * instance (one that only answered questions leaves no session). Calls wait for it (gate): the next one sees the
 * picked-up app, and its reply says so.
 */
function pickup(c: () => Ctl): void {
  gate = gate.then(async () => {
    const r = await fetch('/session').catch(() => null);
    if (!r?.ok || r.headers.get('Content-Type')?.startsWith('text/html')) return; // no agent routes here (403, 404): a LAN tab, --mcp off, mock mode, a static host
    try {
      if (!isJson(r)) return; // 204: no session
      const rec = (await r.json()) as Session, p = parseSettings(rec.settings), failed: string[] = [], shown: Args = {};
      const loaded = () => done(() => !Object.values(c().panes).some((q) => q.loading), Date.now() + 120e3, 'the models');
      const step = async (name: string, args: Args) => {
        const res = await invoke(name, args, c, Date.now() + BUDGET);
        if (res.isError) failed.push(`${name}: ${textOf(res)}`);
        await loaded(); // a load that answered running
      };
      const file = rec.epw ? await epwFile(rec.epw).catch((e: Error) => { failed.push(e.message); return null; }) : null;
      flushSync(() => {
        const d = c().dispatch;
        d({ type: 'SITE', patch: p.site });
        d({ type: 'WEATHER', patch: { ...p.weather, file } }); // after SITE, which picks the station nearest the site
        d({ type: 'TIME', patch: p.time });
        d(simMode(p.sim.mode));
        d({ type: 'SIM', patch: p.sim });
        d({ type: 'VIEW_SIM', patch: p.viewSim });
        for (const key of Object.keys(c().state.settings.viz.library)) if (!(key in p.viz.library)) d({ type: 'GRADIENT', key, gradient: null });
        for (const [key, gradient] of Object.entries(p.viz.library)) d({ type: 'GRADIENT', key, gradient }); // before VIZ: a quantity's gradient may be one of them
        for (const quantity of QUANTITIES) {
          const g = p.viz.gradients[quantity], sc = p.viz.scales[quantity], rg = p.viz.ranges[quantity], sg = p.viz.scalings[quantity];
          d({ type: 'VIZ_RESET', quantity, what: 'scale' });
          d({ type: 'VIZ_RESET', quantity, what: 'range' });
          d({ type: 'VIZ', quantity, patch: { ...(g ? { gradient: g } : {}), ...(sg ? { scaling: sg } : {}), min: sc?.min ?? null, max: sc?.max ?? null, lo: rg?.lo ?? null, hi: rg?.hi ?? null, below: p.viz.colors.below, above: p.viz.colors.above } });
        }
        for (const ch of c().state.settings.charts) if (!p.charts.some((k) => k.id === ch.id)) d({ type: 'CHART', id: ch.id, remove: true });
        for (const spec of p.charts) d({ type: 'CHART', spec });
      });
      const want = rec.subdiv !== undefined ? needsLevel({ subdiv: rec.subdiv, subdivOverride: rec.subdivOverride }, { level: c().ui.subdiv, override: c().ui.subdivOverride }) : null;
      if (want) { // before the models open: they are read at it
        flushSync(() => c().onSubdiv(want.level, want.override));
        await loaded();
      }
      let tab: string | undefined; // the tab the last set_display that named one ended on
      for (const { name, arguments: args } of rec.steps) {
        if (name !== 'set_display') { await step(name, args); continue; }
        const { column, colourBy, highlight, ...rest } = args, later = Object.entries({ column, colourBy, highlight }).filter(([, v]) => v !== undefined);
        if (later.length) Object.assign(shown, Object.fromEntries(later), { analysis: args.analysis ?? tab ?? 'daylight' }); // the tab they were given for
        tab = args.analysis ?? tab;
        if (Object.keys(rest).length) await step(name, rest);
      }
      if (rec.ran) await step('run', {});
      if (rec.ranViews) await step('run', { analysis: 'views' });
      if (!(shown.analysis === 'views' ? rec.ranViews : shown.analysis === 'combined' || rec.ran)) { delete shown.column; delete shown.highlight; } // no result to show them on, as in the hidden instance
      if (Object.keys(shown).length > 1) await step('set_display', shown);
      if (tab && shown.analysis && tab !== shown.analysis) await step('set_display', { analysis: tab });
      note = `Now in the app open in the user's browser; picked up ${rec.steps.length} steps (failures: ${failed.join('; ') || 'none'}). `;
    } finally {
      await fetch('/session', { method: 'DELETE' }).catch(() => {});
    }
  }).catch(() => {});
}
