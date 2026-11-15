// Smoke test of daylight_server: the job API on a plain server (a job that fails in the core fails alone, the next
// runs, an identical request is a cache hit, finished jobs go after their TTL); then --mcp in Claude-only mode (no app
// tab): the agent routes off without --mcp; the
// local-only gate; the MCP handshake; the fixture (building.usda) walked through tools/call in the hidden instance the
// server starts: options A and B, runs, results, find_critical, a 4:1 screenshot, sections (view only; a shot's own), a
// parts chart, a receiver that casts no shade (set_roles shade false), and guide 'report''s two example reports generated
// to PDF (one with a sectioned figure, which differs from the same without its section); then Claude Desktop's stdio
// relay (mcp-stdio.mjs). Node 18+, no packages.
// Run: node server/test/mcp-smoke.mjs --web <app dist dir> [--exe <daylight_server.exe>] [--port 18100]
// It starts its own servers on --port (no --mcp) and --port + 1 (--mcp --web), each with a cache in a fresh temporary
// folder (kept when a check fails: server logs, reports), and needs the GPU and Chrome or Edge. One PASS / FAIL line per
// check with what it saw; exit 1 when one fails.
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { networkInterfaces, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const here = fileURLToPath(new URL('.', import.meta.url));
const { values: opt } = parseArgs({ options: { web: { type: 'string' }, exe: { type: 'string' }, port: { type: 'string', default: '18100' } } });
const exe = resolve(opt.exe ?? join(here, '../build/RelWithDebInfo/daylight_server.exe'));
if (!opt.web || !existsSync(exe)) {
  console.error(!opt.web ? 'usage: node server/test/mcp-smoke.mjs --web <app dist dir> [--exe <daylight_server.exe>] [--port 18100]\n' +
    'Build the app for it with: cd web && npx vite build --outDir <dir>' : `no daylight_server at ${exe}: build it, or pass --exe`);
  process.exit(2);
}
const web = resolve(opt.web), OFF = Number(opt.port), ON = OFF + 1, cache = mkdtempSync(join(tmpdir(), 'mcp-smoke-')), t0 = Date.now();
const BUILDING = join(here, 'building.usda'), FAC = [...'NESW'].map((s) => `/Site/Block/Facade_${s}`).concat('/Site/Block/Roof');
const NAMES = JSON.parse(readFileSync(join(here, '../mcp.json'), 'utf8')).tools.map((t) => t.name);
const JSONH = { 'Content-Type': 'application/json' }, PING = JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'ping' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)), brief = (s) => s.replace(/\s+/g, ' ').trim().slice(0, 200);

let total = 0, failed = 0;
const check = (what, ok, saw) => { total++; if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${what}: ${saw}`); };
/** One part of the test: a throw ends it with a FAIL, and the next part runs. */
const part = async (name, fn) => { try { await fn(); } catch (e) { check(`${name} stopped`, false, e.message); } };

/** One HTTP request with exactly these headers (Host 127.0.0.1:port unless given): {status, headers, body, text}. */
function http(port, method, path, { headers = {}, body, host = '127.0.0.1' } = {}) {
  return new Promise((done, fail) => {
    const req = request({ host, port, method, path, headers: { Host: `127.0.0.1:${port}`, ...headers }, agent: false, timeout: 70e3 }, (res) => {
      const chunks = [];
      res.on('data', (b) => chunks.push(b)).on('end', () => { const b = Buffer.concat(chunks); done({ status: res.statusCode, headers: res.headers, body: b, text: b.toString() }); });
    });
    req.on('timeout', () => req.destroy(new Error(`${method} ${path}: no answer within 70 s`))).on('error', fail);
    req.end(body);
  });
}
const parse = (r) => { try { return JSON.parse(r.text); } catch { throw new Error(`HTTP ${r.status}: ${brief(r.text)}`); } };

let rpcId = 0;
/** One JSON-RPC message to POST /mcp as Claude Code sends it (the version header once initialized). */
const rpc = (method, params, headers = {}) => http(ON, 'POST', '/mcp', {
  headers: { ...JSONH, ...(method === 'initialize' ? {} : { 'MCP-Protocol-Version': '2025-06-18' }), ...headers },
  body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, ...(params ? { params } : {}) }),
});
/** A tools/call: isError, its text (a note may come before the JSON), that JSON object (null for prose), its images. */
async function tool(name, args = {}) {
  const r = await rpc('tools/call', { name, arguments: args }), res = parse(r).result;
  if (!res) throw new Error(`${name}: ${brief(r.text)}`);
  const text = res.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n'), i = text.indexOf('{');
  let json = null;
  try { if (i >= 0) json = JSON.parse(text.slice(i)); } catch { /* prose: a guide, an error */ }
  return { err: !!res.isError, text, json, images: res.content.filter((c) => c.type === 'image') };
}
/** The call again while busy(reply) says the work goes on (starting, running, generating). */
async function again(name, args, busy) {
  let r = await tool(name, args);
  for (let k = 0; k < 5 && busy(r); k++) r = await tool(name, args);
  return r;
}
/** A call that is a check of its own: pass(reply), by default no isError. */
async function step(what, name, args, pass = (r) => !r.err) {
  const r = await tool(name, args);
  check(what, pass(r), brief(r.text));
  return r;
}
const least = (rows) => rows.reduce((a, b) => (b.mean < a.mean ? b : a), rows[0]); // the row with the least mean

/** Width and height from a PNG's IHDR or a JPEG's SOF0 / SOF2 marker (segment by segment after SOI); null if neither. */
function imageSize(b) {
  if (b.readUInt32BE(0) === 0x89504e47) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  for (let i = 2; b[i] === 0xff && i + 9 <= b.length; i += 2 + b.readUInt16BE(i + 2))
    if (b[i + 1] === 0xc0 || b[i + 1] === 0xc2) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
  return null;
}

const servers = [];
/** daylight_server on `port` with its own cache and log under ours; resolves once /health answers. */
async function start(port, args) {
  if (await http(port, 'GET', '/health').then(() => true, () => false)) throw new Error(`port ${port} is taken`);
  const log = openSync(join(cache, `server-${port}.log`), 'w');
  const p = spawn(exe, ['--port', `${port}`, '--cache', join(cache, `${port}`), ...args], { stdio: ['ignore', 'ignore', log] });
  closeSync(log);
  p.exited = new Promise((r) => p.once('exit', r).once('error', r));
  servers.push(p);
  for (const end = Date.now() + 30e3; Date.now() < end; await sleep(250)) {
    if (p.exitCode !== null) throw new Error(`daylight_server --port ${port} exited (${p.exitCode}): see ${cache}`);
    if (await http(port, 'GET', '/health').then((r) => r.status === 200, () => false)) return p;
  }
  throw new Error(`daylight_server --port ${port} did not answer /health within 30 s`);
}
const stop = (p) => { p.kill(); return p.exited; }; // the server's job object takes the hidden Chrome down with it
process.on('exit', () => servers.forEach((p) => p.kill()));
process.on('SIGINT', () => process.exit(130));

console.log(`daylight_server ${exe}\napp ${web}\nports ${OFF} (agent routes off) and ${ON} (--mcp), cache ${cache}`);

// 1. Without --mcp every agent route answers 404. This plain server also takes the job API steps, and stays up until the
// end so its finished jobs can outlive their 1-minute TTL meanwhile.
let off, lastJob = 0;
await part('off', async () => {
  off = await start(OFF, ['--job-ttl-min', '1']);
  for (const [method, path] of [['POST', '/mcp'], ['GET', '/bridge/next'], ['GET', '/files?path=C:/x.usda'], ['GET', '/reports'], ['GET', '/session']]) {
    const r = await http(OFF, method, path, method === 'POST' ? { headers: JSONH, body: PING } : {});
    check(`off: ${method} ${path} -> 404`, r.status === 404, `${r.status} ${brief(r.text)}`);
  }
});

// A 10 m roof quad facing up as a .dmesh: "DLM1", flags, n_points, n_faces, n_indices, xyz float64, counts, indices int32.
function quad() {
  const b = Buffer.alloc(32 + 4 * 24 + 4 + 16);
  b.write('DLM1', 0, 'ascii'); b.writeBigUInt64LE(4n, 8); b.writeBigUInt64LE(1n, 16); b.writeBigUInt64LE(4n, 24);
  [[0, 0, 3], [10, 0, 3], [10, 10, 3], [0, 10, 3]].flat().forEach((v, i) => b.writeDoubleLE(v, 32 + 8 * i));
  b.writeInt32LE(4, 128);
  [0, 1, 2, 3].forEach((v, i) => b.writeInt32LE(v, 132 + 4 * i));
  return b;
}
/** POST /run (multipart) with sensor mesh ids and CLI args: {status, text}. */
async function runSync(port, sensors, args) {
  const fd = new FormData();
  for (const s of sensors) fd.append('sensors', s);
  for (const a of args) fd.append('args', a);
  const r = await fetch(`http://127.0.0.1:${port}/run`, { method: 'POST', body: fd });
  return { status: r.status, text: await r.text() };
}

// 1b. The job API: a failing job fails alone (the server stays up and takes the next), an identical request is a cache hit
if (off) await part('api', async () => {
  const put = await http(OFF, 'PUT', '/mesh/smoke-quad', { headers: { 'Content-Type': 'application/octet-stream' }, body: quad() });
  check('api: PUT /mesh/smoke-quad -> 204', put.status === 204, `${put.status} ${brief(put.text)}`);
  const miss = await http(OFF, 'POST', '/meshes/missing', { headers: JSONH, body: JSON.stringify({ ids: ['nope-1', 'smoke-quad', 'nope-2'] }) });
  check('api: /meshes/missing names the unknown ids in order', miss.status === 200 && JSON.stringify(parse(miss).missing) === '["nope-1","nope-2"]', `${miss.status} ${brief(miss.text)}`);
  const NOON = ['--quantity', 'sunhours', '--lat', '51.5', '--lon', '0', '--tz', '0', '--time', '06-21T12:00'];
  const bad = await runSync(OFF, ['smoke-quad'], [...NOON, '--no-occlude', 'nosuchmesh']);
  check('api: a job that fails in the core -> 500, with the reason', bad.status === 500 && /no mesh of that name/.test(bad.text), `${bad.status} ${brief(bad.text)}`);
  const ok = await runSync(OFF, ['smoke-quad'], NOON), again = await runSync(OFF, ['smoke-quad'], NOON);
  lastJob = Date.now();
  check('api: the next job runs -> 200 with values', ok.status === 200 && /"values_b64"/.test(ok.text), `${ok.status} ${brief(ok.text)}`);
  const okJson = ok.status === 200 ? JSON.parse(ok.text) : {};
  check('api: a run reports where its time went', okJson.timing?.traceMs > 0 && okJson.gpu?.rays > 0 && okJson.timing.totalMs > 0,
    brief(JSON.stringify({ timing: okJson.timing, gpu: okJson.gpu })));
  check('api: the same request again -> cache hit', again.status === 200 && /"response": "hit"/.test(again.text), `${again.status} ${brief(again.text.slice(again.text.indexOf('"cache"')))}`);
  const h = parse(await http(OFF, 'GET', '/health'));
  check('api: /health ok after a failed job', h.status === 'ok' && h.jobs_retained >= 1, JSON.stringify(h));

  // binary values: a job's JSON links them (no values_b64 unless ?inline=1); GET .../values is float32 column-major,
  // equal to the inline values (float64 row-major) rounded to float32; ?col=k is one column
  const fd = new FormData();
  fd.append('sensors', 'smoke-quad');
  for (const a of [...NOON, '--sides', 'both']) fd.append('args', a);
  const sub = await (await fetch(`http://127.0.0.1:${OFF}/jobs`, { method: 'POST', body: fd })).json();
  let job = sub;
  for (let k = 0; k < 10 && !['done', 'error', 'cancelled'].includes(job.state); k++) job = parse(await http(OFF, 'GET', `/jobs/${sub.id}?wait=25`));
  check('api: a done job links its values, no values_b64', job.state === 'done' && job.values?.url === `/jobs/${sub.id}/values` && job.rows === 1 && job.cols === 2 && !('values_b64' in job),
    brief(JSON.stringify({ state: job.state, values: job.values, rows: job.rows, cols: job.cols, b64: 'values_b64' in job })));
  const inl = parse(await http(OFF, 'GET', `/jobs/${sub.id}?inline=1`)), b64 = Buffer.from(inl.values_b64 ?? '', 'base64');
  const rowMajor = Array.from({ length: b64.length / 8 }, (_, i) => b64.readDoubleLE(8 * i)); // [rows x cols]
  const bin = await http(OFF, 'GET', `/jobs/${sub.id}/values`), col1 = await http(OFF, 'GET', `/jobs/${sub.id}/values?col=1`);
  const f32 = (b) => Array.from({ length: b.length / 4 }, (_, i) => b.readFloatLE(4 * i));
  const colMajor = f32(bin.body), want = [0, 1].flatMap((c) => [Math.fround(rowMajor[c])]); // 1 row: column c is value c
  check('api: /values = float32 column-major of the inline values', bin.status === 200 && bin.body.length === 8 && JSON.stringify(colMajor) === JSON.stringify(want),
    `${bin.status} ${bin.body.length} B ${JSON.stringify(colMajor)} vs ${JSON.stringify(want)}`);
  check('api: /values?col=1 is column 1', col1.status === 200 && JSON.stringify(f32(col1.body)) === JSON.stringify([want[1]]), `${col1.status} ${JSON.stringify(f32(col1.body))}`);

  // POST /run answers its values inline: a result over 4,194,304 values is refused before it is queued (a 1000 x 1000
  // quad grid named five times = 5M rows; never traced)
  const n = 1000, g = Buffer.alloc(32 + (n + 1) * (n + 1) * 24 + n * n * 20);
  g.write('DLM1', 0, 'ascii'); g.writeBigUInt64LE(BigInt((n + 1) * (n + 1)), 8); g.writeBigUInt64LE(BigInt(n * n), 16); g.writeBigUInt64LE(BigInt(4 * n * n), 24);
  let o = 32;
  for (let y = 0; y <= n; y++) for (let x = 0; x <= n; x++, o += 24) { g.writeDoubleLE(x, o); g.writeDoubleLE(y, o + 8); g.writeDoubleLE(0, o + 16); }
  for (let f = 0; f < n * n; f++, o += 4) g.writeInt32LE(4, o);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) for (const [dx, dy] of [[0, 0], [1, 0], [1, 1], [0, 1]]) { g.writeInt32LE((y + dy) * (n + 1) + x + dx, o); o += 4; }
  const putGrid = await http(OFF, 'PUT', '/mesh/smoke-grid', { headers: { 'Content-Type': 'application/octet-stream' }, body: g });
  const big = await runSync(OFF, Array(5).fill('smoke-grid'), NOON);
  check('api: POST /run over the inline cap -> 413', putGrid.status === 204 && big.status === 413 && /POST \/jobs/.test(big.text), `${putGrid.status}; ${big.status} ${brief(big.text)}`);
});

// 2. With --mcp: this machine only, then MCP over HTTP
let on;
await part('start --mcp', async () => { on = await start(ON, ['--mcp', '--web', web]); });
if (on) await part('gate', async () => {
  const gate = async (what, headers, want, host) => {
    const r = await http(ON, 'POST', '/mcp', { headers: { ...JSONH, ...headers }, body: PING, host });
    check(`gate: ${what} -> ${want}`, r.status === want, `${r.status} ${brief(r.text)}`);
  };
  await gate('Host evil.example', { Host: 'evil.example' }, 403);
  await gate('Origin http://evil.example', { Origin: 'http://evil.example' }, 403);
  await gate('X-Forwarded-For', { 'X-Forwarded-For': '203.0.113.7' }, 403);
  await gate('Sec-Fetch-Site: cross-site', { 'Sec-Fetch-Site': 'cross-site' }, 403);
  await gate('Content-Type text/plain', { 'Content-Type': 'text/plain' }, 403);
  await gate(`Host localhost:${ON} with a JSON body`, { Host: `localhost:${ON}` }, 200);
  const lan = Object.values(networkInterfaces()).flat().find((a) => [4, 'IPv4'].includes(a.family) && !a.internal)?.address;
  if (lan) await gate(`a LAN peer (${lan}, Host 127.0.0.1)`, {}, 403, lan); // only the TCP peer differs
  else console.log('SKIP gate: a LAN peer: this machine has no LAN address');
});

if (on) await part('protocol', async () => {
  for (const v of ['2025-11-25', '2025-06-18', '2025-03-26']) {
    const r = parse(await rpc('initialize', { protocolVersion: v, capabilities: {}, clientInfo: { name: 'mcp-smoke', version: '1' } })).result;
    check(`initialize ${v} -> echoed`, r?.protocolVersion === v && !!r.serverInfo?.name && !!r.instructions,
      `protocolVersion ${r?.protocolVersion}, serverInfo ${JSON.stringify(r?.serverInfo)}, instructions ${r?.instructions?.length ?? 0} chars`);
  }
  const probe = await rpc('tools/list', null, { 'MCP-Protocol-Version': '2099-01-01' });
  check('tools/list with MCP-Protocol-Version 2099-01-01 -> 400', probe.status === 400, `${probe.status} ${brief(probe.text)}`);
  const get = await http(ON, 'GET', '/mcp');
  check('GET /mcp -> 405, Allow: POST', get.status === 405 && get.headers.allow === 'POST', `${get.status}, Allow ${get.headers.allow}`);
  const note = await http(ON, 'POST', '/mcp', { headers: JSONH, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  check('a notification -> 202', note.status === 202, `${note.status} '${note.text}'`);
  const unknown = await rpc('nope/unknown');
  check('an unknown method -> -32601', unknown.status === 200 && parse(unknown).error?.code === -32601, `${unknown.status} ${brief(unknown.text)}`);
  const names = parse(await rpc('tools/list')).result?.tools?.map((t) => t.name) ?? [];
  check(`tools/list -> the ${NAMES.length} tools of mcp.json`, JSON.stringify(names) === JSON.stringify(NAMES), `${names.length}: ${names.join(', ')}`);
  const ping = await rpc('ping');
  check('ping -> {}', JSON.stringify(parse(ping).result) === '{}', ping.text);
});

// 3. Claude only: no app tab, so the first tools/call starts the hidden instance (up to 55 s; again while it starts)
if (on) await part('walk', async () => {
  const st = await again('app_state', {}, (r) => r.err && /starting/.test(r.text));
  check('the first reply says it is the hidden instance', !st.err && /hidden app instance/.test(st.text) && st.json?.tab?.kind === 'hidden', brief(st.text));
  // option A: the fixture, 21 March 08:00 to 18:00 sun hours on a clear day, problem range below 2 h
  await step('open_model -> A', 'open_model', { paths: [BUILDING] }, (r) => r.json?.model === 'A');
  await step('set_roles /Site/Block receiver', 'set_roles', { paths: ['/Site/Block'], role: 'receiver' });
  await step('set_roles /Site/Neighbour shade', 'set_roles', { paths: ['/Site/Neighbour'], role: 'shade' });
  await step('update_settings: 21 March range, sun hours, clear sky, below 2 h', 'update_settings', {
    time: { mode: 'range', from: { date: '2026-03-21', hour: '08:00' }, to: { date: '2026-03-21', hour: '18:00' }, step: 15 },
    sim: { quantities: ['sunhours'] }, weather: { source: 'clear-sky' }, viz: { quantity: 'sunhours', below: 2 },
  });
  const running = (r) => r.json?.status === 'running', done = (r) => r.json?.status === 'done' && r.json.models.every((m) => m.status === 'done');
  let run = await again('run', {}, running);
  check('run -> A done', done(run), brief(run.text));
  const parts = (await tool('results', { models: ['A'], column: 'sunhours_front', paths: FAC })).json?.models?.[0]?.rows ?? [];
  check("results by 'parts': Facade_S least sun", least(parts)?.path === FAC[2], parts.map((r) => `${r.path.split('/').pop()} ${r.mean} h`).join(', '));
  const sides = (await tool('results', { models: ['A'], column: 'sunhours_front', by: 'facing' })).json?.models?.[0]?.rows ?? [];
  check("results by 'facing': S least sun", least(sides)?.facing === 'S', sides.map((r) => `${r.facing} ${r.mean} h`).join(', '));
  const crit = await tool('find_critical', { model: 'A', column: 'sunhours_front', below: 2 }), g = crit.json?.groups?.[0];
  check('find_critical below 2 -> Facade_S / S first', g?.mesh === FAC[2] && g.facing === 'S', g ? `${g.mesh} ${g.facing}, ${g.area} m², mean ${g.mean} h` : brief(crit.text));
  const shot = await tool('screenshot', { width: 2400, height: 600, column: 'sunhours_front' }), img = shot.images[0];
  const size = img && imageSize(Buffer.from(img.data, 'base64'));
  check('screenshot 2400 x 600 -> 4:1', !!size && Math.abs(size.w / size.h - 4) < 0.01, size ? `${img.mimeType} ${size.w} x ${size.h}` : brief(shot.text));
  // sections: view only, so the result stays fresh; a shot through one differs from one without
  const said = (r) => brief(r.text.slice(r.text.indexOf('Section:'))), plan = { on: true, planes: [{ point: [0, 0, 5], normal: [0, 0, -1] }], boxes: [] };
  const plain = await tool('screenshot', { width: 640, height: 400, section: null });
  await step('set_display section: a plan cut at 5 m', 'set_display', { section: { planes: plan.planes } }, (r) => JSON.stringify(r.json?.section) === JSON.stringify(plan));
  const after = await tool('app_state');
  check('a section leaves the result fresh', after.json?.models?.[0]?.result === 'fresh' && JSON.stringify(after.json.display?.section) === JSON.stringify(plan), `result ${after.json?.models?.[0]?.result}, section ${JSON.stringify(after.json?.display?.section)}`);
  const cut = await tool('screenshot', { width: 640, height: 400 }), [whole, through] = [plain.images[0]?.data, cut.images[0]?.data];
  check('a sectioned screenshot differs from the unsectioned one', !!whole && !!through && whole !== through && /Section: none\./.test(plain.text) && /Section: horizontal at 5\.00 m, keeps below\./.test(cut.text),
    `${said(plain)} | ${said(cut)} | images ${whole === through ? 'equal' : 'different'}`);
  // a shot's own section is that shot's only: null shows none over the live cut, and after one of its own the live cut is back
  const none = await tool('screenshot', { width: 640, height: 400, section: null });
  const own = await tool('screenshot', { width: 640, height: 400, section: { boxes: [{ keep: 'outside', paths: [FAC[4]] }] } });
  const back = await tool('screenshot', { width: 640, height: 400 }), [n, o, b] = [none, own, back].map((r) => r.images[0]?.data);
  check("a shot's own section is that shot's only", !!n && !!o && n !== through && o !== through && b === through && /Section: horizontal at 5\.00 m, keeps below\./.test(back.text),
    `null ${n === through ? 'equals' : 'differs from'} the live cut, its own ${o === through ? 'equals' : 'differs from'} it, the next default shot ${b === through ? 'equals' : 'differs from'} it; ${said(back)}`);
  if (g) {
    const boxed = await tool('set_display', { section: { boxes: [{ keep: 'inside', box: g.box, margin: 1 }, { keep: 'outside', paths: [FAC[4]] }] } }), bs = boxed.json?.section?.boxes ?? [];
    check("set_display section: find_critical's box and a box round the roof -> footprints", !boxed.err && bs.length === 2 && bs.every((b) => b.footprint?.length === 4 && b.top > b.bottom), brief(boxed.text));
  }
  await step('set_display section {planes: [], boxes: []} clears it', 'set_display', { section: { planes: [], boxes: [] } }, (r) => JSON.stringify(r.json?.section) === JSON.stringify({ on: true, planes: [], boxes: [] }));
  await step('update_settings adds a parts chart', 'update_settings', { charts: [{ id: 'facades', kind: 'parts', column: 'sunhours_front', parts: FAC, metric: 'mean', range: 'absolute' }] });
  const charts = (await tool('app_state')).json?.settings?.charts ?? [];
  check('app_state lists it', charts.some((c) => c.id === 'facades' && c.kind === 'parts'), charts.map((c) => `${c.id} (${c.kind})`).join(', '));
  // a receiver that casts no shade: the neighbour measured but out of the scene, so Facade_S gets the sun it kept off; then a shade again
  await step('set_roles /Site/Neighbour receiver, shade false', 'set_roles', { paths: ['/Site/Neighbour'], role: 'receiver', shade: false }, (r) => r.json?.meshes?.noShade === 1);
  run = await again('run', {}, running);
  const open = (await tool('results', { models: ['A'], column: 'sunhours_front', paths: [FAC[2]] })).json?.models?.[0], [shaded, unshaded] = [parts.find((r) => r.path === FAC[2])?.mean, open?.rows?.[0]?.mean];
  const sent = open?.run?.args?.join(' ') ?? '';
  check('a receiver with shade false shades nothing: Facade_S gets more sun, the run sends --no-occlude', done(run) && unshaded > shaded && sent.includes('--no-occlude /Site/Neighbour'),
    `Facade_S ${shaded} h behind the neighbour as shade, ${unshaded} h with it a receiver casting none; ${/--no-occlude \S+/.exec(sent)?.[0] ?? 'no --no-occlude'}`);
  await step('set_roles /Site/Neighbour shade again', 'set_roles', { paths: ['/Site/Neighbour'], role: 'shade' }, (r) => !r.err && r.json?.meshes?.noShade === undefined);
  // option B: the same file with the overhang variant
  await step('open_model -> B', 'open_model', { paths: [BUILDING], model: 'B' }, (r) => r.json?.model === 'B');
  await step('set_geometry B option overhang', 'set_geometry', { model: 'B', variant: { path: '/Site/Block', set: 'option', value: 'overhang' } });
  await step('set_roles B /Site/Block receiver', 'set_roles', { model: 'B', paths: ['/Site/Block'], role: 'receiver' });
  await step('set_roles B overhang and neighbour shade', 'set_roles', { model: 'B', paths: ['/Site/Block/Overhang', '/Site/Neighbour'], role: 'shade' });
  run = await again('run', {}, running);
  check('run -> A and B done', done(run) && run.json.models.length === 2, brief(run.text));

  // reports: guide 'report''s two examples, saved and generated as they are
  const guide = await tool('guide', { topic: 'report' });
  const specs = [...guide.text.matchAll(/```json([\s\S]*?)```/g)]
    .flatMap((m) => { try { return [JSON.parse(m[1])]; } catch { return []; } }).filter((s) => Array.isArray(s.models) && Array.isArray(s.blocks));
  check("guide 'report' -> two example specs", specs.length === 2, specs.map((s) => `${s.id} (${s.models.join(', ')})`).join('; '));
  check("guide 'report' carries the kit-report skill", /^# kit-report$/m.test(guide.text), `${guide.text.length} characters`);
  await step("guide 'kit-ui' -> the skill and the class reference", 'guide', { topic: 'kit-ui' }, (r) => !r.err && /^# kit-ui$/m.test(r.text) && /^# kit-ui reference$/m.test(r.text));
  const sectioned = specs.filter((s) => s.blocks.some((b) => b.type === 'view' && b.section)).map((s) => s.id);
  check("guide 'report' -> one example with a sectioned figure", sectioned.length === 1, sectioned.join(', ') || 'none');
  for (const spec of specs) {
    await step(`save_report ${spec.id} -> valid, ready`, 'save_report', { spec }, (r) => !r.err && r.json?.ready === true);
    const gen = await again('generate_report', { id: spec.id }, (r) => r.json?.status === 'generating'), p = gen.json ?? {}, u = p.url && new URL(p.url);
    const pdf = u ? await http(Number(u.port), 'GET', u.pathname) : null, head = pdf?.body.subarray(0, 5).toString();
    check(`generate_report ${spec.id}${sectioned.includes(spec.id) ? ' (a sectioned figure)' : ''} -> PDF`, !gen.err && p.pages >= 1 && Array.isArray(p.fallback) && !p.fallback.length && pdf?.status === 200 && head === '%PDF-',
      gen.err ? brief(gen.text) : `${p.pages} pages, ${p.bytes} bytes, fonts ${p.fonts}, fallback [${p.fallback}]; GET ${p.url} -> ${pdf?.status} ${head}`);
    if (!sectioned.includes(spec.id) || gen.err) continue;
    const page = readFileSync(join(cache, `${ON}`, 'reports', spec.id, 'index.html'), 'utf8').replace(/<!-- -->/g, ''), words = /[^.>]*is sectioned[^<]*/.exec(page)?.[0];
    check(`${spec.id}: the Method says its figure is sectioned, its values of the whole model`, /is sectioned \(1 plane\); values are of the whole model\./.test(page), words ?? 'not said');
    // the same report without the section: other images, so the figure was shot with the block's own section
    const copy = { ...spec, id: `${spec.id}-whole`, blocks: spec.blocks.map(({ section: _, ...b }) => b) };
    await step(`save_report ${copy.id}: the same without the section`, 'save_report', { spec: copy }, (r) => !r.err && r.json?.ready === true);
    const plainGen = await again('generate_report', { id: copy.id }, (r) => r.json?.status === 'generating');
    const images = (id) => [...readFileSync(join(cache, `${ON}`, 'reports', id, 'index.html'), 'utf8').matchAll(/src="data:image\/png;base64,([^"]+)"/g)].map((m) => m[1]);
    const [cutImages, wholeImages] = plainGen.err ? [[], []] : [images(spec.id), images(copy.id)];
    check(`${spec.id}: its figure differs from the same figure without the section`, cutImages.length > 0 && cutImages.length === wholeImages.length && cutImages.every((s, k) => s !== wholeImages[k]),
      plainGen.err ? brief(plainGen.text) : `${cutImages.length} and ${wholeImages.length} images, ${cutImages.filter((s, k) => s !== wholeImages[k]).length} differ`);
  }
  const one = specs.find((s) => s.models.length === 1);
  if (!one) return;
  // the PDF is a print of index.html: its stat row against results for the same model, column and path
  const page = readFileSync(join(cache, `${ON}`, 'reports', one.id, 'index.html'), 'utf8');
  const printed = [...page.matchAll(/class="stat__value">(.*?)<\/span>/g)].map((m) => parseFloat(m[1].replace(/<!-- -->|,/g, '')));
  const want = [];
  for (const s of one.stats ?? []) {
    const m = (await tool('results', { models: [s.model], column: s.column, ...(s.path ? { paths: [s.path] } : {}) })).json?.models?.[0];
    want.push((s.path ? m?.rows?.[0] : m?.whole)?.[s.metric]);
  }
  check(`${one.id}: printed stats equal results`, printed.length > 0 && JSON.stringify(printed) === JSON.stringify(want), `page ${printed.join(', ')}; results ${want.join(', ')}`);
  // the print takes no page that would navigate it elsewhere (its CSP stops loads, not a refresh to a local file)
  const refresh = await http(ON, 'POST', `/reports/${one.id}/pdf`, { headers: { 'Content-Type': 'text/html' }, body: '<!doctype html><meta HTTP-EQUIV="Refresh" content="0; url=file:///C:/Windows/win.ini">' });
  check('POST /reports/{id}/pdf with a meta refresh -> 400', refresh.status === 400, `${refresh.status} ${brief(refresh.text)}`);
  await step('save_report with a stale updated -> refused', 'save_report', { spec: one, updated: '2000-01-01T00:00:00.000Z' }, (r) => r.err && /changed in the app since/.test(r.text));
  await step(`delete_report ${one.id}`, 'delete_report', { id: one.id });
  await step(`get_report ${one.id} after it -> isError`, 'get_report', { id: one.id }, (r) => r.err);
});

// 4. Claude Desktop's relay: stdin lines in, the same answers out; a notification gets none
if (on) await part('stdio', async () => {
  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mcp-smoke', version: '1' } } };
  const list = { jsonrpc: '2.0', id: 2, method: 'tools/list' }, note = { jsonrpc: '2.0', method: 'notifications/initialized' };
  const relay = spawn(process.execPath, [join(here, '../mcp-stdio.mjs'), `http://127.0.0.1:${ON}/mcp`], { stdio: ['pipe', 'pipe', 'ignore'] }), lines = [];
  createInterface({ input: relay.stdout }).on('line', (l) => lines.push(l));
  relay.stdin.write([init, note, list].map((m) => `${JSON.stringify(m)}\n`).join(''));
  for (const end = Date.now() + 15e3; lines.length < 2 && Date.now() < end;) await sleep(100);
  await sleep(1500); // room for an answer the notification must not get
  relay.kill();
  const answer = (id) => lines.map((l) => JSON.parse(l)).find((m) => m.id === id); // the relay re-serialises: compare as JSON
  const viaHttp = async (m) => JSON.stringify(parse(await http(ON, 'POST', '/mcp', { headers: JSONH, body: JSON.stringify(m) })));
  check('stdio: initialize answers as POST /mcp', JSON.stringify(answer(1)) === await viaHttp(init), brief(JSON.stringify(answer(1)) ?? 'no answer'));
  check('stdio: tools/list answers as POST /mcp', JSON.stringify(answer(2)) === await viaHttp(list), `${answer(2)?.result?.tools?.length ?? 0} tools`);
  check('stdio: no answer to a notification', lines.length === 2, `${lines.length} lines out for 3 in`);
});

// 5. The plain server's finished jobs go once their TTL (1 min) has passed
if (off && lastJob) await part('retention', async () => {
  await sleep(Math.max(0, lastJob + 62e3 - Date.now()));
  const h = parse(await http(OFF, 'GET', '/health'));
  check('retention: finished jobs dropped after their TTL', h.jobs_retained === 0, JSON.stringify(h));
});

for (const p of servers) await stop(p);
if (!failed) try { rmSync(cache, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch { /* a browser still closing: it stays in the temp folder */ }
console.log(`${failed ? 'FAILED' : 'OK'}: ${total - failed} of ${total} checks passed in ${Math.round((Date.now() - t0) / 1000)} s${failed ? `; logs and reports in ${cache}` : ''}`);
process.exit(failed ? 1 : 0);
