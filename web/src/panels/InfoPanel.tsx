// Info: how to use the app, in the app bar where the design-system switch was. A native modal <dialog> (kit-ui / zha-ui
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
      <button className="btn btn--ghost" type="button" aria-haspopup="dialog" title="How to use the app: a quick start, reading the results, comparing models, glass and reflective materials" onClick={() => dlg.current?.showModal()}>Info</button>
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
            <li><em>Model</em>: open the model files (USD, USDZ, glTF, GLB, or OBJ with its MTL and textures), or a folder holding a USD scene and its assets. In the prim tree select meshes or whole groups and give them a role: <em>Receiver</em> (measured and painted with the result), <em>Shade</em> (casts shadows) or <em>Ignore</em> (left out of the run).</li>
            <li><em>Location</em>: search a place, click the map, drag the marker or type coordinates.</li>
            <li><em>Time</em>: <em>Annual</em>, a <em>Single date</em> or a <em>Date range</em>; or drag the sun path drawn around the model.</li>
            <li><em>Simulation</em>: the quantities, the receiving side, sensors on faces or vertices.</li>
            <li><em>Weather</em>: the nearest station, PVGIS, an uploaded EPW file or a clear sky.</li>
            <li><em>Run simulation</em> in the bar under the 3D view, or tick <em>Run on every change</em>.</li>
          </ol>

          <h3>Reading the results</h3>
          <ul>
            <li><em>Result</em> picks the quantity shown; the meshes take its colours (<em>Values</em>) or stay <em>Plain</em>.</li>
            <li><em>Gradient</em>, <em>Min</em> and <em>Max</em> set the colour scale. A <em>Problem range</em> (<em>Below</em>, <em>Above</em>) paints the values outside it in its own colours.</li>
            <li><em>Distribution</em> and <em>Cumulative area</em> are weighted by area, <em>Problem range split</em> gives the share of the area below, within and above the range, and the table lists every receiver mesh (a click selects it).</li>
            <li>Hover a mesh to read its value; hover a bar of the <em>Distribution</em> to see where those values lie on the model.</li>
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
