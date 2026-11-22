// The gradient editor (a menu beside the Gradient select): the gradient as a bar with a handle per stop under it, edited
// in place as in a drawing program. Drag a handle to move its stop, click the bar or the track for a new stop in the
// colour the gradient has there, drag a handle down off the bar (or Delete) to remove it; the selected stop's colour
// and location are the two fields below. Also: the gradient turned round, saved under a name of its own, a preset put
// back as built in.
// Every change goes to the settings' library (GRADIENT), which every result, both analyses and every chart read: a
// preset edited here is that preset everywhere. A colour changes at once (the 3D view only restyles); a dragged stop is
// drawn here while it moves and stored when it is let go (moved stops paint the values again).
// One SVG: the handles' places are attributes, so no inline style is needed (kit-ui).
import { useId, useRef, useState, type Dispatch, type KeyboardEvent, type PointerEvent } from 'react';
import { GRADIENTS, MAX_STOPS, addStop, flipped, moveStop, positionsOf, removeStop, type Gradient, type GradientDef } from '../lib/gradients';
import type { Action } from '../store';
import { MenuButton, NumberField } from '../ui';
import { AXIS, STRONG } from './axes';

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

// the drawing, in viewBox units: the bar, the track of handles under it (a handle: a tip at the bar, its colour below)
const W = 320, PAD = 10, BAR = 26, TIP = BAR + 2, BOX = 12, H = TIP + 6 + BOX + 4, OFF = 30; // OFF: this far under the drawing lets a stop go
const x = (p: number) => PAD + p * (W - 2 * PAD);

/** `onUse(key)`: the quantity takes the gradient saved as new. */
export function GradientEditor({ id, gradient, library, dispatch, onUse }: { id: string; gradient: Gradient; library: Readonly<Record<string, GradientDef>>; dispatch: Dispatch<Action>; onUse: (key: string) => void }) {
  const fill = useId(), svg = useRef<SVGSVGElement>(null);
  const [picked, setPicked] = useState(0); // the selected stop
  const [drag, setDrag] = useState<{ i: number; p: number; off: boolean; moved: boolean } | null>(null); // a handle on its way, not stored yet
  const [name, setName] = useState<{ key: string; text: string } | null>(null); // the name as typed, for this gradient
  const { key, label, stops } = gradient, n = stops.length, preset = GRADIENTS.some((g) => g.key === key), changed = preset && !!library[key];
  const def: GradientDef = { label, stops, ...(gradient.positions ? { positions: gradient.positions } : {}) };
  const at = positionsOf(drag ? moveStop(def, drag.i, drag.p) : def), sel = Math.min(picked, n - 1), text = name?.key === key ? name.text : label;
  const put = (g: GradientDef, as = key) => dispatch({ type: 'GRADIENT', key: as, gradient: g });
  /** The pointer's place along the bar, 0 to 1, and whether it is well under the drawing. */
  const where = (e: PointerEvent) => {
    const r = svg.current!.getBoundingClientRect(), u = ((e.clientX - r.left) / r.width) * W;
    return { p: Math.min(Math.max((u - PAD) / (W - 2 * PAD), 0), 1), off: e.clientY > r.bottom + OFF };
  };
  const remove = (i: number) => { if (n > 2) { put(removeStop(def, i)); setPicked(Math.max(0, Math.min(i, n - 2))); } };
  const colour = () => { const el = document.getElementById(`${id}:colour`) as HTMLInputElement | null; try { el?.showPicker(); } catch { el?.click(); } };
  const grab = (i: number) => (e: PointerEvent<SVGGElement>) => {
    e.stopPropagation(); // not the track's click: no new stop
    e.currentTarget.setPointerCapture(e.pointerId);
    setPicked(i);
    setDrag({ i, p: at[i], off: false, moved: false });
  };
  const move = (e: PointerEvent) => { if (drag) { const w = where(e); setDrag({ i: drag.i, p: w.p, off: w.off && n > 2, moved: true }); } };
  const drop = () => {
    if (!drag) return;
    if (drag.off) remove(drag.i);
    else if (drag.moved) put(moveStop(def, drag.i, drag.p));
    setDrag(null);
  };
  const add = (e: PointerEvent) => { const a = addStop(def, where(e).p); if (a) { put(a.gradient); setPicked(a.index); } };
  const keys = (i: number) => (e: KeyboardEvent) => {
    const step = (e.shiftKey ? 0.1 : 0.01) * (e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : 0);
    if (step) put(moveStop(def, i, at[i] + step));
    else if (e.key === 'Delete' || e.key === 'Backspace') remove(i);
    else if (e.key === 'Enter' || e.key === ' ') colour();
    else return;
    e.preventDefault();
  };
  const saveAs = () => {
    const as = `custom-${Date.now().toString(36)}`;
    put({ ...def, label: text.trim() === label || !text.trim() ? `${label} copy` : text.trim() }, as);
    setName(null);
    onUse(as);
  };
  return (
    <MenuButton id={id} label="Edit" title={`Edit the gradient ${label}: its colours and where they sit`}>
      {() => (
        <>
          <div className="menu__section">{label}: shared by every result that uses it</div>
          <div className="stack stack--tight chart-menu">
            <svg ref={svg} className="gradient-editor" viewBox={`0 0 ${W} ${H}`} width="100%" role="group" aria-label={`The stops of ${label}: drag one to move it, click the bar for a new one, drag one down or press Delete to remove it`}>
              <defs><linearGradient id={fill}>{stops.map((hex, i) => <stop key={i} offset={`${100 * at[i]}%`} stopColor={hex} />)}</linearGradient></defs>
              {/* the bar and the track under it: a click is a new stop there */}
              <rect x={PAD} y={0} width={W - 2 * PAD} height={BAR} fill={`url(#${fill})`} stroke={AXIS} />
              <rect className="gradient-editor__track" x={0} y={0} width={W} height={H} fill="transparent" onPointerDown={n < MAX_STOPS ? add : undefined}>
                <title>{n < MAX_STOPS ? 'Click for a new stop here' : `A gradient holds at most ${MAX_STOPS} stops`}</title>
              </rect>
              {stops.map((hex, i) => {
                const on = i === sel, going = drag?.i === i && drag.off;
                return (
                  <g
                    key={i} className="gradient-editor__stop" role="slider" tabIndex={0} aria-label={`Stop ${i + 1} of ${n}, ${hex}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(100 * at[i])}
                    aria-valuetext={`${Math.round(100 * at[i])} %`} opacity={going ? 0.3 : 1}
                    onPointerDown={grab(i)} onPointerMove={move} onPointerUp={drop} onPointerCancel={() => setDrag(null)} onDoubleClick={colour} onKeyDown={keys(i)} onFocus={() => setPicked(i)}
                  >
                    <title>{`Stop at ${Math.round(100 * at[i])} %: drag to move, double-click for its colour${n > 2 ? ', drag down to remove' : ''}`}</title>
                    <path d={`M${x(at[i])} ${TIP}l${BOX / 2} 6v${BOX}h${-BOX}v${-BOX}Z`} fill={hex} stroke={on ? STRONG : AXIS} strokeWidth={on ? 2 : 1} strokeLinejoin="miter" />
                  </g>
                );
              })}
            </svg>
            <div className="scale-row__cols">
              <NumberField
                key={`${key}:${sel}:${at[sel]}`} id={`${id}:at`} label="Location %" value={Math.round(1000 * at[sel]) / 10} step={1} min={0} max={100}
                onCommit={(v) => { if (Number.isFinite(v)) put(moveStop(def, sel, v / 100)); }}
                adorn={<input className="color-quad" id={`${id}:colour`} type="color" value={stops[sel]} aria-label={`Colour of stop ${sel + 1}`} title="The selected stop's colour" onChange={(e) => put({ ...def, stops: stops.map((s, j) => (j === sel ? e.target.value : s)) })} />}
              />
              <div className="field">
                <span className="field__label">Stop {sel + 1} of {n}</span>
                <button className="btn btn--secondary" type="button" disabled={n <= 2} title={n <= 2 ? 'A gradient keeps two stops' : 'Remove the selected stop'} onClick={() => remove(sel)}>Remove</button>
              </div>
            </div>
            <div className="field">
              <label className="field__label" htmlFor={`${id}:name`}>Name</label>
              <input
                className="input" id={`${id}:name`} type="text" maxLength={40} value={text} onChange={(e) => setName({ key, text: e.target.value })}
                onBlur={() => { if (!preset && text.trim() && text.trim() !== label) put({ ...def, label: text.trim() }); }}
              />
              <span className="field__help">{preset ? 'A built-in gradient: changes stay until Reset. Save as new keeps it and makes a copy under this name.' : 'One of your own gradients.'}</span>
            </div>
          </div>
          <div className="menu__footer cluster">
            <button className="btn btn--secondary" type="button" title="Turn the gradient round: low values take the colours of high ones" onClick={() => { put(flipped(def)); setPicked(n - 1 - sel); }}>Flip</button>
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
