// npm run core: usdcore.js / usdcore.wasm for the pinned USD_WebViewer submodule, from the viewer's GitHub Pages deploy,
// into USD_WebViewer/web/public/core/ (gitignored there). Pages serves only the latest main build and page and core never
// handshake, so this refuses unless the core contract (native/, protocol.ts, worker.js) is the same at the deployed and
// the pinned commit. A core you built yourself: copy its usdcore.js / usdcore.wasm into that folder instead.
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repo = 'Cybernaut0815/USD_WebViewer';
const viewer = fileURLToPath(new URL('../../USD_WebViewer/', import.meta.url)), core = `${viewer}web/public/core/`;
if (!existsSync(`${core}worker.js`)) throw new Error('USD_WebViewer is not checked out: git submodule update --init');
const git = (...args) => execFileSync('git', ['-C', viewer, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const get = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r;
};

const [deploy] = await (await get(`https://api.github.com/repos/${repo}/deployments?environment=github-pages&per_page=1`)).json();
const [status] = await (await get(deploy.statuses_url)).json();
const sha = deploy.sha, short = sha.slice(0, 7);
if (status?.state !== 'success') throw new Error(`the latest Pages deploy (${short}) is ${status?.state ?? 'pending'}: retry later`);
try { git('cat-file', '-e', `${sha}^{commit}`); } catch { git('fetch', '-q', `https://github.com/${repo}`, sha); } // origin may be a local clone
try {
  git('diff', '--quiet', sha, 'HEAD', '--', 'native', 'web/src/protocol.ts', 'web/public/core/worker.js');
} catch {
  throw new Error(`Pages has the core of ${short}, whose contract differs from the pinned ${git('rev-parse', '--short', 'HEAD')}: build the core and copy it in`);
}
for (const f of ['usdcore.js', 'usdcore.wasm']) {
  writeFileSync(core + f, Buffer.from(await (await get(`https://cybernaut0815.github.io/USD_WebViewer/core/${f}`)).arrayBuffer()));
  console.log(`${f} <- Pages (${short})`);
}
