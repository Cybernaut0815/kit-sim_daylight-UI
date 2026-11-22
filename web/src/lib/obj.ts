// OBJ text -> THREE.Group, keeping the file's own faces. three's OBJLoader fans every face into triangles and gives each
// corner a vertex of its own, so a quad came out as two faces and no two faces shared a point: a run on such a mesh has
// two results per quad, and per-vertex results that never join where the file's faces do. Here every `o` / `g` object
// is a Mesh over the `v` its faces name (shared as the file shares them), drawn by a fan index, with the faces
// themselves in geometry.userData.obj for toUsda (lib/usda.ts), which writes them as the USD mesh's polygons.
// Read as OBJLoader reads: `o` and `g` both start an object (the name: the rest of the line), `usemtl` a material run
// that carries over to the next object, `v x y z r g b` vertex colours (sRGB), negative indices count from the end, a
// trailing backslash continues a line. Lines and points (`l`, `p`), smoothing groups and `mtllib` are skipped: the
// materials come from the picked .mtl files (`create`).
import { BufferAttribute, BufferGeometry, Color, Group, Mesh, MeshPhongMaterial, SRGBColorSpace, type Material } from 'three';

/** A mesh's faces as the OBJ has them (geometry.userData.obj). */
export interface ObjFaces {
  counts: Int32Array; // corners per face
  indices: Int32Array; // the point (position attribute) at each corner
  normals: Float32Array | null; // `vn` per corner, 3 each: when every corner names one
  st: Float32Array | null; // `vt` per corner, 2 each: when every corner names one
  groups: { start: number; count: number; materialIndex: number }[]; // faces per material, with several materials
}

/**
 * `create(name)`: the material of a `usemtl` name (MTLLoader's creator), undefined for one it does not know; a mesh
 * without one gets a plain Phong material of that name, as OBJLoader gives it.
 */
export function parseObj(text: string, create?: (name: string) => Material | undefined): Group {
  const V: number[] = [], C: number[] = [], VT: number[] = [], VN: number[] = [], root = new Group(), colour = new Color();
  interface Obj { name: string; v: number[]; vt: number[]; vn: number[]; counts: number[]; runs: { name: string; face: number }[] }
  let material = '';
  const start = (name: string): Obj => ({ name, v: [], vt: [], vn: [], counts: [], runs: [{ name: material, face: 0 }] });
  let o = start('');

  const finish = () => {
    const F = o.counts.length;
    if (!F) return;
    // the points in use, in the file's order of first use
    const local = new Map<number, number>(), from: number[] = [];
    const indices = Int32Array.from(o.v, (g) => { let k = local.get(g); if (k === undefined) { k = from.length; local.set(g, k); from.push(g); } return k; });
    const position = new Float32Array(3 * from.length), coloured = from.every((g) => !Number.isNaN(C[3 * g])), rgb = coloured ? new Float32Array(3 * from.length) : null;
    from.forEach((g, k) => {
      position.set(V.slice(3 * g, 3 * g + 3), 3 * k);
      rgb?.set(colour.setRGB(C[3 * g], C[3 * g + 1], C[3 * g + 2], SRGBColorSpace).toArray(), 3 * k); // linear, as three holds colours
    });
    const pick = (at: number[], all: number[], n: number) => (at.every((i) => i >= 0) ? Float32Array.from({ length: n * at.length }, (_, i) => all[n * at[Math.floor(i / n)] + (i % n)]) : null);
    // a fan per face for three (the viewer draws from the USD layer's polygons, not from this index)
    const tris: number[] = [], triStart = new Int32Array(F + 1);
    for (let f = 0, at = 0; f < F; at += o.counts[f], f++) {
      for (let i = 1; i + 1 < o.counts[f]; i++) tris.push(indices[at], indices[at + i], indices[at + i + 1]);
      triStart[f + 1] = tris.length / 3;
    }
    const geometry = new BufferGeometry().setAttribute('position', new BufferAttribute(position, 3)).setIndex(tris);
    if (rgb) geometry.setAttribute('color', new BufferAttribute(rgb, 3));
    // the materials of the runs that hold faces; one material: no groups
    const runs = o.runs.map((r, i) => ({ name: r.name, start: r.face, count: (o.runs[i + 1]?.face ?? F) - r.face })).filter((r) => r.count > 0);
    const names = [...new Set(runs.map((r) => r.name))];
    const materials = names.map((name) => create?.(name) ?? Object.assign(new MeshPhongMaterial({ vertexColors: coloured }), { name }));
    const groups = names.length > 1 ? runs.map((r) => ({ start: r.start, count: r.count, materialIndex: names.indexOf(r.name) })) : [];
    for (const g of groups) geometry.addGroup(3 * triStart[g.start], 3 * (triStart[g.start + g.count] - triStart[g.start]), g.materialIndex);
    geometry.userData.obj = { counts: Int32Array.from(o.counts), indices, normals: pick(o.vn, VN, 3), st: pick(o.vt, VT, 2), groups } satisfies ObjFaces;
    const mesh = new Mesh(geometry, materials.length > 1 ? materials : materials[0]);
    mesh.name = o.name;
    root.add(mesh);
  };

  const lines = text.split('\n');
  for (let n = 0; n < lines.length; n++) {
    let line = lines[n];
    while (line.trimEnd().endsWith('\\') && n + 1 < lines.length) line = `${line.trimEnd().slice(0, -1)} ${lines[++n]}`;
    line = line.trim();
    const key = line.slice(0, line.search(/\s|$/)), rest = line.slice(key.length).trim();
    if (key === 'v') {
      const p = rest.split(/\s+/).map(Number);
      V.push(p[0], p[1], p[2]);
      if (p.length >= 6) C.push(p[3], p[4], p[5]); else C.push(NaN, NaN, NaN);
    } else if (key === 'vt') { const p = rest.split(/\s+/).map(Number); VT.push(p[0], p[1] ?? 0); }
    else if (key === 'vn') { const p = rest.split(/\s+/).map(Number); VN.push(p[0], p[1], p[2]); }
    else if (key === 'f') {
      const corners = rest.split(/\s+/);
      if (corners.length < 3) continue;
      for (const c of corners) {
        const [a, b, d] = c.split('/'), at = (s: string | undefined, count: number) => { const i = s ? parseInt(s, 10) : NaN; return Number.isNaN(i) ? -1 : i < 0 ? count + i : i - 1; };
        const v = at(a, V.length / 3);
        if (!(v >= 0 && v < V.length / 3)) throw new Error(`OBJ line ${n + 1}: a face names vertex ${a} of ${V.length / 3}`);
        const t = at(b, VT.length / 2), nn = at(d, VN.length / 3);
        o.v.push(v);
        o.vt.push(t < VT.length / 2 ? t : -1);
        o.vn.push(nn < VN.length / 3 ? nn : -1);
      }
      o.counts.push(corners.length);
    } else if (key === 'o' || key === 'g') {
      if (o.counts.length) { finish(); o = start(rest); } else o.name = rest; // an object without faces yet takes the name
    } else if (key === 'usemtl') {
      material = rest;
      const last = o.runs[o.runs.length - 1];
      if (last.face === o.counts.length) last.name = rest; else o.runs.push({ name: rest, face: o.counts.length });
    }
  }
  finish();
  return root;
}
