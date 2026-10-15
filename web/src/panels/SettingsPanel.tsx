import { memo, type Dispatch } from 'react';
import { QUANTITIES, quantitiesFor, type Action, type Settings } from '../store';
import { NumberField, Segmented, knob } from '../ui';

interface Props { sim: Settings['sim']; errors: Record<string, string>; dispatch: Dispatch<Action> }

export const SettingsPanel = memo(function SettingsPanel({ sim, errors, dispatch }: Props) {
  const set = (patch: Partial<Settings['sim']>) => dispatch({ type: 'SIM', patch });
  const valid = quantitiesFor(sim.mode);
  return (
    <section className="stack" aria-labelledby="h-sim">
      <h2 id="h-sim">Simulation</h2>
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
          <div className="grid" style={knob('--grid-min', '6rem')}>
            <NumberField id="north" label="North (deg, ccw from +Y)" value={sim.north} step={1} onCommit={(v) => { if (Number.isFinite(v)) set({ north: v }); }} />
            <NumberField id="offset" label="Sensor offset (m)" value={sim.offset} step={0.01} onCommit={(v) => { if (Number.isFinite(v)) set({ offset: v }); }} />
          </div>
          <label><input type="checkbox" checked={sim.cullBackfaces} onChange={(e) => set({ cullBackfaces: e.target.checked })} /> Occluders block only from their front side</label>
          <label><input type="checkbox" checked={sim.selfOcclude} onChange={(e) => set({ selfOcclude: e.target.checked })} /> Receivers block rays too (self-occlusion)</label>
        </div>
      </details>
    </section>
  );
});
