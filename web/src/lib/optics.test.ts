import { describe, expect, it } from 'vitest';
import type { MaterialNetwork, MaterialNode } from 'usd-viewer';
import type { ObjectRow } from '../store';
import { DEFAULT_GLASS, DEFAULT_KEY, DEFAULT_OPTICS, GLASS_KEY, PRESETS, clamp, derive, opticsArgs, readKey, resolveOptics, textureReads, textureStats, type Optics, type RunMesh } from './optics';

// Networks as the viewer hands them over for what usda.ts writes: a Surface, its textures read through st.
const surface = (params: MaterialNode['params'], inputs: MaterialNode['inputs'] = {}, nodes: MaterialNetwork['nodes'] = {}): MaterialNetwork =>
  ({ surface: 'Surface', nodes: { Surface: { type: 'UsdPreviewSurface', params, inputs }, ...nodes } });
const texture = (name: string, scale: number[], resolved = `/drop/1/textures/${name}.png`): MaterialNode => ({
  type: 'UsdUVTexture', inputs: { st: { node: 'St', output: 'result' } },
  params: { file: { asset: `./textures/${name}.png`, resolved }, sourceColorSpace: name === 'leaf' ? 'raw' : 'sRGB', scale },
});
const texels = (...t: number[][]) => Uint8ClampedArray.from(t.flat()); // RGBA8, one row
/** derive() as the App runs it: every texture textureReads() names decoded (here: `px`) into its textureStats. */
const run = (net: MaterialNetwork, px: Uint8ClampedArray, glass = DEFAULT_GLASS) =>
  derive(net, new Map(textureReads(net).map((r) => [r.file, textureStats(px, px.length / 4, 1, r.opacity)])), DEFAULT_OPTICS, glass);

describe('derive', () => {
  it('reads a grey map_d through r: a cut-out tree with a varying mask is porous, tau = 1 - its mean opacity', () => {
    const net = surface({ diffuseColor: [0.2, 0.4, 0.1], metallic: 0 }, { opacity: { node: 'Opacity', output: 'r' } }, { Opacity: texture('leaf', [1, 1, 1, 1]) });
    expect(textureReads(net)).toEqual([{ file: '/drop/1/textures/leaf.png', opacity: { channel: 'r', scale: 1, bias: 0, threshold: 0 } }]);
    expect(run(net, texels([255, 255, 255, 255], [255, 255, 255, 255], [0, 0, 0, 255], [0, 0, 0, 255]))).toEqual({ rho: 0.1, tau: 0.5, kind: 'porous', source: 'derived' });
  });
  it('reads an RGBA cut-out through a with its scale: with a threshold, tau is the share of texels below it', () => {
    const net = surface({ opacityThreshold: 0.5 }, { diffuseColor: { node: 'BaseColor', output: 'rgb' }, opacity: { node: 'BaseColor', output: 'a' } }, { BaseColor: texture('leaves', [1, 1, 1, 0.9]) });
    expect(textureReads(net)[0].opacity).toEqual({ channel: 'a', scale: 0.9, bias: 0, threshold: 0.5 });
    // alphas 1, 0.78, 0.39, 0 x 0.9: two at or above 0.5
    expect(run(net, texels([40, 90, 20, 255], [40, 90, 20, 200], [0, 0, 0, 100], [0, 0, 0, 0]))).toEqual({ rho: 0.1, tau: 0.5, kind: 'porous', source: 'derived' });
  });
  it('a constant opacity with a threshold is open below it and closed at or above it', () => {
    expect(derive(surface({ opacity: 0.3, opacityThreshold: 0.5 }))).toEqual({ rho: 0, tau: 1, kind: 'porous', source: 'derived' });
    expect(derive(surface({ opacity: 0.5, opacityThreshold: 0.5 })).tau).toBe(0); // at the threshold: drawn
    expect(derive(surface({ opacityThreshold: 0.5 }))).toEqual({ rho: 0.2, tau: 0, kind: 'porous', source: 'derived' }); // glTF MASK, alpha 1
  });
  it('presence mode is porous, tau = 1 - opacity', () => {
    const o = derive(surface({ opacity: 0.7, opacityMode: 'presence' }));
    expect(o.kind).toBe('porous');
    expect(o.tau).toBeCloseTo(0.3, 12);
  });
  it('textured glass of one alpha below 0.98 gets the default glass (or the edited one), never 1 - opacity', () => {
    const net = surface({}, { diffuseColor: { node: 'BaseColor', output: 'rgb' }, opacity: { node: 'BaseColor', output: 'a' } }, { BaseColor: texture('glass', [0.8, 0.9, 1, 1]) });
    expect(run(net, texels([200, 220, 255, 128], [190, 220, 250, 128]))).toEqual({ ...DEFAULT_GLASS, source: 'derived' });
    expect(run(net, texels([200, 220, 255, 255], [190, 220, 250, 255]))).toEqual({ rho: 0.2, tau: 0, kind: 'opaque', source: 'derived' }); // alpha 1
    expect(run(net, texels([0, 0, 0, 128]), { ...DEFAULT_GLASS, tau: 0.5, source: 'edited' })).toEqual({ rho: 0, tau: 0.5, kind: 'glass', source: 'derived' });
  });
  it('a constant opacity below 0.98 is glass whatever its value; a metal is never glass', () => {
    for (const opacity of [0.97, 0.75, 0.25, 0.2]) expect(derive(surface({ opacity }))).toEqual({ ...DEFAULT_GLASS, source: 'derived' }); // SketchUp, Revit, glTF transmission
    expect(derive(surface({ opacity: 0.98 }))).toEqual({ rho: 0.2, tau: 0, kind: 'opaque', source: 'derived' });
    expect(derive(surface({ opacity: 0.5, metallic: 1 })).kind).toBe('opaque');
    expect(derive(surface({ opacity: 0.5, metallic: 1, opacityThreshold: 0.6 })).kind).toBe('porous'); // a perforated sheet
  });
  it('an opaque material takes the default albedo (rho is derived in phase 2)', () => {
    expect(derive(surface({ diffuseColor: [0.8, 0.1, 0.1] }))).toEqual({ rho: 0.2, tau: 0, kind: 'opaque', source: 'derived' });
    expect(derive(surface({ diffuseColor: [0.8, 0.1, 0.1] }), new Map(), { ...DEFAULT_OPTICS, rho: 0.3, source: 'edited' }).rho).toBe(0.3);
  });
  it('an opacity texture that could not be read counts as absent: the constants decide, else opacity 1', () => {
    const link = { opacity: { node: 'Opacity', output: 'r' } }, nodes = { Opacity: texture('leaf', [1, 1, 1, 1]) }, failed = new Map([['/drop/1/textures/leaf.png', null]]);
    expect(derive(surface({}, link, nodes), failed)).toEqual({ rho: 0.2, tau: 0, kind: 'opaque', source: 'derived' });
    expect(derive(surface({}, link, nodes))).toEqual({ rho: 0.2, tau: 0, kind: 'opaque', source: 'derived' }); // not decoded at all
    expect(derive(surface({ opacity: 0.5 }, link, nodes), failed).kind).toBe('glass');
    expect(derive(surface({ opacityThreshold: 0.4 }, link, nodes), failed)).toMatchObject({ kind: 'porous', tau: 0 });
    expect(textureReads(surface({}, link, { Opacity: texture('lost', [1, 1, 1, 1], '') }))).toEqual([]); // unresolved: nothing to read
  });
  it('reads UsdPreviewSurface only: no material, MaterialX or OpenPBR give the default material', () => {
    const mtlx: MaterialNetwork = { surface: 'SR', nodes: { SR: { type: 'ND_standard_surface_surfaceshader', params: { opacity: [0.2, 0.2, 0.2] }, inputs: {} } } };
    expect(derive(undefined)).toEqual(DEFAULT_OPTICS);
    expect(derive(mtlx)).toEqual(DEFAULT_OPTICS);
    expect(textureReads(mtlx)).toEqual([]);
    const edited: Optics = { rho: 0.3, tau: 0.2, kind: 'porous', source: 'edited', warning: 'x' };
    expect(derive(mtlx, new Map(), edited)).toEqual({ rho: 0.3, tau: 0.2, kind: 'porous', source: 'default' });
  });
});

describe('textureStats', () => {
  it('decodes sRGB through the table; without an opacity read the coverage is 1', () => {
    const t = textureStats(texels([255, 128, 10, 255], [0, 128, 0, 0]), 2, 1);
    expect(t.mean[0]).toBe(0.5);
    expect(t.mean[1]).toBeCloseTo(0.2158605, 6);
    expect(t.mean[2]).toBeCloseTo(10 / 255 / 12.92 / 2, 12); // the linear toe
    expect(t).toMatchObject({ covered: t.mean, coverage: 1, range: 0 });
  });
  it('with a threshold, coverage counts the texels at or above it and weights the colour', () => {
    const t = textureStats(texels([255, 0, 0, 255], [0, 0, 255, 254]), 2, 1, { channel: 'a', scale: 0.5, bias: 0, threshold: 0.5 });
    expect(t).toMatchObject({ mean: [0.5, 0, 0.5], covered: [1, 0, 0], coverage: 0.5 });
    expect(t.range).toBeCloseTo(0.5 / 255, 12);
  });
  it('without a threshold, coverage is the mean opacity v x scale + bias, each texel clamped to 0..1', () => {
    expect(textureStats(texels([255, 255, 255, 255], [0, 0, 0, 255]), 2, 1, { channel: 'r', scale: 0.5, bias: 0, threshold: 0 })).toMatchObject({ mean: [0.5, 0.5, 0.5], covered: [1, 1, 1], coverage: 0.25, range: 0.5 });
    expect(textureStats(texels([255, 0, 0, 255], [0, 0, 0, 255]), 2, 1, { channel: 'r', scale: 2, bias: -0.5, threshold: 0 })).toMatchObject({ coverage: 0.5, range: 1 });
    expect(textureStats(texels([255, 0, 0, 0]), 1, 1, { channel: 'a', scale: 1, bias: 0, threshold: 0.5 })).toMatchObject({ covered: [1, 0, 0], coverage: 0 }); // nothing covered: no NaN
  });
});

describe('clamp', () => {
  const o = (rho: number, tau: number, kind: Optics['kind']): Optics => ({ rho, tau, kind, source: 'edited' });
  it('limits values to 0..1', () => {
    expect(clamp(o(1.2, -0.1, 'porous'))).toEqual({ ...o(1, 0, 'porous'), warning: expect.stringMatching(/0\.\.1/) });
    expect(clamp(o(NaN, 0.5, 'porous'))).toMatchObject({ rho: 0, tau: 0.5, warning: expect.any(String) });
  });
  it('gives glass rho 0', () => expect(clamp(o(0.1, 0.6, 'glass'))).toEqual({ ...o(0, 0.6, 'glass'), warning: expect.stringMatching(/reflects by angle/) }));
  it('makes glass that passes nothing opaque', () => expect(clamp(o(0, 0, 'glass'))).toEqual({ ...o(0, 0, 'opaque'), warning: expect.stringMatching(/opaque/) }));
  it('caps glass at 0.918', () => expect(clamp(o(0, 0.95, 'glass'))).toEqual({ ...o(0, 0.918, 'glass'), warning: expect.stringMatching(/0\.918/) }));
  it('lowers rho to 1 - tau', () => {
    const c = clamp(o(0.5, 0.7, 'porous'));
    expect(c.rho).toBeCloseTo(0.3, 12);
    expect(c.warning).toMatch(/1 - transmittance/);
  });
  it('leaves values in range alone and drops an earlier warning; opaque passes nothing', () => {
    expect(clamp({ ...o(0.25, 0.75, 'porous'), warning: 'stale' })).toEqual(o(0.25, 0.75, 'porous'));
    expect(clamp(o(0.2, 0.4, 'opaque'))).toEqual(o(0.2, 0, 'opaque'));
  });
});

describe('PRESETS', () => {
  const by = (name: string) => PRESETS.find((p) => p.name === name)!;
  it('are valid for the core as they are, each with its source', () => {
    for (const p of PRESETS) {
      expect(clamp({ ...p, source: 'edited' }), p.name).toEqual({ rho: p.rho, tau: p.tau, kind: p.kind, source: 'edited' });
      expect(p.kind === 'opaque' ? p.tau === 0 : p.tau > 0, p.name).toBe(true);
      expect(p.source.length, p.name).toBeGreaterThan(20);
    }
    expect(new Set(PRESETS.map((p) => p.name)).size).toBe(PRESETS.length);
    expect(PRESETS.map((p) => p.kind).filter((k, i, a) => k !== a[i - 1])).toEqual(['opaque', 'glass', 'porous']); // one optgroup each
  });
  it('hold an opening, the default glass, crowns crossed twice, and porous rho = the solid albedo x (1 - tau)', () => {
    expect(by('Opening (no glazing)')).toMatchObject({ rho: 0, tau: 1, kind: 'porous' });
    expect(by('Double low-e').tau).toBe(DEFAULT_GLASS.tau);
    expect(by('Deciduous tree, in leaf').tau ** 2).toBeCloseTo(0.1, 2);
    expect(by('Deciduous tree, leafless').tau ** 2).toBeCloseTo(0.5, 2);
    for (const [name, albedo] of [['Deciduous tree, in leaf', 0.15], ['Deciduous tree, leafless', 0.15], ['Perforated metal, 40 % open', 0.4], ['Fabric mesh, light', 0.59], ['Fabric mesh, dark', 0.05]] as const) {
      expect(by(name).rho, name).toBeCloseTo(albedo * (1 - by(name).tau), 2);
    }
  });
});

describe('opticsArgs', () => {
  type Sim = Parameters<typeof opticsArgs>[2];
  const sim = (patch: Partial<Sim> = {}): Sim => ({ mode: 'physical', transmission: false, fresnel: true, ...patch });
  const wall: Optics = { ...DEFAULT_OPTICS, source: 'derived' }, glass: Optics = { ...DEFAULT_GLASS, source: 'derived' };
  const tree: Optics = { rho: 0.1, tau: 0.32, kind: 'porous', source: 'edited' };
  const meshes: RunMesh[] = [
    { id: 'r1', role: 'receiver', optics: [wall, glass] }, // a facade: frame and glazing slots
    { id: 's1', role: 'shade', optics: [tree] },
    { id: 'x1', role: 'none', optics: [glass] }, // Ignore: not in the run
  ];
  it('default runs send no new flags, whatever the materials', () => expect(opticsArgs(meshes, DEFAULT_OPTICS, sim())).toEqual([]));
  it('Ladybug mode sends none', () => expect(opticsArgs(meshes, DEFAULT_OPTICS, sim({ mode: 'ladybug', transmission: true, fresnel: false, bounces: 2 }))).toEqual([]));
  it('with transmission: one token of the slots that differ from *, never an Ignore mesh', () => {
    expect(opticsArgs(meshes, DEFAULT_OPTICS, sim({ transmission: true }))).toEqual(['--transmission', 'on', '--optics', 'r1/1=0,0.64,glass;s1/0=0,0.32,porous']);
  });
  it('--fresnel off only with transmission on', () => {
    expect(opticsArgs([], DEFAULT_OPTICS, sim({ fresnel: false }))).toEqual([]);
    expect(opticsArgs([], DEFAULT_OPTICS, sim({ transmission: true, fresnel: false }))).toEqual(['--transmission', 'on', '--fresnel', 'off']);
  });
  it('a textured opaque model with Reflections Off sends no --optics: its reflectance is not used', () => {
    const facade: RunMesh[] = [{ id: 'f', role: 'receiver', optics: [{ rho: 0.35, tau: 0, kind: 'opaque', source: 'derived' }, wall] }];
    expect(opticsArgs(facade, DEFAULT_OPTICS, sim({ transmission: true }))).toEqual(['--transmission', 'on']);
    expect(opticsArgs(facade, { ...DEFAULT_OPTICS, rho: 0.3, source: 'edited' }, sim({ transmission: true }))).toEqual(['--transmission', 'on']);
  });
  it('* only when the default material differs from the built-in one; with reflections rho counts', () => {
    const screen: Optics = { rho: 0.2, tau: 0.3, kind: 'porous', source: 'edited' };
    expect(opticsArgs(meshes.slice(0, 1), screen, sim({ transmission: true }))).toEqual(['--transmission', 'on', '--optics', '*=0,0.3,porous;r1/0=0,0;r1/1=0,0.64,glass']);
    const bright: Optics = { ...DEFAULT_OPTICS, rho: 0.3, source: 'edited' };
    expect(opticsArgs(meshes.slice(0, 1), bright, sim({ bounces: 1 }))).toEqual(['--optics', '*=0.3,0;r1/0=0.2,0;r1/1=0,0.64,glass']);
  });
  it('clamps every value first: one value never fails a run', () => {
    const edited: RunMesh[] = [{ id: 'g', role: 'receiver', optics: [{ rho: 0.1, tau: 0.95, kind: 'glass', source: 'edited' }, { rho: 0.2, tau: 0, kind: 'glass', source: 'edited' }] }];
    expect(opticsArgs(edited, DEFAULT_OPTICS, sim({ transmission: true }))).toEqual(['--transmission', 'on', '--optics', 'g/0=0,0.918,glass']);
  });
});

describe('resolveOptics', () => {
  const cutout = (name: string) => surface({}, { opacity: { node: 'Opacity', output: 'r' } }, { Opacity: texture(name, [1, 1, 1, 1]) });
  const mats = new Map<number, { path: string; network?: MaterialNetwork }>([
    [1, { path: '/M/Leaves', network: cutout('leaf') }], [2, { path: '/M/Glass', network: surface({ opacity: 0.25 }) }],
    [3, { path: '/M/Tint', network: surface({ opacity: 0.5 }) }], [4, { path: '/M/Mtlx' }], [5, { path: '/M/Bark', network: cutout('bark') }],
  ]);
  const rows: Pick<ObjectRow, 'id' | 'role' | 'materials'>[] = [
    { id: 'r', role: 'receiver', materials: [2, 0, 3] }, // glass, no material, glass
    { id: 's', role: 'shade', materials: [1, 4] }, // a cut-out, a material without a UsdPreviewSurface network
    { id: 'x', role: 'none', materials: [5] }, // Ignore: never resolved, its texture never read
    { id: 'n', role: 'shade' }, // no subsets known: one slot, no material
  ];
  const leaf = textureReads(mats.get(1)!.network)[0], half = texels([255, 255, 255, 255], [255, 255, 255, 255], [0, 0, 0, 255], [0, 0, 0, 255]);
  const glass: Optics = { ...DEFAULT_GLASS, source: 'derived' };

  it("resolves each run slot by its material's rid and lists the textures it still waits for", () => {
    const r = resolveOptics(rows, mats, new Map(), {});
    expect(r.unread).toEqual([leaf]); // not the Ignore row's bark
    expect(r.meshes.map((m) => [m.id, m.role])).toEqual([['r', 'receiver'], ['s', 'shade'], ['n', 'shade']]);
    expect(r.meshes[0].optics).toEqual([glass, DEFAULT_OPTICS, glass]);
    expect(r.meshes[1].optics).toEqual([{ rho: 0.2, tau: 0, kind: 'opaque', source: 'derived' }, DEFAULT_OPTICS]); // the mask not read yet
    expect([r.fallback, r.meshes[2].optics]).toEqual([DEFAULT_OPTICS, [DEFAULT_OPTICS]]);
  });
  it('a decoded texture counts once it lands, a failed one as absent; then nothing waits', () => {
    const read = resolveOptics(rows, mats, new Map([[readKey(leaf), textureStats(half, 4, 1, leaf.opacity)]]), {});
    expect([read.unread, read.meshes[1].optics[0]]).toEqual([[], { rho: 0.1, tau: 0.5, kind: 'porous', source: 'derived' }]);
    expect(opticsArgs(read.meshes, read.fallback, { mode: 'physical', transmission: true, fresnel: true })).toEqual(['--transmission', 'on', '--optics', 'r/0=0,0.64,glass;r/2=0,0.64,glass;s/0=0,0.5,porous']);
    const failed = resolveOptics(rows, mats, new Map([[readKey(leaf), null]]), {});
    expect([failed.unread, failed.meshes[1].optics[0].kind]).toEqual([[], 'opaque']);
    expect(readKey({ ...leaf, opacity: { ...leaf.opacity!, threshold: 0.5 } })).not.toBe(readKey(leaf)); // the same file read otherwise
  });
  it('an edit overrides by prim path, clamped; the default rows take theirs, and derived glass the default glass', () => {
    const e = resolveOptics(rows, mats, new Map(), {
      '/M/Glass': { rho: 0, tau: 0.95, kind: 'glass' }, [DEFAULT_KEY]: { rho: 0.3, tau: 0.2, kind: 'porous' }, [GLASS_KEY]: { rho: 0, tau: 0.5, kind: 'glass' },
    });
    expect(e.fallback).toEqual({ rho: 0.3, tau: 0.2, kind: 'porous', source: 'edited' });
    expect(e.meshes[0].optics).toEqual([{ rho: 0, tau: 0.918, kind: 'glass', source: 'edited', warning: expect.stringMatching(/0\.918/) }, e.fallback, { rho: 0, tau: 0.5, kind: 'glass', source: 'derived' }]);
    expect(e.meshes[2].optics).toEqual([e.fallback]);
  });
});
