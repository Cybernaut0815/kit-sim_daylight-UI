# daylight_server

The `daylight` CLI over HTTP for several users at once. The core (`../kit-sim_daylight`, a git submodule) is linked
in-process; OptiX needs the RTX box, so the server runs there and browsers and scripts on the LAN talk to it.

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

The description lives in [openapi.json](openapi.json) and the guide in [llms.txt](llms.txt); both are embedded into the
exe at build time. `ctest` runs [check_openapi.mjs](check_openapi.mjs), which fails when a route in `src/server.cpp`
is missing from the description (or the reverse), or an operation lacks an id, summary, description or documented
responses. `npx @redocly/cli lint openapi.json` (config [redocly.yaml](redocly.yaml)) validates it against the spec.
Change an endpoint: edit `server.cpp` and `openapi.json` together.

## Several users

- **One GPU, one job at a time.** `POST /jobs` validates the request at once and queues it; one worker thread runs the
  queue in order. Uploads, validation, cached answers, status polls and weather downloads run on the HTTP thread pool
  and never wait for the GPU (measured: about 1 ms each while a 1M-face annual job runs).
- **Progress and cancel.** `GET /jobs/{id}?wait=25` long-polls the state and the queue position; `DELETE /jobs/{id}`
  removes a queued job at once and stops a running one at its next trace chunk. `POST /run` is the blocking variant.
- **Fairness.** Each client (header `X-Client-Id`, else the network address) may have `--client-jobs` jobs (default 2)
  queued or running (`429` beyond that); the queue holds `--max-queue` jobs (default 32, then `503`). `GET /jobs` lists
  only the caller's own jobs.
- **Isolation without accounts.** No authentication; meshes and jobs are addressed by random UUIDs that only their
  owner knows. No CORS headers, so other web pages cannot drive the server.

## Caching

- Meshes: uploaded once, kept in RAM by id (LRU, `--mesh-cache-mb`). A job naming an unknown id gets `404 {missing}`;
  the client uploads those and resubmits (`runRemote` in `bindings/ts` does this).
- Identical request (same mesh ids, args, weather): answered from the result cache at once (`cache.response: hit`).
- Scenes: the acceleration structures of the last `--gpu-scenes` (default 4) scenes stay on the GPU, so users who
  alternate between models do not rebuild each other's (`cache.scene: reused`). A scene is the job's `sensors` ids and
  then its `context` ids, in order, its `--no-self-occlude`, and the layout of the slots that cast shade: the set of
  those that transmit, else (with `--bounces` above 0) whether their RHO or glass differ, which gives the scene a hit
  record per slot (~20 % more GPU memory). New `--optics` values or `--fresnel` reuse it while that layout stays; a
  slot that starts or stops transmitting, or `--bounces` switched on or off for a model whose slots differ (none
  transmitting), is another scene (`built`, then kept like the others). The report is the core's own
  (`Result::sceneReused`).
- Weather: every `/proxy` download stays on disk under `--cache` (delete the file to refresh); parsed EPWs stay in RAM.

## Simulation flags

A job's `args` go to the core's CLI parser unchanged (the table in `/docs`, `submitJob`), so the server stays agnostic
of materials: `.dmesh` uploads may carry a uint16 optics slot per face (header flags bit 0), `--optics` gives meshes and
slots their numbers by mesh name (`PUT /mesh/{id}?name=`, else the id), `--transmission on` and `--fresnel off` switch
the glass and porous paths, and `--bounces N` (0..20, default 0) adds the light the model reflects (up to N diffuse
reflections by each slot's RHO) to diffuse, radiation, irradiance and illuminance, never to direct or sun hours.
Ladybug mode refuses `--transmission on` and `--bounces` above 0. `--bounce-samples M` (64..65536, default 1024) sets
the paths per sensor: the reflected-light pass takes about 2 s per million sensors at 1024 on a city-like model (RTX
2060; linear in M, more among dense overlapping geometry and indoors), and its noise falls as 1 / sqrt(M) (annual
values average it out; raise M to 4096-16384 for a single `--time` instant). Rows or switches out of range are a
`400`; rows the run's meshes do not resolve (unknown or ambiguous name, slot out of range, a row given twice) fail the
job (500).

## Flags

`--port 8080`, `--web DIR` (static files), `--cache DIR` (default `%LOCALAPPDATA%\daylight_server`), `--max-mb 2048`
(request body limit), `--mesh-cache-mb 2048`, `--client-jobs 2`, `--max-queue 32`, `--job-ttl-min 15` (how long finished
jobs stay readable), `--gpu-scenes 4`.

Weather downloads use the Windows-bundled `curl.exe` and only these URL prefixes (see `proxyDownload` in `/docs`):
the EnergyPlus station index on raw.githubusercontent.com, EnergyPlus weather files on S3 (see the EnergyPlus weather
data licence), and PVGIS (European Commission JRC; 30 requests per second per IP).
