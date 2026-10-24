// Optics per face slot from the model's materials, and the run's --transmission / --fresnel / --optics flags. The core
// takes numbers only: the kind (opaque / glass / porous) comes from a UsdPreviewSurface's own settings (never its name),
// classified glass gets the default glass's transmittance (render opacity is a display choice: SketchUp glass d 0.75,
// Revit d 0.25), the user can override, and every value is brought into the core's ranges first, so one value never
// fails a run. rho = the fraction reflected diffusely, tau = the fraction transmitted straight at normal incidence,
// rho + tau <= 1. Glass is Radiance glass (n 1.52; rho 0, it reflects by angle); porous passes tau at every angle, its
// rho = the solid part's albedo x (1 - tau).
import type { MaterialNetwork } from 'usd-viewer';
import type { ObjectRow, Role, SimMode } from '../store';

export interface Optics {
  rho: number; tau: number; kind: 'opaque' | 'glass' | 'porous';
  source: 'derived' | 'default' | 'edited'; // the material's settings, the default material, or the user's edit
  warning?: string; // what clamp() changed
}
/** No material, or an albedo the material does not give: Honeybee generic_context_0.20, BRE GN50 Table 2 (obstructions
 *  and ground 0.2), the core's --ground 0.2. */
export const DEFAULT_OPTICS: Optics = { rho: 0.2, tau: 0, kind: 'opaque', source: 'default' };
/** Glass without numbers: Honeybee generic_exterior_window_vis_0.64, double low-e (Radiance tn 0.6976). One band: the
 *  same unit passes 0.37 of solar energy. */
export const DEFAULT_GLASS: Optics = { rho: 0, tau: 0.64, kind: 'glass', source: 'default' };

/** A preset: absolute, aged values (glass tau at normal incidence); `source`: where the numbers come from (a tooltip). */
export interface Preset { name: string; rho: number; tau: number; kind: Optics['kind']; source: string }
export const PRESETS: Preset[] = ([
  ['Asphalt', 0.12, 0, 'opaque', 'pvlib 0.12; EPA Cool Pavements: aged 0.15-0.20, new 0.05'],
  ['Concrete / pavers', 0.3, 0, 'opaque', 'pvlib and CIBSE 0.30; EPA Cool Pavements: 0.25 after 5 years, new 0.40'],
  ['Brick', 0.3, 0, 'opaque', 'Oke 1987 and CIBSE: 0.20-0.40'],
  ['Light stone', 0.35, 0, 'opaque', 'Oke 1987: stone 0.20-0.35; NYC ZR 81-276: light limestone 0.45 (clean, visible)'],
  ['White render', 0.6, 0, 'opaque', 'BRE GN50 Table 1: white paint outdoors at most 0.6; Oke 1987: 0.50-0.90'],
  ['Dark roof', 0.1, 0, 'opaque', 'EPA Cool Roofs, CARB: dark membranes, bitumen, shingles 0.05-0.20'],
  ['White roof', 0.6, 0, 'opaque', 'Aged white membrane; EPA, CARB: 0.70-0.85 when new'],
  ['Roof tiles', 0.25, 0, 'opaque', 'EPA Cool Roofs: tiles 0.10-0.30; PVsyst: red tiles 0.33'],
  ['Light metal', 0.45, 0, 'opaque', 'CARB: unpainted metal 0.30-0.50; NYC ZR 81-276: aluminium paint 0.55 (specular in reality)'],
  ['Dark metal', 0.1, 0, 'opaque', 'CARB: dark-painted metal 0.05-0.10'],
  ['Grass', 0.2, 0, 'opaque', 'pvlib 0.20, CIBSE 0.25 (solar; visible about 0.1)'],
  ['Soil', 0.15, 0, 'opaque', 'pvlib 0.17; DOE-2: dark soil 0.08'],
  ['Water', 0.07, 0, 'opaque', 'pvlib: sea 0.06; Penn State EARTH 103: 0.06-0.10'],
  ['Snow', 0.8, 0, 'opaque', 'CIBSE: fresh 0.8-0.9, old 0.45-0.7; pvlib: fresh 0.75'],
  ['Single clear', 0, 0.87, 'glass', 'EN 410, 4 mm clear float (Saint-Gobain PLANICLEAR): 0.87 solar, 0.91 visible'],
  ['Double clear', 0, 0.76, 'glass', 'Two 4 mm clear panes (PLANICLEAR): about 0.76 solar, 0.82 visible'],
  ['Double low-e', 0, 0.64, 'glass', 'Honeybee generic_exterior_window_vis_0.64 (visible; 0.37 solar)'],
  ['Solar control', 0, 0.35, 'glass', 'EN 410, Saint-Gobain SKN 176: 0.35 solar, 0.70 visible'],
  ['Deciduous tree, in leaf', 0.1, 0.32, 'porous', 'Crown 0.10 (Larsson 2011: 0.05-0.15), crossed twice: sqrt(0.10) per surface; leaves 0.15 x (1 - tau)'],
  ['Deciduous tree, leafless', 0.04, 0.71, 'porous', 'Crown 0.50 (Larsson 2011: 0.50-0.55), crossed twice: sqrt(0.50) per surface; 0.15 x (1 - tau)'],
  ['Perforated metal, 40 % open', 0.24, 0.4, 'porous', 'The open area, an upper bound (Bustamante et al. 2018 measured 0.29 of the light); metal 0.40 x (1 - tau)'],
  ['Fabric mesh, light', 0.51, 0.14, 'porous', 'Serge Ferrari Soltis 86 (EN 14501): openness 0.14, light colours 0.59 x (1 - tau)'],
  ['Fabric mesh, dark', 0.04, 0.14, 'porous', 'Serge Ferrari Soltis 86 (EN 14501): openness 0.14, black 0.05 x (1 - tau)'],
  ['Opening (no glazing)', 0, 1, 'porous', 'Everything passes, so sun hours stay exact through it: EN 17037 / BRE window checks leave the glazing out'],
] satisfies [string, number, number, Optics['kind'], string][]).map(([name, rho, tau, kind, source]) => ({ name, rho, tau, kind, source }));

/**
 * Optics within the core's ranges, every fix named in `warning` (an earlier warning is dropped): values to 0..1; glass
 * rho 0; glass tau <= 0 -> opaque; glass tau > 0.918 (the most n 1.52 passes) -> 0.918; rho + tau > 1 -> rho = 1 - tau.
 * Opaque passes nothing: its tau is 0.
 */
export function clamp({ rho, tau, kind, source }: Optics): Optics {
  const w: string[] = [], unit = (x: number) => (x >= 0 ? Math.min(x, 1) : 0); // NaN -> 0
  if (unit(rho) !== rho || unit(tau) !== tau) {
    w.push('Reflectance and transmittance are fractions of the light: limited to 0..1.');
    rho = unit(rho);
    tau = unit(tau);
  }
  if (kind === 'glass' && rho > 0) { w.push('Glass reflects by angle, not diffusely: reflectance 0.'); rho = 0; }
  if (kind === 'glass' && tau <= 0) { w.push('Glass that passes no light is opaque.'); kind = 'opaque'; }
  if (kind === 'glass' && tau > 0.918) { w.push('Glass (refractive index 1.52) passes at most 0.918: transmittance 0.918.'); tau = 0.918; }
  if (kind === 'opaque') tau = 0;
  if (rho + tau > 1) { w.push('Reflectance and transmittance add up to more than 1: reflectance lowered to 1 - transmittance.'); rho = 1 - tau; }
  return w.length ? { rho, tau, kind, source, warning: w.join(' ') } : { rho, tau, kind, source };
}

/** How a texture gives the surface's opacity: each texel's `channel` / 255 x scale + bias, cut at `threshold` (0: none). */
export interface OpacityRead { channel: 'r' | 'g' | 'b' | 'a'; scale: number; bias: number; threshold: number }
/** What derive() takes from a decoded texture. Colours are linear r, g, b. */
export interface TextureStats {
  mean: number[]; // every texel alike
  covered: number[]; // weighted by each texel's coverage: the colour of the solid part (phase 2: a porous albedo)
  coverage: number; // the share of texels at or above the threshold, else the mean opacity; 1 without an opacity read
  range: number; // max - min of the texels' opacity; 0 without an opacity read
}

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const LUT = Float64Array.from({ length: 256 }, (_, i) => { const c = i / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }); // sRGB -> linear

/**
 * Statistics of an RGBA8 image (getImageData, not premultiplied): plain and coverage-weighted mean colour, and with an
 * opacity read its coverage and range, each texel's opacity clamped to 0..1 as a renderer does.
 * ponytail: the opacity channel is read raw (alpha always is; a grey mask tagged sRGB reads a little high); every texel
 * weighs the same, as if the UVs covered the surface uniformly
 */
export function textureStats(rgba: ArrayLike<number>, w: number, h: number, opacity?: OpacityRead): TextureStats {
  const n = w * h, ch = opacity ? 'rgba'.indexOf(opacity.channel) : 0, mean = [0, 0, 0], covered = [0, 0, 0];
  let cover = 0, lo = 1, hi = 0;
  for (let i = 0; i < 4 * n; i += 4) {
    let c = 1;
    if (opacity) {
      const o = Math.min(1, Math.max(0, (rgba[i + ch] / 255) * opacity.scale + opacity.bias));
      lo = Math.min(lo, o);
      hi = Math.max(hi, o);
      c = opacity.threshold > 0 ? +(o >= opacity.threshold) : o;
    }
    cover += c;
    for (let k = 0; k < 3; k++) { const v = LUT[rgba[i + k]]; mean[k] += v; covered[k] += c * v; }
  }
  const avg = mean.map((v) => v / Math.max(n, 1));
  return { mean: avg, covered: cover > 0 ? covered.map((v) => v / cover) : avg, coverage: n ? cover / n : 1, range: opacity && n ? hi - lo : 0 };
}

/** The texture a UsdPreviewSurface's opacity reads (a UsdUVTexture with a resolved file), through the output its
 *  connection names (r for a grey map_d, a for an alpha), with that channel's scale and bias. */
function opacityRead(net: MaterialNetwork): { file: string; opacity: OpacityRead } | null {
  const s = net.nodes[net.surface], link = s?.type === 'UsdPreviewSurface' ? s.inputs.opacity : undefined, t = link && net.nodes[link.node];
  const file = t?.type === 'UsdUVTexture' ? (t.params.file as { resolved?: unknown } | null)?.resolved : undefined;
  if (!link || !t || typeof file !== 'string' || !file) return null;
  const channel = (/^[rgba]$/.test(link.output) ? link.output : 'r') as OpacityRead['channel'], k = 'rgba'.indexOf(channel);
  const at = (v: unknown, d: number) => num(Array.isArray(v) ? v[k] : v, d);
  return { file, opacity: { channel, scale: at(t.params.scale, 1), bias: at(t.params.bias, 0), threshold: num(s.params.opacityThreshold, 0) } };
}

/** A texture derive() reads, and its key among the decoded ones: the file and how it is read. */
export interface TextureRead { file: string; opacity?: OpacityRead }
export const readKey = (r: TextureRead) => JSON.stringify([r.file, r.opacity ?? null]);

/** The textures derive() reads from a material's network: decode each file and keep textureStats(rgba, w, h, opacity)
 *  under it, or null when it cannot be read or decoded (readBytes null, EXR / HDR, a decode error). Per material: another
 *  material may read the same file with another scale or threshold. */
export function textureReads(net: MaterialNetwork | undefined): TextureRead[] {
  const r = net && opacityRead(net);
  return r ? [r] : []; // phase 2: + the diffuse texture (with this opacity read when it is the same file)
}

/**
 * A material's optics from its UsdPreviewSurface network (the viewer's material delta). `stats`: textureStats under each
 * file textureReads() names; a missing or null one counts as absent (the constants decide, else UsdPreviewSurface's
 * opacity 1). `fallback`: the default material (also the albedo the material does not give); `glass`: the default glass.
 * - opacity: the constant, or the texture's mean (channel x scale + bias).
 * - kind: porous when cut out (opacityThreshold > 0), in presence mode, or when the opacity texture varies by more than
 *   0.1; else glass below opacity 0.98, unless metallic is 1 (a cut-out metal sheet is still porous); else opaque.
 * - tau: porous 1 - coverage (a constant with a threshold: 1 below it, else 0); glass the default glass's; opaque 0.
 */
export function derive(net: MaterialNetwork | undefined, stats: ReadonlyMap<string, TextureStats | null> = new Map(), fallback = DEFAULT_OPTICS, glass = DEFAULT_GLASS): Optics {
  const s = net && net.nodes[net.surface];
  // ponytail: UsdPreviewSurface only, a MaterialX / OpenPBR surface reads as the default material; read them when models bring them
  if (!net || s?.type !== 'UsdPreviewSurface') return { rho: fallback.rho, tau: fallback.tau, kind: fallback.kind, source: 'default' };
  const p = s.params, read = opacityRead(net), t = read ? stats.get(read.file) : null;
  const threshold = num(p.opacityThreshold, 0), opacity = num(p.opacity, 1);
  const albedo = fallback.rho; // phase 2: Y(diffuseColor, or its texture's stats x scale + bias), Radiance weights, 0.02..0.9
  if (threshold > 0 || p.opacityMode === 'presence' || (t && t.range > 0.1)) {
    const tau = t ? 1 - t.coverage : threshold > 0 ? +(opacity < threshold) : 1 - opacity;
    return clamp({ rho: albedo * (1 - tau), tau, kind: 'porous', source: 'derived' });
  }
  if ((t ? t.coverage : opacity) < 0.98 && !(num(p.metallic, 0) >= 1)) return clamp({ ...glass, source: 'derived' });
  return clamp({ rho: albedo, tau: 0, kind: 'opaque', source: 'derived' });
}

/** A mesh of the run: `id` is its core name (the App names run meshes by their ids); `optics[k]` is face slot k's, for
 *  every slot up to its highest face slot (the core refuses a slot past it). */
export interface RunMesh { id: string; role: Role; optics: readonly Optics[] }

/** A Materials-table edit, by key: a material's prim path, or a default row's DEFAULT_KEY / GLASS_KEY (no '/'). */
export type OpticsEdit = Pick<Optics, 'rho' | 'tau' | 'kind'>;
export const DEFAULT_KEY = 'default', GLASS_KEY = 'glass';

/**
 * The run's meshes for opticsArgs() (receivers and shades: an Ignore row is left out, its materials never read), the
 * default material, and the texture reads still to decode. A face slot's material (`materials` by the viewer's rid; 0 or
 * a rid without an entry = none) takes its edit, else derive() over the textures decoded so far (`stats` by readKey,
 * null = unreadable), else the default material; the default rows take their edits too.
 */
export function resolveOptics(
  rows: readonly Pick<ObjectRow, 'id' | 'role' | 'materials'>[], materials: ReadonlyMap<number, { path: string; network?: MaterialNetwork }>,
  stats: ReadonlyMap<string, TextureStats | null>, edits: Readonly<Record<string, OpticsEdit>>,
): { meshes: RunMesh[]; fallback: Optics; unread: TextureRead[] } {
  const edited = (key: string): Optics | undefined => { const e: OpticsEdit | undefined = edits[key]; return e && clamp({ ...e, source: 'edited' }); };
  const fallback = edited(DEFAULT_KEY) ?? DEFAULT_OPTICS, glass = edited(GLASS_KEY) ?? DEFAULT_GLASS, unread = new Map<string, TextureRead>();
  const slot = (rid: number): Optics => {
    const m = materials.get(rid);
    if (!m) return fallback;
    const reads = textureReads(m.network);
    for (const r of reads) if (!stats.has(readKey(r))) unread.set(readKey(r), r);
    return edited(m.path) ?? derive(m.network, new Map(reads.map((r) => [r.file, stats.get(readKey(r)) ?? null])), fallback, glass);
  };
  const meshes = rows.filter((o) => o.role !== 'none').map((o) => ({ id: o.id, role: o.role, optics: (o.materials ?? [0]).map(slot) }));
  return { meshes, fallback, unread: [...unread.values()] };
}

/**
 * The optics flags of a run, physical mode only (Ladybug: every surface opaque and black): --transmission on and
 * --fresnel off when not the default, and with transmission (or reflections) the packed --optics token
 * `*=V;ID/SLOT=V;...` with V = RHO,TAU,KIND (RHO,0 when nothing passes), every value clamped first: `*` (the default
 * material) only when it differs from the built-in default, a slot only when it differs from `*`. RHO counts only with
 * reflections (0 without), so a reflectance change alone never changes the request. Ignore meshes are never named: the
 * core would not know them.
 */
export function opticsArgs(meshes: readonly RunMesh[], fallback: Optics, sim: { mode: SimMode; transmission: boolean; fresnel: boolean; bounces?: number }): string[] {
  const a: string[] = [], bounces = sim.bounces ?? 0;
  if (sim.mode !== 'physical') return a;
  if (sim.transmission) a.push('--transmission', 'on');
  if (sim.transmission && !sim.fresnel) a.push('--fresnel', 'off');
  if (!sim.transmission && !bounces) return a; // every surface opaque: the numbers are not used
  const val = (o: Optics) => { const c = clamp(o), rho = bounces ? c.rho : 0; return c.tau > 0 ? `${rho},${c.tau},${c.kind}` : `${rho},0`; };
  const all = val(fallback), specs = all === val(DEFAULT_OPTICS) ? [] : [`*=${all}`];
  for (const m of meshes) {
    if (m.role !== 'none') m.optics.forEach((o, k) => { const v = val(o); if (v !== all) specs.push(`${m.id}/${k}=${v}`); });
  }
  if (specs.length) a.push('--optics', specs.join(';'));
  return a;
}
