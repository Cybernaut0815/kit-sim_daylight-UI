import { memo, type Dispatch } from 'react';
import { QUANTITIES, quantitiesFor, type Action, type Settings } from '../store';
import { NumberField, Segmented, knob, Section } from '../ui';

interface Props { sim: Settings['sim']; errors: Record<string, string>; dispatch: Dispatch<Action> }

// The light-through-materials switches (the numbers are the Materials table's); Ladybug mode keeps RadiationStudy's
// opaque black scene. Each hint fits two lines at the narrowest panel, so a mode switch moves nothing; the phase-2
// Reflections switches make it "Transmission on, 2 reflections, 4096 samples (slower); interiors need 5-8 reflections".
const PRECISE = 'More precise: Transmission on (slower).';
const LADYBUG = 'Ladybug mode: every surface opaque and black, as in RadiationStudy';

export const SettingsPanel = memo(function SettingsPanel({ sim, errors, dispatch }: Props) {
  const set = (patch: Partial<Settings['sim']>) => dispatch({ type: 'SIM', patch });
  const valid = quantitiesFor(sim.mode), ladybug = sim.mode === 'ladybug';
  return (
    <Section id="sim" title="Simulation">
      <div className="field">
        <span className="field__label">Sky model</span>
        <Segmented name="mode" label="Sky model" value={sim.mode} options={[['physical', 'Physical'], ['ladybug', 'Ladybug']] as const} onChange={(mode) => set({ mode })} />
      </div>
      <fieldset className="field">
        <legend>Quantities</legend>
        <div className="cluster">
          {QUANTITIES.map((q) => (
            <label key={q}>
              <input
                id={`q-${q}`} type="checkbox" checked={sim.quantities.includes(q)} disabled={!valid.includes(q)} aria-invalid={errors.quantities ? true : undefined}
                onChange={(e) => set({ quantities: e.target.checked ? QUANTITIES.filter((x) => x === q || sim.quantities.includes(x)) : sim.quantities.filter((x) => x !== q) })}
              /> {q}
            </label>
          ))}
        </div>
        {errors.quantities && <span className="field__error">{errors.quantities}</span>}
      </fieldset>
      <div className="field">
        <span className="field__label">Receiving side</span>
        <Segmented name="sides" label="Receiving side" value={sim.sides} options={[['front', 'Front'], ['back', 'Back'], ['both', 'Both']] as const} onChange={(sides) => set({ sides })} />
      </div>
      <div className="field">
        <span className="field__label">Sensors on</span>
        <Segmented name="on" label="Sensors on" value={sim.on} options={[['faces', 'Faces'], ['vertices', 'Vertices']] as const} onChange={(on) => set({ on })} />
      </div>
      <fieldset className="field">
        <legend>Materials</legend>
        <label title="Glass, screens and trees let light through by their transmittance (the Materials table); off: every surface blocks like a solid one">
          <input id="transmission" type="checkbox" checked={sim.transmission} disabled={ladybug} onChange={(e) => set({ transmission: e.target.checked })} /> Transmission
        </label>
        <label title="Glass passes less light at grazing angles, as real panes do (Radiance glass, refractive index 1.52); off: it passes its transmittance at every angle">
          <input id="fresnel" type="checkbox" checked={sim.fresnel} disabled={ladybug || !sim.transmission} onChange={(e) => set({ fresnel: e.target.checked })} /> Angle-dependent glass
        </label>
        <span className="field__help lines-2">{ladybug ? LADYBUG : PRECISE}</span>
      </fieldset>
      <details className="accordion">
        <summary>Advanced</summary>
        <div className="accordion__body stack" style={knob('--stack-gap', 'var(--space-4)')}>
          <div className="field">
            <label className="field__label" htmlFor="sky-density">Sky density</label>
            <select className="select" id="sky-density" value={sim.skyDensity} aria-invalid={errors.skyDensity ? true : undefined} onChange={(e) => set({ skyDensity: Number(e.target.value) as 1 | 2 | 4 })}>
              <option value={1}>1 (145 patches)</option>
              <option value={2}>2 (577 patches)</option>
              <option value={4} disabled={sim.mode === 'ladybug'}>4 (2305 patches, physical only)</option>
            </select>
            {errors.skyDensity && <span className="field__error">{errors.skyDensity}</span>}
          </div>
          <div className="field">
            <label className="field__label" htmlFor="patch-samples">Patch samples</label>
            <select className="select" id="patch-samples" value={sim.patchSamples} disabled={sim.mode === 'ladybug'} onChange={(e) => set({ patchSamples: Number(e.target.value) })}>
              {[1, 4, 9, 16].map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
            <span className="field__help">Physical mode: stratified rays per sky patch; 4, 9 or 16 smooth the patch discretisation.</span>
          </div>
          <label className="slider-row">
            <span>Ground reflectance</span>
            <input type="range" min={0} max={1} step={0.05} value={sim.ground} onChange={(e) => set({ ground: e.target.valueAsNumber })} />
            <span className="slider-row__value">{sim.ground.toFixed(2)}</span>
          </label>
          <NumberField id="offset" label="Sensor offset (m)" value={sim.offset} step={0.01} help="North is set in Location." onCommit={(v) => { if (Number.isFinite(v)) set({ offset: v }); }} />
          <label><input type="checkbox" checked={sim.cullBackfaces} onChange={(e) => set({ cullBackfaces: e.target.checked })} /> Occluders block only from their front side</label>
          <label><input type="checkbox" checked={sim.selfOcclude} onChange={(e) => set({ selfOcclude: e.target.checked })} /> Receivers block rays too (self-occlusion)</label>
        </div>
      </details>
    </Section>
  );
});
