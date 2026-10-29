// Mesh rows against the stage's prim hierarchy: which rows sit at or under a prim, row labels, selection mapping.

type Pathed = { id: string; path: string; paths?: readonly string[] };

/**
 * Row labels: the model's own name (`names`) or the prim name, with parent names put in front while two rows share one
 * (USD files name many meshes alike: 'Block_A/Mesh').
 */
export function rowNames(paths: readonly string[], names: ReadonlyMap<string, string> = new Map()): string[] {
  const segs = paths.map((p) => { const s = p.split('/').filter(Boolean); return s.map((seg, i) => names.get(`/${s.slice(0, i + 1).join('/')}`) ?? seg); });
  const out = segs.map((s) => s[s.length - 1] ?? '');
  for (let k = 2; ; k++) {
    const count = new Map<string, number>();
    for (const n of out) count.set(n, (count.get(n) ?? 0) + 1);
    let grew = false;
    out.forEach((n, i) => { if (count.get(n)! > 1 && segs[i].length >= k) { out[i] = segs[i].slice(-k).join('/'); grew = true; } });
    if (!grew) return out;
  }
}

/**
 * Ids of the rows at or under any of `paths`: a viewer selection may name an Xform, a subtree or a prim with no row. A
 * row with `paths` (an instanced mesh: every copy, or its instancer) is hit through any of them.
 */
export function idsUnder(paths: readonly string[], rows: readonly Pathed[]): string[] {
  const sel = new Set(paths);
  const hit = (p: string) => {
    for (let q = p; q; q = q.slice(0, q.lastIndexOf('/'))) if (sel.has(q)) return true;
    return sel.has('/');
  };
  return rows.filter((r) => (r.paths ?? [r.path]).some(hit)).map((r) => r.id);
}

/** Prim path -> the ids of the rows at or under it (every prefix of every row path), for the hierarchy's rows. */
export function underIndex(rows: readonly Pathed[]): Map<string, string[]> {
  const index = new Map<string, Set<string>>();
  for (const r of rows) {
    for (const path of r.paths ?? [r.path]) {
      for (let q = path; q; q = q.slice(0, q.lastIndexOf('/'))) {
        let ids = index.get(q);
        if (!ids) index.set(q, (ids = new Set()));
        ids.add(r.id);
      }
    }
  }
  return new Map([...index].map(([path, ids]) => [path, [...ids]]));
}

/** A prim search as typed ('type:Mesh roof') -> the core's find() arguments: the name words, the prim type ('' = any). */
export const primQuery = (q: string): [text: string, type: string] => [q.replace(/(?:^|\s)type:\S+/, '').trim(), /(?:^|\s)type:(\S+)/.exec(q)?.[1] ?? ''];

/** Prim path -> the id of the row that is exactly that prim (or one of its copies). */
export function meshAt(rows: readonly Pathed[]): Map<string, string> {
  return new Map(rows.flatMap((r) => (r.paths ?? [r.path]).map((path) => [path, r.id] as const)));
}
