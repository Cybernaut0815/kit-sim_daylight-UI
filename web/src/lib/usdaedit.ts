// Prim-level edits of USDA text as Sdf writes it (a flattened stage from the viewer's core): split a prim's body into
// its items and replace whole prims by path. The scanner only counts ( [ { depth and skips strings ("…", '…', """…"""),
// asset paths (@…@, @@@…@@@), prim paths (<…>) and comments, so it holds for any valid layer.
// ponytail: text in, text out, no parse tree; a real Sdf layer (the wasm core) if edits ever go beyond whole prims

export interface Item {
  kind: 'prim' | 'property' | 'variantSet' | 'other';
  start: number; end: number; // [start, end) in the scanned text: its first character to the end of its last line
  name: string; // prim name, property name (without .connect / .timeSamples), variant set name
  spec?: string; type?: string; // prim: def / over / class, and the type name ('' when none)
  meta?: [number, number]; // prim: the '(' and ')' of its metadata
  body?: [number, number]; // prim: the '{' and '}' of its body
}

const lineEnd = (t: string, i: number) => { const j = t.indexOf('\n', i); return j < 0 ? t.length : j; };

/** Index just past the quoted run that starts at i (a string, asset path or prim path). */
function skipQuoted(t: string, i: number): number {
  const c = t[i];
  if (c === '"' || c === "'") {
    if (t.startsWith(c + c + c, i)) { const j = t.indexOf(c + c + c, i + 3); return j < 0 ? t.length : j + 3; }
    for (let j = i + 1; j < t.length; j++) { if (t[j] === '\\') j++; else if (t[j] === c || t[j] === '\n') return j + 1; }
    return t.length;
  }
  const close = c === '<' ? '>' : t.startsWith('@@@', i) ? '@@@' : '@';
  const j = t.indexOf(close, i + close.length);
  return j < 0 ? t.length : j + close.length;
}

/** The index of the bracket closing the one at i. */
export function matching(t: string, i: number): number {
  let depth = 0;
  for (let j = i; j < t.length; j++) {
    const c = t[j];
    if (c === '"' || c === "'" || c === '@' || c === '<') j = skipQuoted(t, j) - 1;
    else if (c === '#') j = lineEnd(t, j) - 1;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if ((c === ')' || c === ']' || c === '}') && --depth === 0) return j;
  }
  return t.length;
}

/** The items of a prim body (or of a whole layer): one per prim, property, variant set or other statement. */
export function items(t: string, from: number, to: number): Item[] {
  const out: Item[] = [];
  for (let i = from; i < to;) {
    while (i < to && /\s/.test(t[i])) i++;
    if (i >= to) break;
    const start = i;
    let depth = 0, j = i;
    for (; j < to; j++) {
      const c = t[j];
      if (c === '"' || c === "'" || c === '@' || c === '<') j = skipQuoted(t, j) - 1;
      else if (c === '#') j = lineEnd(t, j) - 1;
      else if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth--;
      else if (c === '\n' && depth === 0) {
        let k = j + 1;
        while (k < to && (t[k] === ' ' || t[k] === '\t' || t[k] === '\r')) k++;
        if (t[k] !== '{' && t[k] !== '(') break; // a prim's metadata or body may start on the next line
        j = k - 1;
      }
    }
    const end = Math.min(j, to), head = t.slice(start, lineEnd(t, start)), it: Item = { kind: 'other', start, end, name: '' };
    const prim = /^(def|over|class)\s+(?:([\w:]+)\s+)?"([^"]*)"/.exec(head);
    if (prim) {
      Object.assign(it, { kind: 'prim', spec: prim[1], type: prim[2] ?? '', name: prim[3] });
      let k = start + prim[0].length;
      while (/\s/.test(t[k])) k++;
      if (t[k] === '(') { it.meta = [k, matching(t, k)]; k = it.meta[1] + 1; }
      const open = t.indexOf('{', k);
      if (open >= 0 && open < end) it.body = [open, matching(t, open)];
    } else if (/^variantSet\s+"/.test(head)) Object.assign(it, { kind: 'variantSet', name: /"([^"]*)"/.exec(head)![1] });
    else if (head[0] !== '#' && head[0] !== '(' && !/^reorder\b/.test(head)) {
      const decl = head.split(/\s*[=(]/)[0].trim().split(/\s+/);
      Object.assign(it, { kind: 'property', name: decl[decl.length - 1].replace(/\.(connect|timeSamples|spline|default)$/, '') });
    }
    out.push(it);
    i = end;
  }
  return out;
}

/** A prim to rewrite: its own text pieces, with every edit below it already applied. */
export interface Prim {
  path: string; indent: string; spec: string; type: string; name: string;
  meta: string; // the lines inside its metadata parentheses, trimmed of the first and last newline ('' when none)
  items: { item: Item; text: string }[]; // its body items, in order
}

/**
 * The layer with each prim in `edits` replaced by what its function returns (the whole prim, header to closing brace).
 * Prims nested under an edited prim are edited first, and their new text is what the outer edit sees.
 */
export function rewrite(t: string, edits: ReadonlyMap<string, (p: Prim) => string>): string {
  const under = new Set<string>();
  for (const p of edits.keys()) for (let q = p; q && !under.has(q); q = q.slice(0, q.lastIndexOf('/'))) under.add(q);
  const body = (s: string, from: number, to: number, parent: string): string => {
    let out = '', last = from;
    for (const it of items(s, from, to)) {
      const path = `${parent}/${it.name}`;
      if (it.kind !== 'prim' || !it.body || !under.has(path)) continue;
      out += s.slice(last, it.start) + prim(s, it, path);
      last = it.end;
    }
    return out + s.slice(last, to);
  };
  const prim = (s: string, it: Item, path: string): string => {
    const [open, close] = it.body!, inner = body(s, open + 1, close, path), edit = edits.get(path);
    if (!edit) return s.slice(it.start, open + 1) + inner + s.slice(close, it.end);
    const lineStart = s.lastIndexOf('\n', it.start) + 1;
    return edit({
      path, indent: s.slice(lineStart, it.start), spec: it.spec!, type: it.type!, name: it.name,
      meta: it.meta ? s.slice(it.meta[0] + 1, it.meta[1]).replace(/^\n|\n[ \t]*$/g, '') : '',
      items: items(inner, 0, inner.length).map((item) => ({ item, text: inner.slice(item.start, item.end) })),
    });
  };
  return body(t, 0, t.length, '');
}
