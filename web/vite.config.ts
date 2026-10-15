import { Agent } from 'node:http';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { mock } from './mock/run.ts';

const API = 'http://127.0.0.1:8080'; // the server listens on IPv4 only; 'localhost' would try ::1 first
const agent = new Agent({ keepAlive: true }); // without it the dev proxy opens a new TCP connection for every request

// `VITE_MOCK=1 vite` or `vite --mode mock` (npm run dev:mock): fake the server for GPU-free, offline UI work.
export default defineConfig(({ mode }) => {
  const MOCK = !!process.env.VITE_MOCK || mode === 'mock';
  return {
    plugins: [react(), ...(MOCK ? [mock()] : [])],
    resolve: {
      // The core's TS binding straight from the submodule source; its three / gltf-transform imports resolve here.
      alias: { 'daylight-mesh': fileURLToPath(new URL('../kit-sim_daylight/bindings/ts/src/index.ts', import.meta.url)) },
      dedupe: ['three', '@gltf-transform/core'],
    },
    server: {
      fs: { allow: ['..'] },
      proxy: MOCK ? undefined : Object.fromEntries(['/run', '/jobs', '/mesh', '/proxy', '/health', '/openapi.json', '/docs', '/redoc', '/llms.txt'].map((p) => [p, { target: API, agent }])),
    },
    test: { environment: 'node', include: ['src/**/*.test.ts'] },
  };
});
