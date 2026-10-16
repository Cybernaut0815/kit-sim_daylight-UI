# kit-sim_daylight web

- Use the zha-ui skill for every UI change; never style by hand. Only zha-ui classes and CSS variables in `web/`;
  inline `style=` only for the nine zha-ui knobs; the one project stylesheet is `web/src/app.css` (layout only, tokens only).
  Two product decisions deviate from zha-ui on purpose: the radius tokens are zeroed in `app.css` (sharp corners) and
  result data colours (gradient stops, the problem-range colours) and the neutral scene grey of unpainted meshes are hex
  values, never UI chrome.
- `kit-sim_daylight/` is a git submodule: change the core in its own repo, then bump the pointer here.
- `USD_WebViewer/` is a git submodule: the 3D view (`<usd-viewer>`, `web/src/viewer/usd.ts`). Change it in its own repo,
  bump the pointer here, and run `npm run core` (in `web/`) after every bump: its wasm core is gitignored and comes from
  the viewer's GitHub Pages, which serves only the latest `main` core. When a `native/` or protocol change lands on the
  viewer's `main` (as `feature/in-memory-edits` will), re-pin to that `main` the same day, or `npm run core` refuses on
  fresh clones. The viewer's own chrome (its status line, the Shift-drag marquee) is the one exception to zha-ui-only.
- Server: `server/` (C++17, cpp-httplib, links `daylightcore`); API and caching in `server/README.md`.
- Web: `web/` (Vite + React + TS + three + maplibre); `npm test` (vitest), `VITE_MOCK=1 npm run dev` for GPU-free work.
