import { afterEach, describe, expect, it, vi } from 'vitest';
import mcp from '../../../server/mcp.json';
import { defaultSettings, initialState, reducer, type Action, type State, type Station } from '../store';
import { exclusive, settled, startBridge, until } from './bridge';
import guide from './guide.md?raw';
import { HANDLERS, TOOLS, bySide, check, connect, publicSettings, settingsActions, shotSize } from './tools';

const schema = (name: string) => TOOLS.find((t) => t.name === name)!.inputSchema;

describe('the tool list', () => {
  it('every handler is a tool of mcp.json; these tools have none yet', () => {
    const names = mcp.tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(Object.keys(HANDLERS).filter((n) => !names.includes(n))).toEqual([]);
    expect(names.filter((n) => !(n in HANDLERS))).toEqual(['get_report', 'save_report', 'delete_report', 'generate_report']);
  });
  it('each inputSchema is a closed object whose fields say what they take', () => {
    const fields = (s: Record<string, unknown>, at: string): string[] => {
      const p = (s.properties ?? {}) as Record<string, Record<string, unknown>>, bad = (s.required as string[] | undefined ?? []).filter((k) => !(k in p)).map((k) => `${at}.${k} required`);
      if (s.properties && s.additionalProperties !== false) bad.push(`${at} open`);
      for (const [k, v] of Object.entries(p)) {
        if (!v.type && !v.enum && !v.anyOf) bad.push(`${at}.${k} untyped`);
        if (!v.description) bad.push(`${at}.${k} undescribed`);
        bad.push(...fields(v, `${at}.${k}`), ...(v.items ? fields(v.items as Record<string, unknown>, `${at}.${k}[]`) : []));
      }
      return bad;
    };
    for (const t of mcp.tools) {
      expect(t.inputSchema.type, t.name).toBe('object');
      expect(t.description.length, t.name).toBeGreaterThan(80);
      expect(fields(t.inputSchema, t.name)).toEqual([]);
    }
  });
});

describe('the daylight guide', () => {
  it('names only tools and update_settings fields that exist, in glyphs the report fonts have', () => {
    const names = new Set(mcp.tools.map((t) => t.name)), us = schema('update_settings').properties as Record<string, { properties?: Record<string, unknown> }>;
    expect((guide.match(/\b(?:app_state|site_info|model_tree|(?:update|open|remove|set|get|edit|find|save|delete|generate|download)_[a-z_]+)\b/g) ?? []).filter((w) => !names.has(w))).toEqual([]);
    expect((guide.match(/\b(?:sim|time|weather|viz|site)\.[a-zA-Z]+\b/g) ?? []).filter((d) => { const [g, k] = d.split('.'); return !us[g]?.properties?.[k]; })).toEqual([]);
    // kit-ui's faces: Latin-1, Latin Extended, general punctuation, the minus sign
    expect([...guide].filter((ch) => { const c = ch.codePointAt(0)!; return !(c <= 0x2ba || (c >= 0x2000 && c <= 0x206f) || c === 0x2212); })).toEqual([]);
  });
});

describe('check', () => {
  it('passes what the schema allows, names the field of the rest', () => {
    expect(check(schema('update_settings'), { time: { step: 30, from: { hour: '07:30' } }, viz: { min: null, below: 2 }, charts: [{ id: 'c', kind: 'histogram', range: [0, 8], bins: 'auto' }] })).toBe('');
    expect(check(schema('set_display'), { highlight: null })).toBe('');
    expect(check(schema('update_settings'), { time: { step: 7 } })).toBe('time.step: one of 10, 15, 30, 60');
    expect(check(schema('update_settings'), { time: { from: { hour: '7:30' } } })).toBe("time.from.hour: a time, 'HH:MM'");
    expect(check(schema('update_settings'), { charts: [{ id: 'c', range: 'log' }] })).toBe('charts[0].range: one of relative, absolute');
    expect(check(schema('update_settings'), { charts: [{ id: 'c', range: [1] }] })).toBe('charts[0].range: 2 items');
    expect(check(schema('update_settings'), { weather: { turbidity: 9 } })).toBe('weather.turbidity: 2 to 7');
    expect(check(schema('set_roles'), { role: 'receiver' })).toBe('paths: required');
    expect(check(schema('set_roles'), { paths: ['Roof'], role: 'receiver' })).toBe('paths[0]: a prim path, starting with /');
    expect(check(schema('app_state'), { verbose: true })).toBe('verbose: not an argument here (none)');
    expect(check(schema('set_geometry'), { subdivision: { level: 4 } })).toBe('subdivision.level: one of -1, 0, 1, 2, 3, model');
  });
});

describe('settings', () => {
  const stations: Station[] = [
    { title: 'GBR_London.Gatwick', href: 'https://x/gatwick.epw', lat: 51.15, lon: -0.18 },
    { title: 'DEU_Berlin', href: 'https://x/berlin.epw', lat: 52.57, lon: 13.32 },
  ];
  it('app_state\'s copy goes back through update_settings unchanged', () => {
    let s: State = { ...initialState(), stations };
    const changes: Action[] = [
      { type: 'SITE', patch: { lat: 52.52, lon: 13.4, place: 'Berlin' } }, { type: 'WEATHER', patch: { source: 'clear-sky', turbidity: 4.5 } },
      { type: 'TIME', patch: { mode: 'range', from: { date: '2026-03-01', hour: 450 }, to: { date: '2026-03-21', hour: 1080 }, stepMin: 30 } },
      { type: 'SIM', patch: { mode: 'ladybug', quantities: ['sunhours'], north: 30, sides: 'both' } },
      { type: 'VIZ', quantity: 'sunhours', patch: { gradient: 'viridis', lo: 2, hi: null, below: '#112233' } },
      { type: 'CHART', spec: { id: 'parts', kind: 'parts', models: [0, 2], metric: 'below', parts: ['/Site/Block'] } },
    ];
    for (const a of changes) s = reducer(s, a);
    const p = publicSettings(s.settings);
    expect(p.time).toEqual({ mode: 'range', date: s.settings.time.date, hour: '12:00', from: { date: '2026-03-01', hour: '07:30' }, to: { date: '2026-03-21', hour: '18:00' }, step: 30 });
    expect(p.charts[2]).toEqual({ id: 'parts', kind: 'parts', models: ['A', 'C'], parts: ['/Site/Block'], metric: 'below' });
    let t: State = { ...initialState(), stations };
    const apply = (a: Record<string, unknown>) => { for (const x of settingsActions(a, t, null)) t = reducer(t, x); };
    apply({ site: p.site, time: p.time, sim: p.sim, weather: { source: p.weather.source, turbidity: p.weather.turbidity, altitude: p.weather.altitude }, charts: p.charts });
    for (const [quantity, v] of Object.entries(p.viz.quantities)) apply({ viz: { quantity, ...v, belowColour: p.viz.belowColour, aboveColour: p.viz.aboveColour } });
    expect(publicSettings(t.settings)).toEqual(p);
  });
  it('a station by title sets the source; bad values name their field', () => {
    const s: State = { ...initialState(), stations };
    expect(settingsActions({ weather: { station: 'deu berlin' } }, s, null)).toEqual([{ type: 'WEATHER', patch: { source: 'station', station: stations[1] } }]);
    expect(() => settingsActions({ weather: { station: 'Paris' } }, s, null)).toThrow(/^weather\.station: /);
    expect(() => settingsActions({ time: { date: '2026-02-30' } }, s, null)).toThrow(/^time\.date: /);
    expect(() => settingsActions({ time: { to: { hour: '24:30' } } }, s, null)).toThrow(/^time\.to\.hour: /);
    expect(() => settingsActions({ viz: { gradient: 'magma' } }, s, null)).toThrow(/^viz\.quantity: /);
    expect(settingsActions({ viz: { gradient: 'magma', reset: 'range' } }, s, 'illuminance_front')).toEqual([
      { type: 'VIZ_RESET', quantity: 'illuminance', what: 'range' }, { type: 'VIZ', quantity: 'illuminance', patch: { gradient: 'magma' } },
    ]);
  });
  it('charts: an existing one keeps what is not given; built-ins stay; a refusal names the chart and field', () => {
    const s = initialState(defaultSettings());
    const [put] = settingsActions({ charts: [{ id: 'hist', bins: 32 }] }, s, null);
    expect(put).toEqual({ type: 'CHART', spec: { id: 'hist', kind: 'histogram', bins: 32 } });
    expect(() => settingsActions({ charts: [{ id: 'hist', remove: true }] }, s, null)).toThrow(/^charts\[0\]\.remove: /);
    expect(() => settingsActions({ charts: [{ id: 'mine', kind: 'parts' }, { id: 'mine', remove: true }, { id: 'mine', remove: true }] }, s, null)).toThrow(/^charts\[2\]\.id: /);
    expect(() => settingsActions({ charts: [{ id: 'hist', title: 'x' }] }, s, null)).toThrow(/^charts\[0\] title: /);
  });
  it('a mode switch keeps the quantities given with it', () => {
    let s = initialState();
    for (const x of settingsActions({ sim: { mode: 'ladybug', quantities: ['sunhours'] } }, s, null)) s = reducer(s, x);
    expect([s.settings.sim.mode, s.settings.sim.quantities]).toEqual(['ladybug', ['sunhours']]);
  });
});

describe('results by facing', () => {
  // a 10 × 20 × 6 m block as one mesh: quads a b c d, counter-clockwise seen from where they face, two faces each
  const quads = [
    [[0, 0, 0], [0, 0, 6], [0, 20, 6], [0, 20, 0]], // -X
    [[10, 0, 0], [10, 20, 0], [10, 20, 6], [10, 0, 6]], // +X
    [[0, 0, 0], [10, 0, 0], [10, 0, 6], [0, 0, 6]], // -Y
    [[0, 20, 0], [0, 20, 6], [10, 20, 6], [10, 20, 0]], // +Y
    [[0, 0, 6], [10, 0, 6], [10, 20, 6], [0, 20, 6]], // +Z
  ];
  const one = { first: 0, count: 10, positions: quads.flat(2), indices: quads.flatMap((_, k) => [0, 1, 2, 0, 2, 3].map((i) => 4 * k + i)), w: Array.from({ length: 10 }, (_, f) => f + 1) };
  const values = Array.from({ length: 10 }, (_, f) => Float64Array.of(f)), sides = (r: ReturnType<typeof bySide>) => r.map((g) => `${g.facing} ${g.rows.map((x) => x[0]).join()} ${g.w.join()}`);
  it('faces of a single-mesh model by the side they face, in compass order; north turns them; a back column faces the other way', () => {
    expect(sides(bySide(values, [one], 'faces', 0, false))).toEqual(['N 6,7 7,8', 'E 2,3 3,4', 'S 4,5 5,6', 'W 0,1 1,2', 'up 8,9 9,10']);
    expect(sides(bySide(values, [one], 'faces', 90, false)).map((g) => g.split(' ').slice(0, 2).join(' '))).toEqual(['N 0,1', 'E 6,7', 'S 2,3', 'W 4,5', 'up 8,9']); // north 90: model -X
    expect(sides(bySide(values, [one], 'faces', 0, true)).map((g) => g.split(' ').slice(0, 2).join(' '))).toEqual(['N 4,5', 'E 0,1', 'S 6,7', 'W 2,3', 'down 8,9']);
  });
  it('vertices along their faces\' normals, rows from each mesh\'s first; a degenerate element is left out', () => {
    const wall = { first: 0, count: 4, positions: quads[1].flat(), indices: [0, 1, 2, 0, 2, 3], w: [1, 1, 1, 1] };
    const roof = { first: 4, count: 5, positions: [...quads[4].flat(), 5, 5, 6], indices: [0, 1, 2, 0, 2, 3], w: [2, 2, 2, 2, 2] }; // vertex 4: on no face
    const rows = Array.from({ length: 9 }, (_, i) => Float64Array.of(i));
    expect(sides(bySide(rows, [wall, roof], 'vertices', 0, false))).toEqual(['E 0,1,2,3 1,1,1,1', 'up 4,5,6,7 2,2,2,2']);
  });
});

describe('screenshot size', () => {
  it('the long side at most 1568 px, the aspect kept unless the short side would fall under 16 px; at most 8 MP asked', () => {
    expect(shotSize(1280, 800)).toEqual({ width: 1280, height: 800, reshaped: false });
    expect(shotSize(2400, 600)).toEqual({ width: 1568, height: 392, reshaped: false });
    expect(shotSize(600, 2400)).toEqual({ width: 392, height: 1568, reshaped: false });
    expect(shotSize(8192, 82)).toEqual({ width: 1568, height: 16, reshaped: false }); // 15.7 rounds to 16
    expect(shotSize(8192, 16)).toEqual({ width: 1568, height: 16, reshaped: true });
    expect(() => shotSize(4000, 2001)).toThrow(/^width: 4000 x 2001 px is over 8 megapixels/);
  });
});

describe('bridge', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('until resolves at once or after a commit, else rejects naming what it waited for', async () => {
    await until(() => true, 10, 'nothing');
    let flag = false;
    const p = until(() => flag, 1000, 'the flag');
    flag = true;
    settled();
    await p;
    await expect(until(() => false, 10, 'the model to load')).rejects.toThrow('timed out after 0 s waiting for the model to load');
  });

  it('exclusive runs one step at a time, in order, past a failure', async () => {
    const order: string[] = [];
    const a = exclusive(async () => { await new Promise((r) => setTimeout(r, 10)); order.push('a'); });
    const b = exclusive(() => { throw new Error('b'); });
    const c = exclusive(() => order.push('c'));
    await expect(b).rejects.toThrow('b');
    await Promise.all([a, c]);
    expect(order).toEqual(['a', 'c']);
  });

  it('polls, answers a call once, polls again on 204, stops on 403', async () => {
    const id = '1b4e28ba-2fa1-41d2-883f-0016d3cca427', body = `{"id": "${id}", "params": {"name": "app_state", "arguments": {}}}`; // as the server writes it
    const polls = [() => new Response(body, { headers: { 'Content-Type': 'application/json' } }), () => new Response(body, { headers: { 'Content-Type': 'application/json' } }), () => new Response(null, { status: 204 }), () => new Response('error: agent routes answer only on this machine\n', { status: 403 })];
    const seen: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      return url.includes('wait=25') ? polls.shift()!() : new Response(null, { status: 204 });
    }));
    vi.stubGlobal('document', { hasFocus: () => true, visibilityState: 'visible', addEventListener: vi.fn(), removeEventListener: vi.fn() });
    const win = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
    vi.stubGlobal('window', win);
    const handle = vi.fn(async () => ({ content: [{ type: 'text' as const, text: '{"ok":true}' }] }));
    startBridge(handle);
    await vi.waitFor(() => expect(polls.length).toBe(0));
    await vi.waitFor(() => expect(seen.some((s) => s.url.includes('/bridge/result/'))).toBe(true));
    await new Promise((r) => setTimeout(r, 20));
    expect(win.removeEventListener).toHaveBeenCalledWith('focus', win.addEventListener.mock.calls[0][1]); // stopped: no more pings either
    expect(handle).toHaveBeenCalledTimes(1); // the repeated id is not answered twice
    expect(handle).toHaveBeenCalledWith('app_state', {});
    const post = seen.find((s) => s.url === `/bridge/result/${id}`)!;
    expect(post.init?.method).toBe('POST');
    expect((post.init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(post.init?.body as string)).toEqual({ content: [{ type: 'text', text: '{"ok":true}' }] });
    const gets = seen.filter((s) => s.url.startsWith('/bridge/next'));
    expect(gets.filter((s) => s.url.includes('wait=25'))).toHaveLength(4); // nothing after the 403
    expect(gets.some((s) => s.url === '/bridge/next?wait=0&focus=1')).toBe(true); // the focused tab says so
    const tabs = new Set(gets.map((s) => (s.init?.headers as Record<string, string>)['X-Client-Id']));
    expect(tabs.size).toBe(1);
    expect([...tabs][0]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('a call waiting for a pickup past its budget answers isError and does not run', async () => {
    vi.useFakeTimers();
    let release!: (r: Response) => void; // GET /session: the pickup, answered at the end
    const posted: unknown[] = [], polls = [
      () => new Response('{"id": "1b4e28ba-2fa1-41d2-883f-0016d3cca428", "params": {"name": "app_state", "arguments": {}}}', { headers: { 'Content-Type': 'application/json' } }),
      () => new Response('error: agent routes answer only on this machine\n', { status: 403 }),
    ];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/session') return init?.method ? new Response(null, { status: 204 }) : new Promise<Response>((r) => { release = r; });
      if (url.startsWith('/bridge/result/')) posted.push(JSON.parse(init?.body as string));
      return url.includes('wait=25') ? polls.shift()!() : new Response(null, { status: 204 });
    }));
    vi.stubGlobal('document', { hasFocus: () => false, visibilityState: 'visible', addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    const ctl = vi.fn(), stop = connect(ctl); // the handler would read the controller
    await vi.advanceTimersByTimeAsync(40e3);
    expect(posted).toEqual([]); // still waiting
    await vi.advanceTimersByTimeAsync(2e3);
    expect(posted).toEqual([{ content: [{ type: 'text', text: 'app_state: the app is still taking over the hidden session; call app_state again in a moment' }], isError: true }]);
    expect(ctl).not.toHaveBeenCalled();
    release(new Response(null, { status: 404 }));
    stop();
  });
});
