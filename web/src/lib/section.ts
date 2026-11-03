// Sections as the app keeps them: clipping planes and vertical clipping boxes (the USD viewer's section, view only) in
// model metres, Z up (frame.ts), converted per stage for its viewer (toStage, and fromStage for the viewer's gizmo);
// taken from an agent in its forms (given) and checked as data from an agent or a stored report (validate), and said in
// a few words (describe) for the views, reports and agents. Never a run input. Pure: types only from the viewer.
import type { Section as StageSection } from 'usd-viewer';
import { toModel, toWorld, type Box, type Vec3 } from './frame';

export type Vec2 = [number, number];
/** A stage's up axis. */
export type Up = 'Y' | 'Z';
/**
 * Clipping planes and boxes in model metres. A plane keeps the side its normal points to. A box is a vertical prism: a
 * footprint of 4 corners in plan (any simple quad, concave too) between the heights bottom and top; 'inside' shows only
 * what is in it, 'outside' cuts it away. on: false keeps the entries but shows everything.
 */
export interface Section {
  on: boolean;
  planes: { point: Vec3; normal: Vec3 }[];
  boxes: { keep: 'inside' | 'outside'; footprint: [Vec2, Vec2, Vec2, Vec2]; bottom: number; top: number }[];
}

/** No section. */
export const NONE: Section = { on: true, planes: [], boxes: [] };
/** Planes, and boxes, at most (the viewer's). */
export const MAX = 8;

/** A length rounded to 1 mm (no -0). */
export const mm = (v: number) => Math.round(1000 * v) / 1000 + 0;
/** A direction as a unit vector, its components rounded to 1e-4. */
export const direction = (n: Vec3): Vec3 => { const l = Math.hypot(...n); return n.map((v) => Math.round((1e4 * v) / l) / 1e4 + 0) as Vec3; };
/** True when the section hides something: on, with an entry. */
export const active = (s: Section) => s.on && s.planes.length + s.boxes.length > 0;

/** Model metres -> a stage's units and axes (`k`: its metersPerUnit; 1 for a direction): an exact signed permutation. */
const stage = (p: Vec3, up: Up, k: number): Vec3 => (up === 'Z' ? [p[0] / k, p[1] / k, p[2] / k] : toWorld(p, k));
const model = (p: Vec3, up: Up, k: number): Vec3 => (up === 'Z' ? [p[0] * k, p[1] * k, p[2] * k] : toModel(p, k));

/** The section as the viewer of a stage (metersPerUnit `mpu`, up axis `up`) takes it: stage units and axes. */
export function toStage(s: Section, mpu: number, up: Up): StageSection {
  return {
    on: s.on,
    planes: s.planes.map((p) => ({ point: stage(p.point, up, mpu), normal: stage(p.normal, up, 1) })),
    boxes: s.boxes.map((b) => ({ keep: b.keep, corners: b.footprint.map(([x, y]) => stage([x, y, b.bottom], up, mpu)) as StageSection['boxes'][number]['corners'], bottom: b.bottom / mpu, top: b.top / mpu })),
  };
}

/** A viewer's section back in model metres, rounded: lengths to 1 mm, normals to unit vectors of 1e-4. */
export function fromStage(s: StageSection, mpu: number, up: Up): Section {
  return {
    on: s.on,
    planes: s.planes.map((p) => ({ point: model(p.point, up, mpu).map(mm) as Vec3, normal: direction(model(p.normal, up, 1)) })),
    boxes: s.boxes.map((b) => ({ keep: b.keep, footprint: b.corners.map((c) => { const [x, y] = model(c, up, mpu); return [mm(x), mm(y)]; }) as Section['boxes'][number]['footprint'], bottom: mm(b.bottom * mpu), top: mm(b.top * mpu) })),
  };
}

/** A section given as data (validate() found nothing wrong): its own fields only, on unless false, no entries when left out. */
export const sectionOf = (v: Partial<Section>): Section => ({
  on: v.on !== false,
  planes: (v.planes ?? []).map(({ point, normal }) => ({ point: [...point] as Vec3, normal: [...normal] as Vec3 })),
  boxes: (v.boxes ?? []).map(({ keep, footprint, bottom, top }) => ({ keep, footprint: footprint.map(([x, y]) => [x, y]) as Section['boxes'][number]['footprint'], bottom, top })),
});

/** True when the diagonal from corner k to k + 2 has the other two corners on opposite sides, clear of it: the quad is
 *  simple, has area, and splits into two triangles there (the viewer's own test, in plan). */
function separates(c: readonly Vec2[], k: number): boolean {
  const [ax, ay] = c[k], dx = c[k + 2][0] - ax, dy = c[k + 2][1] - ay, side = ([x, y]: Vec2) => dx * (y - ay) - dy * (x - ax);
  const s1 = side(c[k + 1]), s3 = side(c[(k + 3) % 4]), tolerance = 1e-9 * (dx * dx + dy * dy);
  return (s1 > tolerance && s3 < -tolerance) || (s1 < -tolerance && s3 > tolerance);
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const nums = (v: unknown, n: number): v is number[] => Array.isArray(v) && v.length === n && v.every(finite);

/**
 * What is wrong with a section given as data (an agent's, a stored report's), each problem naming its path under `path`,
 * e.g. 'section.boxes[1].footprint[2]: [x, y], finite numbers in m'; [] when nothing. on, planes and boxes may be left
 * out (on, none). The viewer's clean() stays the final judge.
 */
export function validate(v: unknown, path: string): string[] {
  const no: string[] = [], bad = (at: string, what: string) => void no.push(`${at}: ${what}`);
  const fields = (at: string, o: Obj, own: string[], what: string) => { for (const k of Object.keys(o)) if (!own.includes(k)) bad(`${at}.${k}`, `not a field of ${what} (${own.join(', ')})`); };
  if (!isObj(v)) return [`${path}: an object {on, planes, boxes} in model metres`];
  fields(path, v, ['on', 'planes', 'boxes'], 'a section');
  if (v.on !== undefined && typeof v.on !== 'boolean') bad(`${path}.on`, 'true or false');
  const list = (k: 'planes' | 'boxes', what: string): unknown[] => {
    const a = v[k];
    if (a === undefined) return [];
    if (Array.isArray(a) && a.length <= MAX) return a;
    bad(`${path}.${k}`, `at most ${MAX} ${k}, each ${what}`);
    return [];
  };
  list('planes', '{point, normal}').forEach((p, i) => {
    const at = `${path}.planes[${i}]`;
    if (!isObj(p)) return bad(at, '{point, normal}: it keeps the side its normal points to');
    fields(at, p, ['point', 'normal'], 'a plane');
    if (!nums(p.point, 3)) bad(`${at}.point`, '[x, y, z], finite numbers in m');
    if (!nums(p.normal, 3)) bad(`${at}.normal`, '[x, y, z], finite numbers');
    else if (!(Math.hypot(...p.normal) > 0)) bad(`${at}.normal`, 'not zero: it points to the side the plane keeps');
  });
  list('boxes', '{keep, footprint, bottom, top}').forEach((b, i) => {
    const at = `${path}.boxes[${i}]`;
    if (!isObj(b)) return bad(at, '{keep, footprint, bottom, top}: a vertical prism');
    fields(at, b, ['keep', 'footprint', 'bottom', 'top'], 'a box');
    if (b.keep !== 'inside' && b.keep !== 'outside') bad(`${at}.keep`, "'inside' (shows only what is in it) or 'outside' (cuts it away)");
    const f = b.footprint;
    if (!Array.isArray(f) || f.length !== 4) bad(`${at}.footprint`, '4 corners [x, y] in m, in order round the box');
    else {
      f.forEach((c, k) => { if (!nums(c, 2)) bad(`${at}.footprint[${k}]`, '[x, y], finite numbers in m'); });
      if (f.every((c) => nums(c, 2)) && !separates(f as Vec2[], 0) && !separates(f as Vec2[], 1)) bad(`${at}.footprint`, 'crosses itself or has no area; give the corners in order round the box');
    }
    if (!finite(b.bottom)) bad(`${at}.bottom`, 'a height in m');
    if (!finite(b.top)) bad(`${at}.top`, 'a height in m');
    else if (finite(b.bottom) && !(b.top > b.bottom)) bad(`${at}.top`, `above the bottom (${b.bottom} m)`);
  });
  return no;
}

/**
 * A box round `min`..`max` (model metres) for a section: `margin` m larger on every side (by default 1 % of its diagonal,
 * as the Section menu's), turned `rotation` degrees counter-clockwise (seen from above) about its vertical centre line;
 * its footprint counter-clockwise, lengths to 1 mm.
 */
export function boxOf({ min, max }: Box, margin = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 100, rotation = 0): Omit<Section['boxes'][number], 'keep'> {
  const hx = Math.abs(max[0] - min[0]) / 2 + margin, hy = Math.abs(max[1] - min[1]) / 2 + margin, cx = (min[0] + max[0]) / 2, cy = (min[1] + max[1]) / 2;
  const r = (rotation * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r), at = (u: number, v: number): Vec2 => [mm(cx + c * u - s * v), mm(cy + s * u + c * v)];
  return { footprint: [at(-hx, -hy), at(hx, -hy), at(hx, hy), at(-hx, hy)], bottom: mm(Math.min(min[2], max[2]) - margin), top: mm(Math.max(min[2], max[2]) + margin) };
}

/** Where prims are drawn, for a box round them: their bounds (model metres), or what is wrong, naming its path `at`. */
export type Bounds = (paths: string[], at: string) => Box | string;
/** A section as agents give it (mcp.json's): each box as its footprint with bottom and top; as a box, turned by
 *  `rotation`; or round prims (`paths`); the last two `margin` larger on every side. */
export interface Given {
  on?: boolean; planes?: Section['planes'];
  boxes?: { keep: 'inside' | 'outside'; footprint?: Vec2[]; bottom?: number; top?: number; box?: Box; rotation?: number; paths?: string[]; margin?: number }[];
}
const FORMS = { footprint: ['bottom', 'top'], box: ['rotation', 'margin'], paths: ['margin'] } as const; // each form with its own fields

/**
 * A section as agents give it (set_display, screenshot, a report's view block; mcp.json's schema passed it) in the app's
 * form, or every problem, each naming its path under `at`. A box given as a box (margin 0 by default) or round prims
 * (where `bounds` finds them, the Section menu's margin by default; without `bounds` refused) becomes its footprint.
 */
export function given(v: Given, at: string, bounds?: Bounds): Section | string[] {
  const no: string[] = [], refuse = (what: string) => { no.push(what); return null; };
  const boxes = (v.boxes ?? []).map((b, i) => {
    const here = `${at}.boxes[${i}]`, forms = (Object.keys(FORMS) as (keyof typeof FORMS)[]).filter((k) => b[k] !== undefined), form = forms[0];
    if (forms.length !== 1) return refuse(`${here}: one of footprint (with bottom and top), box or paths`);
    const stray = Object.keys(b).find((k) => k !== 'keep' && k !== form && !(FORMS[form] as readonly string[]).includes(k));
    if (stray) return refuse(`${here}.${stray}: not with ${form}, which takes ${FORMS[form].join(' and ')}`);
    if (form === 'footprint') return { keep: b.keep, footprint: b.footprint, bottom: b.bottom, top: b.top } as Section['boxes'][number];
    const box = form === 'box' ? b.box! : bounds ? bounds(b.paths!, `${here}.paths`) : `${here}.paths: found in the app's models only; give footprint or box`;
    if (typeof box === 'string') return refuse(box);
    const out = boxOf(box, b.margin ?? (form === 'box' ? 0 : undefined), b.rotation);
    return out.top > out.bottom && separates(out.footprint, 0) ? { keep: b.keep, ...out } : refuse(`${here}.${form}: flat, nothing fits in it; give a margin (m), as a find_critical box round a wall or a roof needs`);
  });
  if (no.length) return no;
  const s = sectionOf({ on: v.on, planes: v.planes, boxes: boxes as Section['boxes'] }), wrong = validate(s, at);
  return wrong.length ? wrong : s;
}

const metres = (v: number) => `${v.toFixed(2)} m`;
/** A plane along a model axis in words ('horizontal at 1.20 m, keeps below'); null for any other. */
function aligned({ point, normal }: Section['planes'][number]): string | null {
  const k = normal.findIndex((v) => v !== 0);
  if (k < 0 || normal.some((v, j) => j !== k && v !== 0)) return null;
  const up = normal[k] > 0;
  return k === 2 ? `horizontal at ${metres(point[2])}, keeps ${up ? 'above' : 'below'}` : `vertical at ${'xy'[k]} = ${metres(point[k])}, keeps the ${up ? '+' : '-'}${'xy'[k]} side`;
}

/**
 * A section in a few words, for the views, reports and agents: 'none', 'off', one or two planes along the axes in words
 * ('horizontal at 1.20 m, keeps below'), else their count ('3 planes'), and the boxes by kind ('1 box showing inside,
 * 2 boxes cutting out'), joined by '; '.
 */
export function describe(s: Section): string {
  if (!s.planes.length && !s.boxes.length) return 'none';
  if (!s.on) return 'off';
  const n = s.planes.length, words = s.planes.map(aligned);
  const planes = n <= 2 && words.every((w) => w !== null) ? words.join('; ') : `${n} plane${n === 1 ? '' : 's'}`;
  const boxes = (['inside', 'outside'] as const).flatMap((keep) => {
    const k = s.boxes.filter((b) => b.keep === keep).length;
    return k ? [`${k} box${k === 1 ? '' : 'es'} ${keep === 'inside' ? 'showing inside' : 'cutting out'}`] : [];
  });
  return [planes, boxes.join(', ')].filter(Boolean).join('; ');
}
