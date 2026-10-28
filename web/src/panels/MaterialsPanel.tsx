// Materials: what the run's surfaces reflect and let through, the two default rows first, then each material bound to a
// receiver or a shade: its kind, reflectance and transmittance from its own settings (lib/optics.ts derive(); "Not
// read" while a texture waits), the default, or the user's edit (by material path, for this model); a preset sets the
// numbers at once. A fixed-height box (drag the corner to enlarge) and a fixed-height status, so a model's rows and its
// texture reads never move the panels below. The status is what a run held for the reads focuses, and says when they end.
import { Fragment, memo, type Dispatch } from 'react';
import type { MaterialNetwork } from 'usd-viewer';
import { DEFAULT_KEY, GLASS_KEY, PRESETS, clamp, editOptics, type MaterialRow, type Optics, type OpticsEdit, type Preset } from '../lib/optics';
import { rowNames } from '../lib/tree';
import type { Action, SimMode } from '../store';
import { ResetButton, Section, Swatch } from '../ui';

const KINDS = [['opaque', 'Opaque'], ['glass', 'Glass'], ['porous', 'Porous']] as const;
// a preset group's numbers: opaque ones reflect, glass passes, porous does both
const PRESET_VALUES: Record<Optics['kind'], [string, (p: Preset) => string]> = {
  opaque: ['reflectance', (p) => p.rho.toFixed(2)],
  glass: ['visible transmittance', (p) => p.tau.toFixed(2)],
  porous: ['reflectance | transmittance', (p) => `${p.rho.toFixed(2)} | ${p.tau.toFixed(2)}`],
};
const RHO = 'ρ, reflectance: the share of the light reflected diffusely, used with Reflections on; glass reflects none diffusely (with Angle-dependent glass it mirrors by angle)';
const TAU = 'τ, transmittance: the share of the light passed straight through at normal incidence, used with Transmission on; glass passes less at grazing angles with Angle-dependent glass';
const SOURCE: Record<Optics['source'], [string, string, string]> = { // badge text, intent, what it means
  derived: ['Derived', 'badge--neutral', "Read from the material's own settings (colour, opacity, cut-out, their textures), never its name"],
  default: ['Default', 'badge--neutral', 'The default values'],
  edited: ['Edited', 'badge--info', 'Your values for this model (not saved)'],
  unread: ['Not read', 'badge--neutral', "Its textures are read once their numbers count (masks with Transmission on, colour maps with Reflections on); until then, the values without them"],
};

/** The material's own colour, its constant diffuseColor (linear) as sRGB hex; none when a texture or no preview surface gives it. */
function colourOf(net?: MaterialNetwork): string | undefined {
  const s = net?.nodes[net.surface], c = s?.params.diffuseColor;
  if (s?.type !== 'UsdPreviewSurface' || s.inputs.diffuseColor) return undefined;
  const rgb = Array.isArray(c) ? c.map(Number) : [0.18, 0.18, 0.18]; // UsdPreviewSurface's default
  const hex = (x: number) => { const v = Math.min(Math.max(x || 0, 0), 1); return Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)).toString(16).padStart(2, '0'); };
  return `#${rgb.slice(0, 3).map(hex).join('')}`;
}

/** A ρ or τ box, committed on blur or Enter and only when changed: a blur alone never turns a row into an edit. `commit`
 *  edits the row and returns what it then holds, clamped, which the box shows, also when that is the value it showed
 *  before (no remount). */
function ValueBox({ value, label, max, disabled, describedBy, commit }: { value: number; label: string; max: number; disabled: boolean; describedBy?: string; commit: (v: number) => number }) {
  const shown = Number(value.toFixed(3));
  return (
    <input
      key={shown} className="input" type="number" inputMode="decimal" min={0} max={max} step={0.01} defaultValue={shown} disabled={disabled} aria-label={label} aria-describedby={describedBy}
      onBlur={(e) => { const v = e.currentTarget.valueAsNumber; e.currentTarget.value = String(Number.isFinite(v) && v !== shown ? Number(commit(v).toFixed(3)) : shown); }}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
    />
  );
}

interface Props { slot: number; title: string; rows: MaterialRow[]; fallback: Optics; glass: Optics; reading: boolean; mode: SimMode; transmission: boolean; reflections: boolean; dispatch: Dispatch<Action> }

export const MaterialsPanel = memo(function MaterialsPanel({ slot, title, rows, fallback, glass, reading, mode, transmission, reflections, dispatch }: Props) {
  const names = rowNames(rows.map((m) => m.path)); // parent names in front while two share one (/A/Looks/Glass, /B/Looks/Glass)
  const list: { key: string; name: string; title: string; optics: Optics; colour?: string }[] = [
    { key: DEFAULT_KEY, name: 'Default - no material', optics: fallback, title: 'Surfaces without a material, materials other than a UsdPreviewSurface (MaterialX, OpenPBR), and the reflectance of a material without a colour of its own (none set, or vertex colours). Built in: opaque, reflectance 0.20 (Honeybee generic_context_0.20, BRE GN50).' },
    { key: GLASS_KEY, name: 'Default glass', optics: glass, title: 'Every material that reads as glass: its opacity tells glass apart, not how much it passes. Built in: double low-e, 0.64 (visible light; 0.37 of the solar energy).' },
    ...rows.map((m, i) => ({ key: m.path, name: names[i], title: m.path, optics: m.optics, colour: colourOf(m.network) })),
  ];
  const status = mode === 'ladybug' ? 'Ladybug mode: every surface opaque and black'
    : !transmission && !reflections ? 'Transmission and Reflections are off: every surface opaque and black'
      : !transmission ? 'Transmission is off: glass and screens block like solid surfaces'
        : !reflections ? 'Reflections are off: reflectance is not used'
          : 'ρ: the share reflected diffusely; τ: the share passed straight through, at normal incidence';
  const edit = (key: string, e: OpticsEdit) => { dispatch({ type: 'OPTICS_EDIT', slot, key, edit: e }); return clamp({ ...e, source: 'edited' }); };
  return (
    <Section id="materials" title={title} busy={reading}>
      <p className="text-muted lines-3" id="materials-status" role="status" tabIndex={-1} title={mode === 'physical' ? 'Masks and, with Reflections on, colour textures are read once per model while their numbers count; a run waits for them' : undefined}>
        {reading ? <><span className="spinner" aria-hidden="true" /> Reading the materials</> : status}
      </p>
      <div className="materials">
        <table className="data-table data-table--wrap">
          <caption className="sr-only">The default material, the default glass, then the materials of the receivers and shades</caption>
          <colgroup><col /><col className="materials__col-kind" /><col className="materials__col-num" /></colgroup>
          <thead>
            <tr>
              <th scope="col">Material</th>
              <th scope="col">Kind</th>
              <th scope="col"><span className="th-unit">ρ τ</span><span className="sr-only">: reflectance and transmittance</span></th>
            </tr>
          </thead>
          <tbody>
            {list.map((r, i) => {
              const o = r.optics, [label, intent, about] = SOURCE[o.source], warn = o.warning ? `material-${i}-warning` : undefined;
              return (
                <Fragment key={r.key}>
                  <tr>
                    <td title={r.title}>
                      <div className="line"><Swatch color={r.colour} outline /> {r.name}</div>
                      <div className="cluster">
                        <span className={`badge ${intent}`} title={about}><span className="dot" />{label}</span>
                        {o.source === 'edited' && <ResetButton what={r.name} label={`Undo your edit of ${r.name}`} onClick={() => dispatch({ type: 'OPTICS_RESET', slot, key: r.key })} />}
                      </div>
                    </td>
                    <td>
                      <select
                        className="select" value={o.kind} aria-label={`${r.name}: kind, or a preset`} aria-describedby={warn}
                        onChange={(e) => { const p = PRESETS.find((x) => x.name === e.target.value); edit(r.key, p ? { rho: p.rho, tau: p.tau, kind: p.kind } : editOptics(o, { kind: e.target.value as Optics['kind'] }, fallback, glass)); }}
                      >
                        <optgroup label="Kind">{KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</optgroup>
                        {KINDS.map(([k, l]) => (
                          <optgroup key={k} label={`${l} presets: ${PRESET_VALUES[k][0]}`}>
                            {PRESETS.filter((p) => p.kind === k).map((p) => <option key={p.name} value={p.name} title={p.source}>{p.name} {PRESET_VALUES[k][1](p)}</option>)}
                          </optgroup>
                        ))}
                      </select>
                    </td>
                    <td>
                      {/* the two values one above the other (a row is two lines anyway), so the names keep their room */}
                      <div className="materials__value" title={RHO}>
                        <span aria-hidden="true">ρ</span>
                        <ValueBox value={o.rho} label={`${r.name}: reflectance`} max={1} disabled={o.kind === 'glass'} describedBy={warn} commit={(v) => edit(r.key, editOptics(o, { rho: v }, fallback, glass)).rho} />
                      </div>
                      <div className="materials__value" title={TAU}>
                        <span aria-hidden="true">τ</span>
                        <ValueBox value={o.tau} label={`${r.name}: transmittance`} max={o.kind === 'glass' ? 0.918 : 1} disabled={o.kind === 'opaque'} describedBy={warn} commit={(v) => edit(r.key, editOptics(o, { tau: v }, fallback, glass)).tau} />
                      </div>
                    </td>
                  </tr>
                  {warn && (
                    <tr>
                      <td colSpan={3} className="field__help" id={warn}><span className="badge badge--warning"><span className="dot" />Adjusted</span> {o.warning}</td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </Section>
  );
});
