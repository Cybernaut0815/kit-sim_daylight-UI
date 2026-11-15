// Large-model bench (plan "large models", P0). --mode server: runRemote (the app's client lib, the same TS source)
// against a daylight_server it starts, with big.py's merged model split back into its meshes; each case cold, then as
// after a page reload (a fresh lib instance, fresh mesh objects), with phases, server memory, GPU, and the values against
// the CLI's. --mode browser: the app in Chrome (Playwright, channel chrome) or Playwright's Firefox, fresh profiles under
// --root, driven through the server's MCP tools as mcp-smoke.mjs does; checkpoints after the load and after each case.
// One JSON record per case goes to <root>/results.jsonl (layer server, chrome or firefox; big.py table compares tags),
// one markdown row to stdout. Node 25 (it strips the lib's TS types); the lib needs `npm ci` in kit-sim_daylight/bindings/ts.
// Inputs under --root: <mesh>/model.dmesh + meshes.json (big.py convert, hills), runs/base/<mesh>-<case>.npy (big.py run).
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const USAGE = `node server/test/bench.mjs --selftest
node server/test/bench.mjs --mode server --exe <daylight_server.exe> --tag <tag> [--mesh bhs] [--cases S1,A6,B1,V1] [--port 18200]
node server/test/bench.mjs --mode browser --browser chrome|firefox --exe <daylight_server.exe> --web <app dist> --model <file>
    --tag <tag> [--mesh bhs] [--cases S1,A6] [--port 18300] [--playwright <dir with Playwright's index.mjs>]
both: [--root F:/claude-scratch/large-models] [--epw <EPW>, default validate/_dl's Boston]
     [--lib <client lib index.ts>, default the app's kit-sim_daylight/bindings/ts/src/index.ts; an older server needs
      the lib of its time, as a file beside it (same node_modules), e.g. index.base.ts from git show]`;
const here = fileURLToPath(new URL('.', import.meta.url));
const { values: opt } = parseArgs({ options: { selftest: { type: 'boolean' },
  ...Object.fromEntries('mode root exe epw mesh cases tag port browser web model playwright lib'.split(' ').map((k) => [k, { type: 'string' }])) } });
const LIB = pathToFileURL(resolve(opt.lib ?? join(here, '../../kit-sim_daylight/bindings/ts/src/index.ts'))).href;
const R = resolve(opt.root ?? 'F:/claude-scratch/large-models'), EPW = resolve(opt.epw ?? 'F:/Github/kit-sim_daylight/validate/_dl/epw/USA_MA_Boston-City.WSO_TMY.epw');
const EXE = opt.exe && resolve(opt.exe), MESH = opt.mesh ?? 'bhs', TAG = opt.tag, BROWSER = opt.browser ?? 'chrome', IDS = (opt.cases ?? 'S1').split(',');
const PORT = Number(opt.port ?? (opt.mode === 'browser' ? 18300 : 18200));

// big.py's cases (same ids everywhere): CLI flags (server mode sends them as the job's args) and the app's settings
const S1 = ['--from', '06-21T08:00', '--to', '06-21T18:00', '--step', '30', '--quantity', 'radiation'];
const RANGE = { mode: 'range', from: { date: '2026-06-21', hour: '08:00' }, to: { date: '2026-06-21', hour: '18:00' }, step: 30 };
const SIM = { quantities: ['radiation'], on: 'faces', bounces: 0, bounceSamples: 256 }, SIX = ['radiation', 'direct', 'diffuse', 'irradiance', 'illuminance', 'sunhours'];
const CASES = {
  S1: { args: S1, app: { time: RANGE, sim: SIM } },
  A6: { args: ['--quantity', SIX.join(',')], app: { time: { mode: 'annual' }, sim: { ...SIM, quantities: SIX } } },
  B1: { args: [...S1, '--bounces', '1', '--bounce-samples', '256'], app: { time: RANGE, sim: { ...SIM, bounces: 1 } } },
  V1: { args: [...S1, '--on', 'vertices'], app: { time: RANGE, sim: { ...SIM, on: 'vertices' } } },
};
// ponytail: fixed limits per step (a case past one is recorded as failed); raise one if a slow but healthy case hits it
const START_MS = 30e3, BRIDGE_MS = 60e3, LOAD_MS = 15 * 60e3, RUN_MS = 45 * 60e3, STEP_MS = 10 * 60e3, MEASURE_MS = 60e3, VIEW = { width: 1600, height: 900 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => performance.now();
const gb = (b) => (b == null ? null : +(b / 2 ** 30).toFixed(3)), sec = (a, b) => +((b - a) / 1e3).toFixed(3);
const max = (a) => a.reduce((m, x) => (x > m ? x : m), -Infinity), min = (a) => a.reduce((m, x) => (x < m ? x : m), Infinity); // no spread: 14k+ items
const hex = (code) => `0x${(code >>> 0).toString(16).toUpperCase().padStart(8, '0')}`; // 3221226505 or -1073740791: 0xC0000409
const brief = (s) => String(s).replace(/\s+/g, ' ').trim().slice(0, 200);
/** "TypeError: fetch failed" hides why: the cause chain (socket errors and their codes), as " <- SocketError: ... (UND_ERR_SOCKET)". */
const causes = (e) => { let s = ''; for (let c = e?.cause, d = 0; c && d < 4; c = c.cause, d++) s += ` <- ${c.name}: ${c.message}${c.code ? ` (${c.code})` : ''}`; return s; };

/** big.py's merged model.dmesh (daylight.h layout, all triangles) and meshes.json [{prim, points, faces}] -> one ObjMesh
 *  per mesh, as the app hands runRemote: positions a view of the file, indices shifted back to the mesh's own points. */
function split(b, list) {
  const N = Number(b.readBigUInt64LE(8)), F = Number(b.readBigUInt64LE(16)), M = Number(b.readBigUInt64LE(24));
  if (b.toString('latin1', 0, 4) !== 'DLM1' || M !== 3 * F) throw new Error(`not a .dmesh of triangles (${M} indices for ${F} faces)`);
  if (list.reduce((a, m) => a + m.points, 0) !== N || list.reduce((a, m) => a + m.faces, 0) !== F) throw new Error('meshes.json does not add up to model.dmesh');
  const xyz = new Float64Array(b.buffer, b.byteOffset + 32, 3 * N), idx = new Int32Array(b.buffer, b.byteOffset + 32 + 24 * N + 4 * F, M);
  let p = 0, f = 0;
  return list.map(({ prim, points, faces }) => {
    const indices = new Uint32Array(3 * faces);
    for (let i = 0; i < indices.length; i++) indices[i] = idx[3 * f + i] - p;
    const m = { name: prim, positions: xyz.subarray(3 * p, 3 * (p + points)), indices };
    p += points; f += faces;
    return m;
  });
}

/** The CLI's --out .npy (v1.0, '<f8', C order, 64-byte aligned header: run.cpp npy_write_header) -> {rows, cols, data}. */
function npy(b) {
  const hl = b.readUInt16LE(8), head = b.toString('latin1', 10, 10 + hl), shape = /'shape': \((\d+), (\d+)\)/.exec(head);
  if (b.toString('latin1', 0, 8) !== '\x93NUMPY\x01\x00' || !head.includes("'descr': '<f8'") || !head.includes("'fortran_order': False") || !shape) throw new Error(`not the CLI's .npy: ${brief(head)}`);
  return { rows: +shape[1], cols: +shape[2], data: new Float64Array(b.buffer, b.byteOffset + 10 + hl, shape[1] * shape[2]) };
}

/** A result against the CLI's: float64 rows as today (res.values), or float32 columns (res.data, contract C5) against the
 *  float32 rounding of the CLI's doubles. NaN equals NaN. */
function compare(res, { rows, cols, data }) {
  const f32 = !!res.data, n = f32 ? res.data[0]?.length ?? 0 : res.values.length, c = f32 ? res.data.length : res.columns.length;
  if (n !== rows || c !== cols) return { rows, cols, f32, vs: `${n} x ${c} values, the CLI ${rows} x ${cols}` };
  let bad = 0, worst = 0;
  for (let i = 0; i < rows; i++) for (let k = 0; k < cols; k++) {
    const want = f32 ? Math.fround(data[i * cols + k]) : data[i * cols + k], got = f32 ? res.data[k][i] : res.values[i][k];
    if (got !== want && !(got !== got && want !== want)) { bad++; worst = Math.max(worst, Math.abs(got - want)); }
  }
  return { rows, cols, f32, vs: bad ? `${bad} of ${rows * cols} differ, max abs ${worst}` : 'identical' };
}

/** A run's log ({method, path, t0, t1, bytes} per request, {state, t} per job status the client saw) -> upload (PUT
 *  /mesh/*, POST /meshes/missing), queue (POST /jobs to the first 'running'), job (to the answer of the last poll of the
 *  job) and values (from there to `end`, the result in hand: today the base64 decode, after C3 GET .../values too). */
function phases(log, end) {
  const req = log.filter((e) => e.method), up = req.filter((e) => e.path.startsWith('/mesh')), puts = up.filter((e) => e.method === 'PUT');
  const post = req.findLast((e) => e.method === 'POST' && e.path === '/jobs'), last = req.findLast((e) => /^\/jobs(\/[^/]+)?$/.test(e.path));
  const run = log.find((e) => e.state === 'running'), after = last ? req.filter((e) => e.t0 >= last.t0 && e.path.startsWith('/jobs')) : [];
  return { upload_s: up.length ? sec(min(up.map((e) => e.t0)), max(up.map((e) => e.t1))) : 0, puts: puts.length, put_gb: gb(puts.reduce((a, e) => a + e.bytes, 0)),
    queue_s: post && run ? sec(post.t0, run.t) : null, job_s: post ? sec(run?.t ?? post.t0, last.t1) : null,
    values_s: last ? sec(last.t1, end) : null, values_gb: last ? gb(after.reduce((a, e) => a + e.bytes, 0)) : null };
}
/** The phase a run was in when the server went away: no POST /jobs yet, never seen running, or after. */
const during = (log) => (!log.some((e) => e.path === '/jobs') ? 'upload' : log.some((e) => e.state === 'running') ? 'job' : 'queue');

/** fetch for runRemote: at most 6 requests in flight (a browser's limit per host over HTTP/1.1; Node's fetch would open a
 *  socket per PUT), each logged once its whole answer is in. ponytail: holds an answer twice (here and in runRemote). */
function timed(log) {
  let free = 6;
  const waiting = [], next = () => (waiting.length ? waiting.shift()() : free++);
  return async (url, init = {}) => {
    if (free > 0) free--; else await new Promise((r) => waiting.push(r));
    const e = { method: init.method ?? 'GET', path: new URL(url).pathname, t0: now(), t1: 0, status: 0, bytes: init.body?.byteLength ?? 0 };
    log.push(e);
    try {
      const res = await fetch(url, init), body = await res.arrayBuffer();
      Object.assign(e, { t1: now(), status: res.status, bytes: e.bytes + body.byteLength });
      return new Response(res.status === 204 ? null : body, res); // PUT /mesh answers 204, which may carry no body
    } catch (x) { e.t1 = now(); throw x; } finally { next(); }
  };
}

const kids = [];
process.on('exit', () => kids.forEach((p) => p.kill()));
process.on('SIGINT', () => process.exit(130));
/** A child whose stdout lines go to onLine, ended with the bench. */
function lines(cmd, args, onLine) {
  const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
  p.on('error', (e) => console.log(`warning: ${cmd}: ${e.message}`));
  createInterface({ input: p.stdout }).on('line', onLine);
  kids.push(p);
}
const ps = (script) => ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
/** Every second while process pid lives: {t, pid, v: [private bytes, peak commit bytes, CPU 100 ns]} into out. Get-Process
 *  takes ~0.1 s; any WMI query of Win32_Process takes ~2.5 s on this machine. */
function sampleProc(pid, out) {
  lines('powershell.exe', ps(`while ($p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue) {
  [Console]::WriteLine("$($p.PrivateMemorySize64) $($p.PeakPagedMemorySize64) $($p.TotalProcessorTime.Ticks)"); Start-Sleep -Seconds 1 }`),
  (l) => out.push({ t: now(), pid, v: l.split(' ').map(Number) }));
}
/** The processes whose command line holds key (a Chrome profile dir, Playwright's browsers folder) and their direct
 *  children, now: private bytes in all, the largest single peak commit, the sum of the peaks. ponytail: at checkpoints
 *  only (WMI is slow, above); per-process peaks still catch what happened in between. */
async function browserProcs(key) {
  const out = await new Promise((done) => execFile('powershell.exe', ps(`$all = Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, CommandLine, PrivatePageCount, PeakPageFileUsage
$ids = @($all | ? { $_.CommandLine -and $_.CommandLine.ToLower().Contains('${key.toLowerCase().replace(/'/g, "''")}') } | % { $_.ProcessId })
$all | ? { $ids -contains $_.ProcessId -or $ids -contains $_.ParentProcessId } | % { "$($_.PrivatePageCount) $($_.PeakPageFileUsage)" }`), (e, so) => done(e ? '' : so)));
  const rows = out.split('\n').filter((l) => l.trim()).map((l) => l.trim().split(' ').map(Number)); // [private bytes, peak KB]
  return rows.length ? { n: rows.length, total_gb: gb(rows.reduce((a, r) => a + r[0], 0)), peak_gb: gb(max(rows.map((r) => r[1])) * 1024), peaks_gb: gb(rows.reduce((a, r) => a + r[1], 0) * 1024) } : null;
}
/** nvidia-smi every 250 ms until the bench exits: [busy %, used MiB, total MiB, °C, SM MHz]. ponytail: one NVIDIA GPU and
 *  whole-card memory (per-process GPU memory is N/A on this driver). */
function sampleGpu() {
  const out = [];
  lines('nvidia-smi', ['--query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu,clocks.sm', '--format=csv,noheader,nounits', '-lms', '250'],
    (l) => { const v = l.split(',').map(Number); if (v.length === 5 && v.every(Number.isFinite)) out.push({ t: now(), v }); });
  return out;
}
/** The server over [t0, t1] (a tick either side; a restart is another pid): the largest and the last private bytes, the
 *  peak commit, CPU seconds. */
function procStats(samples, t0, t1) {
  const w = samples.filter((s) => s.t > t0 - 1100 && s.t < t1 + 1100), cpu = new Map();
  if (!w.length) return null;
  for (const s of w) cpu.set(s.pid, [cpu.get(s.pid)?.[0] ?? s.v[2], s.v[2]]);
  return { max_gb: gb(max(w.map((s) => s.v[0]))), end_gb: gb(w.at(-1).v[0]), peak_gb: gb(max(w.map((s) => s.v[1]))),
    cpu_s: +([...cpu.values()].reduce((a, [first, last]) => a + last - first, 0) / 1e7).toFixed(1) };
}
/** The GPU over [t0, t1]: mean busy %, memory added over the first sample, least free, hottest, mean SM clock while busy. */
function gpuStats(gpu, t0, t1) {
  const w = gpu.filter((s) => s.t >= t0 && s.t <= t1).map((s) => s.v), busy = w.filter((v) => v[0] >= 50);
  if (!w.length) return null;
  const mean = (a, i) => Math.round(a.reduce((x, v) => x + v[i], 0) / a.length);
  return { busy_pct: mean(w, 0), dmem_gb: gb((max(w.map((v) => v[1])) - w[0][1]) * 2 ** 20), free_min_gb: gb(min(w.map((v) => v[2] - v[1])) * 2 ** 20),
    temp_max: max(w.map((v) => v[3])), sm_busy_mhz: busy.length ? mean(busy, 4) : null };
}

const health = (port) => fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json());
/** daylight_server on port with --cache <dir>/cache, stderr appended to <dir>/server.log (kept across restarts), its memory
 *  sampled into `samples`; resolves once /health answers (mcp-smoke.mjs's start()). */
async function start(port, dir, args, samples) {
  if (await health(port).catch(() => null)) throw new Error(`port ${port} is taken`);
  mkdirSync(dir, { recursive: true });
  const log = openSync(join(dir, 'server.log'), 'a');
  const p = spawn(EXE, ['--port', `${port}`, '--cache', join(dir, 'cache'), ...args], { stdio: ['ignore', 'ignore', log] });
  closeSync(log);
  p.exited = new Promise((r) => p.once('exit', r).once('error', r));
  kids.push(p);
  sampleProc(p.pid, samples);
  for (const end = Date.now() + START_MS; Date.now() < end; await sleep(250)) {
    if (p.exitCode !== null) throw new Error(`daylight_server exited ${hex(p.exitCode)}: see ${join(dir, 'server.log')}`);
    if (await health(port).catch(() => null)) return p;
  }
  throw new Error(`daylight_server did not answer /health within ${START_MS / 1e3} s`);
}

const up = (r) => r.phases && `${r.phases.upload_s} (${r.phases.puts}, ${r.phases.put_gb})`;
const COLS = {
  server: { case: (r) => `${r.mesh} ${r.case}`, 'upload s (PUTs, GB)': up, 'queue s': (r) => r.phases?.queue_s, 'job s': (r) => r.phases?.job_s,
    run_s: (r) => r.manifest?.run_s, 'values s (GB)': (r) => r.phases && `${r.phases.values_s} (${r.phases.values_gb})`, 'total s': (r) => r.wall_s,
    'server max / end / peak GB': (r) => r.mem.server && `${r.mem.server.max_gb} / ${r.mem.server.end_gb} / ${r.mem.server.peak_gb}`, 'CPU s': (r) => r.mem.server?.cpu_s,
    'GPU busy %': (r) => r.gpu?.busy_pct, 'GPU +GB': (r) => r.gpu?.dmem_gb, retained: (r) => r.retained, 'vs CLI': (r) => r.values?.vs, outcome: (r) => r.error ?? 'ok' },
  browser: { case: (r) => `${r.layer} ${r.mesh} ${r.case}`, 'load / run s': (r) => r.wall_s, 'upload s (PUTs, GB)': up, 'job s': (r) => r.phases?.job_s,
    'values s': (r) => r.phases?.values_s, 'paint s': (r) => r.paint_s, 'results s': (r) => r.results_s, 'long tasks n / s / max s': (r) => r.lt && `${r.lt.n} / ${r.lt.s} / ${r.lt.max_s}`,
    'page GB': (r) => r.page_gb, 'browser total / peak GB': (r) => r.mem.browser && `${r.mem.browser.total_gb} / ${r.mem.browser.peak_gb}`, 'server peak GB': (r) => r.mem.server?.peak_gb,
    'GPU +GB / free GB': (r) => r.gpu && `${r.gpu.dmem_gb} / ${r.gpu.free_min_gb}`, backend: (r) => r.backend, outcome: (r) => r.error ?? 'ok' },
};
const md = (cells) => console.log(`| ${cells.map((c) => (c == null ? '-' : brief(c).replace(/\|/g, '/'))).join(' | ')} |`);
const head = (layer) => { md(Object.keys(COLS[layer])); md(Object.keys(COLS[layer]).map(() => '---')); };
const row = (layer, r) => md(Object.values(COLS[layer]).map((f) => f(r)));
const record = (rec) => appendFileSync(join(R, 'results.jsonl'), `${JSON.stringify(rec)}\n`);
const build = () => ({ exe: EXE, sha256: createHash('sha256').update(readFileSync(EXE)).digest('hex'),
  git: execFileSync('git', ['-C', here, 'describe', '--always', '--dirty'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() });

async function serverMode() {
  const dir = join(R, 'server', TAG), url = `http://127.0.0.1:${PORT}`, epw = new Blob([readFileSync(EPW)]);
  let sensors = split(readFileSync(join(R, MESH, 'model.dmesh')), JSON.parse(readFileSync(join(R, MESH, 'meshes.json'), 'utf8')));
  const s = { procs: [], gpu: sampleGpu() }, b = build();
  let lib = await import(LIB), srv = await start(PORT, dir, [], s.procs), k = 0, coldOk = true;
  console.log(`${MESH}: ${sensors.length} meshes, tag ${TAG}, ${EXE}`);
  head('server');
  for (const id of IDS) for (const reload of [false, true]) {
    const t0 = now(), log = [], rec = { tag: TAG, layer: 'server', mesh: MESH, case: reload ? `${id}+reload` : id, ok: false, when: new Date().toISOString(), build: b };
    if (reload && !coldOk) { Object.assign(rec, { error: 'not run: the cold run failed', phases: phases([], t0), mem: {} }); record(rec); row('server', rec); continue; }
    if (reload) { // as after a page reload: a new lib instance (it has uploaded nothing) and new mesh objects (no ids)
      lib = await import(`${LIB}?reload=${++k}`);
      sensors = sensors.map((m) => ({ name: m.name, positions: m.positions, indices: m.indices }));
    }
    let res, err;
    try {
      res = await lib.runRemote(url, { sensors, epw, args: CASES[id].args, clientId: 'bench', fetch: timed(log), signal: AbortSignal.timeout(RUN_MS),
        onStatus: (j) => log.push({ state: j.state, t: now() }) });
    } catch (e) { err = e; }
    const t1 = now(), ref = join(R, 'runs', 'base', `${MESH}-${id}.npy`);
    if (err && srv.exitCode === null) await Promise.race([srv.exited, sleep(2e3)]); // a reset socket comes before the exit event
    const died = srv.exitCode !== null;
    Object.assign(rec, { ok: !err, wall_s: sec(t0, t1), phases: phases(log, t1),
      error: died ? `server exited ${hex(srv.exitCode)} during the ${during(log)}${err ? `: ${err.message}` : ''}` : err ? `${err.name}: ${err.message}${causes(err)}` : null,
      values: res ? (existsSync(ref) ? compare(res, npy(readFileSync(ref))) : { vs: 'no CLI run' }) : null,
      manifest: res && { run_s: res.manifest.run_s, cache: res.cache ?? res.manifest.cache, timing: res.manifest.timing, gpu: res.manifest.gpu },
      mem: { server: procStats(s.procs, t0, t1) }, gpu: gpuStats(s.gpu, t0, t1), retained: died ? null : (await health(PORT).catch(() => null))?.jobs_retained ?? null });
    record(rec); row('server', rec);
    if (!reload) coldOk = rec.ok;
    if (died) srv = await start(PORT, dir, [], s.procs);
  }
}

let rpcId = 0;
/** One JSON-RPC message to POST /mcp as Claude Code sends it (mcp-smoke.mjs); Node's fetch sends no Origin, so the
 *  local-only gate (agent.h local_request) lets it in. */
const rpc = (method, params) => fetch(`http://127.0.0.1:${PORT}/mcp`, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, ...(params ? { params } : {}) }),
  headers: { 'Content-Type': 'application/json', ...(method === 'initialize' ? {} : { 'MCP-Protocol-Version': '2025-06-18' }) } }).then((r) => r.json());
/** A tools/call: isError, its text, the JSON object in it (null for prose), its images. */
async function tool(name, args = {}) {
  const msg = await rpc('tools/call', { name, arguments: args }), res = msg.result;
  if (!res) throw new Error(`${name}: ${brief(JSON.stringify(msg))}`);
  const text = res.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n'), i = text.indexOf('{');
  let json = null;
  try { if (i >= 0) json = JSON.parse(text.slice(i)); } catch { /* prose */ }
  return { err: !!res.isError, text, json, images: res.content.filter((c) => c.type === 'image') };
}
// no answer in time: the tab's own 45 s, the server's 55 s, or no tab polling (its main thread busy for over 5 s)
const stalled = (r) => r.err && /answer within \d+ s|No daylight app tab is open/.test(r.text);
const sure = (what, r) => { if (r.err && !stalled(r)) throw new Error(`${what}: ${brief(r.text)}`); return r; };
/** name(args), again a second after a busy(reply), or once app_state answers after a stall (as the reply asks); throws after ms. */
async function until(name, args, busy, ms) {
  for (const end = Date.now() + ms; ;) {
    let r = await tool(name, args);
    if (!busy(r) && !stalled(r)) return r;
    if (busy(r)) await sleep(1e3); // run waits up to 40 s itself; an app_state poll would spin
    while (stalled(r) && Date.now() < end) r = await tool('app_state');
    if (Date.now() >= end) throw new Error(`${name}: still ${stalled(r) ? 'no answer from the tab' : 'busy'} after ${ms / 60e3} min`);
  }
}
/** An idempotent call, sent again after a stall (the server drops a call no tab took within 55 s); throws its error. */
const step = async (name, args) => sure(name, await until(name, args, () => false, STEP_MS));
/** Page init script: long tasks (Chrome; Firefox has no such entries: null) and the PUT bodies the app hands fetch (devtools,
 *  so Playwright's request sizes, drop big request bodies). */
const INIT = () => {
  window.__lt = PerformanceObserver.supportedEntryTypes.includes('longtask') ? [] : null;
  if (window.__lt) new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push(e.duration); }).observe({ type: 'longtask', buffered: true });
  const f = window.fetch, put = (window.__put = { n: 0, bytes: 0 });
  window.fetch = function (input, init) {
    if (init?.method === 'PUT') { put.n++; put.bytes += init.body?.byteLength ?? init.body?.size ?? 0; }
    return f.apply(this, arguments);
  };
};
/** The page's memory (Chrome's measureUserAgentSpecificMemory: the app is cross-origin isolated; null elsewhere or after
 *  MEASURE_MS), its long tasks since the last call, and the PUT counter. */
async function pageStats(page) {
  const ev = (fn) => page.evaluate(fn).catch(() => null);
  const [bytes, lt, put] = await Promise.all([Promise.race([ev(() => performance.measureUserAgentSpecificMemory?.().then((m) => m.bytes) ?? null), sleep(MEASURE_MS).then(() => null)]),
    ev(() => window.__lt?.splice(0) ?? null), ev(() => window.__put)]);
  return { page_gb: gb(bytes), lt: lt && { n: lt.length, s: +(lt.reduce((a, d) => a + d, 0) / 1e3).toFixed(2), max_s: +(Math.max(0, max(lt)) / 1e3).toFixed(2) }, put };
}

async function browserMode() {
  process.env.PLAYWRIGHT_BROWSERS_PATH ||= 'F:/claude-scratch/ms-playwright'; // Playwright's Firefox; read as Playwright loads
  const { chromium, firefox } = await import(pathToFileURL(join(resolve(opt.playwright ?? 'F:/Github/USD_web_viewer/web/node_modules/playwright'), 'index.mjs')).href);
  const dir = join(R, 'browser', TAG), profile = join(dir, `${BROWSER}-profile`), none = join(R, 'none.exe');
  if (existsSync(none)) throw new Error(`${none} exists: the server would start it as its hidden browser`);
  const args = ['--web', resolve(opt.web), '--mcp', '--browser', none]; // a --browser that does not exist: the server never starts the user's Chrome
  const s = { procs: [], gpu: sampleGpu() }, key = BROWSER === 'chrome' ? profile : resolve(process.env.PLAYWRIGHT_BROWSERS_PATH); // finds the browser's processes
  let srv = await start(PORT, dir, args, s.procs);
  rmSync(profile, { recursive: true, force: true }); // a fresh profile every run, never the user's
  const b = { ...build(), web: resolve(opt.web) }, ctx = await (BROWSER === 'chrome'
    ? chromium.launchPersistentContext(profile, { channel: 'chrome', headless: false, viewport: VIEW, args: ['--enable-unsafe-webgpu', '--enable-blink-features=ForceEagerMeasureMemory'] })
    : firefox.launchPersistentContext(profile, { headless: false, viewport: VIEW }));
  await ctx.addInitScript(INIT);
  const page = ctx.pages()[0] ?? (await ctx.newPage()), log = [], open = new WeakMap();
  let crashed = null, put = { n: 0, bytes: 0 }, info = {};
  page.on('crash', () => { crashed = 'page crash'; }).on('pageerror', (e) => console.log(`page error: ${brief(e.message)}`));
  page.on('request', (r) => { const e = { method: r.method(), path: new URL(r.url()).pathname, t0: now(), t1: 0, bytes: 0 }; open.set(r, e); log.push(e); });
  page.on('requestfailed', (r) => { if (open.has(r)) open.get(r).t1 = now(); });
  page.on('requestfinished', async (r) => { // answers carry Content-Length (httplib); PUT bodies come from the page's counter
    const e = open.get(r);
    if (!e) return;
    e.t1 = now();
    e.bytes = +((await r.response().catch(() => null))?.headers()['content-length'] ?? 0);
  });
  /** A checkpoint record: the step's fields, then the page, the server's and the browser's processes and the GPU since t0. */
  async function checkpoint(name, t0, fields) {
    if (fields.error && srv.exitCode === null) await Promise.race([srv.exited, sleep(2e3)]);
    const t = now(), p = await pageStats(page), died = srv.exitCode !== null;
    if (fields.phases && p.put) Object.assign(fields.phases, { puts: p.put.n - put.n, put_gb: gb(p.put.bytes - put.bytes) });
    put = p.put ?? put;
    const rec = { tag: TAG, layer: BROWSER, mesh: MESH, case: name, ok: !fields.error && !crashed && !died, when: new Date().toISOString(), build: b, ...fields,
      ...(crashed || died ? { error: crashed ?? `server exited ${hex(srv.exitCode)}${fields.error ? `: ${fields.error}` : ''}` } : {}), page_gb: p.page_gb, lt: p.lt, ...info,
      mem: { server: procStats(s.procs, t0, t), browser: await browserProcs(key) }, gpu: gpuStats(s.gpu, t0, t) };
    record(rec); row('browser', rec);
    if (died) srv = await start(PORT, dir, args, s.procs);
    return rec;
  }
  const polled = page.waitForRequest((r) => r.url().includes('/bridge/next'), { timeout: BRIDGE_MS });
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'commit' });
  await polled; // the app's bridge polls: tool calls reach this tab, never the hidden-instance fallback
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'bench', version: '1' } });
  console.log(`${BROWSER}: ${opt.model}, tag ${TAG}, ${EXE}`);
  head('browser');
  let t0 = now(), tl, m, error;
  try {
    await step('update_settings', { site: { lat: 42.35, lon: -71.07, place: 'Boston' }, weather: { file: EPW } }); // a place: no reverse geocoding
    t0 = now();
    sure('open_model', await tool('open_model', { paths: [resolve(opt.model)] })); // once: a big model answers 'running', then app_state until loaded
    m = (await until('app_state', {}, (r) => !!r.json?.models?.some((x) => x.loading), LOAD_MS)).json?.models?.[0];
    tl = now();
    if (!(m?.faces > 0)) throw new Error(`open_model: ${brief(JSON.stringify(m ?? 'no model'))}`);
    info = await page.evaluate(async () => {
      const a = navigator.gpu ? await navigator.gpu.requestAdapter().catch(() => null) : null, i = a?.info;
      return { backend: document.querySelector('usd-viewer')?.backend ?? null, adapter: i ? [i.vendor, i.architecture, i.device, i.description].filter(Boolean).join(' ') : null, ua: navigator.userAgent };
    });
    await step('set_roles', { paths: ['/'], role: 'receiver' });
  } catch (e) { error = e.message; }
  const load = await checkpoint('load', t0, { error, wall_s: sec(t0, tl ?? now()), faces: m?.faces, meshes: m?.meshes, problems: m?.problems });
  for (const id of load.ok ? IDS : []) {
    const t0 = now(), from = log.length, ts = [];
    let error, shot, res;
    try {
      await step('update_settings', CASES[id].app);
      const run = await until('run', {}, (r) => r.json?.status === 'running', RUN_MS); // run joins the batch going on
      ts.push(now());
      if (!(run.json?.status === 'done' && run.json.models.every((x) => x.status === 'done'))) throw new Error(`run: ${brief(run.text)}`);
      shot = await step('screenshot', { width: 1280, height: 800 });
      ts.push(now());
      res = await step('results', {});
      ts.push(now());
    } catch (e) { error = e.message; }
    const img = shot?.images[0], end = ts[0] ?? now();
    if (img) writeFileSync(join(dir, `${BROWSER}-${MESH}-${id}.${img.mimeType.split('/')[1]}`), Buffer.from(img.data, 'base64'));
    await checkpoint(id, t0, { error, wall_s: sec(t0, end), phases: phases(log.slice(from), end), paint_s: ts[1] && sec(ts[0], ts[1]),
      results_s: ts[2] && sec(ts[1], ts[2]), app: res?.json?.models?.[0]?.run ?? null }); // app: the run's args and timing as the app sent and saw them
    if (crashed) break;
  }
  await ctx.close();
}

async function selftest() {
  const lib = await import(LIB);
  assert.notEqual((await import(`${LIB}?reload=selftest`)).runRemote, lib.runRemote, 'a ?reload= import is a fresh lib instance');
  // split: two meshes merged as big.py writes them, back to each mesh's own .dmesh bytes
  const a = { name: '/a', positions: Float64Array.of(0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0), indices: Uint32Array.of(0, 1, 2, 0, 2, 3) };
  const c = { name: '/b', positions: Float64Array.of(5, 5, 5, 6, 5, 5, 5, 6, 5), indices: Uint32Array.of(0, 1, 2) };
  const merged = lib.toDmesh({ name: 'model', positions: Float64Array.of(...a.positions, ...c.positions), indices: Uint32Array.of(...a.indices, ...c.indices.map((i) => i + 4)) });
  const list = [{ prim: '/a', points: 4, faces: 2 }, { prim: '/b', points: 3, faces: 1 }], parts = split(Buffer.from(merged.buffer), list);
  assert.deepEqual(parts.map((m) => m.name), ['/a', '/b']);
  parts.forEach((m, k) => assert.deepEqual(lib.toDmesh(m), lib.toDmesh([a, c][k])));
  assert.equal(parts[1].positions.buffer, merged.buffer, 'positions are views of the model');
  assert.throws(() => split(Buffer.from(merged.buffer), list.slice(0, 1)), /does not add up/);
  // npy: the CLI's header (padded to 64 bytes) and rows
  const vals = Float64Array.of(1.5, -2, 3e-9, 4, NaN, 6);
  let h = "{'descr': '<f8', 'fortran_order': False, 'shape': (3, 2), }";
  h += `${' '.repeat((64 - ((11 + h.length) % 64)) % 64)}\n`;
  const ref = npy(Buffer.concat([Buffer.from('\x93NUMPY\x01\x00', 'latin1'), Buffer.from(Uint16Array.of(h.length).buffer), Buffer.from(h, 'latin1'), Buffer.from(vals.buffer)]));
  assert.deepEqual([ref.rows, ref.cols, [...ref.data]], [3, 2, [...vals]]);
  // compare: float64 rows; float32 columns against fround (3e-9 is not a float32, so a plain compare would differ)
  const rows = [0, 1, 2].map((i) => vals.subarray(2 * i, 2 * i + 2)), cols = [0, 1].map((k) => Float32Array.from([0, 1, 2], (i) => vals[2 * i + k]));
  assert.equal(compare({ values: rows, columns: ['a', 'b'] }, ref).vs, 'identical');
  assert.equal(compare({ data: cols, columns: ['a', 'b'] }, ref).vs, 'identical');
  cols[1][2] = 7;
  assert.equal(compare({ data: cols, columns: ['a', 'b'] }, ref).vs, '1 of 6 differ, max abs 1');
  assert.equal(compare({ values: rows.slice(1), columns: ['a', 'b'] }, ref).vs, '2 x 2 values, the CLI 3 x 2');
  // phases of a fake log: two PUTs, the job queued then running, the done poll, then (C3) GET .../values
  const log = [{ method: 'PUT', path: '/mesh/a', t0: 0, t1: 100, bytes: 2 ** 29 }, { method: 'PUT', path: '/mesh/b', t0: 10, t1: 150, bytes: 2 ** 29 },
    { method: 'POST', path: '/jobs', t0: 200, t1: 210, bytes: 0 }, { state: 'queued', t: 210 }, { method: 'GET', path: '/jobs/x', t0: 210, t1: 1000, bytes: 0 },
    { state: 'running', t: 1000 }, { method: 'GET', path: '/jobs/x', t0: 1000, t1: 5000, bytes: 2 ** 30 }, { method: 'GET', path: '/jobs/x/values', t0: 5000, t1: 5500, bytes: 2 ** 30 }];
  assert.deepEqual(phases(log, 6000), { upload_s: 0.15, puts: 2, put_gb: 1, queue_s: 0.8, job_s: 4, values_s: 1, values_gb: 2 });
  assert.deepEqual(phases([], 0), { upload_s: 0, puts: 0, put_gb: 0, queue_s: null, job_s: null, values_s: null, values_gb: null });
  assert.deepEqual([during(log.slice(0, 2)), during(log.slice(0, 4)), during(log)], ['upload', 'queue', 'job']);
  assert.deepEqual([hex(3221226505), hex(-1073740791)], ['0xC0000409', '0xC0000409']);
  // timed: at most 6 requests in flight, each logged with its bytes, a 204 passed on without a body
  let busy = 0, most = 0;
  const echo = createServer((q, r) => { most = Math.max(most, ++busy); setTimeout(() => { busy--; r.writeHead(q.method === 'PUT' ? 204 : 200).end(q.method === 'PUT' ? undefined : 'abc'); }, 20); });
  await new Promise((r) => echo.listen(0, '127.0.0.1', r));
  const tlog = [], f = timed(tlog), u = `http://127.0.0.1:${echo.address().port}`;
  const sts = await Promise.all([...Array(20)].map((_, i) => f(`${u}/mesh/${i}`, { method: 'PUT', body: new Uint8Array(10) }).then((r) => r.status)));
  const text = await (await f(`${u}/jobs/x`)).text();
  echo.close();
  assert.deepEqual([most, sts.every((st) => st === 204), text, tlog[0].bytes, tlog.at(-1).bytes], [6, true, 'abc', 10, 3]);
  // the samplers: a process by its pid every second, and by a key in its command line
  const key = `bench-selftest-${process.pid}`, child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60e3)', key], { stdio: 'ignore' }), procs = [];
  sampleProc(child.pid, procs);
  const found = await browserProcs(key);
  for (const end = Date.now() + 30e3; procs.length < 2 && Date.now() < end;) await sleep(200);
  child.kill();
  const st = procStats(procs, 0, now());
  assert.ok(found?.n === 1 && found.total_gb > 0.001 && found.peak_gb >= found.total_gb, `browserProcs found ${JSON.stringify(found)}`);
  assert.ok(procs.length >= 2 && procs[0].pid === child.pid && st.max_gb > 0.001 && st.peak_gb >= st.max_gb && st.cpu_s >= 0, `sampleProc saw ${JSON.stringify(procs)}`);
  console.log('selftest ok: lib reload, split, npy, compare (float64, float32), phases, exit codes, timed fetch, process sampler');
}

const bad = opt.selftest ? null : !['server', 'browser'].includes(opt.mode) ? 'give --mode server or browser, or --selftest' : !TAG ? 'give --tag (base, p1, ...)'
  : !EXE || !existsSync(EXE) ? `no daylight_server at ${EXE}` : !existsSync(EPW) ? `no weather file at ${EPW}`
  : IDS.some((c) => !CASES[c]) ? `cases are ${Object.keys(CASES)}, not ${IDS}`
  : opt.mode === 'browser' && !(opt.web && opt.model && ['chrome', 'firefox'].includes(BROWSER)) ? 'browser mode needs --web, --model and --browser chrome or firefox' : null;
if (bad) { console.error(`${USAGE}\n\nerror: ${bad}`); process.exit(2); }
await (opt.selftest ? selftest() : opt.mode === 'server' ? serverMode() : browserMode());
process.exit(0);
