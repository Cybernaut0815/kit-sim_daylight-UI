// The agent's tools as server/mcp.json describes them, and the strict check of a value against one of their schemas (the
// parts of JSON Schema mcp.json uses): a tool call's arguments, and a report view block's section, which takes the same
// schema as set_display's. Pure: data and functions only.
import mcp from '../../../server/mcp.json';

export interface Schema {
  type?: string | string[]; enum?: unknown[]; anyOf?: Schema[]; pattern?: string; minimum?: number; maximum?: number;
  minLength?: number; maxLength?: number; minItems?: number; maxItems?: number; items?: Schema;
  properties?: Record<string, Schema>; required?: string[]; additionalProperties?: boolean;
}
export const TOOLS = mcp.tools as unknown as { name: string; inputSchema: Schema; annotations?: { readOnlyHint?: boolean } }[];
/** set_display's section (clipping planes and boxes): a report's view block takes it too. */
export const SECTION = TOOLS.find((t) => t.name === 'set_display')!.inputSchema.properties!.section;

const is = (t: string, v: unknown) =>
  t === 'integer' ? Number.isInteger(v) : t === 'number' ? Number.isFinite(v) : t === 'array' ? Array.isArray(v)
    : t === 'object' ? !!v && typeof v === 'object' && !Array.isArray(v) : t === 'null' ? v === null : typeof v === t;
/** Each inputSchema pattern in words (mcp.test.ts: every pattern of mcp.json has them). */
export const WORDS: Record<string, string> = {
  '^\\d{4}-\\d{2}-\\d{2}$': 'a date, YYYY-MM-DD', '^\\d{2}:\\d{2}$': "a time, 'HH:MM'", '^/': 'a prim path, starting with /', '^[a-z0-9-]{1,64}$': '1 to 64 lowercase letters, digits or -',
  '^#[0-9A-Fa-f]{6}$': "a colour, '#rrggbb'", '^[A-Za-z0-9_-]{1,64}$': '1 to 64 letters, digits, _ or -',
  '^(radiation|direct|diffuse|irradiance|illuminance|sunhours)_(front|back)$': "a result column such as 'sunhours_front'",
};
const span = (lo?: number, hi?: number) => (lo === hi ? `${lo}` : lo !== undefined && hi !== undefined ? `${lo} to ${hi}` : lo !== undefined ? `at least ${lo}` : `at most ${hi}`);
/** A span of a count, its noun agreeing with the last number: 'at least 1 item', '1 to 4 items'. */
const count = (lo: number | undefined, hi: number | undefined, noun: string) => `${span(lo, hi)} ${noun}${(hi ?? lo) === 1 ? '' : 's'}`;

/** What is wrong with `v` under a tool's inputSchema (the parts mcp.json uses), by its path, e.g. 'time.step: one of
 *  10, 15, 30, 60'; '' when nothing. */
export function check(s: Schema, v: unknown, at = 'arguments'): string {
  const no = (what: string) => `${at}: ${what}`, types = s.type === undefined ? [] : [s.type].flat();
  if (types.length && !types.some((t) => is(t, v))) return no(s.enum ? `one of ${s.enum.join(', ')}` : types.join(' or '));
  if (s.enum && !s.enum.includes(v)) return no(`one of ${s.enum.join(', ')}`);
  if (s.anyOf) {
    const why = s.anyOf.map((x) => check(x, v, at)); // the alternative of the value's type says what is wrong
    if (why.every(Boolean)) return why.find((_, i) => [s.anyOf![i].type ?? []].flat().some((t) => is(t, v))) ?? why[0];
  }
  if (typeof v === 'string') {
    if (s.pattern && !new RegExp(s.pattern).test(v)) return no(WORDS[s.pattern] ?? `as ${s.pattern}`);
    if (v.length < (s.minLength ?? 0) || v.length > (s.maxLength ?? Infinity)) return no(count(s.minLength, s.maxLength, 'character'));
  }
  if (typeof v === 'number' && (v < (s.minimum ?? -Infinity) || v > (s.maximum ?? Infinity))) return no(span(s.minimum, s.maximum));
  if (Array.isArray(v)) {
    if (v.length < (s.minItems ?? 0) || v.length > (s.maxItems ?? Infinity)) return no(count(s.minItems, s.maxItems, 'item'));
    for (const [i, x] of v.entries()) { const w = s.items && check(s.items, x, `${at}[${i}]`); if (w) return w; }
  }
  if (s.properties && is('object', v)) {
    const o = v as Record<string, unknown>, sub = (k: string) => (at === 'arguments' ? k : `${at}.${k}`);
    for (const k of s.required ?? []) if (o[k] === undefined) return `${sub(k)}: required`;
    for (const [k, x] of Object.entries(o)) {
      const p = Object.hasOwn(s.properties, k) ? s.properties[k] : undefined;
      if (!p && s.additionalProperties === false) return `${sub(k)}: not an argument here (${Object.keys(s.properties).join(', ') || 'none'})`;
      const w = p && check(p, x, sub(k));
      if (w) return w;
    }
  }
  return '';
}
