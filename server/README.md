# daylight_server

The `daylight` CLI over HTTP for several users at once. The core (`../kit-sim_daylight`, a git submodule) is linked
in-process; OptiX needs the RTX box, so the server runs there and browsers and scripts on the LAN talk to it.

```
cmake --preset vs2022 && cmake --build --preset release && ctest --preset release   # build/RelWithDebInfo/daylight_server.exe
build\RelWithDebInfo\daylight_server.exe --web ..\web\dist                           # also serves the built frontend on :8080
```

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
- Scenes: the acceleration structures of the last `--gpu-scenes` (default 4) mesh sets stay on the GPU, so users who
  alternate between models do not rebuild each other's (`cache.scene: reused`).
- Weather: every `/proxy` download stays on disk under `--cache` (delete the file to refresh); parsed EPWs stay in RAM.

## Flags

`--port 8080`, `--web DIR` (static files), `--cache DIR` (default `%LOCALAPPDATA%\daylight_server`), `--max-mb 2048`
(request body limit), `--mesh-cache-mb 2048`, `--client-jobs 2`, `--max-queue 32`, `--job-ttl-min 15` (how long finished
jobs stay readable), `--gpu-scenes 4`.

Weather downloads use the Windows-bundled `curl.exe` and only these URL prefixes (see `proxyDownload` in `/docs`):
the EnergyPlus station index on raw.githubusercontent.com, EnergyPlus weather files on S3 (see the EnergyPlus weather
data licence), and PVGIS (European Commission JRC; 30 requests per second per IP).
