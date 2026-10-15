// The 3D sun-path diagram around the model, in the Ladybug / Andrew Marsh vocabulary. Scaffold: compass with ticks and
// N E S W, 30 / 60 degree altitude rings, the 21st of every month (Jan-Jun solid, Jul-Dec dashed), one analemma per
// hour and the band of every sun position of the year. Active layer: the chosen instant (day arc + sun) or analysis
// period (the window on the end-date arcs, the band they span, the evaluated steps) with handles. Drag a sun or a
// handle along its arc to change the time; drag an arc across the sky to change the date. Built at unit radius in the
// diagram frame (+Y up, true north -Z, east +X); the group carries the position, the radius and north. Everything
// below the horizon is clipped.
import * as THREE from 'three';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { cssVar } from '../lib/cssVar';
import { altAzi, analemma, dayPath, decOf, decTable, dragDay, parseHoy, startDayDrag, stepHoys, sunAt, sunDir, type DayDrag, type Path, type Site } from '../lib/sun';
import { dateFromDoy, daysInYear, doy, fmtClock, fmtDay, fmtTime, pad, timeStep, yearOf } from '../lib/time';
import type { Settings } from '../store';

type Time = Settings['time'];
export interface SunView { site: Site; north: number; time: Time; scale: number } // what the viewer draws; scale x the fitted radius
export interface Ptr { x: number; y: number; w: number; h: number } // pointer in CSS px within the canvas, and the canvas size
type Which = 'sun' | 'from' | 'to'; // the instant's sun / arc, or a range end
export type Grab =
  | { kind: 'time'; which: Which; off: number; last: number }
  | { kind: 'date'; which: Which; dec: number[]; drag: DayDrag; off: number; prev: THREE.Vector3; day: number; first: number; last: number; year: number };

const HANDLE_PX = 14, ARC_PX = 8, Y = 0.003; // pick radii; the compass floats just above the ground (no z-fighting)
const rad = (d: number) => (d * Math.PI) / 180;
const mmdd = (date: string, leap: boolean) => fmtTime(date, 0, leap).slice(0, 5);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** A zha token as a three.js colour plus its alpha (three.js colours have none, so translucent tokens become opacity). */
function token(name: string) {
  const s = cssVar(name, '#808080'), m = /^rgba\((.*), ([\d.]+)\)$/.exec(s);
  return { color: new THREE.Color(m ? `rgb(${m[1]})` : s), opacity: m ? Number(m[2]) : 1 };
}
type Tok = ReturnType<typeof token>;

/** Segment pairs of a polyline (flat xyz) from sample a to b (b = n closes the loop) where at least one end is up. */
function upSegs(xyz: number[], alt: number[], out: number[], a = 0, b = alt.length - 1) {
  for (let i = a; i < b; i++) {
    const j = (i + 1) % alt.length;
    if (!(alt[i] >= 0 || alt[j] >= 0) || !Number.isFinite(alt[i] + alt[j])) continue; // the clip plane cuts the part below
    out.push(xyz[3 * i], xyz[3 * i + 1], xyz[3 * i + 2], xyz[3 * j], xyz[3 * j + 1], xyz[3 * j + 2]);
  }
  return out;
}

/** Circle of radius r at height y around +Y, as segment pairs. */
function circle(r: number, y: number, out: number[], n = 128) {
  for (let i = 0; i < n; i++) {
    const a = (i / n) * 2 * Math.PI, b = ((i + 1) / n) * 2 * Math.PI;
    out.push(r * Math.sin(a), y, -r * Math.cos(a), r * Math.sin(b), y, -r * Math.cos(b));
  }
  return out;
}

function label(text: string, cls: string, [x, y, z]: number[], cx = 0.5, cy = 0.5, data?: [string, string]) {
  const el = document.createElement('div');
  el.className = cls ? `sunpath-label ${cls}` : 'sunpath-label';
  el.textContent = text;
  if (data) el.dataset[data[0]] = data[1];
  const o = new CSS2DObject(el);
  o.position.set(x, y, z);
  o.center.set(cx, cy);
  return o;
}

/** Disposes every geometry and material under a layer and empties it (CSS2D labels remove their element on 'removed'). */
function empty(layer: THREE.Object3D) {
  layer.traverse((o) => {
    const m = o as THREE.Mesh;
    m.geometry?.dispose();
    for (const x of Array.isArray(m.material) ? m.material : m.material ? [m.material] : []) x.dispose();
  });
  layer.clear();
}

export function createSunPath() {
  const group = new THREE.Group(), scaffold = new THREE.Group(), active = new THREE.Group();
  group.add(scaffold, active);
  group.visible = false;
  const horizon = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0); // world space: set by frame()
  // pickable state of the active layer, rebuilt by show()
  let arcs: { which: Which; path: Path; line: LineSegments2; width: number }[] = [];
  let handles: { which: Which; obj: THREE.Object3D; up: boolean; tip: HTMLElement; short: string; long: string }[] = [];
  let hot: string | null = null; // hovered or dragged handle / arc: 'h:sun', 'a:from', ...
  const ray = new THREE.Raycaster(), v = new THREE.Vector3(), w = new THREE.Vector3();

  const lines = (seg: number[], tok: Tok, width: number, dashed = false, clip = true) => {
    const m = new LineMaterial({ color: tok.color, linewidth: width, dashed, dashSize: 0.02, gapSize: 0.015, transparent: tok.opacity < 1, depthWrite: tok.opacity >= 1, clippingPlanes: clip ? [horizon] : null });
    m.opacity = tok.opacity;
    const l = new LineSegments2(new LineSegmentsGeometry().setPositions(seg), m);
    if (dashed) l.computeLineDistances();
    return l;
  };
  const dots = (xyz: number[], tok: Tok, size: number) => {
    const g = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(xyz, 3));
    return new THREE.Points(g, new THREE.PointsMaterial({ color: tok.color, size, sizeAttenuation: false, clippingPlanes: [horizon] }));
  };
  const surface = (pos: number[], index: number[], tok: Tok, opacity: number) => {
    const g = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(index);
    return new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: tok.color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false, clippingPlanes: [horizon] }));
  };
  /** Quads between consecutive rows of n samples each (flat xyz rows of equal length). */
  const strip = (rows: number[][], tok: Tok, opacity: number) => {
    const n = rows[0].length / 3, pos = rows.flat(), index: number[] = [];
    for (let r = 0; r + 1 < rows.length; r++) for (let i = 0; i + 1 < n; i++) {
      const a = r * n + i, b = a + 1, c = a + n, d = c + 1;
      index.push(a, c, b, b, c, d);
    }
    return surface(pos, index, tok, opacity);
  };
  const ball = (r: number, tok: Tok, opacity = 1) => {
    const m = new THREE.Mesh(new THREE.SphereGeometry(r, 24, 12), new THREE.MeshBasicMaterial({ color: tok.color, transparent: true, opacity, depthTest: false, depthWrite: false }));
    m.renderOrder = 10; // handles stay visible through the model
    return m;
  };

  /** Rebuild the scaffold for a site (and the current theme's tokens). ~12k sun positions, ~15 ms. */
  function build(site: Site) {
    empty(scaffold);
    const axis = token('--text-muted'), faint = token('--border-strong');
    // compass: ring, ticks every 5 / 15 / 90 degrees, N E S W
    const ring = circle(1, Y, []), minor = circle(1.06, Y, []);
    for (let a = 0; a < 360; a += 5) {
      const s = Math.sin(rad(a)), c = -Math.cos(rad(a)), r = a % 90 === 0 ? 1.07 : a % 15 === 0 ? 1.035 : 1.02;
      (a % 15 === 0 ? ring : minor).push(s, Y, c, r * s, Y, r * c);
    }
    scaffold.add(lines(ring, axis, 1.5, false, false), lines(minor, faint, 1, false, false));
    ['N', 'E', 'S', 'W'].forEach((t, i) => scaffold.add(label(t, 'sunpath-label--strong', [1.15 * Math.sin(rad(90 * i)), Y, -1.15 * Math.cos(rad(90 * i))])));
    // altitude rings, labelled on the side away from the sun
    const alts: number[] = [], away = site.lat >= 0 ? 0 : 180;
    for (const a of [30, 60]) {
      circle(Math.cos(rad(a)), Math.sin(rad(a)), alts, 96);
      scaffold.add(label(`${a}°`, '', sunDir(a, away), 0.5, 1));
    }
    scaffold.add(lines(alts, faint, 1, true));
    // the 21st of every month (Jan-Jun solid, Jul-Dec dashed: they pair up), the solstices heavier
    const first: number[] = [], second: number[] = [], solstices: number[] = [];
    for (let m = 1; m <= 12; m++) {
      const p = dayPath(site, `${pad(m)}-21`, 10);
      upSegs(p.xyz, p.alt, m === 6 || m === 12 ? solstices : m < 6 ? first : second);
    }
    scaffold.add(lines(first, faint, 1), lines(second, faint, 1, true), lines(solstices, axis, 1.5));
    // one analemma per whole hour (first half of the year solid)
    const hs: number[] = [], hd: number[] = [];
    for (let h = 0; h < 24; h++) {
      const p = analemma(site, h * 60), n = p.alt.length, half = Math.floor(n / 2);
      upSegs(p.xyz, p.alt, hs, 0, half);
      upSegs(p.xyz, p.alt, hd, half, n);
    }
    scaffold.add(lines(hs, faint, 1), lines(hd, faint, 1, true));
  }

  /** Rebuild the active layer: the instant or the analysis period, and its handles. */
  function show(site: Site, t: Time) {
    empty(active);
    arcs = [];
    handles = [];
    if (t.mode === 'annual') return;
    // contrast on the viewport in both themes: dark gold / yellow for the sun, the accent fill for a period; the soft yellow only as the sun's halo
    const range = t.mode === 'range', tok = range ? token('--accent-fill') : token('--typology-yellow-text'), glow = token('--color-typology-yellow');
    const at = (date: string, minute: number) => sunAt(site, parseHoy(fmtTime(date, minute, site.leap), site.leap));
    const arc = (which: Which, date: string, from = 0, to = 1440) => {
      const p = dayPath(site, mmdd(date, site.leap), 5);
      if (!p.alt.length) return;
      const width = range ? 1 : 3, full = lines(upSegs(p.xyz, p.alt, []), tok, width + (hot === `a:${which}` ? 1.5 : 0));
      active.add(full);
      if (range) active.add(lines(upSegs(p.xyz, p.alt, [], Math.round(from / 5), Math.round(to / 5)), tok, 3));
      arcs.push({ which, path: p, line: full, width });
      let top = 0;
      p.alt.forEach((a, i) => { if (a > p.alt[top]) top = i; });
      if (p.alt[top] >= 0) active.add(label(fmtDay(date), 'sunpath-label--strong', p.xyz.slice(3 * top, 3 * top + 3), 0.5, 1.4, ['arc', which]));
    };
    const handle = (which: Which, date: string, minute: number, r: number, color: Tok) => {
      const s = at(date, minute);
      if (!Number.isFinite(s.alt)) return null;
      const d = sunDir(s.alt, s.azi), obj = ball(r, color, s.up ? 1 : 0.35);
      obj.position.set(d[0], d[1], d[2]);
      if (hot === `h:${which}`) obj.scale.setScalar(1.35);
      const short = fmtClock(minute), long = `${short}, altitude ${Math.round(s.alt)}°, azimuth ${Math.round(s.azi)}°`;
      const tip = label(hot === `h:${which}` ? long : short, 'sunpath-label--strong sunpath-label--at', d, 0, 1, ['handle', which]);
      active.add(obj, tip);
      handles.push({ which, obj, up: s.up, tip: tip.element, short, long });
      return { s, d };
    };

    /** Whole hours on the first arc as dots, every third one labelled just inside the dome (the date label sits above). */
    const hours = () => {
      const p = arcs[0]?.path, xyz: number[] = [];
      if (!p) return;
      for (let i = 0; i < p.alt.length - 1; i += 12) {
        if (!(p.alt[i] >= 0)) continue;
        const d = p.xyz.slice(3 * i, 3 * i + 3);
        xyz.push(...d);
        if (i % 36 === 0) active.add(label(String(i / 12), '', d.map((x) => 0.92 * x)));
      }
      if (xyz.length) active.add(dots(xyz, tok, 5));
    };
    if (!range) {
      arc('sun', t.date);
      hours();
      const h = handle('sun', t.date, t.hour, 1 / 30, tok);
      if (!h) return;
      const halo = ball(1 / 15, glow, h.s.up ? 0.35 : 0.1);
      halo.position.copy(handles[0].obj.position);
      active.add(halo);
      if (h.s.up) { // the sun's ray to the centre, its drop to the ground, its azimuth on the compass
        const [x, y, z] = h.d, g = Math.hypot(x, z) || 1;
        active.add(lines([0, Y, 0, x, y, z, x, y, z, x, Y, z, 0, Y, 0, x / g, Y, z / g], tok, 1, true, false));
      }
      return;
    }
    const multi = t.from.date !== t.to.date;
    arc('from', t.from.date, t.from.hour, t.to.hour);
    if (multi) arc('to', t.to.date, t.from.hour, t.to.hour);
    hours();
    if (multi) { // the period between the end arcs: its band, the window edges over the days, the evaluated steps
      const year = yearOf(t.from.date), d0 = doy(t.from.date), d1 = doy(t.to.date), k = Math.min(24, d1 - d0 + 1);
      const rows: { dec: number; xyz: number[] }[] = [];
      for (let r = 0; r < k; r++) {
        const date = dateFromDoy(d0 + Math.round(((d1 - d0) * r) / Math.max(1, k - 1)), year), xyz: number[] = [];
        for (let j = 0; j <= 24; j++) { const s = at(date, t.from.hour + ((t.to.hour - t.from.hour) * j) / 24); xyz.push(...sunDir(s.alt, s.azi)); }
        if (xyz.every(Number.isFinite)) rows.push({ dec: at(date, 720).dec, xyz });
      }
      rows.sort((a, b) => a.dec - b.dec); // a period across a solstice would fold back over itself
      if (rows.length > 1) active.add(strip(rows.map((r) => r.xyz), tok, 0.15));
      const edges: number[] = [];
      for (const minute of [t.from.hour, t.to.hour]) {
        const xyz: number[] = [], alt: number[] = [];
        for (let d = d0; d <= d1; d++) { const s = at(dateFromDoy(d, year), minute); if (Number.isFinite(s.alt)) { xyz.push(...sunDir(s.alt, s.azi)); alt.push(s.alt); } }
        upSegs(xyz, alt, edges);
      }
      active.add(lines(edges, tok, 2));
    }
    const steps = stepHoys(t, site.leap);
    if (steps.length <= 4000) {
      const xyz: number[] = [];
      for (const hoy of steps) { const s = sunAt(site, hoy + t.stepMin / 120); if (s.up) xyz.push(...sunDir(s.alt, s.azi)); } // the core takes each step's sun at its middle
      if (xyz.length) active.add(dots(xyz, tok, 4));
    }
    handle('from', t.from.date, t.from.hour, 1 / 40, tok);
    handle('to', t.to.date, t.to.hour, 1 / 40, tok);
  }

  /** Screen position (CSS px) of a point in the diagram frame; null behind the camera. */
  const screen = (x: number, y: number, z: number, p: Ptr, cam: THREE.Camera) => {
    v.set(x, y, z);
    group.localToWorld(v).project(cam);
    return v.z > 1 ? null : [((v.x + 1) / 2) * p.w, ((1 - v.y) / 2) * p.h];
  };
  /** Nearest point of an arc's visible part to the pointer: minute of day, distance in px, the point (diagram frame). */
  function nearest(path: Path, p: Ptr, cam: THREE.Camera) {
    let best = { d: Infinity, t: NaN, u: [0, 0, 0] };
    let prev = null as number[] | null;
    for (let i = 0; i < path.alt.length; i++) {
      const cur = path.alt[i] >= 0 ? screen(path.xyz[3 * i], path.xyz[3 * i + 1], path.xyz[3 * i + 2], p, cam) : null;
      if (prev && cur) {
        const dx = cur[0] - prev[0], dy = cur[1] - prev[1], L = dx * dx + dy * dy;
        const s = L ? clamp(((p.x - prev[0]) * dx + (p.y - prev[1]) * dy) / L, 0, 1) : 0;
        const d = Math.hypot(prev[0] + s * dx - p.x, prev[1] + s * dy - p.y);
        if (d < best.d) best = { d, t: path.min[i - 1] + s * (path.min[i] - path.min[i - 1]), u: [0, 1, 2].map((k) => path.xyz[3 * (i - 1) + k] * (1 - s) + path.xyz[3 * i + k] * s) };
      }
      prev = cur;
    }
    return best;
  }
  /** What the pointer is over: the nearest handle within HANDLE_PX, else the nearest arc within ARC_PX. */
  function under(p: Ptr, cam: THREE.Camera) {
    group.updateMatrixWorld();
    let best: { kind: 'h' | 'a'; which: Which; d: number } | null = null;
    for (const h of handles) {
      const s = screen(h.obj.position.x, h.obj.position.y, h.obj.position.z, p, cam), d = s ? Math.hypot(s[0] - p.x, s[1] - p.y) : Infinity;
      if (d < HANDLE_PX && (!best || d < best.d)) best = { kind: 'h', which: h.which, d };
    }
    if (best) return best;
    for (const a of arcs) {
      const d = nearest(a.path, p, cam).d;
      if (d < ARC_PX && (!best || d < best.d)) best = { kind: 'a', which: a.which, d };
    }
    return best;
  }
  /** The dome point under the pointer: the ray's sphere hit nearest `near` (the side the drag started on), else the silhouette. */
  function dome(p: Ptr, cam: THREE.Camera, near: THREE.Vector3) {
    ray.setFromCamera(new THREE.Vector2((p.x / p.w) * 2 - 1, 1 - (p.y / p.h) * 2), cam);
    const c = group.getWorldPosition(w), R = group.scale.x, o = ray.ray.origin, dir = ray.ray.direction;
    const oc = o.clone().sub(c), b = oc.dot(dir), disc = b * b - (oc.lengthSq() - R * R);
    if (disc < 0) return o.clone().addScaledVector(dir, -b).sub(c).setLength(R).add(c);
    const t1 = -b - Math.sqrt(disc), t2 = -b + Math.sqrt(disc), p1 = o.clone().addScaledVector(dir, t1), p2 = o.clone().addScaledVector(dir, t2);
    return t1 >= 0 && p1.distanceToSquared(near) <= p2.distanceToSquared(near) ? p1 : p2;
  }
  const decAt = (site: Site, world: THREE.Vector3) => {
    const u = group.worldToLocal(world.clone()), { alt, azi } = altAzi(u.x, u.y, u.z);
    return decOf(site.lat, alt, azi);
  };
  const arcOf = (which: Which) => arcs.find((a) => a.which === which) ?? arcs[0];

  /** Start a drag if the pointer is on a handle (time) or an arc (date). */
  function grab(p: Ptr, cam: THREE.Camera, view: SunView): Grab | null {
    const hit = under(p, cam), t = view.time;
    if (!hit) return null;
    hot = `${hit.kind}:${hit.which}`;
    const range = t.mode === 'range', a = arcOf(hit.which);
    if (hit.kind === 'h') {
      const cur = hit.which === 'sun' ? t.hour : hit.which === 'from' ? t.from.hour : t.to.hour, h = handles.find((x) => x.which === hit.which);
      const n = a ? nearest(a.path, p, cam) : null, off = h?.up && n && Number.isFinite(n.t) ? cur - n.t : 0; // grabbed off-centre: no jump
      return { kind: 'time', which: hit.which, off, last: cur };
    }
    const date = !range ? t.date : hit.which === 'to' ? t.to.date : t.from.date, year = yearOf(date), n = daysInYear(year);
    const dec = decTable(view.site, year), day = doy(date), on = nearest(a.path, p, cam).u;
    const prev = group.localToWorld(new THREE.Vector3(on[0], on[1], on[2])), start = dome(p, cam, prev);
    const multi = range && t.from.date !== t.to.date;
    const [first, last] = !multi ? [0, n - 1] : hit.which === 'from' ? [0, doy(t.to.date) - 1] : [doy(t.from.date) + 1, n - 1];
    return { kind: 'date', which: hit.which, dec, drag: startDayDrag(dec, day), off: dec[day] - decAt(view.site, start), prev: start, day, first, last, year };
  }

  /** Follow a drag: the TIME patch for the pointer, or null when the snapped value did not change. */
  function drag(g: Grab, p: Ptr, cam: THREE.Camera, view: SunView): Partial<Time> | null {
    const t = view.time;
    group.updateMatrixWorld();
    if (g.kind === 'time') {
      const a = arcOf(g.which);
      if (!a) return null;
      const n = nearest(a.path, p, cam);
      if (!Number.isFinite(n.t)) return null;
      let m = n.t + g.off;
      if (a.path.alt[0] >= 0 && a.path.alt[a.path.alt.length - 1] >= 0) m += 1440 * Math.round((g.last - m) / 1440); // polar day: the arc is a loop
      const step = timeStep(t), lo = g.which === 'to' ? t.from.hour + step : 0, hi = g.which === 'from' ? t.to.hour - step : 1440;
      const val = Math.max(lo, Math.min(hi, Math.round(m / step) * step)); // a window shorter than a step: lo wins
      if (val === g.last) return null;
      g.last = val;
      return g.which === 'sun' ? { hour: val } : g.which === 'from' ? { from: { ...t.from, hour: val } } : { to: { ...t.to, hour: val } };
    }
    const at = dome(p, cam, g.prev);
    g.prev = at;
    const d = dragDay(g.dec, decAt(view.site, at) + g.off, g.drag, g.day, g.first, g.last);
    if (d < 0 || d === g.day) return null;
    g.day = d;
    const date = dateFromDoy(d, g.year);
    if (t.mode !== 'range') return { date };
    if (t.from.date === t.to.date) return { from: { ...t.from, date }, to: { ...t.to, date } };
    return g.which === 'from' ? { from: { ...t.from, date } } : { to: { ...t.to, date } };
  }

  /** Highlight what the pointer is over (null pointer: nothing). Returns whether anything is grabbable there and whether the look changed. */
  function hover(p: Ptr | null, cam: THREE.Camera) {
    const hit = p && group.visible ? under(p, cam) : null, key = hit ? `${hit.kind}:${hit.which}` : null;
    if (key === hot) return { over: !!hit, changed: false };
    hot = key;
    for (const h of handles) {
      const on = key === `h:${h.which}`;
      h.obj.scale.setScalar(on ? 1.35 : 1);
      h.tip.textContent = on ? h.long : h.short;
    }
    for (const a of arcs) (a.line.material as LineMaterial).linewidth = a.width + (key === `a:${a.which}` ? 1.5 : 0);
    return { over: !!hit, changed: true };
  }

  return {
    group, build, show, grab, drag, hover,
    /** Place the diagram: centre on the ground, radius r, model north (degrees counter-clockwise, as --north). */
    frame(x: number, y: number, z: number, r: number, north: number) {
      group.position.set(x, y, z);
      group.scale.setScalar(r);
      group.rotation.y = rad(north);
      horizon.constant = -(y - 1e-4 * r);
    },
    dispose() { empty(scaffold); empty(active); },
  };
}
export type SunPath = ReturnType<typeof createSunPath>;
