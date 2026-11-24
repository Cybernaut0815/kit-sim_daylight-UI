// View settings: the view analysis' own inputs, as the core's views flags (docs/views.md): the field of view (out of a
// window about each face's normal, turned level or not, all around, or the horizontal ring of the 2D isovist), its cell size, where the eye
// sits, how far the distances reach, the virtual ground and glass. The roles are the Model panel's (its own set here);
// the materials (glass) are the same as daylight's; north is the site's. Each section's reset button puts its own fields
// back to their defaults.
import { memo, type Dispatch } from 'react';
import type { Action, SettingsSection, ViewSim } from '../store';
import { NumberField, Section, Segmented, knob } from '../ui';

interface Props { v: ViewSim; north: number; errors: Record<string, string>; dispatch: Dispatch<Action> }

type Field = 'view' | 'all' | 'flat';
// each field preset's default [H, LO, HI]: the core's defaults about the normal and all around, the 2D isovist's ring
const FIELDS: Record<Field, ViewSim['fov']> = { view: [120, -70, 50], all: [360, -70, 50], flat: [360, 0, 0] };
const fieldOf = ([h, lo, hi]: ViewSim['fov']): Field => (h !== 360 ? 'view' : lo === 0 && hi === 0 ? 'flat' : 'all');
const FIELD_HELP: Record<Field, string> = {
  view: 'Out of a window: a field about each face\'s normal, turned level as a person looks (50° up and 70° down from the horizon by default). Distances: log mean and nearest.',
  all: 'All around from each element, azimuth from north: an eye turning on the spot (lift it with the eye offset). Default measure: the isovist volume in view.',
  flat: 'One ring of horizontal rays all around: the 2D isovist, the area in view (space syntax), and the shares along the horizon.',
};
const GAZE_HELP: Record<ViewSim['gaze'], string> = {
  level: 'Centred on the normal turned level, elevations about the horizon, on a tilted face too. Faces looking straight up or down keep their normal.',
  normal: 'Centred on the face\'s normal: on a tilted face the field tilts with it (up is uphill). Faces looking straight up or down keep their normal.',
};
const REACH: [string, string][] = [['', 'None'], ['en17037', 'EN 17037: 6, 20 and 50 m'], ['own', 'Own distances…']];
const GLASS = 'Rays pass the faces whose material is glass (the Materials table) and count what lies behind; "Seen through glass" gives the share. Off: windows block like walls.';

export const ViewSettingsPanel = memo(function ViewSettingsPanel({ v, north, errors, dispatch }: Props) {
  const set = (patch: Partial<ViewSim>) => dispatch({ type: 'VIEW_SIM', patch });
  const reset = (what: SettingsSection) => ({ onReset: () => dispatch({ type: 'RESET', what }) });
  const field = fieldOf(v.fov), [h, lo, hi] = v.fov;
  const cols = Math.max(1, Math.round(h / v.cell)), rows = Math.max(1, Math.round((hi - lo) / v.cell));
  const reach = v.reach === '' || v.reach === 'en17037' ? v.reach : 'own';
  const fov = (k: 0 | 1 | 2, x: number) => { if (Number.isFinite(x)) set({ fov: v.fov.map((y, i) => (i === k ? x : y)) as ViewSim['fov'] }); };
  return (
    <>
      <Section id="view-field" title="Field of view" reset={reset('view-field')}>
        <div className="field">
          <span className="field__label">Field</span>
          <Segmented name="view-field" label="Field of view" title={FIELD_HELP[field]} value={field} options={[['view', 'Window'], ['all', 'All around'], ['flat', 'Horizontal']] as const} onChange={(f) => set({ fov: FIELDS[f] })} />
          {errors.fov ? <span className="field__error">{errors.fov}</span> : <span className="field__help lines-3">{FIELD_HELP[field]}</span>}
        </div>
        {field === 'view' && (
          <div className="field">
            <label><input type="checkbox" checked={v.gaze === 'level'} onChange={(e) => set({ gaze: e.target.checked ? 'level' : 'normal' })} /> Level gaze, as a person looks</label>
            <span className="field__help lines-3">{GAZE_HELP[v.gaze]}</span>
          </div>
        )}
        {field === 'view' && <NumberField id="view-fov-h" label="Width (°)" value={h} min={1} max={180} step={1} onCommit={(x) => fov(0, x)} />}
        {field !== 'flat' && (
          <div className="grid" style={knob('--grid-min', '8rem')}>
            <NumberField id="view-fov-lo" label="Down to (°)" value={lo} min={-90} max={90} step={1} onCommit={(x) => fov(1, x)} />
            <NumberField id="view-fov-hi" label="Up to (°)" value={hi} min={-90} max={90} step={1} onCommit={(x) => fov(2, x)} />
          </div>
        )}
        <div className="field">
          <label className="field__label" htmlFor="view-cell">Cell</label>
          <select className="select" id="view-cell" value={v.cell} aria-invalid={errors.cell ? true : undefined} onChange={(e) => set({ cell: Number(e.target.value) })}>
            {[0.5, 1, 2, 3, 5].map((c) => <option key={c} value={c}>{c}°</option>)}
          </select>
          {errors.cell
            ? <span className="field__error">{errors.cell}</span>
            : <span className="field__help line">{`${cols} × ${rows} = ${(cols * rows).toLocaleString('en-GB')} rays per element; 1° for thin or far targets`}</span>}
        </div>
      </Section>
      <Section id="view-eye" title="Eye" reset={reset('view-eye')}>
        <div className="field">
          <span className="field__label">Looking side</span>
          <Segmented name="view-sides" label="Looking side" value={v.sides} options={[['front', 'Front'], ['back', 'Back'], ['both', 'Both']] as const} onChange={(sides) => set({ sides })} />
        </div>
        <div className="field">
          <span className="field__label">Eyes on</span>
          <Segmented name="view-on" label="Eyes on" value={v.on} options={[['faces', 'Faces'], ['vertices', 'Vertices']] as const} onChange={(on) => set({ on })} />
        </div>
        <NumberField id="view-offset" label="Eye offset (m)" value={v.offset} step={0.1} help="Along the normal: 1.2 seated or 1.6 standing above a floor grid. All around at 0 (or with a level gaze on a tilted face), a receiver that blocks rays sees its own surface behind its plane (obstruction): lift the eye, or untick Blocks rays (Model) to see the ground through it." onCommit={(x) => { if (Number.isFinite(x)) set({ offset: x }); }} />
      </Section>
      <Section id="view-distance" title="Distances" reset={reset('view-distance')}>
        <NumberField id="view-far" label="Far (m)" value={v.far} min={0.2} step={10} error={errors.far} help="What an open ray counts as, and the cap of every distance and isovist (interiors: 20 to 50 m)." onCommit={(x) => { if (Number.isFinite(x)) set({ far: x }); }} />
        <div className="field">
          <label className="field__label" htmlFor="view-reach">Reach</label>
          <select className="select" id="view-reach" value={reach} aria-invalid={errors.reach ? true : undefined} onChange={(e) => set({ reach: e.target.value === 'own' ? '10,50,100' : e.target.value })}>
            {REACH.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </select>
          {reach === 'own' && <input className="input" aria-label="Reach distances (m, comma separated)" defaultValue={v.reach} key={v.reach} onBlur={(e) => set({ reach: e.currentTarget.value })} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />}
          {errors.reach
            ? <span className="field__error">{errors.reach}</span>
            : <span className="field__help">The share of the field that sees at least each distance before it meets anything.</span>}
        </div>
      </Section>
      <Section id="view-ground" title="Ground and glass" reset={reset('view-ground')}>
        <label title="A plane at the model's lowest point (or the height below) ends downward rays as ground: the street seen from a facade when no terrain is modelled">
          <input type="checkbox" checked={v.virtualGround} onChange={(e) => set({ virtualGround: e.target.checked })} /> Virtual ground
        </label>
        <NumberField id="view-ground-z" label="Ground height (m)" value={v.groundZ ?? NaN} step={0.1} placeholder="the lowest point" help="Blank: the lowest point of the meshes in the run." onCommit={(x) => set({ groundZ: Number.isFinite(x) ? x : null })} />
        <label title={GLASS}>
          <input type="checkbox" title={GLASS} checked={v.transmission} onChange={(e) => set({ transmission: e.target.checked })} /> See through glass
        </label>
        <details className="accordion">
          <summary>Advanced</summary>
          <div className="accordion__body stack" style={knob('--stack-gap', 'var(--space-4)')}>
            <label><input type="checkbox" checked={v.cullBackfaces} onChange={(e) => set({ cullBackfaces: e.target.checked })} /> Obstructions block only from their front side</label>
            <label><input type="checkbox" checked={v.selfOcclude} onChange={(e) => set({ selfOcclude: e.target.checked })} /> Receivers block rays too</label>
            <span className="field__help">{`North ${north}° (Location, on the Daylight tab): azimuth 0 all around.`}</span>
          </div>
        </details>
      </Section>
    </>
  );
});

