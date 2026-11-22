// The gradient editor (a menu beside the Gradient select): a gradient's stops, each with its colour and its position,
// stops added and removed, the gradient turned round, saved under a name of its own, a preset put back as built in.
// Every change goes to the settings' library (GRADIENT), which every result, both analyses and every chart read: a
// preset edited here is that preset everywhere. A colour changes at once (the 3D view only restyles); a position is
// drawn here while its slider moves and stored when it is let go (moved stops paint the values again).
import { useId, useState, type Dispatch } from 'react';
import { GRADIENTS, MAX_STOPS, flipped, hexAt, positionsOf, type Gradient, type GradientDef } from '../lib/gradients';
import type { Action } from '../store';
import { ColorQuad, Icon, MenuButton } from '../ui';

/** A gradient as a bar: its stops where they sit. */
export function GradientBar({ stops, positions }: { stops: readonly string[]; positions: readonly number[] }) {
  const id = useId();
  return (
    <svg viewBox="0 0 320 12" width="100%" preserveAspectRatio="none" aria-hidden="true">
      <defs><linearGradient id={id}>{stops.map((hex, i) => <stop key={i} offset={`${100 * positions[i]}%`} stopColor={hex} />)}</linearGradient></defs>
      <rect width="320" height="12" fill={`url(#${id})`} />
    </svg>
  );
}

/** `onUse(key)`: the quantity takes the gradient saved as new. */
export function GradientEditor({ id, gradient, library, dispatch, onUse }: { id: string; gradient: Gradient; library: Readonly<Record<string, GradientDef>>; dispatch: Dispatch<Action>; onUse: (key: string) => void }) {
  const [drag, setDrag] = useState<{ i: number; p: number } | null>(null); // the stop whose slider moves, not stored yet
  const [name, setName] = useState<{ key: string; text: string } | null>(null); // the name as typed, for this gradient
  const { key, label, stops } = gradient, n = stops.length, preset = GRADIENTS.some((g) => g.key === key), changed = preset && !!library[key];
  const stored = positionsOf(gradient), at = stored.map((p, i) => (drag?.i === i ? drag.p : p)), text = name?.key === key ? name.text : label;
  const put = (g: GradientDef, as = key) => dispatch({ type: 'GRADIENT', key: as, gradient: g });
  const def = (patch: Partial<GradientDef>): GradientDef => ({ label, stops, positions: stored, ...patch });
  const drop = () => { if (drag) { put(def({ positions: at })); setDrag(null); } };
  const add = () => { // in the middle of the widest gap, in the colour the gradient has there
    let k = 0;
    for (let i = 1; i < n - 1; i++) if (at[i + 1] - at[i] > at[k + 1] - at[k]) k = i;
    const mid = (at[k] + at[k + 1]) / 2;
    put(def({ stops: [...stops.slice(0, k + 1), hexAt(gradient, mid), ...stops.slice(k + 1)], positions: [...at.slice(0, k + 1), mid, ...at.slice(k + 1)] }));
  };
  const remove = (i: number) => { // the ends stay at 0 and 1
    const p = at.filter((_, j) => j !== i);
    p[0] = 0;
    p[p.length - 1] = 1;
    put(def({ stops: stops.filter((_, j) => j !== i), positions: p }));
  };
  const saveAs = () => {
    const as = `custom-${Date.now().toString(36)}`;
    put(def({ label: text.trim() === label || !text.trim() ? `${label} copy` : text.trim() }), as);
    setName(null);
    onUse(as);
  };
  return (
    <MenuButton id={id} label="Edit" title={`Edit the gradient ${label}: its colours and where they sit`}>
      {() => (
        <>
          <div className="menu__section">{label}: shared by every result that uses it</div>
          <div className="stack stack--tight chart-menu">
            <GradientBar stops={stops} positions={at} />
            {stops.map((hex, i) => (
              <div key={i} className="row-fill">
                <label className="slider-row">
                  <ColorQuad id={`${id}:c${i}`} label={`Colour of stop ${i + 1}`} value={hex} onChange={(c) => put(def({ stops: stops.map((s, j) => (j === i ? c : s)) }))} />
                  <input
                    type="range" min={0} max={100} step={1} value={Math.round(100 * at[i])} disabled={i === 0 || i === n - 1} aria-label={`Position of stop ${i + 1}, percent`}
                    onChange={(e) => setDrag({ i, p: Math.min(Math.max(Number(e.target.value) / 100, at[i - 1]), at[i + 1]) })} onPointerUp={drop} onKeyUp={drop} onBlur={drop}
                  />
                  <span className="slider-row__value">{Math.round(100 * at[i])} %</span>
                </label>
                <button className="icon-btn icon-btn--ghost" type="button" aria-label={`Remove stop ${i + 1}`} title="Remove this stop" disabled={n <= 2} onClick={() => remove(i)}><Icon name="close" /></button>
              </div>
            ))}
            <div className="cluster">
              <button className="btn btn--secondary" type="button" disabled={n >= MAX_STOPS} title={n >= MAX_STOPS ? `A gradient holds at most ${MAX_STOPS} stops` : 'A stop in the widest gap'} onClick={add}><Icon name="plus" /> Add stop</button>
              <button className="btn btn--secondary" type="button" title="Turn the gradient round: low values take the colours of high ones" onClick={() => put(flipped(def({})))}>Flip</button>
            </div>
            <div className="field">
              <label className="field__label" htmlFor={`${id}:name`}>Name</label>
              <input
                className="input" id={`${id}:name`} type="text" maxLength={40} value={text} onChange={(e) => setName({ key, text: e.target.value })}
                onBlur={() => { if (!preset && text.trim() && text.trim() !== label) put(def({ label: text.trim() })); }}
              />
              <span className="field__help">{preset ? 'A built-in gradient: changes stay until Reset. Save as new keeps it and makes a copy under this name.' : 'One of your own gradients.'}</span>
            </div>
          </div>
          <div className="menu__footer cluster">
            <button className="btn btn--secondary" type="button" onClick={saveAs}>Save as new</button>
            {preset
              ? <button className="btn btn--secondary" type="button" disabled={!changed} title="Back to the built-in colours and positions" onClick={() => dispatch({ type: 'GRADIENT', key, gradient: null })}>Reset</button>
              : <button className="btn btn--danger" type="button" title="Results that use it go back to their default gradient" onClick={() => dispatch({ type: 'GRADIENT', key, gradient: null })}>Delete</button>}
          </div>
        </>
      )}
    </MenuButton>
  );
}
