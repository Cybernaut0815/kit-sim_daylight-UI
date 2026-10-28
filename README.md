# kit-sim_daylight web

Browser front end and HTTP server for [kit-sim_daylight](https://github.com/Cybernaut0815/kit-sim_daylight) (GPU
annual daylight / solar simulation): open a USD stage (`.usd` / `.usda` / `.usdc` / `.usdz`, as files or a folder with
its assets) or a `.glb` / `.gltf` (Draco and meshopt compression too) / `.obj` (with its `.mtl`), turned into USD in the
browser with its materials, UVs and textures, in the [USD web viewer](https://github.com/Cybernaut0815/USD_WebViewer),
pick shade-casting and receiving meshes (or whole groups) in the stage's prim tree, switch its variants, hide or lock
prims as in the viewer, subdivide catmullClark / loop meshes (creases included) so the run uses the smooth surface, set
the site on a map, the weather (upload, nearest station, PVGIS or clear sky), the time (a single date and time, a date
range such as 09:00 to 17:00 every day of the summer, or the whole year) on timelines or by dragging the sun path drawn
around the model, and every CLI option; run on the GPU box (or tick "Run on every change"), read the results on the
meshes (per-quantity gradients, a problem range painted blue / red) and in charts (legend, area-weighted histogram,
cumulative area curve, each over the colour scale or the whole data range, range split, per-mesh table); the cursor's
element is read out on every chart. Set the 3D view to one of the model's cameras or to a view saved in the app (kept
for the session, never written to a file, removed again from the same menu). Compare up to four models: "+" in the
Model panel adds one (tabs A to D; the Model and Materials panels show the active one, a click in a view makes its model
active), each in its own 3D view (side by side, stacked or 2 x 2; cameras linked or independent); Run runs every model
with a receiver, one after another, and the Results show every model on one colour scale, with its difference to the
first. Download the active model's result from the bar under the 3D views as `.usdz`, `.usda`, `.usdc`, `.usd`,
`.glb`, `.gltf` or `.obj`. In USD either the result colours replace the receivers' materials,
or the flattened stage gets a variant set `daylight` on each receiver (`original` plus one variant per result); both
keep every result column as a value primvar (`primvars:daylight_<result>`) on the polygons the run simulated: a mesh's
own faces, or the subdivided faces when the run used subdivision, never the triangulation. A `.usdz` packs the model
files with it; a `.usda` / `.usdc` / `.usd` is the flattened stage, zipped with the textures it uses. glTF and OBJ hold
the model as drawn, in metres, the receivers coloured with the shown result; glTF also every result as a value
attribute (`_DAYLIGHT_<RESULT>`).
Styled with [kit-ui](https://github.com/Cybernaut0815/kit-UI_template) (`data-kit="sim"`, KIT-SIM) at `/`; for now the
same app in the ZHA design system (`zha-ui`, `data-brand="code"`) stays at `/zha.html`, and a link in the app bar
switches between them (settings carry over). Each page loads only its own design system (`web/src/kit.css`,
`web/src/zha.css`).

**Materials.** By default every surface is opaque and black (today's numbers and speed, as Ladybug's RadiationStudy);
only the virtual ground reflects (*Ground reflectance*). Two switches in Simulation, each slower, add what the model's
materials do: *Transmission* lets glass (by angle, as Radiance glass, unless *Angle-dependent glass* is off), screens
and cut-out trees pass their transmittance τ, and *Reflections* (off, 1-20; 1 for outdoor studies, 5-8 for interiors;
*Reflection samples* under Advanced, 1024) adds the light the model's own surfaces reflect by their reflectance ρ. The
Materials table reads each material's kind, ρ and τ from its own settings, never its name: opacity, cut-out and opacity
texture tell glass (the default glass: double low-e, τ 0.64) and porous apart, the colour or colour map gives ρ (its
luminance, 0.02-0.9; no colour of its own: the default 0.20); edit a value or pick a preset (kept while the model is
open: re-reads keep them, opening another model clears them). Ladybug mode keeps every surface opaque and black. More
precise: Transmission on, 2 reflections, 4096 samples.

![Daylight web UI: mesh tree, site map and coordinates on the left; annual radiation painted on the meshes in the centre; colour scale, problem range, distribution and cumulative area charts on the right](docs/UI_preview.png)

```
git clone --recurse-submodules <this repo>
cd server && cmake --preset vs2022 && cmake --build --preset release     # needs VS 2022, CUDA 12.6, OptiX 9 headers
cd ../web && npm install && npm run core && npm run build                # needs GitHub access to GitZHACODE/zha-ui and Cybernaut0815/kit-UI_template
server\build\RelWithDebInfo\daylight_server.exe --web web\dist            # http://localhost:8080
```

`npm run core` fetches the USD viewer's wasm core (`usdcore.js`, `usdcore.wasm`, gitignored) from the viewer's GitHub
Pages into `USD_WebViewer/web/public/core/`, after checking that it was built from the same sources as the pinned viewer
commit, and records that commit in `web/usdcore.pin`; the build refuses a core fetched for another commit, so run it
again after every bump of that submodule (a core built yourself can be copied there instead, see `web/scripts/core.mjs`). The core needs a cross-origin isolated
page: the server and the dev server send the headers, and browsers honour them on `localhost` or over HTTPS.

To run the server: Windows 10/11 x64, an NVIDIA GPU of compute capability 7.5 or newer (Turing and later, no rebuild
per card), an NVIDIA driver R570+ and the VC++ 2015-2022 x64 runtime; details and why containers on WSL2 cannot run
it yet (OptiX is not in NVIDIA's WSL driver; a Linux GPU host is the container path, and the OptiX SDK licence
restricts hosted / internet use by third parties) are in the core's [README](kit-sim_daylight/README.md#build).

Development: `cd web && npm run dev` (Vite proxies the API paths to `localhost:8080`; `npm run dev:mock` fakes the
server for GPU-free UI work). Judge speed in the built app served by the server: the dev build adds about 40 ms to
every run (an instant re-run takes about 15 ms from click to the new numbers; an annual one is its compute time, mostly
the CPU sky model, plus about 20 ms).

**API**: several users share the GPU through a job queue; every endpoint is documented by the server itself at
`/docs` (Swagger UI), `/redoc`, `/openapi.json` (OpenAPI 3.1, for agents and code generators) and `/llms.txt`.

- [server/README.md](server/README.md): documentation endpoints, multi-user behaviour (queue, limits, cancel), caching, flags.
- `kit-sim_daylight/`: the core as a git submodule (`git submodule update --init`); its `bindings/ts` is imported by
  the web app through a Vite alias.
- `USD_WebViewer/`: the 3D view (`<usd-viewer>`: OpenUSD in WebAssembly, drawn by three.js) as a git submodule; its
  source is imported through a Vite alias and its `web/public` (the core, the skies) is the app's public folder.
- External services the browser uses directly: OpenFreeMap tiles (`styles/dark`, © OpenMapTiles, data from
  OpenStreetMap), Photon geocoder by komoot (OpenStreetMap data). Through the server: EnergyPlus weather files
  (NREL / DOE), PVGIS (European Commission JRC).

Licence: Apache 2.0 with the Commons Clause, like the core (see `kit-sim_daylight/LICENSE`).
