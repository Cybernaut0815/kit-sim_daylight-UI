// Materials: what the run's surfaces let through, the two default rows first, then each material bound to a receiver or
// a shade: its kind and transmittance from its own settings (lib/optics.ts derive()), the default, or the user's edit (by
// material path, for this model); a preset sets the numbers at once. A fixed-height box (drag the corner to enlarge) and
// a two-line status, so a model's rows and its texture reads never move the panels below. The status is what a run held
// for the reads focuses, and says when they end.
import { Fragment, memo, type Dispatch } from 'react';
import type { MaterialNetwork } from 'usd-viewer';
import { DEFAULT_KEY, GLASS_KEY, PRESETS, clamp, editOptics, type MaterialRow, type Optics, type OpticsEdit } from '../lib/optics';
import type { Action, SimMode } from '../store';
import { ResetButton, Section, Swatch } from '../ui';

const KINDS = [['opaque', 'Opaque'], ['glass', 'Glass'], ['porous', 'Porous']] as const;
const SOURCE: Record<Optics['source'], [string, string, string]> = { // badge text, intent, what it means
  derived: ['Derived', 'badge--neutral', "Read from the material's own settings (opacity, cut-out, opacity texture), never its name"],
  default: ['Default', 'badge--neutral', 'The default values'],
  edited: ['Edited', 'badge--info', 'Your values for this model (not saved)'],
};

/** The material's own colour, its constant diffuseColor (linear) as sRGB hex; none when a texture or no preview surface gives it. */
function colourOf(net?: MaterialNetwork): string | undefined {
  const s = net?.nodes[net.surface], c = s?.params.diffuseColor;
  if (s?.type !== 'UsdPreviewSurface' || s.inputs.diffuseColor) return undefined;
  const rgb = Array.isArray(c) ? c.map(Number) : [0.18, 0.18, 0.18]; // UsdPreviewSurface's default
  const hex = (x: number) => { const v = Math.min(Math.max(x || 0, 0), 1); return Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)).toString(16).padStart(2, '0'); };
  return `#${rgb.slice(0, 3).map(hex).join('')}`;
}

interface Props { rows: MaterialRow[]; fallback: Optics; glass: Optics; reading: boolean; mode: SimMode; transmission: boolean; dispatch: Dispatch<Action> }

export const MaterialsPanel = memo(function MaterialsPanel({ rows, fallback, glass, reading, mode, transmission, dispatch }: Props) {
  const list: { key: string; name: string; title: string; optics: Optics; colour?: string }[] = [
    { key: DEFAULT_KEY, name: 'Default - no material', optics: fallback, title: 'Surfaces without a material, and materials other than a UsdPreviewSurface (MaterialX, OpenPBR). Built in: opaque, reflectance 0.20 (Honeybee generic_context_0.20, BRE GN50).' },
    { key: GLASS_KEY, name: 'Default glass', optics: glass, title: 'Every material that reads as glass: its opacity tells glass apart, not how much it passes. Built in: double low-e, 0.64 (visible light; 0.37 of the solar energy).' },
    ...rows.map((m) => ({ key: m.path, name: m.path.slice(m.path.lastIndexOf('/') + 1), title: m.path, optics: m.optics, colour: colourOf(m.network) })),
  ];
  const status = mode === 'ladybug' ? 'Ladybug mode: every surface opaque and black'
    : !transmission ? 'Transmission is off: glass and screens block like solid surfaces'
      : 'τ: the share of the light passed straight through, at normal incidence';
  const edit = (key: string, e: OpticsEdit) => dispatch({ type: 'OPTICS_EDIT', key, edit: e });
  return (
    <Section id="materials" title="Materials" busy={reading}>
      <p className="text-muted lines-2" id="materials-status" role="status" tabIndex={-1} title={mode === 'physical' ? 'Cut-out and screen masks are read once per model, when Transmission is on; a run waits for them' : undefined}>
        {reading ? <><span className="spinner" aria-hidden="true" /> Reading the materials</> : status}
      </p>
      <div className="materials">
        <table className="data-table data-table--wrap">
          <caption className="sr-only">The default material, the default glass, then the materials of the receivers and shades</caption>
          <colgroup><col /><col className="materials__col-kind" /><col className="materials__col-tau" /></colgroup>
          <thead>
            <tr>
              <th scope="col">Material</th>
              <th scope="col">Kind</th>
              <th scope="col" className="num" title="Transmittance: the share of the light passed straight through at normal incidence; glass passes less at grazing angles with Angle-dependent glass"><span className="th-unit">τ</span><span className="sr-only">, transmittance</span></th>
            </tr>
          </thead>
          <tbody>
            {list.map((r, i) => {
              const o = r.optics, [label, intent, about] = SOURCE[o.source], tau = Number(o.tau.toFixed(3)), warn = o.warning ? `material-${i}-warning` : undefined;
              return (
                <Fragment key={r.key}>
                  <tr>
                    <td title={r.title}>
                      <div className="line"><Swatch color={r.colour} outline /> {r.name}</div>
                      <div className="cluster">
                        <span className={`badge ${intent}`} title={about}><span className="dot" />{label}</span>
                        {o.source === 'edited' && <ResetButton what={r.name} label={`Undo your edit of ${r.name}`} onClick={() => dispatch({ type: 'OPTICS_RESET', key: r.key })} />}
                      </div>
                    </td>
                    <td>
                      <select
                        className="select" value={o.kind} aria-label={`${r.name}: kind, or a preset`} aria-describedby={warn}
                        onChange={(e) => { const p = PRESETS.find((x) => x.name === e.target.value); edit(r.key, p ? { rho: p.rho, tau: p.tau, kind: p.kind } : editOptics(o, { kind: e.target.value as Optics['kind'] }, fallback, glass)); }}
                      >
                        <optgroup label="Kind">{KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</optgroup>
                        {/* phase 2: the opaque presets (a reflectance) with the reflectance column; until then they would change nothing */}
                        {KINDS.filter(([k]) => k !== 'opaque').map(([k, l]) => (
                          <optgroup key={k} label={`${l} presets: transmittance`}>
                            {PRESETS.filter((p) => p.kind === k).map((p) => <option key={p.name} value={p.name} title={p.source}>{p.name} {p.tau.toFixed(2)}</option>)}
                          </optgroup>
                        ))}
                      </select>
                    </td>
                    <td className="num">
                      {/* committed on blur or Enter, and only when changed: a blur alone never turns a row into an edit. The box
                          then shows what the row holds, clamped, also when that is the value it showed before (no remount) */}
                      <input
                        key={tau} className="input" type="number" inputMode="decimal" min={0} max={o.kind === 'glass' ? 0.918 : 1} step={0.01} defaultValue={tau} disabled={o.kind === 'opaque'}
                        aria-label={`${r.name}: transmittance`} aria-describedby={warn}
                        onBlur={(e) => {
                          const v = e.currentTarget.valueAsNumber, next = Number.isFinite(v) && v !== tau ? editOptics(o, { tau: v }, fallback, glass) : null;
                          if (next) edit(r.key, next);
                          e.currentTarget.value = String(next ? Number(clamp({ ...next, source: 'edited' }).tau.toFixed(3)) : tau);
                        }}
                        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                      />
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
