# Daylight results: what they mean and how to talk about them

How to read the Daylight app's results (GPU sun, sky and daylight simulation on building meshes) and discuss them
with architects and engineers. Where an app help text (the meaning results returns) differs, this guide holds.

## 1. How to answer

- Start from app_state: the open models, their roles, and whether each result is fresh, stale or running. Stale = the
  inputs changed since that run: run before quoting it.
- Quote numbers only from tool output (results, find_critical, run, site_info, get_materials, screenshot texts),
  rounded as given. Never estimate, interpolate or recompute a statistic a tool can give: ask the tool (results with
  paths, by, thresholds; find_critical with below or above).
- A number you derive (a ratio, a percentage change, a yield from an assumed efficiency) is called derived and shows
  the tool numbers and the formula it comes from, rounded no finer than its inputs.
- Every number says: the model (letter and file name), the column in words (e.g. sun hours, front side), the period
  (time mode, dates, daily hours, standard time), the statistic (area-weighted mean, median, P10, P90, share of the
  receiver area) and what it covers (whole model, a prim path, a facing side).
- Values belong to surfaces: each element (triangle or vertex) of the receiver meshes, weighted by its area. They are
  not room values, and not point values unless the receiver is a small patch at that point.
- Do not over-claim. A result holds for the model as set up (geometry, roles, materials, north) under the assumptions in
  section 5. Where the app approximates a standard (section 7), say "approximates" and what it leaves out; never say a
  design complies with something the app does not compute (section 6).
- "Is it good?": compare with the criterion the user names or a standard's; otherwise describe the distribution (mean,
  P10, P90, shares) and the critical areas. Ask when the surfaces, the period or the threshold are unclear, or state
  the choice you made.

## 2. Quantities

Columns are `<quantity>_<side>`: radiation_front, sunhours_back, ... One column per quantity in sim.quantities and per
side (sim.sides 'both' adds the _back columns). Default: all six quantities, front side, physical mode.

| quantity | per element | total (value x area) | over the period |
| --- | --- | --- | --- |
| radiation | kWh/m² | kWh | sum |
| direct | kWh/m² | kWh | sum |
| diffuse | kWh/m² | kWh | sum |
| irradiance | W/m² | W | mean over the hours evaluated |
| illuminance | lx | lm | mean over the hours evaluated |
| sunhours | h | h·m² | sum of sunlit time |

- radiation: solar energy received per m² in the period: sun, sky and the virtual ground, each weighted by the cosine
  of its angle to the surface and by what blocks it (0 behind an opaque surface; the transmittance with
  sim.transmission on), plus the light the model reflects when sim.bounces > 0. radiation = direct + diffuse (within
  rounding).
- direct: the sun's beam only, DNI x cos(incidence) x transmittance, summed. 0 while the sun is down, behind the
  surface or hidden by solid geometry, so it shows where shading works. Never includes reflections. In ladybug mode the
  sun is spread over the 4 nearest sky patches, so its shadows are blurred.
- diffuse: sky and ground-reflected light, plus all model-reflected light (reflected sun included) with reflections
  on. Hardly changed by small obstructions; the larger share in overcast climates.
- irradiance: radiation x 1000 / hours evaluated, i.e. the mean power over every evaluated step. For an instant, the
  power at that moment.
- illuminance: the visible counterpart, from the weather's irradiance by the Perez luminous efficacy model (as Radiance
  gendaymtx), averaged like irradiance, on the receiver surface in its own plane. Physical mode only.
- sunhours: the sum of the step lengths in which the sun is up (refracted altitude >= 0 at the step's middle, or at the
  instant), in front of the element (strictly positive cosine to its normal) and not blocked. Not cosine-weighted, and
  the weather is ignored completely: these are possible sun hours on a cloudless day, the same with any weather
  source. Not a rights-to-light measure (rights to light use the sky factor: section 6). With sim.transmission on,
  each step counts by the transmittance along the ray (an hour behind tau 0.6 counts 0.6: equivalent full-sun hours);
  with every surface opaque, the default, an exact count at the step's resolution. Never includes reflections.
  - Resolution: range mode counts in steps (10 min = 1/6 h is the finest); annual mode counts whole hours, judged at
    the mid-hour.
  - site_info's day length is about the most sun hours any element can get on that date (to within a step).
  - site_info's monthly digest of the weather file compares its sunshine hours (DNI >= 120 W/m², the WMO threshold)
    with the possible daylight hours: how often the sun really shines. Context for sun hours, never a conversion.
- Totals: kWh = energy on that area in the period; W and lm = mean power or flux on it; h·m² means something only
  divided by the area (the mean).

Means include night hours. An annual irradiance or illuminance is averaged over all 8760 (8784) hours of the year,
about half of them at night; a whole-day range mean includes that day's night. Never compare such means with daytime
criteria: not with 300-500 lx task targets, not with daytime W/m² levels. Such a target fits only an instant or a mean
over occupied hours (section 7) on an interior work plane, and even then a mean hides the hours below the target.

## 3. Time modes (update_settings time)

- annual: every hour of the weather year, one 1 h step per weather row with the sun at mid-hour: 8760 hours (8784 for a
  leap-year EPW; clear sky 8760). Sums are yearly totals. Needs a weather source even for sun hours alone (it sets the
  year's hours).
- instant: one date and hour; one 1 h step evaluated at that instant. irradiance and illuminance are the values at that
  moment; radiation, direct and diffuse are that power held for 1 h (kWh/m² = W/m² / 1000); sunhours is 1 (sunlit), 0
  (not) or the transmittance between: a sunlit mask.
- range: every day from from.date to to.date, each from from.hour to to.hour ('24:00' = end of day), in steps of step
  minutes, the sun at each step's middle; the last step of a day's window can be shorter. One date (from.date =
  to.date) gives that day's window only. Sums cover the steps; means divide by the windows' hours only.
- Instants and sub-hour steps interpolate the weather between its hourly rows; 60 min steps from whole hours read the
  rows exactly.
- The year of a date is ignored (29 February only with a leap-year EPW).
- Times are the site's local standard time all year, no daylight saving (site_info gives the zone). Where clocks go
  forward 1 h in summer, 09:00-17:00 on summer clocks is 08:00-16:00 standard time.
- A date reads that date's weather in the file: a typical year's 21 March may be cloudy. For a cloudless day use
  weather.source 'clear-sky'. Sun hours do not change either way.
- Sums over different periods are not comparable (a sum grows with its period).

## 4. Elements, sides and statistics

- Elements: sim.on 'faces' (default): one per triangle of the drawn meshes (a quad is two), the sensor at the
  triangle's centroid, facing along its normal. 'vertices': one per mesh point, along the area-weighted mean normal of
  its triangles, weighted by a third of each adjacent triangle's area; where a mesh shares a point between faces at an
  angle (a wall's foot joined to the ground) that normal is tilted and biases the value.
- Resolution is the mesh's: a facade drawn as two large triangles gets two values and no shadow edge across it. Fine
  maps need finely meshed receivers; the app refines only catmullClark / loop subdivision meshes (set_geometry
  subdivision).
- Sides: front = where the face normal points (right-handed winding); back = the opposite. Directions behind an element
  add nothing, and an element looking into a wall still gets a row (0). Front values near 0 on a surface that clearly
  sees the sky suggest faces wound the other way: run with sim.sides 'both' and read the _back column, or fix the model.
- Area weighting: every statistic weights elements by their area in m² (model units times open_model's
  metersPerUnit). Means are area-weighted (total / area); P10, median and P90 are area percentiles (P10: 10 % of the
  area gets less; P90: 10 % gets more); shares are shares of the receiver area, never of element counts.
- Scale: a USD stage without metersPerUnit counts as centimetres (USD's fallback 0.01; glb, gltf and obj open as
  metres): drawn in metres, it comes out 100 times too small. Check one known area (results by 'mesh') before quoting
  areas, totals or lengths; values per m² and sun hours do not depend on the scale (apart from sim.offset).
- Thresholds (results thresholds): a value equal to x counts as at or above x.
- Problem range: one per quantity (its front and back columns share it), update_settings viz.below and viz.above in the
  column's unit, null = open. Values under viz.below count as 'below', over viz.above as 'above', between them
  inclusive as 'within'. It drives the shares in results, the default of find_critical and the parts chart metrics
  below / within / above. Set it to the criterion under discussion so the views, charts and numbers agree, and name
  the quantity: viz {quantity: 'sunhours', below: 1.5} (without quantity it applies to the shown column's quantity).
- Colour scale: viz.gradient, viz.min and viz.max (null = the data's range over every model) only colour the views and
  set the charts' relative axis; no statistic changes.

## 5. Assumptions and limits

### Model setup

- Roles (set_roles): receiver = gets results and casts shade (sim.selfOcclude, default on); shade = only casts shade
  (neighbours, trees, terrain); none = left out. Prims hidden by set_visibility still run by their role. Whatever is
  not modelled, or set to none, does not shade.
- sim.north (degrees counter-clockwise from the model's +Y axis to true north) turns the sun for every result and sets
  the N / E / S / W of results by 'facing' and of find_critical. Check it before discussing orientation.

### Surfaces and light

- Default: every surface is opaque and black. Glass blocks like a wall and nothing reflects, except the virtual ground:
  an infinite ground below the horizon of reflectance sim.ground (default 0.2), lit by the whole sky and sun and never
  shaded by the model.
- A modelled ground (site plate, terrain) set to shade or receiver hides the virtual ground from the rays it stops:
  without reflections it is black, so facades near it lose their ground-reflected light; with reflections it reflects
  by its own reflectance, with the model's shadow. Set it to none unless it shades, or turn reflections on.
- Transmission (sim.transmission, physical mode): glass, porous screens and tree crowns pass light by their
  transmittance tau; glass by angle while sim.fresnel is on (default; Radiance glass, refractive index 1.52). Off:
  everything opaque. On, every glass and porous material of every model passes light.
- sim.cullBackfaces (default off): on, surfaces block only rays that reach their front side: single-sided geometry
  facing away from the receivers lets light through, and a closed crown passes its tau once, not twice (the tree
  presets assume two crossings: 'Deciduous tree, in leaf' then passes 0.32, not 0.10). Check it when light leaks.
- Reflections (sim.bounces 1-20, physical mode): up to that many diffuse reflections by each surface's reflectance
  rho; glass mirrors by angle (fresnel on). Diffuse only: a metal or polished facade reflects as a matt one. 1 is the
  common outdoor setting, interiors need 5-8; the app suggests transmission on, 2 reflections and 4096 samples for
  more precise numbers (slower). Interior light needs receivers inside, transmission and reflections.
- Materials (get_materials, edit_material): kind, rho and tau per material, read from the model's UsdPreviewSurface:
  opacity below 0.98 (not metallic) -> glass with tau 0.64 whatever the opacity; cut-outs and varying opacity textures
  -> porous; rho = the diffuse colour's luminance, 0.02 to 0.9. No readable material (MaterialX, OpenPBR too): opaque,
  rho 0.2. Edits are per model.
- One band: rho and tau are single numbers for light and solar energy alike. The default glass tau 0.64 is double
  low-e's visible transmittance; the same unit passes about 0.37 of solar energy, so radiation behind glass is
  overstated for low-e and solar-control glass.
- Ladybug mode (sim.mode 'ladybug') emulates Ladybug Tools' RadiationStudy / DirectSunStudy (sky density 1 or 2);
  physical mode differs from it by 1-4 % on average. Its Grasshopper component uses a 0.1 m sensor offset (sim.offset;
  the app's default is 0) and self-shading.

### Sky, sun and weather

- Sky: a Perez all-weather sky per step from the weather's direct normal (DNI) and diffuse horizontal (DHI) irradiance
  (a port of Radiance gendaymtx), in sim.skyDensity's patches (145 by default), seen along patch directions
  (sim.patchSamples smooth that).
- Sun (physical mode): one exact direction per step, the NOAA position with refraction: sharp shadows, no penumbra.
- Weather (weather.source): 'station' = the EPW file of the chosen station, applied at the same solar time at the site:
  that station's climate (site_info gives its distance); 'pvgis' = the PVGIS typical year at the site, from satellite
  irradiance (SARAH3 in Europe, Africa and most of Asia; NSRDB in North and Central America) or elsewhere ERA5
  reanalysis: derived, not measured at a station; 'upload' = an EPW file; 'clear-sky' = the Ineichen-Perez clear sky
  (pvlib formulation) from weather.turbidity (Linke, default 3) and weather.altitude: cloudless, an upper bound
  typically 20-50 % above a typical year, for relative comparisons (which facade, which overhang), not absolute
  yields. Missing EPW values count as 0.

### Accuracy

- Without reflections the results are deterministic; their errors are discretisation (sky patches, the time step, one
  sensor per element), not noise.
- With reflections, Monte Carlo noise falls as 1 / sqrt(sim.bounceSamples). At the default 1024 per element: annual
  facade values about 0.5 % (median) and 2.3 % (95th percentile); a single instant 2.3 % and 14 %. Use 4096-16384 for
  instants and for small differences between options. The sampling is deterministic: a re-run repeats the numbers, so
  noise shows only against a run with more samples.
- The core is validated against Ladybug Tools, Radiance and pvlib.

## 6. Not computed

No setting gives these; never present an approximation as one of them:

- Daylight factor and vertical sky component (VSC), which use the CIE standard overcast sky, and the sky factor of
  rights-to-light calculations (a uniform sky): the app has only Perez skies from weather data and the clear sky.
- Metrics that count hours above thresholds per point: daylight autonomy (DA, cDA), spatial daylight autonomy (sDA),
  useful daylight illuminance (UDI), annual sunlight exposure (ASE). A run returns one sum or mean per element for its
  period, no hourly values; a profile needs one run per instant.
- EN 17037 daylight provision (illuminance targets reached for half of the daylight hours over a share of the
  reference plane), its view out and its protection from glare.
- Glare (DGP, DGI, UGR), luminance images, views.
- PV electrical yield; solar heat gains through glazing (they need the g-value); temperatures or overheating.
- BRE annual probable sunlight hours (APSH): they weight the hours by the chance of sunshine, while the app's sun hours
  ignore clouds.

## 7. Checks you can derive

Each is an approximation: say so, and what it leaves out.

### EN 17037 exposure to sunlight

- The standard: a space should receive at least 1.5 h of direct sunlight (minimum level; medium 3 h, high 4 h) on a
  selected date between 1 February and 21 March with cloudless conditions (BR 209 suggests 21 March). It is counted
  at a reference point on the inside face of the window aperture, at the centre of the opening width, at least 1.2 m
  above the floor and 0.3 m above the sill (whichever is higher). Sun below a minimum solar altitude, and on
  1 February beyond a maximum solar azimuth, does not count: the standard tabulates both per location (Annex D,
  Tables D.1 and D.2). Sunlight through several windows of a room adds up only when it comes at different times.
  BR 209 (2022) adds: reveals, balconies and overhangs above the window block; frames and bars can be discounted; with
  the surroundings modelled in detail the minimum altitude need not apply.
- Receivers: a small patch modelled at the reference point, facing out through the window (its own prim: results by
  'mesh' or 'parts' gives its value); as a stand-in, the glazing mesh itself (its value varies over the pane: say so).
- Nothing in the opening: with a patch receiver, set the window's glazing and frames to none, so everything else stays
  opaque; with the glazing as stand-in, keep it as receiver (its own sensors see past it) and set only the frames to
  none. If the glazing shares a mesh with the wall, use edit_material preset 'Opening (no glazing)' on its material
  with sim.transmission on; then every other glass passes its tau too and sun through other glazing counts in part:
  say so, or make those materials opaque with edit_material.
- Time: mode 'range', from.date = to.date = the date, from.hour '00:00', to.hour '24:00', step 10; sim.quantities
  including 'sunhours' (in range mode it needs no weather). Read results with column 'sunhours_front' and thresholds
  [1.5, 3, 4]; per window, its value or its min.
- Minimum altitude: the app counts from sunrise and holds none of Annex D's values. Ask the user for the site's, read
  the sun's altitude and azimuth on that date from site_info (hours every 10 min around sunrise and sunset) and narrow
  from.hour / to.hour to the times the sun meets them (right to about one step at each end); else follow BR 209
  (surroundings modelled in detail: no minimum altitude) and say the count starts at sunrise. Never quote a value
  from memory as the standard's.
- Not captured: the reveals when the wall is modelled without thickness; the union of sun times over several windows
  (each window counts alone; a sum can double count); any point that is not an element of a receiver.

### BRE (BR 209, 2022)

- Gardens and open spaces: at least half of a garden or amenity area should receive at least 2 h of sunlight on
  21 March; sunlight at an altitude of 10 degrees or less does not count; grid points 0.3 m apart or less. Each
  dwelling's garden counts on its own (around housing only the main back garden; driveways and car standing are left
  out, and so are small front gardens visible from public footpaths). If an existing space fails this and the area
  receiving 2 h falls below 0.80 times its former value, the loss is noticeable. Trees and shrubs are normally left
  out; dense evergreen belts, and walls or fences over 1.5 m high, are included.
  - In the app: each garden as its own receiver prim, finely meshed (triangles about 0.3 m or smaller); buildings and
    walls as shade; trees to none (a dense evergreen belt as shade). The 21 March range as above, with from.hour /
    to.hour narrowed to the times the sun is above 10 degrees (site_info). results by 'parts' (one path per garden) or
    'mesh', thresholds [2]: a garden meets the guideline when its row's share at or above 2 h is at least 50 %; judge
    every garden's row, never the whole-model row. Existing against proposed: models A (existing) and B (proposed)
    with the same garden receivers; per garden, the ratio of its areas at or above 2 h (share x area) is a derived
    number to compare with 0.80. find_critical with below 2 shows the shaded parts.
- New dwellings: a main window wall faces within 90 degrees of due south, and a habitable room, preferably the main
  living room, receives at least 1.5 h of sunlight on 21 March at the inside centre of its window(s): the EN 17037
  check above on 21 March. Before windows are placed, BR 209 suggests points 1.6 m above the ground or lowest storey
  on each main window wall, at most 5 m apart: a finely meshed facade receiver gives that map.
- Existing buildings are judged by APSH: not computed (section 6).

### Clear-sky instants

- weather.source 'clear-sky' (weather.turbidity, weather.altitude) and time.mode 'instant' (date, hour): the
  irradiance (W/m²) or illuminance (lx) on every surface at that moment under a cloudless sky, e.g. a facade at noon on
  21 June. A clear-sky range over one day gives that cloudless day's radiation sums.

### Occupied-hour means

- time.mode 'range' over the season (from.date, to.date) with the occupied daily hours (from.hour, to.hour, standard
  time), step 60 from whole hours: irradiance and illuminance become means over those hours only (the provenance gives
  the hours evaluated). Still a mean over surfaces and hours: it does not say how many hours reach a target.

### PV potential

- time.mode 'annual' with 'station' or 'pvgis' weather (not 'clear-sky' for absolute values); the candidate roofs and
  facades as receivers. radiation_front is the yearly irradiation in each element's own plane, shading included
  (kWh/m² per year); the total is kWh per year on that area. results by 'facing' or 'parts' separates roof planes and
  facades; P10, P90 and find_critical show the shaded parts. A yield needs the user's module efficiency and performance
  ratio: yield = radiation total x efficiency x performance ratio is a derived estimate; temperature, angle of
  incidence, inverter, cabling and soiling losses are not modelled.

### Shading

- direct shows where and how much sun beam arrives, sunhours how long. Compare both with and without a shading device
  (two models, or a variant via set_geometry) over the period that matters (a summer range for overheating risk, the
  heating season for useful gains): the difference is the beam energy the device removes. Radiation on glazing is
  incident energy, not the solar gain through it.

## 8. Comparing options

- Models A-D share every setting and colour scale; roles and material edits are per model.
- Compare only fresh results; each result's provenance gives its arguments.
- results with models [reference, ...]: the first is the reference, and every value comes with its difference to it
  (in the column's unit; shares in percentage points). A relative change (%) = difference / reference value is derived.
- Like for like: the same receivers in every option (the same prim paths; results by 'parts' with paths present in
  each model). Whole-model means over different receiver sets compare different things. Totals grow with area: compare
  means and shares for how well the surfaces do, totals for how much in all; results gives each area.
- Size of a difference: without reflections it is real for the models as built, but means little below the mesh and
  sky resolution; with reflections, one within the noise (section 5) is no finding: raise sim.bounceSamples, run again.
- Show options side by side: screenshot with models [...] and one view (only for models sharing units and origin) or
  frame (set viz.min and viz.max for a readable legend); charts draw every model with a result.

## 9. Critical conditions

- Agree the criterion with the user (or take a standard's): set the problem range (update_settings viz with quantity,
  below / above: section 4) or pass below / above to find_critical.
- find_critical groups the problem elements by receiver mesh and the side they face (N, E, S, W; up and down within 45
  degrees of vertical), largest problem area first. Groups under 0.5 % of the problem area are left out; one group can
  join separate pieces of one mesh (a large box).
- Quote area and share, not only the worst value: the worst element of a large triangle is one sensor.
- Show: screenshot with the group's view and near (near cuts away what stands in front, often the cause: say it is cut
  away, and add a wider shot that shows it), or set_camera with the view to show the user in the app.
- set_display highlight fades everything outside a band; screenshot sunPath draws the sun path of the time setting
  (the simulation's sun positions).
- Explain the cause with evidence: site_info sun altitude and azimuth at the period's times, direct against diffuse,
  the obstructing prim (model_tree). Test it: open the same file as another model, set the suspected obstruction to
  none there, run, compare.

## 10. Writing rules (chat and reports)

- Latin script only, as the report fonts cover: accented letters are fine (é, ü, ł; place names as site_info gives
  them); symbols only the degree sign, ², ×, ·, ±, dashes and the minus sign. No comparison, arrow or check-mark
  symbols, no Greek letters or sum signs: write >=, <=, ->, "at least", "about", "tau" or "transmittance", "rho" or
  "reflectance".
- A unit with every number: kWh/m², kWh, W/m², lx, h, m², %; differences of shares in percentage points.
- Numbers as the tools give them (3 significant digits, whole numbers from 1000; shares in whole percent, one decimal
  under 10 %); never more digits.
- Say once what the quantity measures and its main assumption (e.g. sun hours: cloudless, geometric).
- Keep results, interpretation and recommendation apart, and state the limits that matter for the question.
- Reports: read guide 'report' first.
