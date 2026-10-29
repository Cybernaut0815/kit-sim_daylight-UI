# Reports: how they work here and how to write them

A report is a PDF in the kit-ui kit-report format (A4, light paper, page numbers): one design option, or 2 to 4
options compared. You write its spec (save_report); the app draws everything else from its own results when it
generates the PDF (generate_report). Read guide 'daylight' first: its writing rules (section 10) hold here too.

## 1. How it works

- save_report stores a ReportSpec in the app (on the server, in the cache folder; one folder per id). The same id
  replaces the report. It checks the spec and names each problem by its path (blocks[3].caption: empty).
- generate_report draws the PDF from the current results: the stat row, the tables, the charts and the view images are
  computed by the app at generation, from the same numbers results gives, so they always match the results. Only the
  summary, the text blocks, the captions, the stat labels and the notes are yours: every number in them is your copy
  of tool output.
- The app writes the rest itself: the title block and status line, Inputs (site, coordinates, time zone, north,
  weather, period, quantities, mode, surfaces, sensors, each model's file, variant choices and roles), Method and
  assumptions (per result column, sky, surfaces, statistics, problem range, the cutaway of each view) and the Appendix
  (Table A1. Provenance: job ids, times, run arguments, weather reference, versions). Do not repeat them.
- save_report also stores each report model's run: its file (and the paths open_model opened it from), the variant
  choices made in the app, its receivers and shades, and the run's settings; and the problem range of each quantity
  the report shows (its shares and range colours depend on it). generate_report refuses when a model or a range no
  longer matches and says what to restore: open_model (another file or none in the slot), set_geometry (other variant
  choices), set_roles (other roles), the settings it names (another date, step, weather ...) and run, run (no result,
  a stale one), update_settings viz (another problem range), or wait (a run on its way). After a run with other
  settings or a new range, check that your text still holds, then save the report again: that stores them.
- The user edits the report in the app: report charts with the settings button of the Results panel's
  "Report: TITLE" group, report cameras in the Views menu (Report: TITLE, Update), and generates again from the Reports
  menu. Each edit saves the report with a new `updated`. So call get_report before you change a report, edit what it
  returns, and pass its `updated` to save_report; a refusal that says "changed in the app since" means: get_report
  again, merge your change into it, save again. Reset on a report chart in the app goes back to the chart as your last
  save_report stored it.
- Order: app_state -> run until every report model is fresh -> results, find_critical, screenshot (the numbers and the
  views) -> save_report -> generate_report (answers 'generating' after 40 s: call it again, and that call answers the
  same generation's PDF or error) -> read the PDF back page by page if you can, else ask the user to -> fix and save
  again. delete_report removes a report and its PDF (not while its PDF is being generated).
- generate_report answers the PDF's path, a link to it, its pages, bytes and fonts; `fallback` lists fonts that are
  not kit-ui's and should be empty. A refusal "the PDF is open in another program" means the user has it open.

## 2. Writing rules

- Every number comes from tool output (results, find_critical, run, site_info), rounded as given, with its unit: h,
  kWh/m², kWh, W/m², lx, m², %; differences of shares in percentage points. A number you derive (a ratio, a change in
  %) says so and from what.
- Say for each number: the model (letter and name), the quantity and side, the period, the statistic
  (area-weighted mean, median, P10, P90, share of the receiver area) and what it covers (the whole model, a part, a
  side).
- Captions in plain words: what (quantity, statistic), where (model, part, side), when (date, hours, period) and the
  unit. "Figure 2. Mean sun hours per facade on 21 March, 08:00 to 18:00, models A (base) and B (overhang), in h."
- A comparison names its reference (the first model) and states each difference with its sign and unit: "B's south
  facade gets 0.306 h less than A's (0.754 h)". Stats and tables read model by model.
- Status in words, never by colour alone: "below the 2 h criterion", not "red".
- Say what the app does not compute where it matters (guide 'daylight' section 6): no daylight factor, VSC, DA, sDA,
  UDI, ASE, glare or PV yield; sun hours ignore clouds; an approximation of a standard is called one.
- Keep results, interpretation and recommendation apart; state the limits that matter for the question.
- Summary first: the answer in two to five sentences, then the evidence. Short paragraphs, lists for parallel
  findings, **bold** for the one finding that matters most.
- Glyphs: only what the report fonts draw: Latin-1, most accented letters of Latin Extended-A (and ə, ș, ț), the dashes
  – and —, the quotes ‘ ’ “ ”, … • † ′ ″ ‹ › €, the minus sign. No other dash, hyphen or space character (write - and a
  plain space), no comparison, arrow or check-mark symbols and no Greek letters: write >=, <=, ->, "at least", "tau",
  "rho". save_report names any other character and how to write it.

## 3. ReportSpec

| field | type, limits | what |
| --- | --- | --- |
| id | 1-64 of a-z, 0-9, - | the report's name; the same id replaces it |
| title | text, 1-120 | the heading and the PDF's title |
| models | 1-4 letters | ['A']: a report on A; ['A', 'B', ...]: a comparison, the first the reference. Each open with a fresh result at save. get_report's model objects are taken too (their letters count) |
| stats | up to 4 stats, optional | the stat row under the title |
| summary | text, 1-4000 | the Summary section |
| blocks | 1-40 blocks | the Results section, in order |
| notes | text, up to 4000, optional | added to Method and assumptions |
| created, updated | set by the app | pass `updated` back when you replace a report |

A stat: {label (text, 1-60), metric, column, model (a report model's letter), path? (a prim path with receivers at
or under it; default every receiver)}. Its value is computed at generation and shown with its unit.

Blocks, by `type`:

- text: {title? (1-120), text (1-8000)}. Paragraphs between blank lines; lines starting with '- ' make a list;
  **bold**. A title shows as a sub-heading.
- chart: {chart, caption (1-400)}. `chart` is a ChartSpec as update_settings charts takes it: id (letters, digits, _
  or -; unique in the report, never 'hist' or 'curve'), kind ('histogram', 'curve', 'parts'), column (default the
  one shown at save), models (letters; default the report's models), parts (prim paths; a parts chart draws one row
  per path, at most 24; histogram and curve: the receivers under them), range ('relative' = the shared colour scale,
  'absolute' = the data's, or [min, max]), bins (histogram: 4-100 or 'auto'), markers (mean, median, p10, p90), grid,
  height (100-400), metric (parts: mean, median, p10, p90, min, max, below, within, above), title (bold at the start
  of the caption, and the chart's heading in the app). A field of another kind is refused. A comparison draws a series,
  curve or bar per model in its colour (the reference solid, the others dashed), with a key. Give a parts chart of
  values range 'absolute': its bars then start at 0 (on 'relative' they start where the colour scale does).
- view: {name (1-60), view, near?, column, aspect?, caption}. `view` is a camera {eye, target, fov, projection,
  height} copied from find_critical, set_camera or app_state; `near` (m, more than 0) cuts away what stands closer to
  the camera; `column` is a result column, or null for the models' own colours (no legend); `aspect` is width /
  height, 0.25-4, default 1.6. One image per report model from the same camera: side by side for two, 2 x 2 for three
  or four, each labelled with its letter and name, the colour legend and unit under them, on one colour scale over the
  report's models (Min and Max of the colour scale, where set, hold). The images show the models as the app shows them
  at generation: prims hidden in the app (set_visibility hide or isolate) stay hidden; the selection and a bin
  highlight do not show.
- table: {column, by?, parts?, metrics, caption}. `by`: 'parts' (default: one row per prim path in `parts`, 1-50),
  'mesh' (one row per receiver mesh, the 50 largest by area) or 'facing' (N, E, S, W, up, down; `parts`, when given,
  limits the rows to the receivers under them). A comparison gives each row a line per model. 1-6 metrics, one
  column each with its unit in the header.

Metrics, exactly as results names them: mean, median, p10, p90, min, max (in the column's unit); total (the column's
total unit: kWh, W, lm or h·m²); area (m²); elements (a count); below, within, above (% of the area under, inside or
over the problem range: the quantity needs a problem range, update_settings viz below / above, and it must be the
same at generation as at save).

Columns: one the report models' results have ('sunhours_front', 'radiation_back', ...). Prim paths: those of
model_tree; a path needs a receiver at or under it in a report model.

The whole spec as stored must stay under 1 MB (it lists every receiver and shade of each report model).

## 4. Views of critical areas

- find_critical: each group has `view` and `near` (m). Copy both into a view block: the cutaway clears what stands in
  front of the group (often its cause): say so in the caption or a text block, and add a second view without `near`
  to show it.
- set_camera with frame {paths: [...]} (and direction, elevation, aspect, projection) frames prims for any aspect;
  copy the `view` and `near` it answers, and give the block the same `aspect`.
- app_state gives each model's current camera (`view`): what the user looks at now.
- Every report model is shot with the same camera: compare models that share units and origin (the same file, other
  variants). Check a view with screenshot (the same view, near and aspect) before you save it.

## 5. Examples

A report on model A: the fixture building, 21 March sun hours on a clear day, problem range below 2 h.

```json
{
  "id": "block-sun-21-march",
  "title": "Sun hours on 21 March: Block, option base",
  "models": ["A"],
  "stats": [
    {"label": "South facade", "metric": "mean", "column": "sunhours_front", "model": "A", "path": "/Site/Block/Facade_S"},
    {"label": "West facade", "metric": "mean", "column": "sunhours_front", "model": "A", "path": "/Site/Block/Facade_W"},
    {"label": "Area under 2 h", "metric": "below", "column": "sunhours_front", "model": "A"}
  ],
  "summary": "On 21 March, between 08:00 and 18:00 on a clear day, the south facade of the block gets the least sun: 0.754 h on area-weighted average, against 3.72 h on the west facade and 4.5 h on the roof.\n\nThe neighbouring slab 6 m in front of it keeps the sun off Facade_S for most of the day. Its mean is **under the 2 h criterion** of BR 209 for amenity areas, which the app approximates with geometric sun hours (clouds ignored).",
  "blocks": [
    {"type": "chart", "chart": {"id": "facades", "kind": "parts", "column": "sunhours_front", "range": "absolute", "parts": ["/Site/Block/Facade_N", "/Site/Block/Facade_E", "/Site/Block/Facade_S", "/Site/Block/Facade_W", "/Site/Block/Roof"], "metric": "mean"}, "caption": "Mean sun hours per facade and the roof on 21 March, 08:00 to 18:00, clear sky, in h."},
    {"type": "view", "name": "South facade", "view": {"eye": [17.12, 11.16, 9.65], "target": [8.66, 5, -5], "fov": 45, "projection": "perspective", "height": 7.46}, "near": 15.7, "column": "sunhours_front", "caption": "Sun hours on the south facade on 21 March, 08:00 to 18:00, in h; the neighbouring slab in front of it is cut away."},
    {"type": "table", "column": "sunhours_front", "parts": ["/Site/Block/Facade_N", "/Site/Block/Facade_E", "/Site/Block/Facade_S", "/Site/Block/Facade_W"], "metrics": ["mean", "p10", "p90", "below"], "caption": "Sun hours per facade on 21 March, 08:00 to 18:00: area-weighted mean, P10 and P90 in h, and the share of each facade's area under 2 h."},
    {"type": "text", "title": "Reading the results", "text": "- Sun hours count the time the sun is up, in front of a surface and not blocked: a geometric measure.\n- The criterion of 2 h on 21 March is BR 209's for gardens and amenity areas; on a facade it only flags where sun is scarce."}
  ],
  "notes": "The neighbouring slab is modelled as a plain box from the site survey; trees are left out."
}
```

A comparison of model A (option base, the reference) and model B (option overhang: a 2 m slab over the south
facade):

```json
{
  "id": "block-overhang-compare",
  "title": "Overhang or not: sun hours on 21 March",
  "models": ["A", "B"],
  "stats": [
    {"label": "South facade, A", "metric": "mean", "column": "sunhours_front", "model": "A", "path": "/Site/Block/Facade_S"},
    {"label": "South facade, B", "metric": "mean", "column": "sunhours_front", "model": "B", "path": "/Site/Block/Facade_S"},
    {"label": "Under 2 h, A", "metric": "below", "column": "sunhours_front", "model": "A"},
    {"label": "Under 2 h, B", "metric": "below", "column": "sunhours_front", "model": "B"}
  ],
  "summary": "Option B adds a 2 m overhang along the top of the south facade. On 21 March, 08:00 to 18:00 on a clear day, it takes the south facade's area-weighted mean from 0.754 h (A, the reference) to 0.448 h (B): 0.306 h less. The other facades and the roof keep their values (north 2.25 h, east 1.9 h, west 3.72 h, roof 4.5 h).\n\nSun on the south facade is scarce in both options because of the neighbouring slab: 99 % of its area gets under 2 h in A, 100 % in B.",
  "blocks": [
    {"type": "chart", "chart": {"id": "facades-ab", "kind": "parts", "column": "sunhours_front", "range": "absolute", "parts": ["/Site/Block/Facade_N", "/Site/Block/Facade_E", "/Site/Block/Facade_S", "/Site/Block/Facade_W", "/Site/Block/Roof"], "metric": "mean"}, "caption": "Mean sun hours per facade and the roof on 21 March, 08:00 to 18:00, clear sky, models A (base) and B (overhang), in h."},
    {"type": "chart", "chart": {"id": "spread-ab", "kind": "curve", "column": "sunhours_front"}, "caption": "Share of the receiver area at or below each number of sun hours on 21 March, models A and B."},
    {"type": "view", "name": "South facade", "view": {"eye": [17.12, 11.16, 9.65], "target": [8.66, 5, -5], "fov": 45, "projection": "perspective", "height": 7.46}, "near": 15.7, "column": "sunhours_front", "aspect": 1.6, "caption": "Sun hours on the south facade on 21 March, 08:00 to 18:00, in h, models A (base) and B (overhang) from the same camera; the neighbouring slab is cut away."},
    {"type": "table", "column": "sunhours_front", "by": "facing", "metrics": ["mean", "p10", "below"], "caption": "Sun hours by the side the receivers face on 21 March, 08:00 to 18:00, per model: mean and P10 in h, share under 2 h."}
  ]
}
```
