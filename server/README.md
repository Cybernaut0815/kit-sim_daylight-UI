# daylight_server

The `daylight` CLI over HTTP. The core (`../kit-sim_daylight`, a git submodule) is linked in-process; OptiX needs
the RTX box, so the server runs there and browsers on the LAN talk to it. One GPU: runs serialise.

```
cmake --preset vs2022 && cmake --build --preset release          # build/RelWithDebInfo/daylight_server.exe
build\RelWithDebInfo\daylight_server.exe --web ..\web\dist       # serves the built frontend on :8080 too
```

Flags: `--port 8080`, `--web DIR` (static files), `--cache DIR` (default `%LOCALAPPDATA%\daylight_server`, the
`/proxy` disk cache), `--max-mb 2048` (request body limit), `--mesh-cache-mb 2048` (RAM for cached meshes).

| Method, path | Body / query | Response |
|---|---|---|
| `PUT /mesh/{id}?name=` | one `.dmesh` image; `id` = `[A-Za-z0-9-]{1,64}` chosen by the client | 204; 400 with the reader's message |
| `GET /mesh/{id}` | | 204 cached, 404 not |
| `POST /run` | multipart: `sensors` / `context` (mesh ids, repeated), `args` (CLI flags verbatim, repeated), `epw` (file) or `epw_url` | 200 JSON: the CLI's `FILE.json` manifest fields + `values_b64` (float64 LE `[N x C]`) + `run_s` + `cache {response, scene, weather}`; 404 `{"missing": [ids]}`; 400 = CLI exit 1 (usage, text); 500 = CLI exit 2 (runtime, text) |
| `GET /proxy?url=` | one of the allowlisted prefixes below, URL-encoded | the bytes, `X-Daylight-Cache` hit or miss, `Cache-Control: max-age=86400`; 400 outside the allowlist; 502 download failure |
| `GET /health` | | `ok` |

Not available over HTTP: positional / `--context` files, `--epw FILE`, `--out`, `--timeseries`, `--dump-*`, `--bench`.

```
curl -T box.dmesh "localhost:8080/mesh/box-1?name=box"
curl -F sensors=box-1 -F args=--lat -F args=42.35 -F args=--lon -F args=-71.07 -F args=--tz -F args=-5 ^
     -F args=--quantity -F args=sunhours -F args=--time -F args=06-21T12:00 localhost:8080/run
curl -G --data-urlencode "url=https://re.jrc.ec.europa.eu/api/v5_3/tmy?lat=52.52&lon=13.41&outputformat=epw" localhost:8080/proxy -o berlin.epw
```

The `url` query parameter must be URL-encoded (its own `&` would otherwise split it). A stored response (`cache.response:
hit`) replays the body of the run that produced it, so its `scene` / `weather` fields describe that original run.

## Caching

- Meshes: uploaded once, kept in RAM by id (LRU by bytes). A `/run` that names an unknown id answers 404
  `{"missing": [...]}`; the client PUTs those and retries (`runRemote` in `bindings/ts` does this). A browser logs
  that 404 in its console on the first run after a model load; it is the normal handshake, not a failure.
- Identical request (same ids, args, weather) -> the stored response (`cache.response: hit`), no GPU work.
- Same meshes and `--no-self-occlude` state as the previous run -> the core keeps its triangles and OptiX
  acceleration structure (`cache.scene: reused`); the GPU context lives for the process either way.
- Weather: `/proxy` keeps every download on disk (delete the file under `--cache` to refresh); parsed EPWs stay in RAM.

## /proxy allowlist (the only URLs the process fetches; downloads via the Windows-bundled `curl.exe`)

- `https://raw.githubusercontent.com/NREL/EnergyPlus/develop/weather/master.geojson` (station index)
- `https://energyplus-weather.s3.amazonaws.com/` (EnergyPlus weather files; see the EnergyPlus weather data licence)
- `https://re.jrc.ec.europa.eu/api/v5_3/tmy?` (PVGIS typical meteorological year, European Commission JRC; 30 req/s per IP)
