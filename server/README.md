# daylight_server

The core's two tools over HTTP for several users at once: `daylight` (sun and sky) and `views` (what each element
sees), chosen per job (`tool`). The core (`../kit-sim_daylight`, a git submodule) is linked in-process; OptiX needs the
RTX box, so the server runs there and browsers and scripts on the LAN talk to it.

```
cmake --preset vs2022 && cmake --build --preset release && ctest --preset release   # build/RelWithDebInfo/daylight_server.exe
build\RelWithDebInfo\daylight_server.exe --web ..\web\dist                           # also serves the built frontend on :8080
```

The frontend's 3D view (the USD viewer) runs a threaded wasm core, so `--web` serves its files cross-origin isolated
(`Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`; the API and the docs pages
are unchanged). Browsers honour isolation only in a secure context: `http://localhost` works, LAN browsers need HTTPS
in front of the server (a TLS reverse proxy) or a port forward to their own localhost.

## API documentation (served by the server)

| URL | What |
|---|---|
| `/docs` | Swagger UI: every endpoint with parameters, schemas, examples and try-it-out |
| `/redoc` | ReDoc: the same as a reference page |
| `/openapi.json` | OpenAPI 3.1, the machine-readable source; agents should read this |
| `/llms.txt` | a short plain-text guide for agents (workflow, units, limits) pointing at `/openapi.json` |
| `/usage/daylight`, `/usage/views` | each tool's CLI usage text: every flag a job's `args` take, with defaults |

The routes by tag, as operation ids:

- **meshes:** `uploadMesh`, `meshExists`, `meshesMissing`
- **jobs:** `submitJob`, `listMyJobs`, `getJob`, `cancelJob`, `getJobValues`; **run:** `runSync`
- **weather:** `proxyDownload`
- **sets:** `listSets`, `saveSet`, `deleteSet`
- **meta:** `getHealth`, `getUsage`, `getOpenApi`, `getLlmsTxt`, `getDocs`, `getRedoc`
- **agents** (`--mcp`): `mcpMessage`, `mcpGet`, `bridgeNext`, `bridgeResult`, `readLocalPath`, `listReports`,
  `saveReport`, `deleteReport`, `printReport`, `getReportPdf`, `getSession`, `putSession`, `deleteSession`

The description lives in [openapi.json](openapi.json), the guide in [llms.txt](llms.txt) and the MCP tools in
[mcp.json](mcp.json); all three are embedded into the exe at build time. `ctest` runs [check_openapi.mjs](check_openapi.mjs),
which fails when a route in `src/server.cpp` is missing from the description (or the reverse), an operation lacks an
id, summary, description or documented responses, `llms.txt` does not name an operation id, or a tool in `mcp.json`
is not named in the `mcpMessage` description. `npx @redocly/cli lint openapi.json` (config [redocly.yaml](redocly.yaml))
validates it against the spec. Change an endpoint: edit `server.cpp` and `openapi.json` together.

## Several users

- **One GPU, one job at a time.** `POST /jobs` validates the request at once and queues it; one worker thread runs the
  queue in order. Uploads, validation, cached answers, status polls and weather downloads run on the HTTP thread pool
  and never wait for the GPU (measured: about 1 ms each while a 1M-face annual job runs).
- **Progress and cancel.** `GET /jobs/{id}?wait=25` long-polls the state and the queue position; `DELETE /jobs/{id}`
  removes a queued job at once and stops a running one at its next trace chunk. `POST /run` is the blocking variant.
- **Fairness.** Each client (header `X-Client-Id`, else the network address) may have `--client-jobs` jobs (default 2)
  queued or running (`429` beyond that); the queue holds `--max-queue` jobs (default 32, then `503`). `GET /jobs` lists
  only the caller's own jobs.
- **Isolation without accounts.** No authentication; jobs are addressed by random UUIDs that only their owner knows,
  meshes by ids their clients choose: the daylight-mesh client's derive from the bytes' SHA-256 (with the mesh's name
  folded in when it has one), so only a client holding the same geometry can name one (and the server never sends
  mesh bytes back). One name per id: the last PUT's. No CORS headers, so other web pages cannot drive the server.

## Caching

- Meshes: uploaded once, kept in RAM by id (LRU, `--mesh-cache-mb`). A job naming an unknown id gets `404 {missing}`;
  the client uploads those and resubmits (`runRemote` in `bindings/ts` does this).
- Identical request (same mesh ids, args, weather): answered from the result cache at once (`cache.response: hit`).
- Scenes: the acceleration structures of the last `--gpu-scenes` (default 4) scenes stay on the GPU, so users who
  alternate between models do not rebuild each other's (`cache.scene: reused`; what makes a scene: `CacheReport` in
  `/docs`). New `--optics` values reuse a scene while the layout of its transmitting and reflecting slots stays. The
  report is the core's own (`Result::sceneReused`).
- Weather: every `/proxy` download stays on disk under `--cache` (delete the file to refresh); parsed EPWs stay in RAM.

## Simulation flags

A job's `args` go to the core's CLI parser unchanged (`daylight` or, with `tool=views`, `views`; every flag in
`/usage/{tool}`, the same text as the CLI's `-h`), so the server stays agnostic of materials: `.dmesh` uploads may carry a uint16 optics slot per face (header flags bit 0), `--optics` gives meshes and
slots their numbers by mesh name (`PUT /mesh/{id}?name=`, else the id), `--transmission on` and `--fresnel off` switch
the glass and porous paths, and `--bounces N` (0..20, default 0) adds the light the model reflects (up to N diffuse
reflections by each slot's RHO) to diffuse, radiation, irradiance and illuminance, never to direct or sun hours.
Ladybug mode refuses `--transmission on` and `--bounces` above 0. `--bounce-samples M` (64..65536, default 1024) sets
the paths per sensor: the reflected-light pass takes about 2 s per million sensors at 1024 on a city-like model (RTX
2060; linear in M, more among dense overlapping geometry and indoors), and its noise falls as 1 / sqrt(M) (annual
values average it out; raise M to 4096-16384 for a single `--time` instant). Rows or switches out of range are a
`400`; rows the run's meshes do not resolve (unknown or ambiguous name, slot out of range, a row given twice) fail the
job (500).

A run the machine has no memory for (host RAM, or GPU memory for the scene) fails its job with `507` and the server
keeps running; a result over 134,217,728 values (rows x columns) is refused with `413` before it is queued.

## Flags

`--port 8080`, `--web DIR` (static files), `--cache DIR` (default `%LOCALAPPDATA%\daylight_server`), `--max-mb 2048`
(request body limit), `--mesh-cache-mb 2048`, `--client-jobs 2`, `--max-queue 32`, `--job-ttl-min 15` (how long finished
jobs stay readable), `--results-mb 1024` (finished jobs' results kept at most; the oldest go first), `--gpu-scenes 4`, `--mcp` (the agent routes, below), `--browser PATH` (Chrome or Edge for report
PDFs and the hidden instance; default the one registered under Windows App Paths), `--app-url URL` (the app the hidden
instance opens; default this server's `--web` app).

Weather downloads use the Windows-bundled `curl.exe` and only these URL prefixes (see `proxyDownload` in `/docs`):
the EnergyPlus station index on raw.githubusercontent.com, EnergyPlus weather files on S3 (see the EnergyPlus weather
data licence), and PVGIS (European Commission JRC; 30 requests per second per IP).

## Analysis sets

The web app saves its analysis sets (one analysis' roles by prim path per model, its settings and the shown result) and
its combined views (weighted combinations of sets' results) here, one JSON object each in `<cache>\sets\<id>.json`
(their fields: `AnalysisSet` and `CombinedView` in `/docs`):
`GET /sets` lists them, `PUT /sets/{id}` stores one (at most 256 KB, one JSON object, written to a temporary file and
renamed; at most 500 sets, a new one past that is `409`), `DELETE /sets/{id}` removes one. These routes need no
`--mcp` and answer every client: every browser that reaches the server sees and edits the same sets, with no owner and
no version check (the last write wins), and the agent reaches them through the app's tools.

## Agents (MCP)

`--mcp` lets agents on this machine work with the web app over MCP: Claude Code or Claude Desktop opens models (A to
D, USD variants included), sets roles, settings and cameras, runs the Daylight and the View analysis, reads results,
saves, opens and runs analysis sets and weighs them into combined views (the Combined tab), takes screenshots of any
shape, sections the views with clipping planes and boxes (view only: runs use the whole model), edits the Results
charts, writes PDF reports in the kit-ui `kit-report` layout (one option, or 2 to 4 compared) and talks through what
the results mean. The app has no chat: the
agent drives the open app tab and everything it changes shows there. `POST /mcp` answers the handshake and the tool
list from [mcp.json](mcp.json) and relays each tool call to the tab (`web/src/mcp`); `/docs` documents the routes (tag
`agents`) and lists the tools under `mcpMessage`.

```
build\RelWithDebInfo\daylight_server.exe --web ..\web\dist --mcp
```

- **Claude Code:** `claude mcp add --transport http daylight http://127.0.0.1:8080/mcp`, then `/mcp` lists the tools. If
  it does not connect, start Claude Code with `MCP_PROTOCOL_NEGOTIATION=legacy` (the server speaks the MCP revisions
  2025-11-25, 2025-06-18 and 2025-03-26, which have the `initialize` handshake).
- **Claude Desktop** runs local servers only as stdio commands (its connectors run in Anthropic's cloud and cannot reach
  this machine), so [mcp-stdio.mjs](mcp-stdio.mjs) (Node 18 or later, no packages) relays its messages to `POST /mcp`.
  Merge the entry into `%APPDATA%\Claude\claude_desktop_config.json` with absolute paths (`where node` shows node.exe;
  Claude Desktop does not quote `args`, so keep the script path free of spaces), restart Claude Desktop and read
  `%APPDATA%\Claude\logs\mcp*.log` if the tools do not show. A URL after the script path picks another server.

  ```json
  { "mcpServers": { "daylight": { "command": "C:\\Program Files\\nodejs\\node.exe",
                                  "args": ["F:\\Github\\kit-sim_daylight_frontend\\server\\mcp-stdio.mjs"] } } }
  ```

- **Every call answers within 55 s** (Claude Desktop ends tool calls at about 60 s): a run, a big model or a PDF goes on
  in the app, the reply says `running` or `generating`, and the agent calls again.
- **Keep the app tab open.** Background and minimised tabs work, but a browser that discards tabs to save memory loses
  the loaded models: put the app's address on its list of sites to always keep active (Chrome: Settings > Performance;
  Edge: Settings > System and performance, "Never put these sites to sleep"). **One tab per address:** each tab holds
  one long poll open and browsers allow 6 connections per host, so several tabs slow each other's model downloads;
  calls go to the tab focused last.
- **Claude-only mode.** With no app tab open, the first tool call starts the app hidden in headless Chrome (or Edge) and
  the agent works there. It needs `--web` (or `--app-url URL` for an app served elsewhere, such as the Vite dev server
  on `http://localhost:5173/`) and a browser (`--browser PATH`, else the one registered under Windows App Paths). The
  hidden instance has its own profile in `<cache>\agent-profile` and takes about 1.5 GB of memory with a model loaded.
  It ends with the server, or when you open the app: the app picks its session up (models, roles, settings, camera,
  results) and the server closes it. A tool call that finds no tab first gives one 5 s to come back (a page reloading,
  or an app tab reconnecting after a server restart: it retries every 3 s), so the hidden instance never starts beside
  the app you have open; should it start anyway (a frozen background tab), the app's next poll closes it when it has
  changed nothing, else reloading the app picks its session up. A hidden page that cannot reach the server (a wrong
  `--app-url`, a host name other than localhost or 127.0.0.1, a dev server that does not forward `/bridge`) makes tool
  calls say so after 30 s; one that stops polling for a minute is started again.
- **Reports** live in `<cache>\reports\<id>\`: `report.json` (the spec the agent saved, which you edit in the app: charts
  with the settings button in Results, cameras in the Views menu), `index.html` (the page last printed) and `report.pdf`,
  printed by the same browser in headless mode (profile `<cache>\pdf-profile`). After editing, generate the PDF again from
  the Reports menu; a PDF viewer that locks `report.pdf` stops that (`409`), so close the PDF first.
- **This machine only.** Without `--mcp` the agent routes (`/mcp`, `/bridge`, `/files`, `/reports`, `/session`) answer
  `404`. With it they answer only requests from this machine (TCP peer 127.0.0.1 or ::1, `Host` localhost, 127.0.0.1 or
  [::1], same origin, no proxy headers: `Forwarded`, `X-Forwarded-*`, `X-Real-IP`, `Via`; else `403`), since they read
  files on this machine and drive its browser; LAN users keep the app and the job API. Two setups make a LAN user look
  local, so do not combine them with `--mcp`: an SSH port forward (`ssh -L 8080:localhost:8080`), and a reverse proxy on
  this machine that adds none of those headers (nginx: `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`
  makes the agent routes refuse its requests). The app's own dev server (`vite --host`, `vite preview --host`) names a
  client from another machine in `X-Forwarded-For` (web/vite.config.ts), so the agent routes refuse it too.
- **Smoke test:** `node test\mcp-smoke.mjs --web ..\web\dist` starts servers of its own (ports 18100 and 18101, a fresh
  cache) and checks the agent routes end to end in Claude-only mode: `404` without `--mcp`, the gate, the handshake, the
  fixture [test/building.usda](test/building.usda) through the tools to two PDF reports, and `mcp-stdio.mjs`.
- **Large-model bench:** `node test\bench.mjs --selftest`; `--mode server` (the client lib on a server of its own) and
  `--mode browser` (Chrome or Playwright's Firefox through these tools) time the core's `validate/big.py` models and cases
  into `<root>\results.jsonl`; usage at the top of [test/bench.mjs](test/bench.mjs).
