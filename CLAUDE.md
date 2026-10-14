# kit-sim_daylight web

- Use the zha-ui skill for every UI change; never style by hand. Only zha-ui classes and CSS variables in `web/`;
  inline `style=` only for the nine zha-ui knobs; the one project stylesheet is `web/src/app.css` (layout only, tokens only).
  Two product decisions deviate from zha-ui on purpose: the radius tokens are zeroed in `app.css` (sharp corners) and
  result data colours (gradient stops, the problem-range colours) are user-chosen hex values, never UI chrome.
- `kit-sim_daylight/` is a git submodule: change the core in its own repo, then bump the pointer here.
- Server: `server/` (C++17, cpp-httplib, links `daylightcore`); API and caching in `server/README.md`.
- Web: `web/` (Vite + React + TS + three + maplibre); `npm test` (vitest), `VITE_MOCK=1 npm run dev` for GPU-free work.
