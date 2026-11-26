// Info: how to use the app, in the app bar where the design-system switch was. A native modal <dialog> (kit-ui
// .dialog): Esc closes it, so does a click on the backdrop (the dialog has no padding: a click on it is one outside its
// content), and the focus returns to the button. It lives in <body>: inside the bar it would take the bar's dark tokens
// (kit-ui's bar is black in every theme).
import { useRef } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../ui';

export function InfoButton() {
  const dlg = useRef<HTMLDialogElement>(null);
  return (
    <>
      <button className="btn btn--ghost" type="button" aria-haspopup="dialog" title="How to use the app: a quick start, reading the results, comparing models, glass and reflective materials, sets and combined views" onClick={() => dlg.current?.showModal()}>Info</button>
      {createPortal(<dialog ref={dlg} className="dialog dialog--md" aria-labelledby="info-title" onClick={(e) => { if (e.target === e.currentTarget) dlg.current?.close(); }}>
        <div className="dialog__header">
          <h2 className="dialog__title" id="info-title">Using Daylight</h2>
          <button className="icon-btn icon-btn--ghost dialog__close" type="button" aria-label="Close" onClick={() => dlg.current?.close()}><Icon name="close" /></button>
        </div>
        <div className="dialog__body prose">
          <p>
            Daylight simulates the sun and the sky on your model on a GPU server: radiation, direct and diffuse, irradiance,
            illuminance and sun hours, painted on the meshes and charted on the right. Every control explains itself in its tooltip.
          </p>

          <h3>Quick start</h3>
          <ol>
            <li><em>Model</em>: open the model files (USD, USDZ, glTF, GLB, or OBJ with its MTL and textures), or a folder holding a USD scene and its assets. In the prim tree select meshes or whole groups and give them a role: <em>Receiver</em> (measured and painted with the result), <em>Shade</em> (casts shadows) or <em>Ignore</em> (left out of the run). A receiver casts shadows too; untick <em>Casts shade</em> for one that should only measure, such as a grid of points inside a room (with <em>Receivers block rays too</em> off, under Simulation, Advanced, no receiver casts any).</li>
            <li><em>Location</em>: search a place, click the map, drag the marker or type coordinates.</li>
            <li><em>Time</em>: <em>Annual</em>, a <em>Single date</em> or a <em>Date range</em>; or drag the sun path drawn around the model. <em>Around selection</em> draws it around the selected meshes instead.</li>
            <li><em>Simulation</em>: the quantities, the receiving side, sensors on faces or vertices. The faces and points are the file's own: a quad is one face, and two parts that only meet at a position keep their own points, although the view draws triangles and joins such points.</li>
            <li><em>Weather</em>: the nearest station, PVGIS, an uploaded EPW file or a clear sky.</li>
            <li><em>Run simulation</em> in the bar under the 3D view, or tick <em>Run on every change</em>.</li>
          </ol>

          <h3>Reading the results</h3>
          <ul>
            <li><em>Result</em> picks the quantity shown; the meshes take its colours (<em>Values</em>) or stay <em>Plain</em>.</li>
            <li><em>Gradient</em>, <em>Min</em> and <em>Max</em> set the colour scale. A <em>Problem range</em> (<em>Below</em>, <em>Above</em>) paints the values outside it in its own colours.</li>
            <li><em>Scaling</em> spreads the values along the gradient: <em>Logarithmic</em> or <em>Square root</em> show differences among low values, <em>Square</em> among high ones, <em>Equalised</em> gives every colour the same number of elements. The legend's ticks show where the values sit; the numbers do not change.</li>
            <li><em>Edit</em> opens the gradient as a bar with a handle per stop: drag a handle to move its stop, click the bar for a new one, drag a handle down (or press Delete) to remove it; the selected stop's colour and location are below. <em>Flip</em> turns it round, <em>Save as new</em> keeps a gradient of your own, <em>Reset</em> restores a built-in one. Every result that uses the gradient takes the change.</li>
            <li><em>Distribution</em> and <em>Cumulative area</em> are weighted by area, <em>Problem range split</em> gives the share of the area below, within and above the range, and the table lists every receiver mesh (a click selects it).</li>
            <li>Hover a mesh to read its value; hover a bar of the <em>Distribution</em> to see where those values lie on the model. Click a bar to keep it: Shift+click takes the range from the bar clicked before, Ctrl+click adds or removes a bar, a drag takes the bars it crosses; a click on the empty plot lets go.</li>
            <li>The result shown stays the one you picked when you change roles or settings and run again.</li>
            <li><em>Display</em>, <em>Values on the surfaces</em> (off by default) writes the values on the painted surfaces where nothing covers them, one per face or point, at most 150 a view, once the camera rests. Under it, <em>Size</em> (50 to 200 %) and <em>Spacing</em> (100 to 400 %) set their size and the room each takes, <em>Layout</em> where they stand (a grid, staggered rows, scattered, or on their own face or point), <em>Show</em> which values (all, the 10 highest and 10 lowest in view, or those outside the problem range), and <em>Box</em> off writes the text alone, in a colour of its own.</li>
            <li>Values from a million on show in exponent form with three digits (1.23e6), in the panels, the legend and the charts.</li>
          </ul>

          <h3>Comparing models</h3>
          <ul>
            <li><em>+</em> in the Model panel adds a model, up to four (tabs A to D), each in its own 3D view; × removes one. The others keep their letters and colours.</li>
            <li>The active model (its tab, or a click in its view) is the one the Model and Materials panels, <em>Views</em> and <em>Download</em> act on.</li>
            <li>In the bar under the views: <em>Side by side</em> or <em>Stacked</em> (four always show 2 × 2), and <em>Linked cameras</em> (one camera in world coordinates for every view: the models should share units and origin) or <em>Independent</em>.</li>
            <li><em>Run simulation</em> runs every model with a receiver, one after another. Location, time, weather and settings are shared; Materials edits are per model.</li>
            <li>The Results show every model on one colour scale: a column, outline or curve per model, each value with its difference to the first model.</li>
          </ul>

          <h3>Glass and reflective materials</h3>
          <p>
            By default every surface is opaque and black, and only the virtual ground reflects (<em>Ground reflectance</em>).
            Two switches under Simulation add what the materials do, for every model; each makes a run slower:
          </p>
          <ul>
            <li><em>Transmission</em>: glass, screens and cut-out trees let light through by their transmittance τ. With <em>Angle-dependent glass</em> (on by default) glass passes less and mirrors more at grazing angles, as real panes do.</li>
            <li><em>Reflections</em>: the light the model's own surfaces reflect by their reflectance ρ; 1 for outdoor studies, 5 to 8 for interiors. <em>Reflection samples</em> (under Advanced) lower the noise.</li>
          </ul>
          <p>Nothing extra goes into the model: each material's kind, ρ and τ are read from its own UsdPreviewSurface settings, never its name.</p>
          <ul>
            <li><em>Glass</em>: an opacity below 0.98, unless metallic. It gets the default glass's τ (double low-e, 0.64): exporters set the opacity for the display (SketchUp 0.75, Revit 0.25), so it tells the kind, never how much passes.</li>
            <li><em>Porous</em>: a cut-out (an opacity threshold), the presence mode, or an opacity texture that varies (leaves, perforated sheets); τ is its open share.</li>
            <li><em>Opaque</em>: anything else.</li>
            <li>ρ is the luminance of the diffuse colour or the mean of its texture, 0.02 to 0.9. A surface without a material, or with MaterialX or OpenPBR, takes the default: opaque, ρ 0.20.</li>
            <li>OBJ: the MTL's <code>Kd</code> gives the colour, <code>d</code> and <code>map_d</code> the opacity.</li>
          </ul>
          <p>
            The Materials panel lists the default material, the default glass and every material on a receiver or a shade, with
            its kind, ρ, τ and where they come from (<em>Derived</em>, <em>Default</em>, <em>Edited</em>, <em>Not read</em> while a
            texture waits). Type a value or pick a preset from the Kind list (clear, double, low-e and solar control glass,
            trees, perforated metal, fabric, an opening, ground and facade finishes). Edits stay while the model is open,
            are cleared when another file is opened in its tab, and never go into a download.
          </p>
          <p>
            Limits: reflection is diffuse only (a metal or polished facade reflects as a matt one of its ρ; only glass mirrors,
            by angle); ρ and τ cannot be set in the file, and glass always takes the default or your edit. <em>Ladybug</em>{' '}
            mode keeps every surface opaque and black. More precise: Transmission on, 2 reflections, 4096 samples.
          </p>

          <h3>View analysis</h3>
          <p>
            The <em>View analysis</em> tab in the bar at the top asks what each receiver sees: from every face (or vertex) it
            casts rays over a field of view and reports which share ends on the sky, the ground, an obstruction or a target,
            and how far it sees. It uses the same models and materials as Daylight; its roles, settings and results are its own.
          </p>
          <ul>
            <li><em>Model</em>: <em>Receiver</em> (analysed and painted), <em>Obstruction</em> (blocks the view), <em>Ignore</em>, and <em>Targets</em>: obstructions whose rays count for a named group (water, park, a tower). Select meshes, name a group and press <em>Add target</em>; <em>Assign</em> puts the selection into a group of the list, × removes a group. Every group is measured in the same run, each as a result of its own. Untick <em>Blocks rays</em> for a grid of eye points.</li>
            <li><em>Field of view</em>: <em>Window</em> (about each face's normal, 120° wide by default), <em>All around</em> (360°, an eye turning on the spot: lift it with the <em>Eye offset</em>; at offset 0 a receiver that blocks rays sees its own surface behind it, untick <em>Blocks rays</em> to see the ground through it), or <em>Horizontal</em> (the 2D isovist, the area in view).</li>
            <li><em>Distances</em>: <em>Far</em> is what an open ray counts as; <em>Reach</em> adds the share that sees at least 6, 20 and 50 m (EN 17037) or your distances.</li>
            <li><em>See through glass</em>: rays pass the glass of the Materials table and count what lies behind; off, windows block.</li>
            <li><em>Total obstruction</em> is everything that is not open sky: the ground, the obstructions and the targets together (1 minus the sky share).</li>
            <li>Results: the shares (0 to 1 of the field), the distances (m) and the isovist (m³ or m²) per element, the <em>View composition</em> of the field and the <em>Reach</em>, beside the same distribution charts as Daylight.</li>
          </ul>

          <h3>Sets and the Combined tab</h3>
          <ul>
            <li><em>Sets</em> in the bar under the 3D view saves the tab's whole setup under a name: per open model its roles and Materials edits, linked to that model (its letter and file); the Daylight or View analysis settings, north, the location and weather (Daylight; an uploaded EPW by its name), the result shown, the colours, the charts and the subdivision level, with whether it overrides each mesh's own. Display switches and per-mesh refinements are not part of one. Sets are kept on the server, for every browser and the agent.</li>
            <li>A click on a set opens it: each model takes its own entry only, the one of its letter and file (or its file reopened in another tab). A model without one keeps its roles and edits. The note under the list says what each model took. <em>Update</em> saves the open set again with the current setup.</li>
            <li>A set's fold-out lists what it keeps. <em>Copy to model</em> makes a new set of one entry for another open model: the roles and Materials edits whose USD paths that model has, every other mesh without a role. It opens at once, to change and update.</li>
            <li>Resets: the Model panel's puts the roles back to how the file opened (on the tab shown), the Materials panel's undoes every edit of the model, and the Location panel's moves the site to your own position when the browser shares it (it asks first; refused, nothing changes and a warning says why).</li>
            <li>Results stay at hand while the page is open (up to 512 MB): a set opened again shows its result without a run. Opening another file in a model's tab forgets that model's results.</li>
            <li>The <em>Combined</em> tab, always the last, saves the Daylight or View analysis setup as it is now as a new set, and lists the sets of each tab, each folded to its name and its state per model. Unfolded: <em>Open</em>, <em>Run</em> (in the background for the models without a result, one run at a time), <em>Update from the current setup</em> (after asking), <em>Rename</em> (its id stays, so combined views keep it), <em>Delete</em>, what it keeps and Copy to model.</li>
            <li>A <em>Combined view</em> weighs up to 8 inputs into one value per element: each a set's result through a function (as it is, normalised 0 to 1, inverted, log10, a threshold or a band), with a weight, on some meshes or every receiver; combined by weighted mean or sum, the lowest, the highest or the product. In the editor each input is a fold-out whose line says what it takes; unfolded, it shows only the bounds its function uses. <em>Show</em> paints it on every model, with the same results charts.</li>
            <li>A report the agent saves keeps the Daylight setup of that time. <em>Generate PDF</em> in the Reports menu opens it first (it stays open), runs what has no result, then makes the PDF; the files and variants must still be those of the save (the setup brings its location and weather back).</li>
          </ul>

          <h3>Views and download</h3>
          <ul>
            <li><em>Views</em> jumps to one of the model's cameras or the <em>Whole model</em>, and saves the current view. Saved views serve every 3D view for this session and never go into a file.</li>
            <li><em>Download</em> writes the active model's result as <code>.usdz</code>, <code>.usda</code>, <code>.usdc</code>, <code>.usd</code>, <code>.glb</code>, <code>.gltf</code> or <code>.obj</code>. In USD the result colours replace the receivers' materials, or each receiver gets a <code>daylight</code> variant set; every result stays on the meshes as a value.</li>
          </ul>

          <h3>More</h3>
          <p>
            Runs from every user queue on one GPU; a run already computed comes from the cache. <em>API</em> in the bar opens the
            server's documentation, for scripts and agents.
          </p>
        </div>
      </dialog>, document.body)}
    </>
  );
}
