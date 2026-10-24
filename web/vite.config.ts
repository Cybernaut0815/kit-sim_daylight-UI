import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { Agent } from 'node:http';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { mock } from './mock/run.ts';

const API = 'http://127.0.0.1:8080'; // the server listens on IPv4 only; 'localhost' would try ::1 first
const agent = new Agent({ keepAlive: true }); // without it the dev proxy opens a new TCP connection for every request
// The USD viewer's wasm core runs threads (SharedArrayBuffer), so pages must be cross-origin isolated; preview inherits it.
const isolation = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };

// `VITE_MOCK=1 vite` or `vite --mode mock` (npm run dev:mock): fake the server for GPU-free, offline UI work.
export default defineConfig(({ command, mode }) => {
  const MOCK = !!process.env.VITE_MOCK || mode === 'mock';
  // The viewer's wasm core is gitignored and fetched by `npm run core` for one viewer commit (usdcore.pin). Missing, or
  // fetched for another commit (page and core never handshake), a dist would build, boot, and fail at the first model.
  if (mode !== 'test') {
    const pin = existsSync(new URL('./usdcore.pin', import.meta.url)) ? readFileSync(new URL('./usdcore.pin', import.meta.url), 'utf8').trim() : null;
    let head: string | null = null;
    try { head = execFileSync('git', ['-C', fileURLToPath(new URL('../USD_WebViewer', import.meta.url)), 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* no git: the existence check only */ }
    const problem = !existsSync(new URL('../USD_WebViewer/web/public/core/usdcore.wasm', import.meta.url)) ? 'No USD core in USD_WebViewer/web/public/core'
      : head && pin !== head ? `The USD core was fetched for ${pin?.slice(0, 7) ?? 'another commit'}, USD_WebViewer is at ${head.slice(0, 7)}` : null;
    if (problem) {
      if (command === 'build') throw new Error(`${problem}: run \`npm run core\` (README).`);
      console.warn(`${problem}: run \`npm run core\` (README).`);
    }
  }
  return {
    plugins: [react(), ...(MOCK ? [mock()] : [])],
    // The viewer's public/ (core/, skies/, samples/, mock-core/): served in dev, copied into dist. web/public is empty.
    publicDir: '../USD_WebViewer/web/public',
    // Two pages, one app: index.html in kit-ui (the default), zha.html in zha-ui; each loads only its design system.
    build: {
      rolldownOptions: {
        input: { main: fileURLToPath(new URL('./index.html', import.meta.url)), zha: fileURLToPath(new URL('./zha.html', import.meta.url)) },
      },
    },
    resolve: {
      // The core's TS binding and the USD viewer straight from the submodule sources; their three / gltf-transform
      // imports resolve here.
      alias: {
        'daylight-mesh': fileURLToPath(new URL('../kit-sim_daylight/bindings/ts/src/index.ts', import.meta.url)),
        'usd-viewer': fileURLToPath(new URL('../USD_WebViewer/web/src/index.ts', import.meta.url)),
      },
      dedupe: ['three', '@gltf-transform/core'],
    },
    server: {
      headers: isolation,
      fs: { allow: ['..'] },
      proxy: MOCK ? undefined : Object.fromEntries(['/run', '/jobs', '/mesh', '/proxy', '/health', '/openapi.json', '/docs', '/redoc', '/llms.txt'].map((p) => [p, { target: API, agent }])),
    },
    test: { environment: 'node', include: ['src/**/*.test.ts'] },
  };
});
