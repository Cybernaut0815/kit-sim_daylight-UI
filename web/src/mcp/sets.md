# Analysis sets and combined views

How to keep several setups of the same models side by side, run them without changing what the user sees, read their
results and weigh them into one value per element. Sets and combined views are stored on the server: every client of
the app shares them. Their results stay in this browser session.

## 1. Sets

- A set is one analysis' whole setup under a name: per open model an entry linked to it (its letter and file) with its
  roles (receivers and shades by prim path, a receiver's casts-shade flag, a View analysis target's group) and its
  Materials edits; the analysis' run settings (Daylight: sim and time; View analysis: view), north, the site and
  weather (Daylight; an uploaded EPW by its file name: opened elsewhere, weather asks for that file again), the column
  it shows, the colours of every quantity, the charts and the subdivision level. Not in it: display switches,
  per-mesh refinements and the geometry. A set saved before these were kept leaves them as the app has them (app_state
  summary says "not kept").
- save_set saves the app's setup now; its roles and settings change the set only, so several setups (a facade's
  receivers in summer and in winter, a daylight and a view analysis of the same facade) are kept without changing what
  the user sees. save_set with a set's id replaces it with the app's setup now. open_set applies one to the app and
  shows its tab; app_state's summary says what each keeps.
- Each entry applies to its own model only: the one with its letter and file, else (its letter shows another file now)
  its file reopened in another slot. An entry never goes to another model, not even of the same file: a model without
  one keeps its roles and edits, and is not run (status 'no entry'). open_set says which entry each model took
  (notOpen: entries whose file is not open).
- copy_set makes a set for another model (another design option, the same file in another slot): a new set of one entry
  for that model, with the roles of the prim paths it has (every other mesh none), the Materials edits of the material
  paths it has and the default and glass rows, and the rest of the set as it is; it is saved and opened, so change it
  and save_set it with its id. It says how many roles and edits matched: few matched means another model's paths, so
  assign roles with set_roles.

## 2. Running sets and their kept results

- run_set runs a set in the background: the app keeps showing what it shows, and one job runs at a time, only while
  neither tab runs. wait is in seconds (0: answer at once); 'running' means call run_set again (it runs nothing twice)
  or watch app_state.
- Results are kept this session by their exact inputs (gone on reload, or when a model is opened, re-read or removed):
  run_set, open_set, results and the Combined tab find them without running again. app_state sets gives the status per
  model (done with its run time in seconds, not run, queued, running, failed, no entry, no receiver, another
  subdivision: a set of another level runs only once opened, open_set it).
- results with set quotes a set's kept results without opening it, as it quotes an analysis' last runs: per model the
  whole and its rows (by mesh, parts or facing), thresholds, the first model the reference. The column and problem
  range are the set's own unless column is given. Compare two setups of the same model this way: results with set for
  each, or open_set one and results the other.

## 3. Combined views

- A combined view takes up to 8 inputs, each a set's column, and per element transforms each (fn: raw; normalise and
  invert to 0 to 1 over lo to hi, by default the range over every model; log10; threshold: 1 at or above lo, else 0;
  band: 1 within lo to hi, else 0), weights it and joins them (op: weighted mean or sum, min, max, or the product with
  the weights as powers). meshes limits an input to prims; an element takes the inputs that cover it.
- Inputs combine element by element: each must have run on the same elements (the same receiver meshes, faces or
  vertices, subdivision). For a mesh where an input ran on other elements, that input is skipped (results mismatches;
  the Results panel's "Skipped"): give every set the same receivers.
- Units: raw inputs keep theirs, and mean or sum only join like with like (radiation in kWh/m² with radiation). Mixing
  quantities takes normalise, invert, threshold or band and gives a score (unit ''), whose total is the score × area in
  m². Say how a score is built (results and app_state give it in words as meaning) whenever you quote one.
- save_combined with preview shows a draft on the Combined tab without storing it (as the editor shows its draft):
  check it with a screenshot, adjust, then save_combined without preview (with the view's id to replace it). An edit in
  the app or leaving the Combined tab drops the preview; app_state combined lists it with preview true.
- results with analysis 'combined' and id quotes a view per model: first the input sets missing a result run (wait
  seconds; 0 quotes what there is), then each model's whole and rows, inputs used of all, and missing or mismatched
  inputs. With several models each combines its own input results; normalise and invert bounds span every model, so
  the scores compare, and the differences are to the first model with a result.
- Typical: a daylight set and a View analysis set on the same receivers; a score as the mean of normalised sunhours and
  inverted obstruction; or two criteria as threshold inputs with op min (1 where both hold): results with thresholds
  [0.5] gives the share of the area at or above 0.5, where both hold.
- Show one: set_display or screenshot with analysis 'combined' and id; labels writes the values on the surfaces,
  highlight fades everything outside value ranges.

## 4. Names and deleting

- rename_set renames a set or a combined view: its id and contents stay, so combined views that take a set keep it.
- delete_set deletes either kind for every client; it cannot be undone. A deleted set's kept results stay this session,
  and combined views that took it as an input then miss it (the reply names them). Deleting a combined view leaves its
  input sets.
