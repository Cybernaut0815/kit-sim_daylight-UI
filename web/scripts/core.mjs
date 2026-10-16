// npm run core: usdcore.js / usdcore.wasm for the pinned USD_WebViewer submodule, from the viewer's GitHub Pages deploy,
// into USD_WebViewer/web/public/core/ (gitignored there), and web/usdcore.pin (gitignored): the commit they were fetched
// for, so vite's build refuses a core fetched for another pin. Pages serves only the latest successful main build and
// page and core never handshake, so this refuses unless the core's sources (native/, sdk/) and its contract
// (protocol.ts, worker.js) are the same at the deployed and the pinned commit. A core you built yourself: copy its
// usdcore.js / usdcore.wasm into that folder and write the pinned commit (git -C USD_WebViewer rev-parse HEAD) into
// web/usdcore.pin.
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repo = 'Cybernaut0815/USD_WebViewer';
const viewer = fileURLToPath(new URL('../../USD_WebViewer/', import.meta.url)), core = `${viewer}web/public/core/`;
if (!existsSync(`${core}worker.js`)) throw new Error('USD_WebViewer is not checked out: git submodule update --init');
const git = (...args) => execFileSync('git', ['-C', viewer, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const get = async (url) => {
  const r = await fetch(url, process.env.GITHUB_TOKEN && url.startsWith('https://api.') ? { headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } } : {});
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}${r.status === 403 ? ' (GitHub API rate limit? set GITHUB_TOKEN)' : ''}`);
  return r;
};

// The newest deploy that succeeded is what Pages serves; one still running means the files may be changing.
let sha = null;
for (const d of await (await get(`https://api.github.com/repos/${repo}/deployments?environment=github-pages&per_page=10`)).json()) {
  const [status] = await (await get(d.statuses_url)).json();
  if (!status || ['waiting', 'queued', 'pending', 'in_progress'].includes(status.state)) throw new Error(`a Pages deploy (${d.sha.slice(0, 7)}) is under way: retry in a few minutes`);
  if (status.state === 'success') { sha = d.sha; break; }
}
if (!sha) throw new Error('no successful Pages deploy: build the core and copy it in');
const short = sha.slice(0, 7), head = git('rev-parse', 'HEAD');
try { git('cat-file', '-e', `${sha}^{commit}`); } catch { git('fetch', '-q', `https://github.com/${repo}`, sha); } // origin may be a local clone
try {
  git('diff', '--quiet', sha, 'HEAD', '--', 'native', 'sdk', 'web/src/protocol.ts', 'web/public/core/worker.js');
} catch {
  throw new Error(`Pages has the core of ${short}, built from other sources than the pinned ${head.slice(0, 7)}: build the core and copy it in`);
}
// both files before writing either: a failed download never leaves new glue beside an old wasm
const names = ['usdcore.js', 'usdcore.wasm'];
const bytes = await Promise.all(names.map(async (f) => Buffer.from(await (await get(`https://cybernaut0815.github.io/USD_WebViewer/core/${f}`)).arrayBuffer())));
names.forEach((f, i) => { writeFileSync(core + f, bytes[i]); console.log(`${f} <- Pages (${short})`); });
writeFileSync(new URL('../usdcore.pin', import.meta.url), head);
