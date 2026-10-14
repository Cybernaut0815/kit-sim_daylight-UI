# kit-sim_daylight web

Browser front end and HTTP server for [kit-sim_daylight](https://github.com/Cybernaut0815/kit-sim_daylight) (GPU
annual daylight / solar simulation): load `.glb` / `.gltf` / `.obj`, pick shade-casting and receiving meshes, set the
site on a map, the weather (upload, nearest station, PVGIS or clear sky), the time and every CLI option, run on the
GPU box, read the results on the meshes (per-quantity gradients, a problem range painted blue / red) and in charts
(legend, area-weighted histogram, cumulative area curve, range split, per-mesh table); the cursor's element is read
out on every chart. Styled with the ZHA design system (`zha-ui`, `data-brand="code"`).

![Daylight web UI: mesh tree, site map and coordinates on the left; annual radiation painted on the meshes in the centre; colour scale, problem range, distribution and cumulative area charts on the right](docs/UI_preview.png)

```
git clone --recurse-submodules <this repo>
cd server && cmake --preset vs2022 && cmake --build --preset release     # needs VS 2022, CUDA 12.6, OptiX 9 headers, an RTX GPU
cd ../web && npm install && npm run build                                 # needs GitHub access to GitZHACODE/zha-ui
server\build\RelWithDebInfo\daylight_server.exe --web web\dist            # http://localhost:8080
```

Development: `cd web && npm run dev` (Vite proxies the API paths to `localhost:8080`; `npm run dev:mock` fakes the
server for GPU-free UI work).

**API**: several users share the GPU through a job queue; every endpoint is documented by the server itself at
`/docs` (Swagger UI), `/redoc`, `/openapi.json` (OpenAPI 3.1, for agents and code generators) and `/llms.txt`.

- [server/README.md](server/README.md): documentation endpoints, multi-user behaviour (queue, limits, cancel), caching, flags.
- `kit-sim_daylight/`: the core as a git submodule (`git submodule update --init`); its `bindings/ts` is imported by
  the web app through a Vite alias.
- External services the browser uses directly: OpenFreeMap tiles (`styles/dark`, © OpenMapTiles, data from
  OpenStreetMap), Photon geocoder by komoot (OpenStreetMap data). Through the server: EnergyPlus weather files
  (NREL / DOE), PVGIS (European Commission JRC).

Licence: Apache 2.0 with the Commons Clause, like the core (see `kit-sim_daylight/LICENSE`).
