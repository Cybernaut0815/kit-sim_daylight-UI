# kit-sim_daylight web

- Use the kit-ui skill for every UI change; never style by hand. The design system is the `kit-ui` package
  (`github:Cybernaut0815/kit-UI_template#v0.2.2` in `web/package.json`; source repo `Cybernaut0815/kit-UI_template`), and
  its skill ships inside it: read `web/node_modules/kit-ui/skills/kit-ui/SKILL.md` and `reference.md` before writing
  markup. Only kit-ui classes and CSS variables in `web/`; inline `style=` only for its seven knobs (`--container-w
  --grid-min --stack-gap --split-aside --control-h --dialog-w --sidebar-w`, via `knob()` in `web/src/ui.tsx`); charts take
  `--chart-*` tokens (`--chart-cat-1..8` for series in fixed order). The one project stylesheet is `web/src/app.css`
  (layout only, tokens only). One deliberate deviation: result data colours (gradient stops, the problem-range colours)
  and the neutral scene grey of unpainted meshes are hex values, never UI chrome. The `kit-report` skill in the same
  package (`skills/kit-report/SKILL.md`) is the layout of the PDF reports (`web/src/report`, the agent's `guide` topic).
- `kit-sim_daylight/` is a git submodule (the repo kit-sim_core): change the core in its own repo, then bump the pointer
  here.
- `USD_WebViewer/` is a git submodule: the 3D view (`<usd-viewer>`, `web/src/viewer/usd.ts`). Change it in its own repo,
  bump the pointer here, and run `npm run core` (in `web/`) after every bump: its wasm core is gitignored and comes from
  the viewer's GitHub Pages, which serves only the latest `main` core. When a `native/` or protocol change lands on the
  viewer's `main`, re-pin to that `main` the same day, or `npm run core` refuses on fresh clones. The viewer's own chrome
  (its status line, the Shift-drag marquee) is the one exception to kit-ui-only.
- Two analyses of the same models, a tab each: Daylight and View analysis (the core's `views`), then the Combined tab,
  always last (saved sets' results weighed into one value per element, `web/src/sets`). Their roles, settings, runs and
  results are separate (`web/src/store.ts`: the view analysis' slice, actions tagged `tab: 'views'`, the Combined tab's
  column and colouring `tab: 'combined'`; untagged = daylight). The agent tools in `web/src/mcp` drive both analyses
  (`analysis` parameter, daylight by default) and the Combined tab. Materials edits are shared. Analysis sets and
  combined views live on the server (`/sets`, open to every client); results stay per session in `web/src/sets/kept.ts`.
  A set is a tab's whole setup, each entry linked to its own model (letter and file, `sets/apply.ts` `entryFor`, no
  borrowing); another model takes one only as a copy (`copySet`, roles and Materials edits by USD path).
- Server: `server/` (C++17, cpp-httplib, links `daylightcore`; `tool` = daylight or views per job); API and caching in
  `server/README.md`. Edit `server/src/server.cpp` and `server/openapi.json` together.
- Web: `web/` (Vite + React + TS + three + maplibre); `npm test` (vitest; from PowerShell: in Git Bash its default
  forks pool fails with "Cannot read properties of undefined (reading 'config')"), `VITE_MOCK=1 npm run dev` for GPU-free
  work.
