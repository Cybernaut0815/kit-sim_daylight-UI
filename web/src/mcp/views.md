# View analysis results: what they mean and how to talk about them

The app's View analysis tab runs the core's `views` tool on the same models: from every element (face or vertex) of
its receiver meshes it casts one ray per cell of a field of view, about the element's normal (a view out of a window)
or all around (an eye turning on the spot), and reports which share of the field ends on the sky, the ground, an
obstruction or each target group (a park, water, ...), and how far the element sees. No sun, sky model, weather or
period: the geometry, the roles and the field decide. Guide 'daylight' section 1 (how to answer) holds here too:
quote numbers only from tool output, name the model, the column in words, the statistic and what it covers.

## 1. Driving it

- The View analysis has its own roles, settings, runs and results beside Daylight's; the models, the materials, the
  site's north and the colour scales by quantity name are shared. Every tool acts on Daylight unless told otherwise.
- app_state viewAnalysis: its settings, its shown column and colouring, per model its meshes by role, run status and
  freshness, and the problems that would stop its run.
- set_roles analysis 'views': receiver (gets results; blocks rays unless shade false or view.selfOcclude off),
  obstruction (only blocks), target with a group (blocks, and its share of the field becomes the column
  `<group>_front`) or none (ignored: rays pass through it). Several meshes may share a group; at most 16 groups.
- update_settings view: the fields below (reset ['view-field'] and the like put a section back; the reply gives the
  field in numbers: grid, rays per eye, azimuth and elevation). run with analysis 'views' runs it (one job per model);
  results, find_critical, download_result with analysis 'views' read it; set_display and screenshot show it with
  analysis 'views'. fieldPreview {show, scale, density, around} draws the field each eye traces on the receivers, as
  the View settings panel's preview: check fov, cell and gaze with a screenshot before a long run.
- Problem ranges and colour scales are per quantity name (update_settings viz quantity 'sky', 'distance_min', a
  group's name, ...); find_critical and the results shares use them as for Daylight.

## 2. Columns

Columns are `<quantity>_<side>` (view.sides 'both' adds the `_back` columns: the reversed normal's field). Which come
depends on the field:

| column | per element | unit | when |
| --- | --- | --- | --- |
| sky | share of the field that is open sky | 0 to 1 | always |
| ground | share ending on the virtual ground below (the street seen from a facade when no terrain is modelled) | 0 to 1 | always |
| obstruction | share ending on a mesh that is no target: buildings, the receivers themselves, a modelled terrain | 0 to 1 | always |
| `<group>` | share ending on that target group | 0 to 1 | per group |
| obstruction_total | everything that is not sky (ground, obstructions and targets): 1 minus sky | 0 to 1 | always |
| glazing | share seen through glass | 0 to 1 | view.transmission on |
| volume | the 3D isovist: the volume in view within the field, every ray capped at far | m³ | fov 360 |
| area | the 2D isovist: the area in view around the eye in the horizontal plane, capped at far | m² | fov [360, 0, 0] |
| distance | log (geometric) mean distance over the field, an open ray counting as far | m | field about the normal |
| distance_min | the nearest thing in view (far when the whole field is open) | m | field about the normal |
| reach_D | share of the field whose ray travels at least D m before it meets anything | 0 to 1 | per view.reach distance |

- sky, ground, obstruction and the groups sum to 1. obstruction_total repeats them (1 - sky) and glazing counts beside
  the class behind the pane: neither is another part of that sum.
- Shares are by solid angle: a cell near the zenith or the nadir counts less than one at the horizon. In a flat field
  ([H, 0, 0]) every ray weighs the same. The sky share is not a vertical sky component (VSC, an overcast-sky
  illuminance ratio) nor a cosine-weighted sky view factor.
- `distance` is exp(mean of ln d): near walls weigh strongly and open rays count as good but bounded. Half sky and half
  a wall at 5 m gives sqrt(1000 x 5) = 70.7 m (far 1000), not the arithmetic 502.5 m; a wall at 20 m everywhere 20 m.
  Distances are clamped to 0.1 m to far. Long is an open view, short a wall in front.
- NaN (no value) where no ray of the field is traced: all of it own surface (fov 360, offset 0, the whole field behind
  the element) or a face without area.
- results totals are value x area: for shares that is m² of share, rarely meaningful; quote the area-weighted mean,
  median, P10, P90 and the area shares of a problem range or thresholds instead.

## 3. Settings (update_settings view)

| field | default | meaning |
| --- | --- | --- |
| fov | [120, -70, 50] | [H, LO, HI] degrees: H wide about the normal (0 < H <= 180), or 360 all around; elevation LO to HI (-90 to 90), or 0 to 0 for one row of horizontal rays (the 2D isovist) |
| gaze | level | H <= 180 only: level centres the field on the normal turned level (elevation about the horizon, as a person looks); normal centres it on the normal itself |
| cell | 2 | degrees per ray; at most 2^20 (1,048,576) rays per element; 1 degree is 4x the rays |
| sides | front | front, back or both viewing sides |
| on | faces | faces (eye at the centroid) or vertices (area-weighted vertex normal) |
| offset | 0 | the eye moved along the normal, m (e.g. 1.6 above a floor grid: a standing eye) |
| far | 1000 | what open counts as, m, and the cap of every distance and of the isovist |
| reach | '' | 'en17037' (6, 20, 50 m) or up to 8 distances, comma separated: the reach_D columns |
| virtualGround | true | a horizontal plane ends downward rays (ground at its distance); off: they stay open (far) |
| groundZ | null | the plane's height, m; null = the lowest point of every mesh given |
| transmission | false | rays pass glass (materials of kind glass with a transmittance above 0) and the glazing column is added |
| cullBackfaces | false | meshes block only from their front side |
| selfOcclude | true | receivers block rays; off: only obstructions and targets do |

- About the normal (H <= 180) the field is centred on the element's normal turned level (gaze level, the default):
  by default 60 degrees to either side, 50 up and 70 down from the horizon, on a vertical face and a tilted one alike;
  at offset 0 a tilted face whose mesh blocks rays sees its own surface behind its plane (obstruction). With gaze
  normal it is centred on the normal itself, so on a tilted face it tilts with it. A face looking straight up or down
  keeps its normal either way and takes the model's east as its right. Two nearly horizontal faces sloping different
  ways see differently turned fields: fov 360 (one world frame, e.g. [360, 0, 90] for the hemisphere an upward face
  sees) avoids that.
- All around (H = 360) the azimuth runs clockwise from the site's north; at offset 0 the directions behind the
  element's own plane are not traced and count as obstruction (own surface). A non-zero offset, or a receiver that
  blocks no rays, traces them.
- The default distance columns follow the mode: distance and distance_min about the normal, the isovist (volume, or
  area in a flat field) all around.

## 4. Reading the numbers

- Noise: every ray goes through a random point of its cell, the same for every run of the same model (a result
  repeats bit for bit). Per element that is about 1e-3 on a share and 0.3 % on distance at 2 degree cells, 2 to 3x
  less per halving of cell. Use 1 degree for thin or far targets (a lake 200 to 500 m away seen from 10 m up is a
  1.7 degree strip) or element-by-element comparisons; means over many elements average it out.
- Virtual ground: at the lowest point of what the run is given, so a partial model (upper floors without the ground
  and context) puts the plane at its own foot: set groundZ. Geometry below a raised groundZ is hidden. With
  virtualGround off downward misses are still ground but count as open, so a lawn or water below ranks worse than open
  ground: keep the plane on to rank views.
- reach_D is a share of the whole field, the street below a window included at its plane distance: an open view stays
  well under 1 (about 0.47 at 50 m from a ground-floor window with the default field). For EN 17037's horizontal
  outside distance take the field above the horizon (fov [H, 0, HI]) or virtualGround off, or pick a share threshold.
  No EN 17037 level is assigned.
- The isovist is the polygon or mesh through the rays' end points: it cuts corners and bridges depth jumps, a little
  under the true area or volume (0.5 % in a 93 m³ test room at 2 degrees), less at a finer cell. fov 360 leaves out
  what lies above 50 and below -70 degrees: the whole 3D isovist is fov [360, -90, 90]. In the open it grows with far.
- Interiors: the room's meshes as obstructions, its windows as glass materials with transmission on, a grid of
  measuring points as receiver with shade false (it must not block), fov 360 from eye height (offset above the grid),
  a far such as 50 m when looking out. Without transmission the room is closed: obstruction 1.
- A target lying exactly on a terrain mesh flickers between the two (coplanar faces): lift it 1 cm or cut it out.

## 5. Limits and what it does not compute

- Glass is passed or not: no refraction or reflection in it, at most 16 panes per ray; screens and trees (porous)
  block like opaque surfaces.
- Targets are whole meshes (no material slots); at most 16 groups and 8 reach distances.
- Only the isovist's area and volume: no perimeter, compactness or other space-syntax measures, no isovist per group.
- EN 17037 view: only the shares at its distance levels; no level, and not its horizontal sight angle or the layers
  seen (sky, landscape, ground).
- No daylight, sunlight or glare: the Daylight tab computes light (guide 'daylight').

## 6. Typical uses

- View out of windows: the facade or window faces as receivers, neighbours as obstructions, a park or water as target
  groups, view.reach 'en17037'; compare sky, the group shares, distance and reach_D per facade (results by 'facing')
  and between options (results models, with differences to the first).
- A standing eye on a plaza: the plaza grid as receiver with shade false, fov 360, offset 1.6 (a flat grid at the
  model's lowest point: the virtual ground takes its place below the eye); all around its distance measure is the
  volume in view, not distance and distance_min.
- Interior openness: the room grid as above with fov [360, -90, 90] (volume) or [360, 0, 0] (area).
- Combined with Daylight per element (e.g. sky share and sun hours in one score): analysis sets and combined views,
  guide 'daylight' section 11.
