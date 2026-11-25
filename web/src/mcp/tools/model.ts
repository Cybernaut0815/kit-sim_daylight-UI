// The model tools, as the Model and Materials panels and the prim tree offer them: open and remove a model, browse its
// prims, set roles (either analysis'), visibility, variants and subdivision, and read or edit its Materials table.
import { flushSync } from 'react-dom';
import { DEFAULT_KEY, GLASS_KEY, PRESETS, editOptics, type Optics } from '../../lib/optics';
import { roundNum } from '../../lib/result';
import { idsUnder, primQuery, underIndex } from '../../lib/tree';
import type { Action, Model, Tool } from '../../store';
import { exclusive, fail } from '../bridge';
import { LETTERS, base, done, isJson, letter, loadedOf, local, modelOf, ok, opened, roles, viewRoles, type Args, type Ctl, type Handler } from './common';

/** A model's files by absolute path, as the Model panel's pickers give them: the files, or one folder's files fetched one
 *  after another, each with its path under the folder (the folder's name first), as a folder pick has it. */
async function modelFiles(paths: string[]): Promise<File[]> {
  const out: File[] = [];
  for (const [i, path] of paths.entries()) {
    const r = await local(path, `paths[${i}]`);
    if (!isJson(r)) { out.push(new File([await r.blob()], base(path))); continue; }
    if (paths.length > 1) throw new Error(`paths[${i}]: a folder; give one folder alone, or the model's files`);
    const { files } = (await r.json()) as { files: { path: string }[] };
    if (!files.length) throw new Error(`paths[0]: no model files in ${path}`);
    for (const f of files) {
      const file = new File([await (await local(`${path.replace(/[\\/]+$/, '')}/${f.path}`, 'paths[0]')).blob()], base(f.path));
      // ponytail: the folder layout rides on webkitRelativePath set on the File (what onFiles and loaders.ts read); hand
      // onFiles LocalFile paths if a browser ever refuses that
      out.push(Object.defineProperty(file, 'webkitRelativePath', { value: `${base(path)}/${f.path}` }));
    }
  }
  return out;
}

/** A roles entry (set_roles; save_set's roles, `at` its path) as the store's actions on model `m` in analysis `tool`:
 *  daylight's receiver, shade or none (shade: whether receivers cast shade); the view analysis' receiver, obstruction,
 *  target (a shade in target group `group`) or none. A role of the other analysis throws, naming its field. */
export function roleActions(m: Model, r: Args, tool: Tool, at = 'arguments'): Action[] {
  const field = (k: string) => (at === 'arguments' ? k : `${at}.${k}`), views = tool === 'views';
  if (!views && (r.role === 'obstruction' || r.role === 'target')) throw new Error(`${field('role')}: ${r.role} is a View analysis role (analysis 'views'); Daylight's are receiver, shade and none`);
  if (views && r.role === 'shade') throw new Error(`${field('role')}: the View analysis' roles are receiver, obstruction, target and none (a shade there is an obstruction)`);
  if (r.shade !== undefined && r.role !== 'receiver') throw new Error(`${field('shade')}: only with role 'receiver' (a shade always casts shade; role none leaves a mesh out)`);
  if (r.group !== undefined && r.role !== 'target') throw new Error(`${field('group')}: only with role 'target'`);
  if (r.role === 'target' && r.group === undefined) throw new Error(`${field('group')}: a target takes its group (the result's column, e.g. 'park' gives park_front)`);
  const ids = idsUnder(r.paths, views ? m.viewAnalysis.objects : m.objects), tag = views ? { tab: 'views' as const } : {}, role = r.role === 'obstruction' || r.role === 'target' ? 'shade' : r.role;
  return [{ type: 'ROLE', slot: m.slot, ids, role, ...(r.group !== undefined ? { group: r.group } : {}), ...tag }, ...(r.shade !== undefined ? [{ type: 'SHADE' as const, slot: m.slot, ids, shade: r.shade as boolean, ...tag }] : [])];
}
/** A Materials table row as get_materials and edit_material answer it. */
const materialRow = (material: string, p: Optics) => ({ material, kind: p.kind, rho: roundNum(p.rho), tau: roundNum(p.tau), source: p.source, ...(p.warning ? { warning: p.warning } : {}) });

export const MODEL_HANDLERS: Record<string, Handler> = {
  async open_model(a, c, end) {
    const files = await modelFiles(a.paths);
    const slot = await exclusive(() => {
      const x = c(), s = x.state, free = [0, 1, 2, 3].find((k) => !s.models.some((m) => m.slot === k));
      const empty = (k: number) => !s.models.find((m) => m.slot === k)?.objects.length && !x.panes[k]?.loading;
      const k = a.model === undefined ? (empty(s.active) ? s.active : free) : LETTERS.indexOf(a.model);
      if (k === undefined) throw new Error('model: four models are open; give model to replace one, or remove_model first');
      if (x.panes[k]?.loading) throw new Error(`model: model ${letter(k)} is loading; wait for it (app_state), or open into another slot`);
      if (!s.models.some((m) => m.slot === k)) {
        if (k !== free) throw new Error(`model: slot ${letter(k)} is not open; replace ${s.models.map((m) => letter(m.slot)).join(', ')}, or add ${letter(free!)} (or leave model out)`);
        flushSync(() => x.dispatch({ type: 'ADD' }));
      }
      opened.set(k, { paths: a.paths, stage: (x.panes[k]?.stage ?? 0) + 1 }); // the counter once this open has loaded
      flushSync(() => void c().onFiles(k, files));
      return k;
    });
    if (!(await done(() => !c().panes[slot]?.loading, end, 'the model to load'))) return ok({ model: letter(slot), status: 'running', note: 'still loading: call app_state until it has loaded (do not open it again)' });
    const x = c(), m = modelOf(x, letter(slot)), p = x.panes[slot], { el } = x.viewer(slot), o = opened.get(slot);
    if (o && o.stage === p?.stage) o.name = m.name;
    if (!m.objects.length) return fail(`paths: ${p?.loadError ?? 'no meshes in this model'}`);
    const top = await el.usd.children('/');
    return ok({
      model: letter(slot), name: m.name, metersPerUnit: el.stage?.metersPerUnit ?? 1, upAxis: el.stage?.upAxis, meshes: roles(m), faces: m.objects.reduce((n, o) => n + o.tris, 0),
      top: top.slice(0, 20).map((t) => t.path), ...(top.length > 20 ? { moreTop: top.length - 20 } : {}), problems: p?.loadError ?? null,
    });
  },

  async remove_model(a, c) {
    return exclusive(() => {
      const x = c(), m = modelOf(x, a.model);
      if (x.state.models.length === 1) throw new Error('model: the last model cannot be removed; open another model into it with open_model');
      if (Object.values(x.panes).some((p) => p.loading)) throw new Error('model: a model is loading; try again once it has loaded (app_state)');
      flushSync(() => x.onRemove(m.slot));
      opened.delete(m.slot);
      return ok({ removed: a.model, models: c().state.models.map((k) => letter(k.slot)), active: letter(c().state.active) });
    });
  },

  async model_tree(a, c) {
    const m = loadedOf(c(), a.model), L = letter(m.slot), { el } = c().viewer(m.slot), limit: number = a.limit ?? 100;
    if (a.query !== undefined) {
      const found = await el.usd.find(...primQuery(a.query), limit + 1);
      return ok({ model: L, query: a.query, prims: found.slice(0, limit), ...(found.length > limit ? { more: true } : {}) });
    }
    const root: string = a.path ?? '/';
    if (root !== '/' && !(await el.usd.prim(root).catch(() => null))) throw new Error(`path: no prim ${root} in model ${L}; list from '/', or search with query`);
    const under = underIndex(m.objects), byId = new Map(m.objects.map((o) => [o.id, o])), names = c().panes[m.slot]?.names, out: object[] = [];
    let level = [root], more = false;
    for (let d = 0; d < (a.depth ?? 2) && level.length && !more; d++) { // level by level: the top of the tree first
      const next: string[] = [];
      for (const p of level) {
        for (const s of await el.usd.children(p)) {
          if (out.length >= limit) { more = true; break; }
          const rows = (under.get(s.path) ?? []).map((id) => byId.get(id)!), first = rows[0]?.role, free = rows.filter((o) => o.shade === false).length;
          out.push({
            path: s.path, name: names?.get(s.path) ?? s.name, type: s.typeName, children: s.hasChildren,
            ...(rows.length ? { meshes: rows.length, triangles: rows.reduce((n, o) => n + o.tris, 0), role: rows.every((o) => o.role === first) ? first : 'mixed' } : {}),
            ...(free ? { shade: free === rows.filter((o) => o.role === 'receiver').length ? false : 'mixed' } : {}), // its receivers cast no shade (some: mixed)
            visible: s.visible, locked: el.session.isLocked(s.path),
            ...(s.hasVariantSets ? { variants: ((await el.usd.prim(s.path).catch(() => null))?.variantSets ?? []).map((v) => ({ set: v.name, values: v.variants, selected: v.selection })) } : {}),
          });
          if (s.hasChildren) next.push(s.path);
        }
        if (more) break;
      }
      level = next;
    }
    return ok({ model: L, path: root, prims: out, ...(more ? { more: true } : {}) });
  },

  async set_roles(a, c) {
    const tool: Tool = a.analysis ?? 'daylight', views = tool === 'views', rowsOf = (k: Model) => (views ? k.viewAnalysis.objects : k.objects);
    if (a.paths === undefined) {
      if (!a.reset) throw new Error('paths: required (or reset: true alone)');
      const k = ['role', 'group', 'shade'].find((f) => a[f] !== undefined);
      if (k) throw new Error(`${k}: goes with paths`);
    } else if (a.role === undefined) throw new Error('role: required with paths');
    return exclusive(() => {
      const m = loadedOf(c(), a.model), L = letter(m.slot), was = new Map(rowsOf(m).map((o) => [o.id, o]));
      const actions: Action[] = a.paths ? roleActions(m, a, tool) : [], ids = a.paths ? idsUnder(a.paths, rowsOf(m)) : []; // checked before anything changes
      flushSync(() => {
        if (a.reset) c().dispatch({ type: 'ROLES_RESET', slot: m.slot, ...(views ? { tab: 'views' as const } : {}) });
        for (const action of actions) c().dispatch(action);
      });
      const now = modelOf(c(), L), rows = rowsOf(now), changed = rows.filter((o) => { const w = was.get(o.id); return w?.role !== o.role || w?.shade !== o.shade || w?.group !== o.group; }).map((o) => o.path);
      const hit = new Set(ids), instanced = a.role === 'receiver' ? rows.filter((o) => hit.has(o.id) && o.instances).length : 0;
      const selfOcclude = views ? c().state.settings.viewSim.selfOcclude : c().state.settings.sim.selfOcclude, block = views ? 'view' : 'sim';
      const notes = [instanced ? 'instanced meshes can only shade or be ignored' : '', a.shade === false && !selfOcclude ? `no receiver casts shade while ${block}.selfOcclude is off: shade false counts once it is on` : ''].filter(Boolean);
      return ok({
        model: L, ...(views ? { analysis: tool } : {}), ...(a.reset ? { reset: true } : {}), meshes: views ? viewRoles(now.viewAnalysis) : roles(now), changed: changed.slice(0, 50), ...(changed.length > 50 ? { moreChanged: changed.length - 50 } : {}),
        unmatched: ((a.paths ?? []) as string[]).filter((p) => !idsUnder([p], rowsOf(m)).length), ...(instanced ? { instanced } : {}), ...(notes.length ? { note: notes.join('; ') } : {}),
      });
    });
  },

  async set_visibility(a, c) {
    return exclusive(async () => {
      const m = loadedOf(c(), a.model), L = letter(m.slot), { el } = c().viewer(m.slot), roots = (await el.usd.children('/')).map((s) => s.path);
      const [hide, show, isolate, lock, unlock, select] = await Promise.all(['hide', 'show', 'isolate', 'lock', 'unlock', 'select'].map(async (k) => {
        const out: string[] = []; // '/': every top prim
        for (const [i, p] of ((a[k] ?? []) as string[]).entries()) {
          if (p === '/') out.push(...roots);
          else if (await el.usd.prim(p).catch(() => null)) out.push(p);
          else throw new Error(`${k}[${i}]: no prim ${p} in model ${L}; find it with model_tree`);
        }
        return out;
      }));
      if (a.showAll) await el.usd.showAll();
      if (hide.length) await el.usd.hide(hide);
      for (const p of show) await el.usd.setVisible(p, true);
      if (isolate.length) await el.usd.isolate(isolate);
      for (const p of lock) el.session.setLocked(p, true);
      for (const p of unlock) el.session.setLocked(p, false);
      if (a.select) flushSync(() => el.select(select)); // the viewer's selectionchange -> SELECTION, in this commit
      // hidden: the highest prims with meshes under them that are not shown, as the tree's eyes show them (the drawn objects
      // cannot tell: a hidden instancer's is rebuilt with no instances)
      // ponytail: one children() call per shown prim above a mesh; ask the core for the hidden prims if huge stages make it slow
      const under = underIndex(modelOf(c(), L).objects), hidden: string[] = [];
      for (let level = ['/']; level.length;) {
        const next: string[] = [];
        for (const p of level) {
          for (const s of await el.usd.children(p)) {
            if (!under.has(s.path)) continue; // no mesh at or under it
            if (!s.visible) hidden.push(s.path);
            else if (s.hasChildren) next.push(s.path);
          }
        }
        level = next;
      }
      return ok({ model: L, hidden, locked: [...el.session.locked], selected: [...el.selection] });
    });
  },

  async set_geometry(a, c, end) {
    const m = loadedOf(c(), a.model), slot = m.slot, L = letter(slot), running = { model: L, status: 'running', note: 'still re-reading: call app_state until it has loaded' };
    if (!a.variant && !a.subdivision) throw new Error('variant: give variant or subdivision');
    if (a.variant) {
      const { path, set, value } = a.variant, sets = (await c().viewer(slot).el.usd.prim(path).catch(() => null))?.variantSets, vs = sets?.find((v) => v.name === set);
      if (!sets) throw new Error(`variant.path: no prim ${path} in model ${L}; find it with model_tree`);
      if (!vs) throw new Error(`variant.set: ${path} has no variant set '${set}'${sets.length ? ` (${sets.map((v) => v.name).join(', ')})` : ''}`);
      if (!vs.variants.includes(value)) throw new Error(`variant.value: '${value}' is not in set '${set}' (${vs.variants.join(', ')})`);
      await exclusive(() => flushSync(() => c().onVariant(slot, path, set, value)));
      if (!(await done(() => !c().panes[slot]?.loading, end, 'the re-read'))) return ok(running);
    }
    if (a.subdivision) {
      const { level, paths } = a.subdivision;
      if (paths) {
        if (level === -1) throw new Error("subdivision.level: -1 applies to every model; with paths give 0 to 3 or 'model'");
        const now = modelOf(c(), L), ids = new Set(idsUnder(paths, now.objects)), meshes = now.objects.filter((o) => ids.has(o.id) && !o.instances).map((o) => o.path);
        if (!meshes.length) throw new Error('subdivision.paths: no meshes under them (instanced meshes do not refine)');
        await exclusive(() => flushSync(() => c().onRefine(slot, meshes, level === 'model' ? null : level)));
      } else {
        if (level === 'model') throw new Error("subdivision.level: 'model' needs paths");
        await exclusive(() => flushSync(() => c().onSubdiv(level)));
      }
      if (!(await done(() => !Object.values(c().panes).some((p) => p.loading), end, 'the re-read'))) return ok(running);
    }
    const x = c(), now = modelOf(x, L);
    return ok({ model: L, meshes: roles(now), subdivision: x.ui.subdiv, problems: x.panes[slot]?.loadError ?? null, note: 'results cleared: run' });
  },

  async get_materials(a, c) {
    const x = c(), m = modelOf(x, a.model), o = x.optics[x.state.models.indexOf(m)], { mode, transmission, bounces } = x.state.settings.sim;
    return ok({
      model: letter(m.slot), counts: { tau: mode === 'physical' && transmission, rho: mode === 'physical' && bounces > 0 }, reading: !x.materialsReady,
      rows: [materialRow(DEFAULT_KEY, o.fallback), materialRow(GLASS_KEY, o.glass), ...o.materials.map((r) => materialRow(r.path, r.optics))],
      presets: PRESETS.map(({ name, kind, rho, tau }) => ({ name, kind, rho, tau })),
    });
  },

  async edit_material(a, c) {
    return exclusive(() => {
      const x = c(), m = modelOf(x, a.model), L = letter(m.slot), key: string | undefined = a.material, values = a.kind !== undefined || a.rho !== undefined || a.tau !== undefined;
      if (key === undefined) { // reset alone: every edit of the model, as reopening it would
        if (!a.reset || a.preset !== undefined || values) throw new Error('material: required, unless reset alone resets every edit of the model');
        const edits = Object.keys(m.optics).length;
        flushSync(() => x.dispatch({ type: 'OPTICS_RESET', slot: m.slot }));
        return ok({ model: L, reset: edits, note: edits ? `${edits} edited row${edits > 1 ? 's' : ''} back to the derived or default values` : 'no row was edited' });
      }
      const rowOf = (y: Ctl) => { const o = y.optics[y.state.models.findIndex((k) => k.slot === m.slot)]; return key === DEFAULT_KEY ? o.fallback : key === GLASS_KEY ? o.glass : o.materials.find((r) => r.path === key)?.optics; };
      const cur = rowOf(x), o = x.optics[x.state.models.indexOf(m)];
      if (!cur) throw new Error(`material: no material ${key} on model ${L}'s receivers or shades; see get_materials`);
      if ([a.reset === true, a.preset !== undefined, values].filter(Boolean).length !== 1) throw new Error('preset: give one of reset, a preset, or kind, rho and/or tau');
      const p = a.preset !== undefined && PRESETS.find((q) => q.name.toLowerCase() === a.preset.toLowerCase());
      if (p === undefined) throw new Error(`preset: no preset '${a.preset}' (${PRESETS.map((q) => q.name).join(', ')})`);
      flushSync(() => x.dispatch(a.reset ? { type: 'OPTICS_RESET', slot: m.slot, key }
        : { type: 'OPTICS_EDIT', slot: m.slot, key, edit: p ? { rho: p.rho, tau: p.tau, kind: p.kind } : editOptics(cur, { kind: a.kind, rho: a.rho, tau: a.tau }, o.fallback, o.glass) }));
      return ok({ model: L, ...materialRow(key, rowOf(c())!) });
    });
  },
};
